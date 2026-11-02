#!/usr/bin/env node
/* global console, process */
// Bundles the MCP servers ADF Studio ships into resources/mcp-servers/ so
// they run on Studio's own executable (ELECTRON_RUN_AS_NODE=1) with no
// system Node.js or npm: src/main/services/bundled-mcp-servers.ts resolves
// them, electron-builder.yml copies the folder next to the asar
// (extraResources). Runs as part of `npm run build`.
//
// Today: the Gmail catalog server (@gongrzhe/server-gmail-autoauth-mcp),
// pinned EXACTLY in package.json devDependencies. One ESM file per server
// plus a THIRD_PARTY_NOTICES.txt with the licenses of every bundled package.

import { build } from 'esbuild'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// --out <dir>: bundle somewhere else (tests); default resources/mcp-servers.
const outArg = process.argv.indexOf('--out')
const outRoot = outArg !== -1 && process.argv[outArg + 1] ? resolve(process.argv[outArg + 1]) : join(root, 'resources', 'mcp-servers')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

const SERVERS = [
  { dir: 'gmail', pkg: '@gongrzhe/server-gmail-autoauth-mcp', entry: 'dist/index.js' },
]

/** name@version + license text of every node_modules package in the bundle. */
function thirdPartyNotices(inputs) {
  const pkgDirs = new Set()
  for (const input of Object.keys(inputs)) {
    const parts = resolve(root, input).split(sep)
    const i = parts.lastIndexOf('node_modules')
    if (i === -1) continue
    const len = parts[i + 1]?.startsWith('@') ? 2 : 1
    pkgDirs.add(parts.slice(0, i + 1 + len).join(sep))
  }
  const sections = []
  for (const dir of [...pkgDirs].sort()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
    const text = licenseFile ? readFileSync(join(dir, licenseFile), 'utf-8').trim() : `License: ${pkg.license ?? 'see package'} (no license file in the package)`
    sections.push(`${pkg.name}@${pkg.version}\n${'-'.repeat(`${pkg.name}@${pkg.version}`.length)}\n${text}`)
  }
  return `Third-party packages bundled into index.mjs\n\n${sections.join('\n\n\n')}\n`
}

for (const server of SERVERS) {
  const pinned = rootPkg.devDependencies?.[server.pkg]
  if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`${server.pkg} must be pinned to an exact version in package.json devDependencies (found ${pinned ?? 'none'})`)
  }
  const pkgDir = join(root, 'node_modules', server.pkg)
  const installed = existsSync(join(pkgDir, 'package.json')) ? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')).version : null
  if (installed !== pinned) {
    throw new Error(`${server.pkg}: node_modules has ${installed ?? 'nothing'}, package.json pins ${pinned}. Run npm ci.`)
  }

  const outDir = join(outRoot, server.dir)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const result = await build({
    entryPoints: [join(pkgDir, server.entry)],
    outfile: join(outDir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: true,
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
    // googleapis declares "sideEffects": "false" (a string); harmless.
    logOverride: { 'package.json': 'silent' },
    // CommonJS dependencies call require(); ESM output has none.
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  })
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices(result.metafile.inputs))
  console.log(`[bundle-mcp-servers] ${server.pkg}@${pinned} -> ${join(outDir, 'index.mjs')}`)
}
