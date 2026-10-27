/**
 * Launcher for the ALF MCP server (registered via .mcp.json).
 *
 * Bundles index.ts and all its dependencies into .build/server.cjs, then runs
 * that bundle with plain node. Running through tsx would keep tsx's
 * esbuild.exe alive for the whole session, and Windows refuses to delete a
 * running executable, so `npm ci` would fail with EPERM while any Claude Code
 * session is open. Here esbuild runs only during the build and is stopped
 * before the server starts; the bundle reads nothing from node_modules.
 *
 * If esbuild is unavailable (node_modules mid-reinstall), the last bundle runs.
 *
 * stdout carries the MCP protocol, so this file writes only to stderr.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, '.build', 'server.cjs')

async function build() {
  const esbuild = await import('esbuild')
  try {
    const result = await esbuild.build({
      entryPoints: [join(here, 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      write: false,
      logLevel: 'silent'
    })
    const code = result.outputFiles[0].contents
    // Several sessions may start at once: write only on change, atomically.
    if (existsSync(outFile) && Buffer.compare(readFileSync(outFile), code) === 0) return
    mkdirSync(dirname(outFile), { recursive: true })
    const tmp = `${outFile}.${process.pid}.tmp`
    writeFileSync(tmp, code)
    renameSync(tmp, outFile)
  } finally {
    await esbuild.stop()
  }
}

try {
  await build()
} catch (err) {
  if (!existsSync(outFile)) throw err
  console.error('[alf-mcp] build failed, running the last bundle:', err?.message ?? err)
}

createRequire(import.meta.url)(outFile)
