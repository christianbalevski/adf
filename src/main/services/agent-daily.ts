/**
 * The overview's 14-day Activity chart, read from the .adf file alone:
 * messages per local day (live adf_loop rows plus compacted history in
 * adf_audit) and cost per day (priced adf_loop rows).
 *
 * Bounded reads only. adf_loop.created_at sits after content_json in the
 * row, so reading it walks that row's overflow pages: live rows are scanned
 * once and then incrementally above a high-water seq, kept per row so a
 * compaction only drops rows instead of rescanning. adf_audit is read as
 * metadata (source, seq range, entry_count, created_at), never `data`.
 */

import type { ActivityDay } from '../../shared/types/agent-vitals.types'
import { localDayKeys, windowStartMs } from '../../shared/utils/agent-activity'
import { estimateTokenCostUsd } from '../runtime/llm-pricing'

type Sql = (sql: string, params?: unknown[]) => unknown[]

function rowsOf<T>(q: Sql, sql: string, params?: unknown[]): T[] | null {
  try {
    return q(sql, params) as T[]
  } catch {
    return null
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const DAY_MS = 24 * 60 * 60 * 1000

// =============================================================================
// Cost of one adf_loop row
// =============================================================================

/**
 * Loop rows carry `cost_usd` in their usage record from this time on
 * (2026-08-27, local pricing table release). A later row without it had no
 * price when it was written: a subscription provider, estimated usage or an
 * unpriced model. Pricing it from the table now would invent dollars, so it
 * stays unpriced; only older rows are priced from the table.
 */
export const LOOP_COST_RECORDED_SINCE_MS = Date.UTC(2026, 7, 27)

/** A loop row's cost: `none` (no usage record), `priced` (USD) or `unpriced`. */
export type RowCost = { kind: 'none' } | { kind: 'priced'; usd: number } | { kind: 'unpriced' }

/**
 * Cost of the call behind one adf_loop row. `tokens` is the stored cell: a
 * JSON usage record `{input, output, cache_read?, cache_write?, reasoning?,
 * cost_usd?}`, NULL on rows no call produced (user input, tool results), or
 * a bare integer on files from before the record (the column was INTEGER).
 * A recorded `cost_usd` wins; otherwise rows from before
 * LOOP_COST_RECORDED_SINCE_MS are priced with the pricing table.
 */
export function rowCost(model: unknown, tokens: unknown, createdAt: number): RowCost {
  if (tokens === null || tokens === undefined || tokens === '') return { kind: 'none' }
  let usage: unknown = tokens
  if (typeof tokens === 'string') {
    try { usage = JSON.parse(tokens) } catch { return { kind: 'unpriced' } }
  }
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return { kind: 'unpriced' }
  const u = usage as Record<string, unknown>
  const recorded = num(u.cost_usd)
  if (recorded !== null) return { kind: 'priced', usd: recorded }
  if (createdAt >= LOOP_COST_RECORDED_SINCE_MS || typeof model !== 'string' || !model) return { kind: 'unpriced' }
  const usd = estimateTokenCostUsd(model, {
    input: num(u.input) ?? undefined,
    output: num(u.output) ?? undefined,
    cache_read: num(u.cache_read) ?? undefined,
    cache_write: num(u.cache_write) ?? undefined
  })
  return usd === undefined ? { kind: 'unpriced' } : { kind: 'priced', usd }
}

// =============================================================================
// Live rows: incremental per-row scan
// =============================================================================

/** One scanned adf_loop row: its time and the cost of its call. */
export interface LoopScanRow {
  t: number
  /** Priced USD; absent when the row has no call or the call has no price. */
  usd?: number
  /** The row carries a usage record without a price. */
  unpriced?: true
}

/**
 * Every adf_loop row with startSeq <= seq <= lastSeq, read once. Built for
 * one window start (`since`); a new local day builds a new one.
 */
export interface LoopDayScan {
  since: number
  /** First seq whose created_at was inside the window when the scan began. */
  startSeq: number
  /** Highest seq read. */
  lastSeq: number
  rows: Map<number, LoopScanRow>
}

/** MAX(seq) of adf_loop; 0 when empty or unreadable. */
export function maxLoopSeq(q: Sql): number {
  return num((rowsOf<{ n: unknown }>(q, 'SELECT MAX(seq) AS n FROM adf_loop')?.[0])?.n) ?? 0
}

/**
 * First seq whose created_at is at or after `since`, by binary search over
 * seq (created_at grows with seq: rows are appended with the current time).
 * About log2(rows) single-row reads. maxSeq + 1 when no row qualifies.
 */
export function firstSeqSince(q: Sql, since: number, maxSeq = maxLoopSeq(q)): number {
  const probe = (seq: number): { seq: number; t: number } | null => {
    const r = rowsOf<{ seq: number; t: unknown }>(q, 'SELECT seq, created_at AS t FROM adf_loop WHERE seq >= ? ORDER BY seq LIMIT 1', [seq])?.[0]
    return r ? { seq: r.seq, t: num(r.t) ?? 0 } : null
  }
  let lo = 0
  let hi = maxSeq + 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const row = probe(mid)
    // No row in [mid, hi), or the first one is in the window: the start is at or below mid.
    if (!row || row.seq >= hi || row.t >= since) hi = mid
    else lo = row.seq + 1
  }
  return lo
}

/** An empty scan for the window starting at `since`. */
export function startLoopDayScan(q: Sql, since: number): LoopDayScan {
  const startSeq = firstSeqSince(q, since)
  return { since, startSeq, lastSeq: startSeq - 1, rows: new Map() }
}

type ScanRowSql = { seq: number; t: unknown; model: unknown; tokens: unknown }

function addRows(scan: LoopDayScan, rows: ScanRowSql[]): void {
  for (const r of rows) {
    const t = num(r.t) ?? 0
    const cost = rowCost(r.model, r.tokens, t)
    scan.rows.set(r.seq, cost.kind === 'priced' ? { t, usd: cost.usd } : cost.kind === 'unpriced' ? { t, unpriced: true } : { t })
  }
}

/** Read rows (scan.lastSeq, upTo] into `scan` (in place). One bounded rowid range. */
export function scanLoopRows(q: Sql, scan: LoopDayScan, upTo: number): LoopDayScan {
  if (upTo <= scan.lastSeq) return scan
  const rows = rowsOf<ScanRowSql>(q, 'SELECT seq, created_at AS t, model, tokens FROM adf_loop WHERE seq > ? AND seq <= ?', [scan.lastSeq, upTo])
    // Files from before the model/tokens columns.
    ?? rowsOf<ScanRowSql>(q, 'SELECT seq, created_at AS t, NULL AS model, NULL AS tokens FROM adf_loop WHERE seq > ? AND seq <= ?', [scan.lastSeq, upTo])
    ?? []
  addRows(scan, rows)
  scan.lastSeq = upTo
  return scan
}

/** seq-range predicate read from the (loop, seq) index alone; the table's own rowid range walks every leaf page. */
function seqRangeRows<T>(q: Sql, select: string, from: number, to: number): T[] | null {
  return rowsOf<T>(q, `SELECT ${select} FROM adf_loop INDEXED BY idx_adf_loop_loop_seq WHERE seq BETWEEN ? AND ?`, [from, to])
    ?? rowsOf<T>(q, `SELECT ${select} FROM adf_loop WHERE seq BETWEEN ? AND ?`, [from, to])
}

/**
 * Bring `prior` (updated in place) up to date, or build a scan when there is
 * none for this window. Rows deleted since (compaction, clears) are dropped:
 * an index-only COUNT over the scanned seq range detects them, and only then
 * are the surviving seqs listed. Rows re-inserted under an old seq are read
 * again. New rows are read above the high-water seq.
 */
export function refreshLoopDayScan(q: Sql, since: number, prior?: LoopDayScan): LoopDayScan {
  const maxSeq = maxLoopSeq(q)
  if (!prior || prior.since !== since || prior.lastSeq > maxSeq) return scanLoopRows(q, startLoopDayScan(q, since), maxSeq)
  const scan = prior
  if (scan.lastSeq >= scan.startSeq) {
    const count = num(seqRangeRows<{ n: unknown }>(q, 'COUNT(*) AS n', scan.startSeq, scan.lastSeq)?.[0]?.n)
    if (count !== null && count !== scan.rows.size) {
      const alive = new Set((seqRangeRows<{ seq: number }>(q, 'seq', scan.startSeq, scan.lastSeq) ?? []).map((r) => r.seq))
      for (const seq of scan.rows.keys()) if (!alive.has(seq)) scan.rows.delete(seq)
      const missing = [...alive].filter((seq) => !scan.rows.has(seq))
      if (missing.length > 0) {
        addRows(scan, rowsOf<ScanRowSql>(q, 'SELECT seq, created_at AS t, model, tokens FROM adf_loop WHERE seq IN (SELECT value FROM json_each(?))', [JSON.stringify(missing)]) ?? [])
      }
    }
  }
  return scanLoopRows(q, scan, maxSeq)
}

// =============================================================================
// Archived rows: compacted history spread over time
// =============================================================================

/** adf_audit sources of archived loop streams: legacy `loop` (main) and `loop:<name>`. */
const LOOP_AUDIT_WHERE = "(source = 'loop' OR source LIKE 'loop:%')"

/** An archive's messages, spread evenly over [from, to] (ms epoch). */
export interface ArchiveSpan {
  loop: string
  from: number
  to: number
  count: number
}

/** Longest an archive's messages are spread over, back from its end. */
export const ARCHIVE_SPREAD_MAX_MS = DAY_MS

const loopOfSource = (source: string): string => (source === 'loop' ? 'main' : source.slice('loop:'.length) || 'main')

/** First adf_audit id with created_at >= `at`, by binary search over id (ids grow with insert time). */
function firstAuditIdSince(q: Sql, at: number): number | null {
  const bounds = rowsOf<{ lo: unknown; hi: unknown }>(q, 'SELECT MIN(id) AS lo, MAX(id) AS hi FROM adf_audit')?.[0]
  const minId = num(bounds?.lo)
  const maxId = num(bounds?.hi)
  if (minId === null || maxId === null) return null
  let lo = minId
  let hi = maxId + 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const row = rowsOf<{ id: number; t: unknown }>(q, 'SELECT id, created_at AS t FROM adf_audit WHERE id >= ? ORDER BY id LIMIT 1', [mid])?.[0]
    if (!row || row.id >= hi || (num(row.t) ?? 0) >= at) hi = mid
    else lo = row.id + 1
  }
  return lo
}

