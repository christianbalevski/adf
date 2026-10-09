/**
 * agent-daily.ts: the Activity chart from the .adf file alone. Per-row cost
 * (recorded cost_usd, legacy table pricing, unpriced rows), the incremental
 * live scan (new rows, deleted rows), compacted history spread from
 * adf_audit metadata (anchors, multiple loops, missing anchors, superseded
 * snapshots), and that no query ever selects adf_audit.data.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import {
  ARCHIVE_SPREAD_MAX_MS,
  LOOP_COST_RECORDED_SINCE_MS,
  buildDailyActivity,
  firstSeqSince,
  readArchiveSpans,
  readDailyActivity,
  recentCost,
  refreshLoopDayScan,
  rowCost
} from '../../../src/main/services/agent-daily'
import { estimateTokenCostUsd } from '../../../src/main/runtime/llm-pricing'
import { windowStartMs } from '../../../src/shared/utils/agent-activity'
import { localDateKey } from '../../../src/shared/utils/date-key'

const dir = mkdtempSync(join(tmpdir(), 'adf-agent-daily-'))
const opened: AdfWorkspace[] = []
afterAll(() => {
  for (const w of opened) try { w.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Local noon, so no fixture time lands near a day boundary. */
const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime()
/** Local `h`:00 on the day `daysAgo` before NOW's. */
const at = (daysAgo: number, h: number): number => new Date(2026, 9, 9 - daysAgo, h, 0, 0).getTime()
const key = (daysAgo: number): string => localDateKey(new Date(at(daysAgo, 12)))
const MODEL = 'claude-sonnet-4-5-20250929'

let n = 0
function agent(): { ws: AdfWorkspace; q: (s: string, p?: unknown[]) => unknown[]; sqls: string[] } {
  const ws = AdfWorkspace.create(join(dir, `agent-${++n}.adf`), { name: `agent-${n}` })
  opened.push(ws)
  ws.executeSQL('DELETE FROM adf_loop')
  ws.executeSQL('DELETE FROM adf_audit')
  const sqls: string[] = []
  return { ws, sqls, q: (s, p) => { sqls.push(s); return ws.querySQL(s, p) } }
}

function row(ws: AdfWorkspace, o: { seq?: number; t: number; role?: string; loop?: string; model?: string | null; tokens?: unknown }): void {
  ws.executeSQL('INSERT INTO adf_loop (seq, role, content_json, model, tokens, created_at, loop) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    o.seq ?? null,
    o.role ?? 'assistant',
    JSON.stringify([{ type: 'text', text: 'x' }]),
    o.model ?? null,
    o.tokens === undefined ? null : typeof o.tokens === 'string' ? o.tokens : JSON.stringify(o.tokens),
    o.t,
    o.loop ?? 'main'
  ])
}

function archive(ws: AdfWorkspace, o: { loop?: string; source?: string; start: number | null; end: number | null; count: number; t: number }): void {
  ws.executeSQL("INSERT INTO adf_audit (source, start_seq, end_seq, entry_count, size_bytes, data, created_at) VALUES (?, ?, ?, ?, 1, x'00', ?)", [
    o.source ?? `loop:${o.loop ?? 'main'}`,
    o.start,
    o.end,
    o.count,
    o.t
  ])
}

const byDate = (daily: Array<{ date: string }>): Record<string, Record<string, unknown>> =>
  Object.fromEntries(daily.map((d) => [d.date, d]))

