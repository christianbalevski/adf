import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync, rmSync, copyFileSync } from 'fs'

// Controllable existsSync hook, pass-through when disarmed. Lets the
// ghost-file race test delete the .adf "between" reapSidecars' existence
// guard and its open — an interleaving impossible to hit reliably with real
// concurrency. All other fs functions stay real.
const fsHook = vi.hoisted(() => ({
  impl: null as ((p: unknown) => boolean) | null,
  actualExistsSync: null as ((p: unknown) => boolean) | null,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const actualExists = actual.existsSync as (p: unknown) => boolean
  fsHook.actualExistsSync = actualExists
  return {
    ...actual,
    existsSync: (p: unknown) => (fsHook.impl ? fsHook.impl(p) : actualExists(p)),
  }
})
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import BetterSqlite3 from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

const sidecarsExist = (adfPath: string): { wal: boolean; shm: boolean } => ({
  wal: existsSync(`${adfPath}-wal`),
  shm: existsSync(`${adfPath}-shm`),
})

/**
 * Fabricate an unclean-exit .adf at `dstPath`: create a WAL database, fold a
 * first row into the main file, write a second row that lives ONLY in the
 * -wal, then copy .adf + -wal + -shm while the connection is still open.
 * The copy is byte-identical to a crashed session (no clean-close marker,
 * live sidecars, data split across main file and WAL).
 */
function fabricateCrashedDb(srcPath: string, dstPath: string): void {
  const db = AdfDatabase.create(srcPath, { name: 'crash-src' })
  try {
    db.setMeta('in-main', 'checkpointed', 'none')
    db.checkpoint()
    db.setMeta('in-wal', 'wal-only', 'none')
    copyFileSync(srcPath, dstPath)
    copyFileSync(`${srcPath}-wal`, `${dstPath}-wal`)
    copyFileSync(`${srcPath}-shm`, `${dstPath}-shm`)
  } finally {
    db.close()
  }
}

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

  describe('reapSidecars', () => {
    it('returns no-sidecars when neither -wal nor -shm exists', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-none-'))
      dirs.push(dir)
      const adfPath = join(dir, 'clean.adf')
      const db = AdfDatabase.create(adfPath, { name: 'clean' })
      db.close()
      expect(sidecarsExist(adfPath)).toEqual({ wal: false, shm: false })
      expect(AdfDatabase.reapSidecars(adfPath)).toBe('no-sidecars')
    })

    it('reaps after an unclean exit and the WAL data survives into the main file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-crash-'))
      dirs.push(dir)
      const crashed = join(dir, 'crashed.adf')
      fabricateCrashedDb(join(dir, 'src.adf'), crashed)
      expect(sidecarsExist(crashed)).toEqual({ wal: true, shm: true })

      expect(AdfDatabase.reapSidecars(crashed)).toBe('reaped')
      expect(sidecarsExist(crashed)).toEqual({ wal: false, shm: false })

      // Data from BOTH the main file and the (former) WAL must be present,
      // and the file must still be a WAL-mode database.
      const raw = new BetterSqlite3(crashed, { readonly: true })
      try {
        const mode = raw.pragma('journal_mode') as Array<{ journal_mode: string }>
        expect(mode[0]?.journal_mode).toBe('wal')
      } finally {
        raw.close()
      }
      const reopened = AdfDatabase.open(crashed)
      try {
        expect(reopened.getMeta('in-main')).toBe('checkpointed')
        expect(reopened.getMeta('in-wal')).toBe('wal-only')
      } finally {
        reopened.close()
      }
    })

    it('returns busy and touches nothing while the file is open in this process (AdfDatabase pre-filter)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-open-'))
      dirs.push(dir)
      const adfPath = join(dir, 'open.adf')
      const db = AdfDatabase.create(adfPath, { name: 'open' })
      try {
        db.setMeta('probe', 'value', 'none')
        expect(sidecarsExist(adfPath).wal).toBe(true)
        expect(AdfDatabase.reapSidecars(adfPath)).toBe('busy')
        expect(sidecarsExist(adfPath)).toEqual({ wal: true, shm: true })
        // The held connection must still be usable afterwards.
        expect(db.getMeta('probe')).toBe('value')
      } finally {
        db.close()
      }
    })

    it('returns busy and touches nothing while a second raw connection holds the file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-busy-'))
      dirs.push(dir)
      const crashed = join(dir, 'held.adf')
      fabricateCrashedDb(join(dir, 'src.adf'), crashed)

      // Raw better-sqlite3 connection — bypasses the AdfDatabase refcount, so
      // only SQLite's own locking can detect it. An IDLE holder must trip the
      // exclusive-lock probe (checkpoint busy=0 would NOT catch this).
      const holder = new BetterSqlite3(crashed)
      try {
        holder.prepare('SELECT count(*) FROM adf_meta').get()
        expect(AdfDatabase.reapSidecars(crashed)).toBe('busy')
        expect(sidecarsExist(crashed)).toEqual({ wal: true, shm: true })
        // Holder unaffected: still reads its data.
        expect(holder.prepare('SELECT count(*) c FROM adf_meta').get()).toBeTruthy()
      } finally {
        holder.close()
      }
    })

    it('returns busy while a REAL child process holds the file open (cross-process detection)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-xproc-'))
      dirs.push(dir)
      const crashed = join(dir, 'xproc.adf')
      fabricateCrashedDb(join(dir, 'src.adf'), crashed)

      const req = createRequire(import.meta.url)
      const sqlitePath = req.resolve('better-sqlite3')
      const childScript = [
        'const Database = require(process.argv[1])',
        'const db = new Database(process.argv[2])',
        "db.prepare('SELECT count(*) FROM adf_meta').get()",
        "process.send('held')",
        'setInterval(() => {}, 1000)',
      ].join('\n')

      let child: ChildProcess | null = null
      try {
        child = spawn(process.execPath, ['-e', childScript, sqlitePath, crashed], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        })
        const spawned = child
        await new Promise<void>((res, rej) => {
          const t = setTimeout(() => rej(new Error('child never reported held')), 15_000)
          spawned.on('message', (m) => { if (m === 'held') { clearTimeout(t); res() } })
          spawned.on('exit', (code) => rej(new Error(`child exited early: ${code}`)))
          spawned.on('error', rej)
        })

        expect(AdfDatabase.reapSidecars(crashed)).toBe('busy')
        expect(sidecarsExist(crashed)).toEqual({ wal: true, shm: true })
      } finally {
        if (child) {
          child.removeAllListeners('exit')
          child.kill()
          await new Promise<void>((res) => {
            child!.on('exit', () => res())
            setTimeout(res, 3_000)
          })
        }
      }

      // Holder gone — the same call must now succeed and recover the data.
      expect(AdfDatabase.reapSidecars(crashed)).toBe('reaped')
      expect(sidecarsExist(crashed)).toEqual({ wal: false, shm: false })
      const reopened = AdfDatabase.open(crashed)
      try {
        expect(reopened.getMeta('in-wal')).toBe('wal-only')
      } finally {
        reopened.close()
      }
    }, 30_000)

    it('deletes orphaned sidecars when the .adf itself is missing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-orphan-'))
      dirs.push(dir)
      const adfPath = join(dir, 'gone.adf')
      writeFileSync(`${adfPath}-wal`, '')
      writeFileSync(`${adfPath}-shm`, '')

      expect(AdfDatabase.reapSidecars(adfPath)).toBe('reaped')
      expect(sidecarsExist(adfPath)).toEqual({ wal: false, shm: false })
    })

    it('does not resurrect a .adf deleted between the existence guard and the open', () => {
      // Ghost-file race: reapSidecars checks existsSync(filePath) and then
      // opens it. If the .adf is deleted in that window, an open without
      // fileMustExist would CREATE a fresh stub — a deleted agent coming
      // back from the dead. Simulate the race by deleting the real file
      // inside the guard while still reporting it as present.
      const dir = mkdtempSync(join(tmpdir(), 'adf-reap-vanish-'))
      dirs.push(dir)
      const adfPath = join(dir, 'vanish.adf')
      fabricateCrashedDb(join(dir, 'src.adf'), adfPath)
      expect(sidecarsExist(adfPath)).toEqual({ wal: true, shm: true })

      const realExists = fsHook.actualExistsSync!
      fsHook.impl = (p) => {
        if (p === adfPath && realExists(adfPath)) {
          rmSync(adfPath, { force: true })
          return true // the guard saw the file an instant before deletion
        }
        return realExists(p)
      }
      try {
        expect(AdfDatabase.reapSidecars(adfPath)).toBe('reaped')
      } finally {
        fsHook.impl = null
      }
      // The deleted agent must NOT reappear as an empty stub, and its
      // orphaned sidecars must be gone.
      expect(existsSync(adfPath)).toBe(false)
      expect(sidecarsExist(adfPath)).toEqual({ wal: false, shm: false })
    })
  })

  describe('shutdown-sweep invariant: only in-process-open files retain sidecars', () => {
    it('sweep reaps crashed + orphaned files and leaves open ones alone', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-sweep-invariant-'))
      dirs.push(dir)

      // 1. A database open in this process (its sidecars are live).
      const livePath = join(dir, 'live.adf')
      const live = AdfDatabase.create(livePath, { name: 'live' })
      live.setMeta('probe', 'value', 'none')

      // 2. A cleanly-closed database (no sidecars at all).
      const closedPath = join(dir, 'closed.adf')
      AdfDatabase.create(closedPath, { name: 'closed' }).close()

      // 3. A crashed database (connection "killed": sidecars left behind).
      const crashedPath = join(dir, 'crashed.adf')
      fabricateCrashedDb(join(dir, 'crash-src.adf'), crashedPath)

      // 4. Orphaned sidecars with no .adf.
      const orphanPath = join(dir, 'orphan.adf')
      writeFileSync(`${orphanPath}-wal`, '')
      writeFileSync(`${orphanPath}-shm`, '')

      try {
        AdfDatabase.cleanupOrphanedWalFiles(dir, AdfDatabase.openFilePaths())

        expect(sidecarsExist(livePath)).toEqual({ wal: true, shm: true })
        expect(sidecarsExist(closedPath)).toEqual({ wal: false, shm: false })
        expect(sidecarsExist(crashedPath)).toEqual({ wal: false, shm: false })
        expect(sidecarsExist(orphanPath)).toEqual({ wal: false, shm: false })

        // Live database still fully usable after the sweep.
        expect(live.getMeta('probe')).toBe('value')
      } finally {
        live.close()
      }

      // After the last close, the live file's sidecars are gone too — the
      // end state of a full shutdown is zero sidecars anywhere.
      expect(sidecarsExist(livePath)).toEqual({ wal: false, shm: false })
      // Crash-recovered data survived the sweep.
      const reopened = AdfDatabase.open(crashedPath)
      try {
        expect(reopened.getMeta('in-wal')).toBe('wal-only')
      } finally {
        reopened.close()
      }
    })
  })

  describe('readonly peeks leave no sidecars behind', () => {
    it('peekAgentMeta on a cleanly-closed file creates no lasting sidecars', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-peek-clean-'))
      dirs.push(dir)
      const adfPath = join(dir, 'peek.adf')
      AdfDatabase.create(adfPath, { name: 'peek' }).close()
      expect(sidecarsExist(adfPath)).toEqual({ wal: false, shm: false })

      const meta = AdfDatabase.peekAgentMeta(adfPath)
      expect(meta).not.toBeNull()
      // Empirically a readonly open CREATES -wal/-shm on a WAL database and
      // cannot remove them at close; the peek helper must reap them.
      expect(sidecarsExist(adfPath)).toEqual({ wal: false, shm: false })
    })

    it('peekBootStatusDetailed on a cleanly-closed file creates no lasting sidecars', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-peek-boot-'))
      dirs.push(dir)
      const adfPath = join(dir, 'boot.adf')
      AdfDatabase.create(adfPath, { name: 'boot' }).close()

      const result = AdfDatabase.peekBootStatusDetailed(adfPath)
      expect(result.status).not.toBeNull()
      expect(sidecarsExist(adfPath)).toEqual({ wal: false, shm: false })
    })

    it('peeking a file held open elsewhere leaves its live sidecars untouched', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-peek-live-'))
      dirs.push(dir)
      const adfPath = join(dir, 'held.adf')
      const holder = AdfDatabase.create(adfPath, { name: 'held' })
      try {
        holder.setMeta('probe', 'value', 'none')
        expect(sidecarsExist(adfPath).wal).toBe(true)

        const meta = AdfDatabase.peekAgentMeta(adfPath)
        expect(meta).not.toBeNull()
        expect(sidecarsExist(adfPath)).toEqual({ wal: true, shm: true })
        expect(holder.getMeta('probe')).toBe('value')
      } finally {
        holder.close()
      }
    })
  })
})
