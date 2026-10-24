// CVE-2026-111497: every place ADF decodes Brotli it did not produce asks the
// runtime guard first, and refuses before decoding on a vulnerable runtime.
// The verdict is mocked here (a real vulnerable runtime cannot be faked from
// inside a fixed one); the real decision is brotli-runtime-guard.test.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const guard = vi.hoisted(() => ({ safe: true, asked: 0 }))
vi.mock('../../src/main/utils/brotli-runtime-guard', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/utils/brotli-runtime-guard')>()
  const verdict = () => {
    guard.asked++
    return guard.safe
      ? { safe: true as const, runtime: 'Node.js 24.22.1' }
      : { safe: false as const, runtime: 'Node.js 24.18.0', reason: 'it is vulnerable to CVE-2026-111497', remedy: 'Install Node.js 24.22.1+.' }
  }
  return {
    ...real,
    brotliRuntimeVerdict: verdict,
    assertSafeBrotliRuntime: () => {
      const v = verdict()
      if (!v.safe) throw new real.UnsafeBrotliRuntimeError(real.refusalMessage(v))
    },
  }
})

// The DNS answer for the test host name (the pinned fetch checks every address).
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = (async (host: string, opts?: unknown) => {
    if (host !== 'brotli.adf-test.invalid') return real.lookup(host, opts as never)
    return (opts as { all?: boolean } | undefined)?.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 }
  }) as typeof real.lookup
  return { ...real, lookup, default: { ...real, lookup } }
})

import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { AdfDatabase } from '../../src/main/adf/adf-database'
import { SandboxHost } from '../../src/main/runtime/sandbox-host'
import { pinnedFetch } from '../../src/main/utils/guarded-fetch'

const REFUSAL = /ADF refuses to run on Node\.js 24\.18\.0: it is vulnerable to CVE-2026-111497/

let rootDir: string
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-brotli-sites-'))
  guard.safe = true
  guard.asked = 0
})
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('guarded fetch (Content-Encoding: br)', () => {
  let server: Server | null = null
  let hits = 0
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = null
  })
  async function brServer(): Promise<string> {
    hits = 0
    server = createServer((_req, res) => {
      hits++
      // Sent whatever the client advertised: a server chooses the encoding.
      res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'text/plain' })
      res.end(brotliCompressSync('decoded from br'))
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()))
    return `http://brotli.adf-test.invalid:${(server!.address() as { port: number }).port}/`
  }

  it('decodes a valid br response on a fixed runtime', async () => {
    const url = await brServer()
    const res = await pinnedFetch({ daemonPort: 1 })(url)
    expect(await res.text()).toBe('decoded from br')
    expect(guard.asked).toBeGreaterThan(0)
  })

  it('refuses before the request is sent on a vulnerable runtime (not just by dropping br from accept-encoding)', async () => {
    const url = await brServer()
    guard.safe = false
    await expect(pinnedFetch({ daemonPort: 1 })(url)).rejects.toThrow(REFUSAL)
    expect(hits).toBe(0)
  })
})

describe('adf_audit blobs', () => {
  it('readAudit decodes on a fixed runtime and refuses on a vulnerable one', () => {
    const ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'brotli-sites' })
    try {
      const rows = [{ seq: 1, role: 'user', content_json: [{ type: 'text', text: 'hi' }] }]
      const id = ws.getDatabase().insertAudit('loop', { startSeq: 1, endSeq: 1, entryCount: 1, sizeBytes: 10, data: brotliCompressSync(Buffer.from(JSON.stringify(rows))) })
      expect(ws.readAudit(id)).toEqual(rows)
      guard.safe = false
      expect(() => ws.readAudit(id)).toThrow(REFUSAL)
    } finally {
      ws.close()
    }
  })

  it('the v28 migration refuses to backfill from blobs on a vulnerable runtime instead of skipping them as corrupt', () => {
    const adfPath = join(rootDir, 'imported.adf')
    AdfDatabase.create(adfPath, { name: 'imported' }).close()
    const raw = new Database(adfPath)
    raw.exec(`
      DROP TABLE adf_audit;
      CREATE TABLE adf_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
        entry_count INTEGER NOT NULL, size_bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
      DROP INDEX IF EXISTS idx_adf_loop_stream;
      ALTER TABLE adf_loop DROP COLUMN ord;
    `)
    raw.prepare('INSERT INTO adf_audit (source, start_at, end_at, entry_count, size_bytes, data, created_at) VALUES (?, 0, 0, 1, 1, ?, 0)')
      .run('loop', brotliCompressSync(Buffer.from(JSON.stringify([{ seq: 3 }]))))
    raw.prepare("UPDATE adf_meta SET value = '27' WHERE key = 'adf_schema_version'").run()
    raw.close()

    guard.safe = false
    expect(() => AdfDatabase.open(adfPath)).toThrow(REFUSAL)
    // Nothing was migrated: the file is still v27 and opens once the runtime is fixed.
    const check = new Database(adfPath, { readonly: true })
    expect((check.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string }).value).toBe('27')
    check.close()
    guard.safe = true
    const db = AdfDatabase.open(adfPath)
    try {
      const row = (db as unknown as { db: InstanceType<typeof Database> }).db.prepare('SELECT start_seq, end_seq FROM adf_audit').get()
      expect(row).toEqual({ start_seq: 3, end_seq: 3 })
    } finally {
      db.close()
    }
  })
})

describe('code sandbox host (sandbox code can call zlib)', () => {
  it('does not start on a vulnerable runtime', () => {
    guard.safe = false
    const host = new SandboxHost([])
    expect(() => host.spawnWorker()).toThrow(REFUSAL)
    expect(host.alive).toBe(false)
  })
})
