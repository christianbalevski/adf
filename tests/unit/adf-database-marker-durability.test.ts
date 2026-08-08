import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

const CLEAN_CLOSE_KEY = 'adf_clean_close'

/**
 * Reads the clean-close marker from a database file that has NO -wal/-shm
 * sidecars on disk, i.e. exactly what a future open would see after the WAL
 * was lost without replay (cross-process sidecar unlink, sweep, or the user
 * copying the bare .adf).
 */
function readMarkerFromBareFile(path: string): string | null {
  const raw = new Database(path, { readonly: true })
  try {
    const row = raw.prepare('SELECT value FROM adf_meta WHERE key = ?').get(CLEAN_CLOSE_KEY) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } finally {
    raw.close()
  }
}

describe('clean-close marker durability under WAL loss (stale marker resurrection)', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checkpoints the marker deletion into the main file immediately on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-marker-durability-'))
    dirs.push(dir)
    const adfPath = join(dir, 'session.adf')

    // Session 1 closes cleanly — the marker is checkpointed into the main file.
    AdfDatabase.create(adfPath, { name: 'agent-1' }).close()
    expect(readMarkerFromBareFile(adfPath)).not.toBeNull()

    // Session 2 opens the file. open() deletes the marker; without an
    // immediate checkpoint that deletion lives only in the -wal.
    const db = AdfDatabase.open(adfPath)
    const bareCopyPath = join(dir, 'wal-lost.adf')
    try {
      // Simulate losing the WAL without replay while the session is live:
      // copy ONLY the main .adf, leaving the sidecars behind.
      copyFileSync(adfPath, bareCopyPath)
    } finally {
      db.close()
    }
    expect(existsSync(`${bareCopyPath}-wal`)).toBe(false)
    expect(existsSync(`${bareCopyPath}-shm`)).toBe(false)

    // The previous session's marker must NOT have survived in the main file —
    // otherwise the next open would falsely certify a file that silently lost
    // an entire session's writes.
    expect(readMarkerFromBareFile(bareCopyPath)).toBeNull()

    // And the next open of the WAL-lost file must take the FULL check path.
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma')
    const reopened = AdfDatabase.open(bareCopyPath)
    try {
      const pragmas = pragmaSpy.mock.calls.map(call => String(call[0]))
      expect(pragmas).toContain('integrity_check')
      expect(pragmas).not.toContain('quick_check')
    } finally {
      pragmaSpy.mockRestore()
      reopened.close()
    }
  })

  it('skips the full check for a genuinely clean close even when the bare file is copied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-marker-clean-'))
    dirs.push(dir)
    const adfPath = join(dir, 'clean.adf')

    // Full open/close cycle — close() writes the marker and SQLite folds it
    // into the main file when the last connection closes.
    AdfDatabase.create(adfPath, { name: 'agent-1' }).close()
    AdfDatabase.open(adfPath).close()

    const bareCopyPath = join(dir, 'clean-copy.adf')
    copyFileSync(adfPath, bareCopyPath)
    expect(readMarkerFromBareFile(bareCopyPath)).not.toBeNull()
    // The readonly probe above may leave an empty -shm behind; remove it so
    // this open sees the true "bare file, no sidecars" state.
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(bareCopyPath + ext)) unlinkSync(bareCopyPath + ext)
    }

    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma')
    const reopened = AdfDatabase.open(bareCopyPath)
    try {
      const pragmas = pragmaSpy.mock.calls.map(call => String(call[0]))
      // Marker present + no sidecars ⇒ no integrity pragma at all.
      expect(pragmas).not.toContain('integrity_check')
      expect(pragmas).not.toContain('quick_check')
    } finally {
      pragmaSpy.mockRestore()
      reopened.close()
    }
  })
})
