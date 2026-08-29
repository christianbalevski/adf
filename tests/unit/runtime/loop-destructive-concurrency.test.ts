import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'fs'
import Database from 'better-sqlite3'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { AdfDatabase } from '../../../src/main/adf/adf-database'

let rootDir: string
let filePath: string
let ws: AdfWorkspace

/** The workspace's AdfDatabase — the revision counter and the raw loop
 *  primitives live there, and the concurrency tests need to observe them. */
function rawDb(workspace: AdfWorkspace): AdfDatabase {
  return (workspace as unknown as { db: AdfDatabase }).db
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-loop-concurrency-'))
  filePath = join(rootDir, 'agent.adf')
  ws = AdfWorkspace.create(filePath, { name: 'loop-concurrency' })
  const config = ws.getAgentConfig()
  config.context.audit = { loop: true, inbox: false, outbox: false }
  ws.setAgentConfig(config)
})

afterEach(() => {
  vi.restoreAllMocks()
  ws.close()
  rmSync(rootDir, { recursive: true, force: true })
})

function text(t: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: t }]
}

/** Every adf_loop primitive is per-stream now; the membrane-facing stream is 'main'. */
const MAIN = 'main'

describe('adf_loop revision counter', () => {
  it('bumps on every loop mutation primitive', () => {
    const db = rawDb(ws)

    const afterAppend = (() => {
      const before = db.getLoopRevision(MAIN)
      ws.appendToLoop('user', text('one'))
      return { before, after: db.getLoopRevision(MAIN) }
    })()
    expect(afterAppend.after).toBeGreaterThan(afterAppend.before)

    const s2 = ws.appendToLoop('assistant', text('two'))
    const s3 = ws.appendToLoop('user', text('three'))

    const beforeRangeDelete = db.getLoopRevision(MAIN)
    db.deleteLoopBySeqRange(MAIN, s3, s3)
    expect(db.getLoopRevision(MAIN)).toBeGreaterThan(beforeRangeDelete)

    const beforeSeqDelete = db.getLoopRevision(MAIN)
    db.deleteLoopBySeqs(MAIN, [s2])
    expect(db.getLoopRevision(MAIN)).toBeGreaterThan(beforeSeqDelete)

    const beforeClear = db.getLoopRevision(MAIN)
    db.clearLoop(MAIN)
    expect(db.getLoopRevision(MAIN)).toBeGreaterThan(beforeClear)
  })

  it('scopes bumps to the mutated stream, and bumps the epoch only on cross-loop wipes', () => {
    const db = rawDb(ws)
    ws.appendToLoop('user', text('main-one'))

    // A side stream's append leaves main's counter (and the epoch) alone.
    const mainBefore = db.getLoopRevision(MAIN)
    const epochBefore = db.getLoopEpoch()
    db.appendLoopEntry('side', 'user', text('side-one'))
    expect(db.getLoopRevision(MAIN)).toBe(mainBefore)
    expect(db.getLoopRevision('side')).toBeGreaterThan(0)
    expect(db.getLoopEpoch()).toBe(epochBefore)

    // Per-stream reads are isolated too.
    expect(db.getLoopCount(MAIN)).toBe(1)
    expect(db.getLoopCount('side')).toBe(1)

    // clearAllLoops is cross-loop: it must move the epoch, which is the half of
    // the guard pair a stream with an untouched counter relies on.
    db.clearAllLoops()
    expect(db.getLoopEpoch()).toBeGreaterThan(epochBefore)
    expect(db.getLoopCount(MAIN)).toBe(0)
    expect(db.getLoopCount('side')).toBe(0)
  })

  it('sees a replaceLoop that reuses identical seqs with different content', async () => {
    const s1 = ws.appendToLoop('user', text('one'))
    const s2 = ws.appendToLoop('assistant', text('two'))
    const db = rawDb(ws)

    // Same row count, same max seq — the old rowCount:maxSeq fingerprint could
    // not distinguish this from "nothing happened" (the tool-mismatch repair
    // path rewrites content in place).
    const before = db.getLoopRevision(MAIN)
    await ws.replaceLoop([
      { role: 'user', content: text('one-repaired'), seq: s1 },
      { role: 'assistant', content: text('two-repaired'), seq: s2 }
    ])
    expect(db.getLoopRevision(MAIN)).toBeGreaterThan(before)
    expect(ws.getLoop().map(e => e.content_json[0].text)).toEqual(['one-repaired', 'two-repaired'])
  })

  it('is not bumped by loop reads', () => {
    ws.appendToLoop('user', text('one'))
    const db = rawDb(ws)
    const before = db.getLoopRevision(MAIN)
    ws.getLoop()
    ws.getLoopCount()
    db.getLoopSeqs(MAIN)
    expect(db.getLoopRevision(MAIN)).toBe(before)
  })
})

