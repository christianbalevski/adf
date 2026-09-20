/**
 * Adapter around jq-wasm (real jq 1.8.2 compiled to WebAssembly).
 *
 * Execution model: same as wasi-applet-adapter — the wasm runs in a
 * short-lived worker thread, NOT on the main/Electron event loop. jq's filter
 * evaluation is synchronous CPU work inside the wasm; on the main thread a
 * heavy filter (a big `group_by`, a runaway `range`) froze the UI and could
 * not be preempted by execution_timeout_ms, because the shell's
 * AbortController callback cannot run while the loop is blocked. In a worker a
 * timeout terminates the thread for a real kill.
 *
 * The .wasm is compiled once in this (parent) process and the compiled module
 * is transferred to each worker via workerData, so no per-call recompile and
 * no asar fs read from inside the worker. The jq-wasm CJS entry is required by
 * absolute path (Electron's patched fs serves it from asar).
 *
 * Isolation seam: keeps the third-party import out of structured.ts so the
 * implementation can be mocked in tests.
 */

import { readFileSync } from 'fs'
import { Worker } from 'node:worker_threads'
import { locate } from './locate-resource'

export interface JqRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunJqOptions {
  /** Hard wall-clock cap; on breach the worker is terminated (exit 124). */
  timeoutMs?: number
  /** Abort signal (shell cancel); aborting terminates the worker (exit 130). */
  signal?: AbortSignal
}

/** Absolute path to jq-wasm's CJS entry, required by the worker. */
function locateJqEntry(): string {
  return locate(['node_modules', 'jq-wasm', 'dist', 'index.cjs'])
}

function locateJqWasm(): string {
  return locate(['node_modules', 'jq-wasm', 'dist', 'build', 'jq.wasm'])
}

let modulePromise: Promise<WebAssembly.Module> | null = null

/** Compile the jq module once (async → off the event loop) and cache. */
function getModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = WebAssembly.compile(readFileSync(locateJqWasm()))
  }
  return modulePromise
}

/**
 * Worker body (CJS, run via `{ eval: true }`). Instantiates jq from the
 * pre-compiled module and runs one filter, posting back jq's own
 * {stdout, stderr, exitCode} verbatim.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const { entryPath, wasmModule, input, filter, flags } = workerData
  const jq = require(entryPath)
  const handle = await jq.loadJq({ wasmModule })
  const r = await handle.raw(input, filter, flags)
  parentPort.postMessage({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode })
})().catch((e) => parentPort.postMessage({ error: String((e && e.message) || e) }))
`

// Bound concurrent jq workers for the same reason the applet adapter does:
// a wide pipeline must not spawn unbounded OS threads. Excess calls queue.
const MAX_CONCURRENT_WORKERS = 4
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
 * Run a jq filter over input text. Flags are CLI-style (e.g. ['-r', '-c']).
 * Never throws on jq errors — inspect exitCode. Never blocks the calling
 * thread; honors timeout/abort by terminating the worker.
 */
export async function runJq(
  input: string,
  filter: string,
  flags: string[] = [],
  opts: RunJqOptions = {}
): Promise<JqRunResult> {
  const wasmModule = await getModule()
  const entryPath = locateJqEntry()
  // Clamp: a 0/negative/NaN timeout must not kill every filter instantly.
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 60_000

  await acquireSlot()
  return new Promise<JqRunResult>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { entryPath, wasmModule, input, filter, flags },
      })
    } catch (e) {
      // Constructor threw (e.g. resource exhaustion) — release the slot we took,
      // else the semaphore leaks and future filters deadlock.
      releaseSlot()
      resolve({ stdout: '', stderr: `jq: worker start failed: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 })
      return
    }
    let settled = false
    const finish = (r: JqRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      releaseSlot()
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ stdout: '', stderr: `jq: timed out after ${Math.round(timeoutMs / 1000)}s`, exitCode: 124 }),
      timeoutMs
    )
    worker.once('message', (m: { stdout?: string; stderr?: string; exitCode?: number; error?: string }) => {
      if (m?.error) finish({ stdout: '', stderr: `jq: ${m.error}`, exitCode: 1 })
      else finish({ stdout: m.stdout ?? '', stderr: m.stderr ?? '', exitCode: m.exitCode ?? 0 })
    })
    worker.once('error', (e: Error) => finish({ stdout: '', stderr: `jq: ${e.message}`, exitCode: 1 }))
    if (opts.signal) {
      const onAbort = () => finish({ stdout: '', stderr: 'jq: aborted', exitCode: 130 })
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