describe('rowCost', () => {
  const after = LOOP_COST_RECORDED_SINCE_MS + DAY
  const before = LOOP_COST_RECORDED_SINCE_MS - DAY

  it('uses a recorded cost_usd', () => {
    expect(rowCost(MODEL, JSON.stringify({ input: 10, output: 5, cost_usd: 0.25 }), after)).toEqual({ kind: 'priced', usd: 0.25 })
    expect(rowCost(null, JSON.stringify({ cost_usd: 0 }), after)).toEqual({ kind: 'priced', usd: 0 })
  })

  it('prices records from before cost_usd with the pricing table', () => {
    const tokens = { input: 12_000, output: 800, cache_read: 9_000, cache_write: 1_000 }
    const usd = estimateTokenCostUsd(MODEL, tokens)
    expect(usd).toBeGreaterThan(0)
    expect(rowCost(MODEL, JSON.stringify(tokens), before)).toEqual({ kind: 'priced', usd })
    expect(rowCost('no-such-model', JSON.stringify(tokens), before)).toEqual({ kind: 'unpriced' })
    expect(rowCost(null, JSON.stringify(tokens), before)).toEqual({ kind: 'unpriced' })
  })

  it('leaves a later record without cost_usd unpriced (subscription, estimated usage)', () => {
    expect(rowCost(MODEL, JSON.stringify({ input: 1000, output: 100 }), after)).toEqual({ kind: 'unpriced' })
  })

  it('no record: none; legacy bare integer or garbage: unpriced', () => {
    expect(rowCost(MODEL, null, after)).toEqual({ kind: 'none' })
    expect(rowCost(MODEL, '1234', before)).toEqual({ kind: 'unpriced' })
    expect(rowCost(MODEL, 1234, before)).toEqual({ kind: 'unpriced' })
    expect(rowCost(MODEL, '{oops', before)).toEqual({ kind: 'unpriced' })
  })
})

describe('live rows', () => {
  it('counts every role per local day and sums priced rows; unpriced marks the day partial', () => {
    const { ws, q } = agent()
    row(ws, { t: at(20, 9), tokens: { cost_usd: 9 } }) // before the window
    row(ws, { t: at(3, 9), role: 'user' })
    row(ws, { t: at(3, 10), model: MODEL, tokens: { input: 100, output: 10, cost_usd: 0.1 } })
    row(ws, { t: at(3, 11), role: 'user' }) // a tool result
    row(ws, { t: at(3, 12), model: MODEL, tokens: { input: 100, output: 10, cost_usd: 0.2 } })
    row(ws, { t: at(0, 9), role: 'user' })
    row(ws, { t: at(0, 10), model: 'gpt-5.4', tokens: { input: 100, output: 10 } }) // subscription: no price
    row(ws, { t: at(0, 11), model: MODEL, tokens: { input: 1, output: 1, cost_usd: 0.05 } })
    row(ws, { t: at(1, 11), role: 'user', loop: 'critic' })

    const { daily } = readDailyActivity(q, NOW)
    expect(daily).toHaveLength(14)
    expect(daily[13].date).toBe(key(0))
    const d = byDate(daily)
    expect(d[key(3)]).toEqual({ date: key(3), messages: 4, costUsd: 0.3 })
    expect(d[key(1)]).toEqual({ date: key(1), messages: 1 })
    expect(d[key(0)]).toEqual({ date: key(0), messages: 3, costUsd: 0.05, costPartial: true })
    expect(daily.reduce((s, x) => s + x.messages, 0)).toBe(8)
    expect(recentCost(daily)).toEqual({ usd: 0.35, partial: true })
    expect(recentCost(daily.map((x) => ({ date: x.date, messages: x.messages })))).toBeUndefined()
  })

  it('finds the window start by binary search; rows before it are never read', () => {
    const { ws, q, sqls } = agent()
    for (let i = 0; i < 40; i++) row(ws, { t: at(30 - i, 9), role: 'user' })
    const since = windowStartMs(NOW)
    const start = firstSeqSince(q, since)
    const first = (ws.querySQL('SELECT seq FROM adf_loop WHERE created_at >= ? ORDER BY seq LIMIT 1', [since])[0] as { seq: number }).seq
    expect(start).toBe(first)
    sqls.length = 0
    const { daily, scan } = readDailyActivity(q, NOW)
    expect(Math.min(...scan.rows.keys())).toBe(first)
    expect(daily.reduce((s, x) => s + x.messages, 0)).toBe(14)
  })

  it('is incremental: new rows above the high-water seq, deleted rows dropped, re-inserted rows read again', () => {
    const { ws, q, sqls } = agent()
    row(ws, { t: at(2, 9), role: 'user' })
    row(ws, { t: at(2, 10), tokens: { cost_usd: 1 } })
    row(ws, { t: at(1, 10), tokens: { cost_usd: 2 } })
    const first = readDailyActivity(q, NOW)
    expect(first.scan.rows.size).toBe(3)

    row(ws, { t: at(0, 9), tokens: { cost_usd: 4 } })
    sqls.length = 0
    const second = readDailyActivity(q, NOW, first.scan)
    expect(second.scan).toBe(first.scan)
    expect(byDate(second.daily)[key(0)]).toEqual({ date: key(0), messages: 1, costUsd: 4 })
    // Only the new row's columns were read: the content-walking scan starts above the old high-water seq.
    const scans = sqls.filter((s) => s.includes('created_at AS t, model, tokens'))
    expect(scans).toHaveLength(1)

    // Compaction deletes rows: the count over the scanned range drops them.
    const seq2 = (ws.querySQL('SELECT seq FROM adf_loop ORDER BY seq LIMIT 1 OFFSET 1')[0] as { seq: number }).seq
    ws.executeSQL('DELETE FROM adf_loop WHERE seq = ?', [seq2])
    const third = readDailyActivity(q, NOW, second.scan)
    expect(byDate(third.daily)[key(2)]).toEqual({ date: key(2), messages: 1 })

    // A rebuilt loop re-inserts under the old seq: read again.
    row(ws, { seq: seq2, t: at(2, 10), tokens: { cost_usd: 1.5 } })
    const fourth = readDailyActivity(q, NOW, third.scan)
    expect(byDate(fourth.daily)[key(2)]).toEqual({ date: key(2), messages: 2, costUsd: 1.5 })

    // A new local day starts a new scan.
    const nextDay = readDailyActivity(q, NOW + DAY, fourth.scan)
    expect(nextDay.scan).not.toBe(fourth.scan)
    expect(nextDay.daily[13].date).toBe(localDateKey(new Date(NOW + DAY)))
  })
})

