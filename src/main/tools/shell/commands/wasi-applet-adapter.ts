/**
 * Runs real coreutils (uutils, compiled to wasm32-wasip1) as shell applets.
 *
 * Execution model: the WASM runs in a short-lived worker thread, NOT on the
 * main/Electron event loop. wasi.start() is synchronous CPU work; on the main
 * thread a large or pathological applet (a big sort, `seq` to a huge number)
 * would freeze the UI and could not be preempted by execution_timeout_ms. In a
 * worker it can't block the UI, and a timeout terminates the worker for a real
 * kill. The compiled module is cached in this (parent) process and transferred
 * to each worker via workerData, so no per-call recompile. Files live in an
 * in-memory WASI filesystem (@bjorn3/browser_wasi_shim), pre-read from the
 * SQLite VFS by the command handlers — the applet never touches host disk.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { Worker } from 'node:worker_threads'

export interface AppletResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunAppletOptions {
  /** Hard wall-clock cap; on breach the worker is terminated (exit 124). */
  timeoutMs?: number
  /** Abort signal (shell cancel); aborting terminates the worker (exit 130). */
  signal?: AbortSignal
}

/**
 * Walk up from `start` looking for `resources/wasm/<name>` or
 * `node_modules/<pkg>`. Resolves across all runtimes: bundled Electron main
 * (out/main inside asar — Electron patches fs for asar paths), tsx daemon/CLI,
 * and vitest. Falls back to cwd for module systems without __dirname.
 */
function locate(segments: string[]): string {
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

function locateWasm(): string {
  return locate(['resources', 'wasm', 'coreutils.wasm'])
}

/** Absolute path to the WASI shim's CJS entry, required by the worker. Using
 *  an absolute path avoids module-resolution ambiguity inside an eval worker
 *  (Electron's patched fs serves it from asar). */
function locateShim(): string {
  return locate(['node_modules', '@bjorn3', 'browser_wasi_shim', 'dist', 'index.js'])
}

let modulePromise: Promise<WebAssembly.Module> | null = null

/** Compile the coreutils module once (async → off the event loop) and cache. */
function getModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = WebAssembly.compile(readFileSync(locateWasm()))
  }
  return modulePromise
}

/**
 * Worker body (CJS, run via `{ eval: true }`). Receives the compiled module,
 * applet, argv, stdin, files, and the shim path via workerData; builds the
 * in-memory FS, runs the applet synchronously here (isolated from the main
 * thread), and posts back {stdout, stderr, exitCode}.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
const { WASI, File, Directory, OpenFile, PreopenDirectory, ConsoleStdout, WASIProcExit } = require(workerData.shimPath)

function buildTree(files) {
  const enc = new TextEncoder()
  const root = new Map()
  for (const [path, content] of Object.entries(files)) {
    const segments = String(path).split('/').filter(Boolean)
    if (segments.length === 0) continue
    const bytes = typeof content === 'string' ? enc.encode(content) : content
    let dir = root, conflict = false
    for (let i = 0; i < segments.length - 1; i++) {
      const existing = dir.get(segments[i])
      if (existing instanceof Directory) { dir = existing.contents; continue }
      // Don't overwrite a File with a Directory (path 'a' and 'a/b' collide) —
      // skip the conflicting entry rather than corrupt the earlier one.
      if (existing !== undefined) { conflict = true; break }
      const next = new Directory(new Map())
      dir.set(segments[i], next)
      dir = next.contents
    }
    if (conflict) continue
    const leaf = segments[segments.length - 1]
    if (dir.get(leaf) instanceof Directory) continue
    dir.set(leaf, new File(bytes))
  }
  return root
}

;(async () => {
  const { wasmModule, applet, argv, stdin, files } = workerData
  let stdout = '', stderr = ''
  const od = new TextDecoder(), ed = new TextDecoder()
  const fds = [
    new OpenFile(new File(new TextEncoder().encode(stdin))),
    new ConsoleStdout((b) => { stdout += od.decode(b, { stream: true }) }),
    new ConsoleStdout((b) => { stderr += ed.decode(b, { stream: true }) }),
    new PreopenDirectory('.', buildTree(files)),
  ]
  const wasi = new WASI(['coreutils', applet, ...argv], [], fds, { debug: false })
  const instance = await WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasi.wasiImport })
  let exitCode = 0
  try { exitCode = wasi.start(instance) }
  catch (e) { if (e instanceof WASIProcExit) exitCode = e.code; else throw e }
  // Flush any bytes held back by a multibyte sequence at a chunk boundary.
  stdout += od.decode(); stderr += ed.decode()
  parentPort.postMessage({ stdout, stderr, exitCode })
})().catch((e) => parentPort.postMessage({ error: String((e && e.message) || e) }))
`

// Bound concurrent workers so a wide pipeline / xargs fan-out can't spawn
// unbounded OS threads. Excess calls queue. NOTE: this semaphore is
// process-global, so in a multi-agent daemon one agent's fan-out can delay
// (never starve — the queue is FIFO and each applet is short) another's
// applets. Acceptable given applets are short-lived; revisit with a per-agent
// pool if head-of-line latency becomes a problem.
const MAX_CONCURRENT_WORKERS = 8
let activeWorkers = 0
const workerQueue: Array<() => void> = []
function acquireSlot(): Promise<void> {
  if (activeWorkers < MAX_CONCURRENT_WORKERS) { activeWorkers++; return Promise.resolve() }
  return new Promise<void>((resolve) => workerQueue.push(resolve))
}
function releaseSlot(): void {
  const next = workerQueue.shift()
  if (next) next()
  else activeWorkers--
}

/**
 * Run a coreutils applet in a worker thread. `argv` is everything after the
 * applet name (flags + positionals); `files` mounts VFS contents so file
 * arguments resolve. Never blocks the calling thread; honors timeout/abort
 * by terminating the worker.
 */
export async function runApplet(
  applet: string,
  argv: string[],
  stdin: string,
  files: Record<string, string | Uint8Array> = {},
  opts: RunAppletOptions = {}
): Promise<AppletResult> {
  const wasmModule = await getModule()
  const shimPath = locateShim()
  // Clamp: a 0/negative/NaN timeout must not kill every applet instantly.
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 60_000

  await acquireSlot()
  return new Promise<AppletResult>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { wasmModule, applet, argv, stdin, files, shimPath },
      })
    } catch (e) {
      // Constructor threw (e.g. resource exhaustion) — release the slot we took,
      // else the semaphore leaks and future applets deadlock.
      releaseSlot()
      resolve({ stdout: '', stderr: `${applet}: worker start failed: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 })
      return
    }
    let settled = false
    const finish = (r: AppletResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      releaseSlot()
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ stdout: '', stderr: `${applet}: timed out after ${Math.round(timeoutMs / 1000)}s`, exitCode: 124 }),
      timeoutMs
    )
    worker.once('message', (m: { stdout?: string; stderr?: string; exitCode?: number; error?: string }) => {
      if (m?.error) finish({ stdout: '', stderr: `${applet}: ${m.error}`, exitCode: 1 })
      else finish({ stdout: m.stdout ?? '', stderr: m.stderr ?? '', exitCode: m.exitCode ?? 0 })
    })
    worker.once('error', (e: Error) => finish({ stdout: '', stderr: `${applet}: ${e.message}`, exitCode: 1 }))
    if (opts.signal) {
      const onAbort = () => finish({ stdout: '', stderr: `${applet}: aborted`, exitCode: 130 })
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
