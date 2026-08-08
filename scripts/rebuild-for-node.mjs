#!/usr/bin/env node
/**
 * Ensures better-sqlite3 is compiled for the current (system) Node.js runtime.
 *
 * ABI ping-pong fix: node <-> electron switches used to trigger a full
 * node-gyp recompile (30-120s) every time. Now each successfully built
 * binary is cached per ABI (process.versions.modules) under
 * node_modules/better-sqlite3/.abi-cache/, and a mismatch is fixed by a
 * file copy when a cached binary for the wanted ABI exists. Before the
 * active binary is overwritten, it is saved to its own ABI slot (its ABI
 * is parsed from the NODE_MODULE_VERSION require error), so switching
 * back (e.g. electron-rebuild ran via postinstall) is also just a copy.
 *
 * Cache lives outside build/ because node-gyp and electron-rebuild wipe
 * build/ on every run. `npm install` (full reinstall of the package)
 * wipes the whole package dir including the cache — that's acceptable,
 * the cache repopulates on the next rebuild.
 *
 * Dependency-free ESM. Only touches better-sqlite3 (never node-pty).
 */

import { execSync, execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const start = Date.now()
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Locate the package via real module resolution (worktrees may reach the
// parent repo's node_modules through walk-up when a symlinked node_modules
// is not traversable on Windows). Fall back to the conventional path.
let pkgDir = join(scriptRoot, 'node_modules', 'better-sqlite3')
try {
  const require = createRequire(join(scriptRoot, 'noop.js'))
  pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
} catch { /* package not installed yet — keep conventional path */ }

const binding = join(pkgDir, 'build', 'Release', 'better_sqlite3.node')
const cacheDir = join(pkgDir, '.abi-cache')
// npm rebuild must run from the project that owns this node_modules tree
const npmRoot = dirname(dirname(pkgDir))
const targetAbi = process.versions.modules

const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`
const cachePath = (abi) => join(cacheDir, `better_sqlite3-abi${abi}.node`)

/**
 * Verify the binding loads, in a child process so a previously mapped
 * wrong-ABI DLL in this process can never give a stale answer (Windows).
 */
function loadable() {
  try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(binding)})`], { stdio: 'pipe' })
    return { ok: true, message: '' }
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message || err) }
  }
}

/** Copy the active binding into the cache slot for the given ABI. Best-effort. */
function cacheActive(abi) {
  if (!abi || !existsSync(binding)) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    copyFileSync(binding, cachePath(abi))
  } catch { /* cache is an optimization — never fatal */ }
}

const check = loadable()
if (check.ok) {
  cacheActive(targetAbi) // keep the cache warm for the next ABI switch
  console.log(`[rebuild] better-sqlite3 already matches Node ${process.version} (ABI ${targetAbi}) — ${elapsed()}`)
  process.exit(0)
}

// Active binary is for some other ABI (usually Electron's). Parse its ABI
// from the require error and save it to its own cache slot before we
// overwrite it, so switching back later is a copy, not a recompile.
const abiMatch = /NODE_MODULE_VERSION (\d+)/.exec(check.message)
const activeAbi = abiMatch ? abiMatch[1] : null
if (activeAbi && activeAbi !== targetAbi) cacheActive(activeAbi)

// Fast path: restore a previously built binary for this ABI.
if (existsSync(cachePath(targetAbi))) {
  try {
    mkdirSync(dirname(binding), { recursive: true })
    copyFileSync(cachePath(targetAbi), binding)
    if (loadable().ok) {
      console.log(`[rebuild] restored cached better-sqlite3 for Node ${process.version} (ABI ${targetAbi}) — ${elapsed()}`)
      process.exit(0)
    }
    console.log(`[rebuild] cached binary for ABI ${targetAbi} failed to load — falling back to full rebuild`)
  } catch (err) {
    console.log(`[rebuild] cache restore failed (${err.message}) — falling back to full rebuild`)
  }
}

// Slow path: full node-gyp recompile.
console.log(`[rebuild] better-sqlite3 needs rebuild for Node ${process.version} (ABI ${targetAbi})...`)
try {
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit', cwd: npmRoot })
} catch {
  console.error('')
  console.error('[rebuild] npm rebuild better-sqlite3 FAILED.')
  console.error('[rebuild] Likely causes and fixes:')
  console.error('[rebuild]   - EBUSY/EPERM on better_sqlite3.node: the binary is locked by a running app —')
  console.error('[rebuild]     quit the Electron app / daemon using this repo and retry')
  console.error('[rebuild]   - Missing native toolchain: install Visual Studio Build Tools with the')
  console.error('[rebuild]     "Desktop development with C++" workload (incl. Spectre-mitigated libs on Windows)')
  console.error('[rebuild]   - Broken/partial node_modules: run `npm install` and retry')
  console.error(`[rebuild] Failed after ${elapsed()}.`)
  process.exit(1)
}

const post = loadable()
if (!post.ok) {
  console.error('[rebuild] rebuilt binary still fails to load for the current Node runtime:')
  console.error(post.message.trim())
  console.error(`[rebuild] Failed after ${elapsed()}.`)
  process.exit(1)
}
cacheActive(targetAbi)
console.log(`[rebuild] done — rebuilt and cached ABI ${targetAbi} in ${elapsed()}.`)
