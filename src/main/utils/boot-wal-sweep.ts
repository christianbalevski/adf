import { dirname, resolve } from 'path'

/**
 * The directories of last session's recent files that embedded Studio's boot
 * WAL sweep visits (ipc/index.ts scheduleBootWalSweep): foreground opens that
 * live outside the tracked directories. `recent` is the `recentFiles`
 * setting as read; anything but an array of non-empty strings is ignored.
 */
export function recentFileSweepDirs(recent: unknown): string[] {
  const dirs = new Set<string>()
  if (Array.isArray(recent)) {
    for (const f of recent) if (typeof f === 'string' && f) dirs.add(resolve(dirname(f)))
  }
  return [...dirs]
}
