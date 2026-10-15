import { dirname, resolve } from 'path'
import { unsafeLocalPath } from '../backend/local-open-grants'

/**
 * The directories of last session's recent files that embedded Studio's boot
 * WAL sweep visits (ipc/index.ts scheduleBootWalSweep): foreground opens that
 * live outside the tracked directories. `recent` is the `recentFiles`
 * setting as read; anything but an array of non-empty strings is ignored.
 *
 * A network or device path (`\\server\share`, `\\?\`, `\\.\`, a relative
 * path; local-open-grants.ts unsafeLocalPath) is skipped and logged: a
 * readdir there makes Windows connect to that host and send the user's NTLM
 * credentials. Such a path can reach `recentFiles` from a remote daemon's
 * paths kept by an earlier build (E3, W5-D3).
 */
export function recentFileSweepDirs(recent: unknown, log: Pick<Console, 'warn'> = console): string[] {
  const dirs = new Set<string>()
  if (Array.isArray(recent)) {
    for (const f of recent) {
      if (typeof f !== 'string' || !f) continue
      const unsafe = unsafeLocalPath(f)
      if (unsafe) {
        log.warn(`[Boot] WAL sweep skips the recent file ${JSON.stringify(f)}: ${unsafe}`)
        continue
      }
      dirs.add(resolve(dirname(f)))
    }
  }
  return [...dirs]
}
