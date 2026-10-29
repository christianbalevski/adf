#!/usr/bin/env node
// Real Chromium/React correctness + performance harness. On headless Linux:
// xvfb-run -a node scripts/bench-studio.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const sourceRoot = resolve(option('--baseline') ?? repo)
const baseline = sourceRoot !== repo
const output = option('--output')
const work = await mkdtemp(join(tmpdir(), 'adf-studio-bench-'))
const require = createRequire(import.meta.url)
let child
let timeout
try {
  const component = join(sourceRoot, 'src/renderer/components/agent/MarkdownEntry.tsx')
  let standalone = true
  try { await access(component) } catch { standalone = false }
  await build({
    entryPoints: [join(repo, 'tests/perf/studio-browser-fixture.tsx')],
    outfile: join(work, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', STUDIO_BASELINE: String(baseline) },
    alias: {
      '@studio/markdown': join(sourceRoot, 'src/renderer/utils/markdown.ts'),
      '@studio/styles': join(sourceRoot, 'src/renderer/styles/editor.css'),
      ...(standalone ? { '@studio/entry': component } : {}),
    },
    plugins: standalone ? [] : [{
      name: 'baseline-markdown-entry',
      setup(build) {
        build.onResolve({ filter: /^@studio\/entry$/ }, () => ({ path: 'entry', namespace: 'baseline' }))
        build.onLoad({ filter: /.*/, namespace: 'baseline' }, async () => {
          // The original component was private in AgentLoop. Compile its exact
          // source and helpers, with the same real imports; no simulated render.
          const source = await readFile(join(sourceRoot, 'src/renderer/components/agent/AgentLoop.tsx'), 'utf8')
          const start = source.indexOf('/** Percent-encode spaces in adf-file://')
          const end = source.indexOf('// Reasoning traces are mostly', start)
          if (start < 0 || end < 0) throw new Error('Unsupported baseline: MarkdownEntry source boundaries changed')
          return {
            contents: `import {useState,useRef,useEffect,useCallback,useMemo,memo} from 'react';\n`
              + `import {renderMarkdownToSafeHtml,createIncrementalMarkdownRenderer,useMarkdownHighlightVersion} from '../../utils/markdown';\n`
              + `import {isAdfFileUrl,openAdfFileLink} from '../../utils/open-adf-link';\n`
              + source.slice(start, end) + '\nexport {MarkdownEntry};',
            loader: 'tsx', resolveDir: join(sourceRoot, 'src/renderer/components/agent'),
          }
        })
      },
    }],
  })
  await writeFile(join(work, 'index.html'), '<!doctype html><link rel="stylesheet" href="fixture.css"><body><script src="fixture.js"></script>')
  const env = { ...process.env, STUDIO_BENCH_DIR: work, STUDIO_BENCH_PROFILE: args.includes('--profile') ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  // Explicit test-only escape hatch for Linux runners whose AppArmor policy
  // blocks the unpackaged npm Electron binary from creating its sandbox.
  const electronArgs = [
    ...(args.includes('--no-sandbox') ? ['--no-sandbox'] : []),
    join(repo, 'tests/perf/studio-browser-main.cjs'),
  ]
  child = spawn(require('electron'), electronArgs, { env, stdio: 'inherit', windowsHide: true })
  timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timeout)
  if (code !== 0) throw new Error(`Studio browser harness exited ${code}`)
  const results = JSON.parse(await readFile(join(work, 'results.json'), 'utf8'))
  results.sourceRoot = sourceRoot
  if (output) await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
  if (args.includes('--profile')) console.log(`CPU profile and browser bundle retained: ${work}`)
} finally {
  clearTimeout(timeout)
  if (child && child.exitCode === null) child.kill('SIGKILL')
  if (!args.includes('--profile')) await rm(work, { recursive: true, force: true })
}
