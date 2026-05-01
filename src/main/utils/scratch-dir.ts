import { createHash } from 'crypto'
import { mkdirSync, rmSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { getTempPath } from './user-data-path'

const SCRATCH_PREFIX = 'adf-scratch'

/**
 * Per-process scratch root.  Scoped by PID so that concurrent Studio
 * instances (multi-instance via ADF_INSTANCE) don't nuke each other's
 * directories on startup.
 */
export function scratchRootPath(): string {
  return join(getTempPath(), `${SCRATCH_PREFIX}-${process.pid}`)
}

export function scratchDirForAgent(filePath: string): string {
  const name = basename(filePath, '.adf')
  const hash = createHash('md5').update(filePath).digest('hex').slice(0, 6)
  return join(scratchRootPath(), `${name}-${hash}`)
}

export function createScratchDir(filePath: string): string {
  const dir = scratchDirForAgent(filePath)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function removeScratchDir(dirPath: string | null): void {
  if (!dirPath) return
  try { rmSync(dirPath, { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * Remove the current process's scratch root.  Called on app shutdown
 * as a safety net after per-agent cleanup.
 */
export function purgeAllScratchDirs(): void {
  try { rmSync(scratchRootPath(), { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * Scan temp for stale scratch dirs left by previous processes that
 * exited uncleanly.  A directory is stale if the PID it belongs to
 * is no longer running.
 */
export function purgeStaleProcessDirs(): void {
  const tempDir = getTempPath()
  let entries: string[]
  try { entries = readdirSync(tempDir) } catch { return }

  for (const entry of entries) {
    if (!entry.startsWith(`${SCRATCH_PREFIX}-`)) continue
    const pid = Number(entry.slice(SCRATCH_PREFIX.length + 1))
    if (!pid || pid === process.pid) continue

    // Check if the owning process is still alive
    let alive = false
    try {
      process.kill(pid, 0) // signal 0 = existence check, no actual signal
      alive = true
    } catch (err: any) {
      // EPERM = process exists but we can't signal it (different user/root)
      // ESRCH = no such process — safe to clean up
      alive = err?.code === 'EPERM'
    }
    if (!alive) {
      try { rmSync(join(tempDir, entry), { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
