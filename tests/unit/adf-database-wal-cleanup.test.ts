import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
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

  it('defers -shm/-wal unlink until the last connection for a file closes', () => {
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
    // Last connection gone — sidecars cleaned up.
    expect(existsSync(walPath)).toBe(false)
    expect(existsSync(shmPath)).toBe(false)
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