type AuditRow = { id: number; source: string; start_seq: unknown; end_seq: unknown; entry_count: unknown; created_at: unknown }

/**
 * Archived loop rows that can fall inside the window, as spans of time.
 * adf_audit holds no per-message times without decompressing `data`, so
 * each archive's messages are spread evenly over an estimated span:
 *
 * - end: the archive's created_at, or earlier, the created_at of the first
 *   live row after its end_seq (seq grows with time, so every archived row
 *   was written before that row).
 * - start: the latest of the previous archive of the same loop, the
 *   created_at of the last live row before its start_seq, and end minus
 *   ARCHIVE_SPREAD_MAX_MS.
 *
 * Counted: entry_count, less live rows of the same loop still inside its
 * seq range (a rebuilt loop re-inserts rows it archived). An archive whose
 * seq range a later archive of the same loop covers is an older snapshot
 * of the same rows and is skipped. Spans end by created_at, so archives
 * older than `since` minus ARCHIVE_SPREAD_MAX_MS (only needed as the
 * previous archive) are not read. The query never selects `data`.
 */
export function readArchiveSpans(q: Sql, since: number): ArchiveSpan[] {
  const firstId = firstAuditIdSince(q, since - ARCHIVE_SPREAD_MAX_MS)
  if (firstId === null) return []
  const cols = (seqCols: string): string =>
    `SELECT id, source, ${seqCols}, entry_count, created_at FROM adf_audit WHERE id >= ? AND ${LOOP_AUDIT_WHERE} ORDER BY id`
  const archives = rowsOf<AuditRow>(q, cols('start_seq, end_seq'), [firstId])
    // adf_audit from before the seq range columns.
    ?? rowsOf<AuditRow>(q, cols('NULL AS start_seq, NULL AS end_seq'), [firstId])
    ?? []

  const liveAt = (sql: string, seq: number): number | null =>
    num(rowsOf<{ t: unknown }>(q, sql, [seq])?.[0]?.t)
  const liveInRange = (loop: string, from: number, to: number): number =>
    num(rowsOf<{ n: unknown }>(q, 'SELECT COUNT(*) AS n FROM adf_loop WHERE loop = ? AND seq BETWEEN ? AND ?', [loop, from, to])?.[0]?.n)
      // Files without the loop column: every row is main's.
      ?? (loop === 'main' ? num(rowsOf<{ n: unknown }>(q, 'SELECT COUNT(*) AS n FROM adf_loop WHERE seq BETWEEN ? AND ?', [from, to])?.[0]?.n) ?? 0 : 0)

  const spans: ArchiveSpan[] = []
  const prevCreated = new Map<string, number>()
  archives.forEach((a, i) => {
    const loop = loopOfSource(a.source)
    const created = num(a.created_at) ?? 0
    const prev = prevCreated.get(loop)
    prevCreated.set(loop, created)
    if (created < since) return
    const startSeq = num(a.start_seq)
    const endSeq = num(a.end_seq)
    const hasRange = startSeq !== null && endSeq !== null
    if (hasRange && archives.slice(i + 1).some((b) => loopOfSource(b.source) === loop && num(b.start_seq) !== null && num(b.start_seq)! <= startSeq && (num(b.end_seq) ?? -Infinity) >= endSeq)) return
    let count = num(a.entry_count) ?? 0
    if (hasRange) count -= liveInRange(loop, startSeq, endSeq)
    if (count <= 0) return

    let to = created
    const after = hasRange ? liveAt('SELECT created_at AS t FROM adf_loop WHERE seq > ? ORDER BY seq LIMIT 1', endSeq) : null
    if (after !== null && after < to) to = after
    let from = to - ARCHIVE_SPREAD_MAX_MS
    if (prev !== undefined) from = Math.max(from, prev)
    const before = hasRange ? liveAt('SELECT created_at AS t FROM adf_loop WHERE seq < ? ORDER BY seq DESC LIMIT 1', startSeq) : null
    if (before !== null) from = Math.max(from, before)
    spans.push({ loop, from: Math.min(from, to), to, count })
  })
  return spans
}

