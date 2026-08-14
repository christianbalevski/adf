import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

let rootDir: string
let ws: AdfWorkspace

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-seq-stability-'))
  ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'seq-stability' })
  const config = ws.getAgentConfig()
  config.context.audit = { loop: true, inbox: false, outbox: false }
  ws.setAgentConfig(config)
})

afterEach(() => {
  ws.close()
  rmSync(rootDir, { recursive: true, force: true })
})

function text(t: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: t }]
}

describe('seq stability (seq = identity, ord = position)', () => {
  it('replaceLoop preserves explicit seqs, leaves gaps for dropped rows, and AUTOINCREMENT continues above max', async () => {
    const s1 = ws.appendToLoop('user', text('one'))
    const s2 = ws.appendToLoop('assistant', text('two'))
    const s3 = ws.appendToLoop('user', text('three'))

    // Rebuild history, dropping the middle row (image-strip-style rebuild).
    const kept = ws.getLoop().filter(e => e.seq !== s2)
    await ws.replaceLoop(kept.map(e => ({
      role: e.role, content: e.content_json, model: e.model, tokens: e.tokens,
      created_at: e.created_at, seq: e.seq, ord: e.ord
    })))

    const after = ws.getLoop()
    expect(after.map(e => e.seq)).toEqual([s1, s3])
    expect(after.map(e => e.content_json[0].text)).toEqual(['one', 'three'])

    // A new append must not reuse the dropped seq (no future collisions).
    const s4 = ws.appendToLoop('user', text('four'))
    expect(s4).toBeGreaterThan(s3)
  })

  it('compactLoop keeps tail rows physically in place and sorts the summary first via ord', async () => {
    const s1 = ws.appendToLoop('user', text('old-1'), undefined, undefined, 100)
    const s2 = ws.appendToLoop('assistant', text('old-2'), 'model-a', { input: 10, output: 5 }, 200)
    const s3 = ws.appendToLoop('assistant', text('keep-1'), 'model-b', { input: 20, output: 9 }, 300)
    const s4 = ws.appendToLoop('user', text('keep-2'), undefined, undefined, 400)

    await ws.compactLoop([s3, s4], { content: text('[Loop Compacted] summary'), model: 'compactor', tokens: { input: 1, output: 2 } })

    const after = ws.getLoop()
    expect(after).toHaveLength(3)
    // Summary sorts first through its ord override...
    expect(after[0].content_json[0].text).toBe('[Loop Compacted] summary')
    expect(after[0].ord).toBe(s3 - 1)
    expect(after[0].model).toBe('compactor')
    // ...while its seq is a fresh AUTOINCREMENT value above the tail.
    expect(after[0].seq).toBeGreaterThan(s4)
    // Tail rows keep seq, content, model and token metadata untouched.
    expect(after[1]).toMatchObject({ seq: s3, model: 'model-b', created_at: 300 })
    expect(after[1].tokens).toEqual({ input: 20, output: 9 })
    expect(after[2]).toMatchObject({ seq: s4, created_at: 400 })

    // Audit blob is disjoint from the surviving rows and carries the seq range.
    const audits = ws.listAudits().filter(a => a.source === 'loop')
    expect(audits).toHaveLength(1)
    expect(audits[0].start_seq).toBe(s1)
    expect(audits[0].end_seq).toBe(s2)
    expect(audits[0].entry_count).toBe(2)
    const archived = ws.readAudit(audits[0].id) as Array<{ seq: number }>
    expect(archived.map(e => e.seq)).toEqual([s1, s2])

    // Appends continue above everything (including the summary's seq).
    const s5 = ws.appendToLoop('user', text('next'))
    expect(s5).toBeGreaterThan(after[0].seq)
    expect(ws.getLoop().map(e => e.content_json[0].text))
      .toEqual(['[Loop Compacted] summary', 'keep-1', 'keep-2', 'next'])
  })

  it('compactLoop with no preserved tail leaves the summary ord NULL', async () => {
    ws.appendToLoop('user', text('a'))
    ws.appendToLoop('assistant', text('b'))

    await ws.compactLoop([], { content: text('[Loop Compacted] all gone') })

    const after = ws.getLoop()
    expect(after).toHaveLength(1)
    expect(after[0].content_json[0].text).toBe('[Loop Compacted] all gone')
    expect(after[0].ord).toBeUndefined()
  })

  it('clearLoopSlice resolves positions against the ordering key, so an ord\'d summary is sliceable at position 0', async () => {
    const s1 = ws.appendToLoop('user', text('old'))
    const s2 = ws.appendToLoop('assistant', text('keep-1'))
    const s3 = ws.appendToLoop('user', text('keep-2'))
    await ws.compactLoop([s2, s3], { content: text('summary') })
    expect(ws.getLoop().map(e => e.content_json[0].text)).toEqual(['summary', 'keep-1', 'keep-2'])
    expect(s1).toBeLessThan(s2)

    // Slice position 0 must remove the summary (display-first row), not the
    // row with the smallest raw seq.
    const result = await ws.clearLoopSlice(0, 1)
    expect(result.deleted).toBe(1)
    expect(ws.getLoop().map(e => e.seq)).toEqual([s2, s3])

    // The slice audit carries the summary's actual seq.
    const audits = ws.listAudits().filter(a => a.source === 'loop')
    const sliceAudit = audits[0]
    expect(sliceAudit.entry_count).toBe(1)
    expect(sliceAudit.start_seq).toBe(sliceAudit.end_seq)
    expect(sliceAudit.start_seq).toBeGreaterThan(s3)
  })

  it('getLoopBefore keyset pagination follows the ordering key', async () => {
    const s1 = ws.appendToLoop('user', text('old'))
    const s2 = ws.appendToLoop('assistant', text('keep-1'))
    const s3 = ws.appendToLoop('user', text('keep-2'))
    await ws.compactLoop([s2, s3], { content: text('summary') })
    expect(s1).toBeGreaterThan(0)

    // Entries ordering-before the first preserved row: exactly the summary.
    const before = ws.getLoopBefore(s2, 10)
    expect(before).toHaveLength(1)
    expect(before[0].content_json[0].text).toBe('summary')
    expect(ws.getLoopCountBefore(s2)).toBe(1)
  })

  // Regressions from the adversarial review.

  it('audit seq ranges stay min/max even when an ord\'d summary inverts display order', async () => {
    const s1 = ws.appendToLoop('user', text('old'))
    const s2 = ws.appendToLoop('assistant', text('keep-1'))
    const s3 = ws.appendToLoop('user', text('keep-2'))
    await ws.compactLoop([s2, s3], { content: text('summary-1') })
    const summarySeq = ws.getLoop()[0].seq
    expect(s1).toBeLessThan(s2)

    // Second compaction archives [summary-1(seq=high, display-first), keep-1,
    // keep-2] — the naive first/last-element range would be inverted.
    const s5 = ws.appendToLoop('assistant', text('keep-3'))
    const s6 = ws.appendToLoop('user', text('keep-4'))
    await ws.compactLoop([s5, s6], { content: text('summary-2') })

    const audits = ws.listAudits().filter(a => a.source === 'loop')
    expect(audits).toHaveLength(2)
    for (const a of audits) {
      expect(a.start_seq).not.toBeNull()
      expect(a.start_seq!).toBeLessThanOrEqual(a.end_seq!)
    }
    const second = audits.find(a => a.entry_count === 3)!
    // Range covers both the tail seqs and the archived summary's high seq.
    expect(second.start_seq).toBe(s2)
    expect(second.end_seq).toBe(summarySeq)

    // clearLoop after a compaction gets the same treatment.
    await ws.clearLoop()
    const all = ws.listAudits().filter(a => a.source === 'loop')
    for (const a of all) expect(a.start_seq!).toBeLessThanOrEqual(a.end_seq!)
  })

  it('keyset paging with the summary itself as cursor returns nothing before it', async () => {
    const s1 = ws.appendToLoop('user', text('old'))
    const s2 = ws.appendToLoop('assistant', text('keep-1'))
    const s3 = ws.appendToLoop('user', text('keep-2'))
    await ws.compactLoop([s2, s3], { content: text('summary') })
    expect(s1).toBeLessThan(s2)
    const summarySeq = ws.getLoop()[0].seq

    // The summary is display-first: a raw-seq comparison against ordering
    // keys would claim 2 earlier rows and re-serve the whole visible page.
    expect(ws.getLoopCountBefore(summarySeq)).toBe(0)
    expect(ws.getLoopBefore(summarySeq, 10)).toHaveLength(0)
    // Tail cursors still see exactly the rows displayed above them,
    // in ascending display order (summary's key sorts first).
    expect(ws.getLoopCountBefore(s3)).toBe(2)
    expect(ws.getLoopBefore(s3, 10).map(e => e.seq)).toEqual([summarySeq, s2])
  })

  it('summary ord derives from preserved ordering keys, so preserving a prior summary cannot collide', async () => {
    const s1 = ws.appendToLoop('user', text('old'))
    const s2 = ws.appendToLoop('assistant', text('keep-1'))
    await ws.compactLoop([s2], { content: text('summary-1') })
    const summary1 = ws.getLoop()[0]
    expect(summary1.ord).toBe(s2 - 1)
    expect(s1).toBeLessThan(s2)

    // Degenerate but public-API-reachable: preserve the prior summary itself.
    await ws.compactLoop([summary1.seq, s2], { content: text('summary-2') })
    const after = ws.getLoop()
    const keys = after.map(e => e.ord ?? e.seq)
    // All ordering keys unique, new summary sorts first.
    expect(new Set(keys).size).toBe(keys.length)
    expect(after[0].content_json[0].text).toBe('summary-2')
    expect(after[0].ord).toBe((summary1.ord ?? summary1.seq) - 1)
  })

  it('compactLoop throws when preserved seqs are missing instead of silently dropping the tail', async () => {
    const s1 = ws.appendToLoop('user', text('one'))
    await ws.clearLoop()
    await expect(ws.compactLoop([s1], { content: text('summary') })).rejects.toThrow(/preserved seq/)
    // Loop untouched by the failed compaction (transaction rolled back).
    expect(ws.getLoop()).toHaveLength(0)
  })
})
