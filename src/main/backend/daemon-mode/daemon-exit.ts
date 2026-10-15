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
