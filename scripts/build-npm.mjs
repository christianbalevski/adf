#!/usr/bin/env node
/* global console */
// Builds the `@agentdocumentformat/cli` npm package (daemon + CLI + TUI, no
// Electron) into dist/npm. `npm run build:npm`, then `npm pack ./dist/npm`
// or `npm publish ./dist/npm`.
//
// One esbuild ESM bundle (code-split: the daemon and the TUI load lazily)
// from src/main/cli/bin.ts. Native modules and packages the code resolves
// on disk at runtime stay external and become the package's dependencies.

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgSrc = join(root, 'packages', 'cli')
const out = join(root, 'dist', 'npm')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

// Runtime dependencies of the published package. Each is either native
// (prebuilt binaries per platform), resolved by path at runtime
// (createRequire / require.resolve / locate()), or only reached in dev.
const RUNTIME_DEPS = [
  'better-sqlite3', // native
  '@napi-rs/keyring', // native (OS keychain)
  'sqlite-vec', // loadable SQLite extension, per-platform optional deps
  '@modelcontextprotocol/sdk', // transports required from the SDK's own dir
  'gpt-tokenizer', // lazy createRequire
  '@anthropic-ai/tokenizer', // lazy createRequire
  'jq-wasm', // worker requires its CJS entry + .wasm by path
  '@bjorn3/browser_wasi_shim', // worker requires it by path
]
// Never shipped: Studio-only (required inside try/catch) or dev-only.
const NEVER = ['electron', 'react-devtools-core']

/**
 * Source rewrites needed only in the bundle. Each must match, or the build
 * fails. None today: bin.ts is the only entry that runs anything, and
 * http-api imports openapi.json (inlined by esbuild).
 */
const REWRITES = []

const rewritePlugin = {
  name: 'adf-npm-rewrites',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      const norm = args.path.replace(/\\/g, '/')
      const rw = REWRITES.find((r) => norm === join(root, r.file).replace(/\\/g, '/'))
      if (!rw) return undefined
      const src = readFileSync(args.path, 'utf-8')
      const next = src.replace(rw.from, rw.to)
      if (next === src) throw new Error(`build-npm: rewrite for ${rw.file} no longer matches (${rw.from}) — update scripts/build-npm.mjs`)
      rw.applied = true
      return { contents: next, loader: 'ts' }
    })
  },
}

function depVersion(name) {
  const v = rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name]
  if (!v) throw new Error(`build-npm: ${name} is not a dependency of the root package.json`)
  return v
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'dist'), { recursive: true })

const started = Date.now()
const result = await build({
  entryPoints: { adf: join(root, 'src/main/cli/bin.ts') },
  outdir: join(out, 'dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  chunkNames: 'chunks/[name]-[hash]',
  tsconfig: join(root, 'tsconfig.node.json'),
  jsx: 'automatic',
  external: [...RUNTIME_DEPS, ...RUNTIME_DEPS.map((d) => `${d}/*`), ...NEVER],
  define: { __ADF_VERSION__: JSON.stringify(rootPkg.version) },
  // CJS-era code in the graph uses require / __dirname / __filename.
  banner: {
    js: [
      "import { createRequire as __adfCreateRequire } from 'node:module';",
      "import { fileURLToPath as __adfFileURLToPath } from 'node:url';",
      "import { dirname as __adfDirname } from 'node:path';",
      'const require = __adfCreateRequire(import.meta.url);',
      'const __filename = __adfFileURLToPath(import.meta.url);',
      'const __dirname = __adfDirname(__filename);',
    ].join('\n'),
  },
  plugins: [rewritePlugin],
  legalComments: 'none',
  minifySyntax: true,
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
})
for (const rw of REWRITES) {
  if (!rw.applied) throw new Error(`build-npm: ${rw.file} was not part of the bundle — rewrite never applied`)
}
// Shell userland: locate() walks up from the bundle dir to resources/wasm.
mkdirSync(join(out, 'resources', 'wasm'), { recursive: true })
for (const f of ['coreutils.wasm', 'coreutils.LICENSE']) {
  cpSync(join(root, 'resources', 'wasm', f), join(out, 'resources', 'wasm', f))
}

// Package manifest: template + version + dependency ranges from the root.
const template = JSON.parse(readFileSync(join(pkgSrc, 'package.json'), 'utf-8'))
const manifest = {
  ...template,
  version: rootPkg.version,
  comment: undefined,
  license: rootPkg.license,
  repository: rootPkg.repository,
  dependencies: Object.fromEntries(RUNTIME_DEPS.map((d) => [d, depVersion(d)])),
}
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(join(pkgSrc, 'README.md'), join(out, 'README.md'))
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'))

// Report.
let bytes = 0
for (const info of Object.values(result.metafile.outputs)) bytes += info.bytes
const inputs = Object.keys(result.metafile.inputs)
const bundledPkgs = new Set(inputs.map((p) => p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))
for (const bad of ['electron', 'better-sqlite3']) {
  if (bundledPkgs.has(bad)) throw new Error(`build-npm: ${bad} ended up inside the bundle`)
}
// electron may only be reached through a guarded require(); a static import
// would crash the chunk at load time with no electron installed.
for (const file of Object.keys(result.metafile.outputs)) {
  if (!file.endsWith('.mjs')) continue
  const code = readFileSync(resolve(root, file), 'utf-8')
  if (/from\s*["']electron["']|import\(["']electron["']\)/.test(code)) {
    throw new Error(`build-npm: ${file} imports electron statically — a Studio-only module leaked into the daemon/CLI graph`)
  }
}
console.log(`[build-npm] @agentdocumentformat/cli@${rootPkg.version} -> ${out}`)
console.log(`[build-npm] ${(bytes / 1024 / 1024).toFixed(1)} MB JS, ${Object.keys(result.metafile.outputs).length} files, ${bundledPkgs.size} packages bundled, ${Date.now() - started} ms`)
if (!existsSync(join(out, 'dist', 'adf.mjs')) || statSync(join(out, 'dist', 'adf.mjs')).size === 0) {
  throw new Error('build-npm: dist/adf.mjs missing')
}
