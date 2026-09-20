/**
 * Runtime resource resolution for worker-backed shell commands.
 *
 * Shared by the WASM adapters (coreutils, jq) and the regex worker: anything a
 * worker needs at runtime — a .wasm blob, a CJS entry it will `require` — must
 * resolve in BOTH dev (tsx daemon/CLI, vitest) and the packaged asar build.
 */

import { existsSync } from 'fs'
import { join, dirname } from 'path'

/**
 * Walk up from `start` looking for `resources/wasm/<name>` or
 * `node_modules/<pkg>`. Resolves across all runtimes: bundled Electron main
 * (out/main inside asar — Electron patches fs for asar paths), tsx daemon/CLI,
 * and vitest. Falls back to cwd for module systems without __dirname.
 */
export function locate(segments: string[]): string {
  const starts: string[] = []
  if (typeof __dirname !== 'undefined') starts.push(__dirname)
  starts.push(process.cwd())
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, ...segments)
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error(`not found: ${segments.join('/')}`)
}
