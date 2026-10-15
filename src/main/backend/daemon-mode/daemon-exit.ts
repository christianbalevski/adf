import { open } from 'node:fs/promises'
import { processAlive } from '../../cli/daemon-control'

/**
 * Wait for the daemon process to exit (a switch to embedded, §11.1): its
 * HTTP server closes first, while it still unloads agents and holds their
 * leases, so /health going quiet is not enough; the process is gone only
 * when its pid is. Its agent leases and host record are released with it
 * (unloaded agents release theirs; a dead pid's leftovers are stale to the
 * next runtime). Resolves true once the pid is gone, false at the deadline.
 */
export async function waitForDaemonExit(pid: number, budgetMs: number, opts: {
  alive?: (pid: number) => boolean
  pollMs?: number
} = {}): Promise<boolean> {
  const alive = opts.alive ?? processAlive
  const deadline = Date.now() + budgetMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 200))
  }
  return true
}

/** What the daemon's log says ended it (readDaemonExitCause). */
export interface DaemonExitCause {
  /** For the sentence: "signal SIGTERM", "stopped with adf daemon stop", "Failed to start: …". */
  text: string
  /** The user or another client stopped it on purpose: Studio does not start it again by itself. */
  deliberate: boolean
}

/**
 * The cause of a daemon's exit from the tail of its log (the last 64 KiB),
 * read after the last "[ADF Daemon] Version" line (that run's lines). Null
 * when that run logged no shutdown: it was killed (taskkill, Defender, the
 * OS) or crashed hard. A forced kill leaves no exit code to read.
 */
export async function readDaemonExitCause(logFile: string | null): Promise<DaemonExitCause | null> {
  if (!logFile) return null
  let text: string
  try {
    const handle = await open(logFile, 'r')
    try {
      const { size } = await handle.stat()
      const len = Math.min(size, 64 * 1024)
      const buf = Buffer.alloc(len)
      await handle.read(buf, 0, len, size - len)
      text = buf.toString('utf-8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('[ADF Daemon] Version ')) { start = i; break }
  let cause = null as DaemonExitCause | null
  for (const line of lines.slice(start)) {
    let match: RegExpExecArray | null
    if ((match = /\[ADF Daemon\] Received (SIG[A-Z]+)/.exec(line))) cause = { text: `signal ${match[1]}`, deliberate: false }
    else if (line.includes('[ADF Daemon] Stop requested over HTTP')) cause = { text: 'stopped with adf daemon stop', deliberate: true }
    else if (line.includes('[ADF Daemon] The last client session that owned this daemon run expired')) cause = { text: 'its last client session expired', deliberate: true }
    else if ((match = /\[ADF Daemon\] Shutdown exceeded (\d+)ms/.exec(line))) cause = { text: `${cause ? `${cause.text}; ` : ''}forced exit after ${Math.round(Number(match[1]) / 1000)}s`, deliberate: cause?.deliberate ?? false }
    else if ((match = /\[ADF Daemon\] (Failed to start: .+)$/.exec(line))) cause = { text: `code 1: ${match[1].split(' — ')[0].trim().replace(/[.\s]+$/, '')}`, deliberate: false }
  }
  return cause
}