/** Each span's count split over `days` local days (keys), by overlap with each day. */
export function spreadSpans(spans: ArchiveSpan[], dayStarts: number[]): number[] {
  const out = new Array<number>(dayStarts.length - 1).fill(0)
  for (const s of spans) {
    const width = s.to - s.from
    for (let i = 0; i < out.length; i++) {
      const a = dayStarts[i]
      const b = dayStarts[i + 1]
      if (width <= 0) {
        if (s.to >= a && s.to < b) out[i] += s.count
        continue
      }
      const overlap = Math.min(b, s.to) - Math.max(a, s.from)
      if (overlap > 0) out[i] += (s.count * overlap) / width
    }
  }
  return out
}

// =============================================================================
// The chart
// =============================================================================

/** Local midnights bounding each day of the window, plus the next midnight. */
export function windowDayStarts(now: number, days: number): number[] {
  const d = new Date(now)
  const out: number[] = []
  for (let i = days - 1; i >= -1; i--) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime())
  return out
}

/**
 * The chart's days, oldest first. Per day: live rows (every role) plus the
 * rounded archived share; `estimated` when that share adds at least one
 * message. Cost: the sum of priced rows, present when the day has one;
 * `costPartial` when some row had no price or compacted calls (whose cost
 * is not recorded) fall on the day.
 */