describe('destructive loop op mutex', () => {
  it('serializes two overlapping ops end to end (no interleaved read/commit)', async () => {
    ws.appendToLoop('user', text('one'))
    ws.appendToLoop('assistant', text('two'))

    const db = rawDb(ws)
    const events: string[] = []
    const readEntries = db.getLoopEntries.bind(db)
    const clear = db.clearLoop.bind(db)
    vi.spyOn(db, 'getLoopEntries').mockImplementation((...args: Parameters<AdfDatabase['getLoopEntries']>) => {
      events.push('read')
      return readEntries(...args)
    })
    vi.spyOn(db, 'clearLoop').mockImplementation((...args: Parameters<AdfDatabase['clearLoop']>) => {
      events.push('commit')
      clear(...args)
    })

    // Fire both without awaiting the first: unserialized, both would read
    // before either committed (['read', 'read', 'commit', 'commit']).
    await Promise.all([ws.clearLoop(), ws.clearLoop()])

    expect(events).toEqual(['read', 'commit', 'read', 'commit'])
    expect(ws.getLoop()).toHaveLength(0)
  })

  it('keeps a compaction that overlaps a clear from silently dropping the preserved tail', async () => {
    ws.appendToLoop('user', text('old-1'))
    const keep = ws.appendToLoop('assistant', text('keep-1'))

    // compactLoop rejects (throws) when its preserved seqs are gone; it must
    // never report success after a concurrent clear removed them.
    const compaction = ws.compactLoop([keep], { content: text('[Loop Compacted] summary') })
    const cleared = ws.clearLoop()

    const results = await Promise.allSettled([compaction, cleared])
    expect(results[1].status).toBe('fulfilled')
    if (results[0].status === 'fulfilled') {
      // Compaction won the mutex and ran to completion BEFORE the clear: it
      // archived only the non-preserved row, and the clear that followed found
      // the preserved tail still in place (audits are in creation order).
      const audits = ws.listAudits().filter(a => a.source === 'loop:main').reverse()
      expect(audits).toHaveLength(2)
      expect(ws.readAudit(audits[0].id)).toHaveLength(1)
      const clearedRows = ws.readAudit(audits[1].id) as Array<{ content_json: Array<{ text: string }> }>
      expect(clearedRows.map(e => e.content_json[0].text)).toContain('keep-1')
    } else {
      // Clear won: compaction refuses rather than committing a summary over a
      // tail that no longer exists (the caller falls back to the legacy path).
      expect(String(results[0].reason)).toContain('preserved seq')
    }
  })
})

describe('archive retry cap', () => {
  it('falls back to compressing inside the transaction instead of spinning forever', async () => {
    ws.appendToLoop('user', text('one'))
    ws.appendToLoop('assistant', text('two'))
    ws.appendToLoop('user', text('three'))

    const db = rawDb(ws)
    // Simulate an agent appending on every compression window: the revision
    // never matches, so the off-transaction fast path can never converge.
    let revision = 10_000
    vi.spyOn(db, 'getLoopRevision').mockImplementation(() => revision++)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await ws.clearLoop()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive attempts'))
    expect(ws.getLoop()).toHaveLength(0)

    // The blocking fallback must still produce a correct audit blob.
    const audits = ws.listAudits().filter(a => a.source === 'loop:main')
    expect(audits).toHaveLength(1)
    expect(audits[0].entry_count).toBe(3)
    expect(ws.readAudit(audits[0].id)).toHaveLength(3)
  })
})

describe('pre-destructive backup', () => {
  it('produces a consistent, openable database (online backup, not a file copy)', async () => {
    ws.appendToLoop('user', text('one'))
    ws.appendToLoop('assistant', text('two'))

    const backupPath = await rawDb(ws).backupBeforeDestructive()
    expect(existsSync(backupPath)).toBe(true)

    const copy = new Database(backupPath, { readonly: true, fileMustExist: true })
    try {
      expect((copy.pragma('integrity_check') as Array<{ integrity_check: string }>)[0].integrity_check).toBe('ok')
      // WAL content is included — a bare file copy could miss uncheckpointed frames.
      expect((copy.prepare('SELECT COUNT(*) AS c FROM adf_loop').get() as { c: number }).c).toBe(2)
    } finally {
      copy.close()
    }
  })

  it('preserves a stale .bak from a failed op instead of overwriting it', async () => {
    ws.appendToLoop('user', text('one'))
    // A .bak left on disk means a previous destructive op failed — it is the
    // user's only recovery copy and must not be clobbered.
    writeFileSync(`${filePath}.bak`, 'previous-failed-op-backup')

    await ws.clearLoop()

    // The successful op removed its own backup...
    expect(existsSync(`${filePath}.bak`)).toBe(false)
    // ...and the stale one survives under a timestamped name.
    const preserved = readdirSync(rootDir).filter(f => /^agent\.adf\.bak\.\d+$/.test(f))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(rootDir, preserved[0]), 'utf-8')).toBe('previous-failed-op-backup')
  })
})
