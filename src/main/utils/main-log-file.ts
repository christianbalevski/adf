/**
 * Persistent main-process log.
 *
 * Packaged builds have no stdout: every console line the main process emits
 * (quit reasons, exit codes, cleanup progress, crash-dump paths) vanishes,
 * which is why a silent exit of the installed app has been undiagnosable.
 * This mirrors console output to <userData>/logs/main.log with size-based
 * rotation. Writes are buffered and flushed asynchronously so the hot path
 * never blocks on disk; the buffer is drained synchronously on process exit
 * so the final lines (the ones that explain an exit) always land.
 */
import { appendFile, appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { format } from 'util'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP_ROTATED = 2
const FLUSH_MS = 250
const MAX_BUFFER_BYTES = 256 * 1024

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

let logPath: string | null = null
let buffer: string[] = []
let bufferBytes = 0
let flushTimer: NodeJS.Timeout | null = null
let flushing = false
let writtenSinceStat = 0

function rotateIfNeeded(): void {
  if (!logPath) return
  try {
    const size = existsSync(logPath) ? statSync(logPath).size : 0
    if (size < MAX_BYTES) return
    for (let i = KEEP_ROTATED; i >= 1; i--) {
      const from = i === 1 ? logPath : `${logPath}.${i - 1}`
      const to = `${logPath}.${i}`
      if (existsSync(to)) rmSync(to, { force: true })
      if (existsSync(from)) renameSync(from, to)
    }
  } catch { /* rotation is best-effort */ }
}

function flushAsync(): void {
  flushTimer = null
  if (!logPath || flushing || buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  bufferBytes = 0
  flushing = true
  appendFile(logPath, chunk, (err) => {
    flushing = false
    if (!err) {
      writtenSinceStat += chunk.length
      if (writtenSinceStat > 512 * 1024) { writtenSinceStat = 0; rotateIfNeeded() }
    }
    if (buffer.length > 0) scheduleFlush()
  })
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushAsync, FLUSH_MS)
  flushTimer.unref?.()
}

/** Drain synchronously — for process 'exit', where async I/O never completes. */
export function flushMainLogSync(): void {
  if (!logPath || buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  bufferBytes = 0
  try { appendFileSync(logPath, chunk) } catch { /* nothing left to do */ }
}

function enqueue(level: string, args: unknown[]): void {
  if (!logPath) return
  const text = format(...args).replace(ANSI_RE, '')
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`
  buffer.push(line)
  bufferBytes += line.length
  if (bufferBytes >= MAX_BUFFER_BYTES) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    flushAsync()
  } else {
    scheduleFlush()
  }
}

/** Current log file path, or null before install. */
export function mainLogFilePath(): string | null {
  return logPath
}

/**
 * Mirror console.* to a rotating file under `dir`. Idempotent. Returns the
 * log path, or null when the directory could not be created.
 */
export function installMainLogFile(dir: string): string | null {
  if (logPath) return logPath
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }
  logPath = join(dir, 'main.log')
  rotateIfNeeded()

  const levels: Array<['log' | 'info' | 'warn' | 'error' | 'debug', string]> = [
    ['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR'], ['debug', 'DEBUG']
  ]
  for (const [method, label] of levels) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      try { enqueue(label, args) } catch { /* never let logging throw */ }
    }
  }
  process.on('exit', flushMainLogSync)
  return logPath
}
