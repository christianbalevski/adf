import { ChildProcess, execFile } from 'child_process'

/**
 * Process-wide registry of long-lived child processes so shutdown can
 * reap the full tree.  On Windows, child.kill() only terminates the
 * direct child (TerminateProcess) — grandchildren spawned through
 * cmd.exe / npx shims survive — so tree-kill goes through taskkill /T.
 * On POSIX, tree-kill requires the child to lead its own process group
 * (spawn with detached: true), letting us signal -pid.
 */
const tracked = new Set<ChildProcess>()

/** SIGTERM → SIGKILL escalation delay for POSIX group kills. */
const KILL_ESCALATION_MS = 2000

/**
 * Track a long-lived child for shutdown reaping.
 *
 * POSIX note: full tree-kill (signalling the process GROUP) requires the
 * child to have been spawned with `detached: true` so it leads its own
 * group. Call sites tracking non-detached children silently degrade to a
 * direct-child kill — grandchildren (e.g. anything spawned through an npx
 * shim) are NOT reached.
 */
export function trackChild<T extends ChildProcess>(child: T): T {
  if (child.pid == null) return child
  tracked.add(child)
  child.once('exit', () => tracked.delete(child))
  child.once('error', () => tracked.delete(child))
  return child
}

export function trackedChildCount(): number {
  return tracked.size
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** SIGKILL a POSIX process group, falling back to a direct-child SIGKILL. */
function killGroupHard(child: ChildProcess): void {
  const pid = child.pid
  if (pid == null) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

/** Kill a child and its entire descendant tree. Fire-and-forget safe. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    } catch { /* ignore */ }
    return
  }
  // Negative pid signals the process group; only works when the child
  // was spawned with detached: true. Fall back to a direct SIGKILL.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    return
  }
  // A TERM-ignoring tree must not survive shutdown: escalate to a group
  // SIGKILL if the child hasn't exited shortly (Windows taskkill /F above
  // is already forceful).
  const timer = setTimeout(() => {
    if (!hasExited(child)) killGroupHard(child)
  }, KILL_ESCALATION_MS)
  timer.unref?.()
  child.once('exit', () => clearTimeout(timer))
}

/**
 * Kill every tracked child tree, waiting up to budgetMs for exits.
 * Survivors past the budget get a group SIGKILL before returning.
 * Never throws; intended for shutdown paths.
 */
export async function killAllTracked(budgetMs = 3000): Promise<void> {
  const children = [...tracked]
  if (children.length === 0) return
  const exits = children.map(
    (c) =>
      new Promise<void>((resolve) => {
        if (c.pid == null || hasExited(c)) return resolve()
        c.once('exit', () => resolve())
      })
  )
  for (const c of children) killTree(c)
  await Promise.race([
    Promise.allSettled(exits),
    new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref?.()),
  ])
  // Budget expired (or exits raced through): hard-kill any survivors so the
  // process can quit without leaving TERM-ignoring trees behind. Windows
  // already used taskkill /F in killTree.
  if (process.platform !== 'win32') {
    for (const c of children) {
      if (c.pid != null && !hasExited(c)) killGroupHard(c)
    }
  }
}
