import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { AdfDatabase } from '../../src/main/adf/adf-database'

describe('AdfDatabase WAL cleanup', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes orphaned shm sidecars even when the wal sidecar is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-wal-cleanup-'))
    dirs.push(dir)
    const adfPath = join(dir, 'missing.adf')
    const shmPath = `${adfPath}-shm`

    writeFileSync(shmPath, '')

    AdfDatabase.cleanupOrphanedWalFiles(dir)

    expect(existsSync(shmPath)).toBe(false)
  })

  it('removes both sidecars when the main adf file is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-wal-cleanup-'))
    dirs.push(dir)
    const adfPath = join(dir, 'missing.adf')
    const walPath = `${adfPath}-wal`
    const shmPath = `${adfPath}-shm`

    writeFileSync(walPath, '')
    writeFileSync(shmPath, '')

    AdfDatabase.cleanupOrphanedWalFiles(dir)

    expect(existsSync(walPath)).toBe(false)
    expect(existsSync(shmPath)).toBe(false)
  })

  it('leaves sidecar removal to SQLite: intact while any connection is open, gone after the last close', () => {
    // close() must NEVER unlink -wal/-shm itself — a manual unlink keyed on
    // the per-process refcount would delete the WAL under another process's
    // live connection. SQLite removes the sidecars when the genuinely-last
    // connection closes.
    const dir = mkdtempSync(join(tmpdir(), 'adf-wal-refcount-'))
    dirs.push(dir)
    const adfPath = join(dir, 'shared.adf')
    const walPath = `${adfPath}-wal`
    const shmPath = `${adfPath}-shm`

    const a = AdfDatabase.create(adfPath, { name: 'refcount-test' })
    const b = AdfDatabase.open(adfPath)

    // Writing through one connection ensures the WAL file exists on disk.
    a.setMeta('probe', 'value', 'none')
    expect(existsSync(walPath) || existsSync(shmPath)).toBe(true)

    a.close()
    // Still-open second connection — sidecars must remain.
    expect(existsSync(walPath)).toBe(true)
    expect(existsSync(shmPath)).toBe(true)

    b.close()
    // Last connection gone — SQLite checkpointed and removed the sidecars.
    expect(existsSync(walPath)).toBe(false)
    expect(existsSync(shmPath)).toBe(false)
  })

  it('honors skipPaths regardless of path casing and accepts arrays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-wal-skip-'))
    dirs.push(dir)
    const adfPath = join(dir, 'live.adf')
    const walPath = `${adfPath}-wal`
    const shmPath = `${adfPath}-shm`

    const db = AdfDatabase.create(adfPath, { name: 'skip-test' })
    db.setMeta('probe', 'value', 'none')
    expect(existsSync(walPath)).toBe(true)

    try {
      // Case-insensitive filesystems (Windows/macOS) must match despite the
      // caller's casing; on Linux paths are case-sensitive, so pass verbatim.
      const skipVariant = process.platform === 'linux' ? adfPath : adfPath.toUpperCase()
      AdfDatabase.cleanupOrphanedWalFiles(dir, new Set([skipVariant]))
      expect(existsSync(walPath)).toBe(true)
      expect(existsSync(shmPath)).toBe(true)

      // openFilePaths() feeds straight into skipPaths (array form).
      AdfDatabase.cleanupOrphanedWalFiles(dir, AdfDatabase.openFilePaths())
      expect(existsSync(walPath)).toBe(true)
      expect(existsSync(shmPath)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('openFilePaths tracks currently-open databases in this process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-wal-openset-'))
    dirs.push(dir)
    const adfPath = join(dir, 'tracked.adf')
    const canonical = process.platform === 'linux'
      ? resolve(adfPath)
      : resolve(adfPath).toLowerCase()

    const db = AdfDatabase.create(adfPath, { name: 'openset-test' })
    try {
      expect(AdfDatabase.openFilePaths()).toContain(canonical)
    } finally {
      db.close()
    }
    expect(AdfDatabase.openFilePaths()).not.toContain(canonical)
  })

  it('is idempotent on double-close', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-wal-idempotent-'))
    dirs.push(dir)
    const adfPath = join(dir, 'idem.adf')

    const db = AdfDatabase.create(adfPath, { name: 'idem-test' })
    db.close()
    expect(() => db.close()).not.toThrow()
  })
})
