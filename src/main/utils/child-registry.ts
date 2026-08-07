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
  }
}

/**
 * Kill every tracked child tree, waiting up to budgetMs for exits.
 * Never throws; intended for shutdown paths.
 */
export async function killAllTracked(budgetMs = 3000): Promise<void> {
  const children = [...tracked]
  if (children.length === 0) return
  const exits = children.map(
    (c) =>
      new Promise<void>((resolve) => {
        if (c.pid == null || c.exitCode !== null || c.signalCode !== null) return resolve()
        c.once('exit', () => resolve())
      })
  )
  for (const c of children) killTree(c)
  await Promise.race([
    Promise.allSettled(exits),
    new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref?.()),
  ])
}
