/**
 * Off-thread regex matching for grep/sed.
 *
 * grep and sed compile AGENT-SUPPLIED patterns into JS RegExp. JS regex
 * matching is synchronous and unbounded: a pattern with nested quantifiers
 * (`(a+)+$`) against a long non-matching line backtracks exponentially, so on
 * the main thread it freezes the whole Electron process and the shell's
 * execution_timeout_ms can never fire — the AbortController callback needs the
 * event loop that the match is holding.
 *
 * Same remedy as the WASM adapters: run the match in a worker thread with a
 * hard wall-clock cap and terminate on breach. Unlike those, regex jobs are
 * tiny and frequent, so workers are POOLED AND WARM (an idle worker is
 * unref'd, so it never holds the process open) — a hop costs well under a
 * millisecond once one is up. Only patterns that can blow up, or inputs big
 * enough for the hop to disappear into the noise, pay for it at all; see
 * shouldOffload.
 *
 * The worker returns match POSITIONS, never rendered output: sed's replacement
 * rendering (backrefs, &, \n) stays on the main thread in one implementation,
 * so the off-thread path cannot drift from the inline one.
 */

import { Worker } from 'node:worker_threads'

/** One regex match, enough for the caller to rebuild replace() semantics. */
export interface RegexMatch {
  index: number
  match: string
  /** Capture groups (1..n); an unmatched optional group is undefined. */
  groups: Array<string | undefined>
}

export interface SelectJob {
  source: string
  flags: string
  lines: string[]
  /** Invert selection (grep -v). */
  invert: boolean
  /** Stop after this many selected lines (grep -m); Infinity for no cap. */
  maxCount: number
  /** Also return the matching substrings of each selected line (grep -o). */
  pieces: boolean
}

export interface SelectResult {
  idx: number[]
  /** Parallel to idx when SelectJob.pieces was set, else null. */
  pieces: string[][] | null
}

export interface ExecJob {
  source: string
  flags: string
  lines: string[]
}

export interface RegexOptions {
  /** Hard wall-clock cap; on breach the worker is terminated. */
  timeoutMs?: number
  /** Abort signal (shell cancel); aborting terminates the worker. */
  signal?: AbortSignal
}

export type RegexOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' | 'aborted' | 'error'; message: string }

/** Inputs at or below this run inline on the main thread — the worker hop
 *  would dominate, and a linear pattern over this little text is microseconds. */
export const OFFLOAD_MIN_BYTES = 64 * 1024

/**
 * Cheap structural check for patterns that can backtrack catastrophically: a
 * quantified group whose body itself contains a quantifier or an alternation
 * (`(a+)+`, `(a|aa)*`, `(?:\d+|x)+`), or a backreference. Conservative by
 * design — a false positive only costs a worker hop.
 */
export function mayBacktrack(source: string): boolean {
  if (/\\[1-9]/.test(source)) return true
  const groupStarts: number[] = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') { i++; continue }
    if (c === '[') {
      // Character class: ']' first (or after '^') is a literal.
      i++
      if (source[i] === '^') i++
      if (source[i] === ']') i++
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '(') { groupStarts.push(i); continue }
    if (c === ')') {
      const start = groupStarts.pop()
      if (start === undefined) continue
      const next = source[i + 1]
      // '?' is bounded (one optional pass), '*'/'+'/'{n,m}' are not.
      if (next === '*' || next === '+' || next === '{') {
        if (/[*+{|]/.test(source.slice(start + 1, i))) return true
      }
    }
  }
  return false
}

/** Route to a worker when the pattern can blow up, or the input is big. */
export function shouldOffload(source: string, inputBytes: number): boolean {
  return inputBytes > OFFLOAD_MIN_BYTES || mayBacktrack(source)
}

/**
 * Worker body (CJS, run via `{ eval: true }`). Long-lived: handles one job per
 * message and stays warm. Selection mirrors grep's inline loop; 'exec' mirrors
 * String.replace's scan, including the lastIndex bump on a zero-width match,
 * so the caller can rebuild the substitution byte-for-byte.
 */
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads')

function scan(re, line) {
  const out = []
  if (!re.global) {
    const m = re.exec(line)
    if (m) out.push({ index: m.index, match: m[0], groups: m.slice(1) })
    return out
  }
  re.lastIndex = 0
  let m
  while ((m = re.exec(line)) !== null) {
    out.push({ index: m.index, match: m[0], groups: m.slice(1) })
    if (m[0] === '') re.lastIndex++
  }
  return out
}