describe('compacted history', () => {
  it('spreads an archive between the live rows around its seq range', () => {
    const { ws, q } = agent()
    row(ws, { seq: 1, t: at(3, 10), role: 'user' })
    archive(ws, { start: 2, end: 5, count: 4, t: at(2, 12) })
    row(ws, { seq: 6, t: at(2, 11) })
    const spans = readArchiveSpans(q, windowStartMs(NOW))
    // End: the first live row after end_seq (11:00) is earlier than the archive (12:00).
    // Start: 24 h before the end beats the live row before start_seq (3 days ago 10:00).
    expect(spans).toEqual([{ loop: 'main', from: at(3, 11), to: at(2, 11), count: 4 }])
    const d = byDate(readDailyActivity(q, NOW).daily)
    // 13 h of the span on day 3 (4 × 13/24 ≈ 2.2), 11 h on day 2 (≈ 1.8): rounded, plus each day's live row.
    expect(d[key(3)]).toEqual({ date: key(3), messages: 3, estimated: true, costPartial: true })
    expect(d[key(2)]).toEqual({ date: key(2), messages: 3, estimated: true, costPartial: true })
  })

  it('uses the previous archive of the same loop as the start, per loop', () => {
    const { ws, q } = agent()
    archive(ws, { loop: 'main', start: 1, end: 10, count: 10, t: at(5, 6) })
    archive(ws, { loop: 'critic', start: 11, end: 12, count: 2, t: at(5, 9) })
    archive(ws, { loop: 'main', start: 13, end: 20, count: 8, t: at(5, 12) })
    archive(ws, { loop: 'critic', start: 21, end: 22, count: 2, t: at(4, 9) })
    const spans = readArchiveSpans(q, windowStartMs(NOW))
    expect(spans).toEqual([
      { loop: 'main', from: at(6, 6), to: at(5, 6), count: 10 },
      { loop: 'critic', from: at(6, 9), to: at(5, 9), count: 2 },
      { loop: 'main', from: at(5, 6), to: at(5, 12), count: 8 },
      { loop: 'critic', from: at(5, 9), to: at(4, 9), count: 2 }
    ])
    const d = byDate(readDailyActivity(q, NOW).daily)
    // main: 10 × 18/24 on day 6, 10 × 6/24 + 8 on day 5; critic: 2 × 15/24 on day 6, 2 × 9/24 + 2 × 15/24 on day 5, 2 × 9/24 on day 4.
    expect(d[key(6)].messages).toBe(Math.round(7.5 + 1.25))
    expect(d[key(5)].messages).toBe(Math.round(2.5 + 8 + 0.75 + 1.25))
    expect(d[key(4)].messages).toBe(1)
    expect(d[key(4)].estimated).toBe(true)
  })

  it('without anchors, spreads over ARCHIVE_SPREAD_MAX_MS before the archive; legacy rows without a seq range too', () => {
    const { ws, q } = agent()
    archive(ws, { start: 1, end: 6, count: 6, t: at(1, 12) })
    archive(ws, { source: 'loop', start: null, end: null, count: 3, t: at(0, 6) })
    expect(readArchiveSpans(q, windowStartMs(NOW))).toEqual([
      { loop: 'main', from: at(1, 12) - ARCHIVE_SPREAD_MAX_MS, to: at(1, 12), count: 6 },
      { loop: 'main', from: at(1, 12), to: at(0, 6), count: 3 }
    ])
    const d = byDate(readDailyActivity(q, NOW).daily)
    expect(d[key(2)].messages).toBe(3)
    expect(d[key(1)].messages).toBe(3 + 2)
    expect(d[key(0)].messages).toBe(1)
  })

  it('skips older snapshots of the same rows and rows that are still live; ignores archives before the window', () => {
    const { ws, q } = agent()
    archive(ws, { start: 1, end: 9, count: 9, t: at(40, 12) }) // long before the window
    archive(ws, { start: 1, end: 5, count: 5, t: at(3, 12) }) // replaced, then archived again below
    archive(ws, { start: 1, end: 5, count: 5, t: at(2, 12) })
    archive(ws, { start: 6, end: 8, count: 3, t: at(1, 12) }) // a rebuild kept two of these rows live
    row(ws, { seq: 6, t: at(1, 10) })
    row(ws, { seq: 7, t: at(1, 10) })
    const spans = readArchiveSpans(q, windowStartMs(NOW))
    expect(spans.map((s) => s.count)).toEqual([5, 1])
  })

  it('never selects adf_audit.data', () => {
    const { ws, q, sqls } = agent()
    row(ws, { seq: 1, t: at(3, 10) })
    archive(ws, { start: 2, end: 3, count: 2, t: at(2, 12) })
    archive(ws, { start: 4, end: 5, count: 2, t: at(1, 12) })
    readDailyActivity(q, NOW)
    const audit = sqls.filter((s) => /adf_audit/.test(s))
    expect(audit.length).toBeGreaterThan(0)
    for (const s of audit) {
      expect(s).not.toMatch(/\bdata\b/i)
      expect(s).not.toMatch(/\*/)
    }
  })
})

describe('buildDailyActivity', () => {
  it('a span that is a single instant lands on its day', () => {
    const scan = refreshLoopDayScan(agent().q, windowStartMs(NOW))
    const daily = buildDailyActivity(scan, [{ loop: 'main', from: at(4, 8), to: at(4, 8), count: 7 }], NOW)
    expect(byDate(daily)[key(4)]).toEqual({ date: key(4), messages: 7, estimated: true, costPartial: true })
  })
})