export function buildDailyActivity(scan: LoopDayScan, spans: ArchiveSpan[], now: number, days?: number): ActivityDay[] {
  const keys = localDayKeys(now, days)
  const starts = windowDayStarts(now, keys.length)
  const live = keys.map(() => ({ messages: 0, usd: 0, priced: false, unpriced: false }))
  for (const r of scan.rows.values()) {
    if (r.t < starts[0] || r.t >= starts[starts.length - 1]) continue
    let i = 0
    while (r.t >= starts[i + 1]) i++
    const day = live[i]
    day.messages++
    if (r.usd !== undefined) {
      day.usd += r.usd
      day.priced = true
    }
    if (r.unpriced) day.unpriced = true
  }
  const archived = spreadSpans(spans, starts)
  return keys.map((date, i) => {
    const extra = Math.round(archived[i])
    const d = live[i]
    return {
      date,
      messages: d.messages + extra,
      ...(extra > 0 ? { estimated: true as const } : {}),
      ...(d.priced ? { costUsd: Number(d.usd.toFixed(8)) } : {}),
      ...(d.unpriced || extra > 0 ? { costPartial: true as const } : {})
    }
  })
}

/**
 * The chart from the file: incremental live scan (`prior`, updated in place)
 * plus archive spans. Returns the days and the scan to keep.
 */
export function readDailyActivity(q: Sql, now: number, prior?: LoopDayScan): { daily: ActivityDay[]; scan: LoopDayScan } {
  const since = windowStartMs(now)
  const scan = refreshLoopDayScan(q, since, prior)
  return { daily: buildDailyActivity(scan, readArchiveSpans(q, since), now), scan }
}

/** Cost over the last `days` days of `daily` (today included); undefined when no day there has a priced row. */
export function recentCost(daily: ActivityDay[], days = 7): { usd: number; partial: boolean } | undefined {
  const recent = daily.slice(-days)
  if (!recent.some((d) => d.costUsd !== undefined)) return undefined
  return {
    usd: Number(recent.reduce((s, d) => s + (d.costUsd ?? 0), 0).toFixed(8)),
    partial: recent.some((d) => d.costPartial === true)
  }
}