parentPort.on('message', (job) => {
  try {
    if (job.kind === 'select') {
      const re = new RegExp(job.source, job.flags)
      const oRe = job.pieces ? new RegExp(job.source, job.flags.includes('g') ? job.flags : job.flags + 'g') : null
      const idx = []
      const pieces = oRe ? [] : null
      for (let i = 0; i < job.lines.length && idx.length < job.maxCount; i++) {
        const line = job.lines[i]
        if (re.test(line) !== job.invert) {
          idx.push(i)
          if (pieces) pieces.push((line.match(oRe) || []).filter((s) => s.length > 0))
        }
      }
      parentPort.postMessage({ id: job.id, ok: true, value: { idx, pieces } })
    } else {
      const re = new RegExp(job.source, job.flags)
      const matches = job.lines.map((line) => scan(re, line))
      parentPort.postMessage({ id: job.id, ok: true, value: matches })
    }
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, message: String((e && e.message) || e) })
  }
})
`

// Warm pool. An idle worker is unref'd so it never keeps the process (or a
// vitest run) alive; it is ref'd again while a job is in flight.
const MAX_WORKERS = 4
const idleWorkers: Worker[] = []
let liveWorkers = 0
const waiters: Array<(w: Worker) => void> = []
let jobSeq = 0

function spawn(): Worker {
  const w = new Worker(WORKER_SRC, { eval: true })
  w.unref()
  // A worker that dies on its own must leave the pool and free its slot.
  const drop = (): void => {
    const at = idleWorkers.indexOf(w)
    if (at >= 0) { idleWorkers.splice(at, 1); liveWorkers-- }
  }
  w.on('error', drop)
  w.on('exit', drop)
  return w
}

function acquire(): Promise<Worker> {
  const w = idleWorkers.pop()
  if (w) { w.ref(); return Promise.resolve(w) }
  if (liveWorkers < MAX_WORKERS) {
    liveWorkers++
    const fresh = spawn()
    fresh.ref()
    return Promise.resolve(fresh)
  }
  return new Promise<Worker>((resolve) => waiters.push(resolve))
}

/** Return a worker to the pool, or `null` when it was terminated/died. */
function release(w: Worker | null): void {
  const next = waiters.shift()
  if (w) {
    if (next) { next(w); return }
    w.unref()
    idleWorkers.push(w)
    return
  }
  // Terminated: its slot is free again.
  liveWorkers--
  if (next) {
    liveWorkers++
    const fresh = spawn()
    fresh.ref()
    next(fresh)
  }
}

async function run<T>(job: Record<string, unknown>, opts: RegexOptions): Promise<RegexOutcome<T>> {
  // Clamp: a 0/negative/NaN timeout must not kill every match instantly.
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 60_000
  const worker = await acquire()
  return new Promise<RegexOutcome<T>>((resolve) => {
    let settled = false
    const onMessage = (m: { ok?: boolean; value?: T; message?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      opts.signal?.removeEventListener('abort', onAbort)
      release(worker)
      if (m?.ok) resolve({ ok: true, value: m.value as T })
      else resolve({ ok: false, reason: 'error', message: m?.message ?? 'regex worker failed' })
    }
    // Kill path: the worker is mid-backtrack and will never answer, so the
    // thread must die — it cannot be reused.
    const kill = (reason: 'timeout' | 'aborted' | 'error', message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      opts.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      release(null)
      resolve({ ok: false, reason, message })
    }
    const onError = (e: Error): void => kill('error', e.message)
    const onAbort = (): void => kill('aborted', 'aborted')
    const timer = setTimeout(
      () => kill('timeout', `timed out after ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs
    )
    worker.on('message', onMessage)
    worker.on('error', onError)
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    worker.postMessage({ ...job, id: ++jobSeq })
  })
}

/** grep's line selection, off-thread. */
export function selectLines(job: SelectJob, opts: RegexOptions = {}): Promise<RegexOutcome<SelectResult>> {
  return run<SelectResult>({ kind: 'select', ...job }, opts)
}

/** Per-line match positions for sed's substitution, off-thread. */
export function execLines(job: ExecJob, opts: RegexOptions = {}): Promise<RegexOutcome<RegexMatch[][]>> {
  return run<RegexMatch[][]>({ kind: 'exec', ...job }, opts)
}
