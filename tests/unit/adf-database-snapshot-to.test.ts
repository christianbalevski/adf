import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { spawn, type ChildProcess } from 'child_process'
import BetterSqlite3 from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

/**
 * `snapshotTo` is what stands between "share this agent" and a torn file:
 * the .adf is a live WAL database that its own agent may be writing while
 * the user drags it out. A plain fs.copyFile would capture the main file
 * without the WAL pages that complete it. This suite copies WHILE a real
 * second process writes in a loop and checks the result is a database, not
 * a photograph of one halfway through a transaction.
 *
 * Needs the node-ABI build of better-sqlite3 (`npm test` rebuilds it).
 */
const sidecars = (path: string): { wal: boolean; shm: boolean } => ({
  wal: existsSync(`${path}-wal`),
  shm: existsSync(`${path}-shm`),
})

/** A child process hammering `adf_meta` on `adfPath` until it is killed. */
function spawnWriter(adfPath: string): Promise<ChildProcess> {
  const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3')
  const script = [
    'const Database = require(process.argv[1])',
    'const db = new Database(process.argv[2])',
    "db.pragma('journal_mode = WAL')",
    "db.pragma('busy_timeout = 5000')",
    "const put = db.prepare(\"INSERT INTO adf_meta (key, value, protection) VALUES (?, ?, 'none') ON CONFLICT(key) DO UPDATE SET value = excluded.value\")",
    'let n = 0',
    'process.send("ready")',
    'setInterval(() => { for (let i = 0; i < 50; i++) put.run("churn-" + (n % 200), String(n++)) }, 1)',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script, sqlitePath, adfPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  return new Promise<ChildProcess>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('writer never reported ready')), 15_000)
    child.on('message', (m) => { if (m === 'ready') { clearTimeout(timer); resolve(child) } })
    child.on('exit', (code) => reject(new Error(`writer exited early: ${code}`)))
    child.on('error', reject)
  })
}

async function stop(child: ChildProcess): Promise<void> {
  child.removeAllListeners('exit')
  child.kill()
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve())
    setTimeout(resolve, 3_000)
  })
}

describe('AdfDatabase.snapshotTo', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('copies a consistent database out from under a live writer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-snapshot-'))
    dirs.push(dir)
    const source = join(dir, 'busy.adf')
    const dest = join(dir, 'copy.adf')

    const db = AdfDatabase.create(source, { name: 'busy' })
    db.setMeta('marker', 'present', 'none')
    // Hold the source open, as Studio does for a running agent: the copy has
    // to be taken from a file with live sidecars it does not own.
    const writer = await spawnWriter(source)
    let before = sidecars(source)
    try {
      // Let the writer get a WAL going, then copy mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 100))
      before = sidecars(source)
      expect(before).toEqual({ wal: true, shm: true })
      await AdfDatabase.snapshotTo(source, dest)
      // The live sidecars are untouched — reaping them would pull the WAL out
      // from under two open connections.
      expect(sidecars(source)).toEqual(before)
    } finally {
      await stop(writer)
      db.close()
    }

    expect(existsSync(dest)).toBe(true)
    const copy = new BetterSqlite3(dest, { readonly: true })
    try {
      const check = copy.pragma('integrity_check') as Array<{ integrity_check: string }>
      expect(check[0]?.integrity_check).toBe('ok')
      expect(copy.prepare("SELECT value FROM adf_meta WHERE key = 'marker'").get()).toEqual({ value: 'present' })
    } finally {
      copy.close()
    }
    // A snapshot is self-contained: no sidecars beside the copy.
    expect(sidecars(dest)).toEqual({ wal: false, shm: false })
    expect(existsSync(source)).toBe(true)
  }, 30_000)

  it('leaves no sidecars on a cleanly-closed source it had to open itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-snapshot-clean-'))
    dirs.push(dir)
    const source = join(dir, 'idle.adf')
    const dest = join(dir, 'idle-copy.adf')
    AdfDatabase.create(source, { name: 'idle' }).close()
    expect(sidecars(source)).toEqual({ wal: false, shm: false })

    await AdfDatabase.snapshotTo(source, dest)

    expect(sidecars(source)).toEqual({ wal: false, shm: false })
    expect(sidecars(dest)).toEqual({ wal: false, shm: false })
  })
})

describe('AdfDatabase.snapshotForSend', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Seed an agent with everything that must NOT travel: keys, attestations, DIDs. */
  function seedIdentity(adfPath: string): void {
    const db = AdfDatabase.create(adfPath, { name: 'sender' })
    try {
      db.setIdentity('crypto:signing:private_key', 'PRIVATE-KEY-MATERIAL')
      db.setIdentity('crypto:signing:public_key', 'PUBLIC-KEY-MATERIAL')
      db.setIdentity('crypto:envelope:identity', JSON.stringify({ slots: [{ type: 'owner' }] }))
      db.setMeta('adf_did', 'did:key:zSender', 'none')
      db.setMeta('adf_owner_did', 'did:key:zOwner', 'none')
      db.setMeta('adf_runtime_did', 'did:key:zRuntime', 'none')
      db.setMeta('keepsake', 'stays', 'none')
    } finally {
      db.close()
    }
    const raw = new BetterSqlite3(adfPath)
    try {
      raw.prepare(
        'INSERT INTO adf_attestations (issuer, subject, role, issued_at, signature, raw_json) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('did:key:zOwner', 'did:key:zSender', 'owner', '2026-09-17T00:00:00Z', 'sig', '{}')
    } finally {
      raw.close()
    }
  }

  it('sends the agent, not its identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-snapshot-send-'))
    dirs.push(dir)
    const source = join(dir, 'sender.adf')
    const dest = join(dir, 'sent.adf')
    seedIdentity(source)

    await AdfDatabase.snapshotForSend(source, dest)

    const copy = new BetterSqlite3(dest, { readonly: true })
    try {
      const crypto = copy
        .prepare("SELECT COUNT(*) AS n FROM adf_identity WHERE purpose LIKE 'crypto:%'")
        .get() as { n: number }
      expect(crypto.n).toBe(0)
      const attestations = copy.prepare('SELECT COUNT(*) AS n FROM adf_attestations').get() as { n: number }
      expect(attestations.n).toBe(0)
      const dids = copy
        .prepare("SELECT COUNT(*) AS n FROM adf_meta WHERE key IN ('adf_did', 'adf_owner_did', 'adf_runtime_did')")
        .get() as { n: number }
      expect(dids.n).toBe(0)
      // Everything that is not identity still travels.
      expect(copy.prepare("SELECT value FROM adf_meta WHERE key = 'keepsake'").get()).toEqual({ value: 'stays' })
      const check = copy.pragma('integrity_check') as Array<{ integrity_check: string }>
      expect(check[0]?.integrity_check).toBe('ok')
    } finally {
      copy.close()
    }
    expect(sidecars(dest)).toEqual({ wal: false, shm: false })
    // The source keeps its identity: sending is a copy, never a move.
    const original = AdfDatabase.open(source)
    try {
      expect(original.getIdentity('crypto:signing:private_key')).toBe('PRIVATE-KEY-MATERIAL')
      expect(original.getMeta('adf_did')).toBe('did:key:zSender')
    } finally {
      original.close()
    }
  })
})
