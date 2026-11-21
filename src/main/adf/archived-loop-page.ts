import { brotliDecompress } from 'zlib'
import { promisify } from 'util'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
import type { DisplayEntry } from '../../shared/types/adf-v02.types'
import { assertSafeBrotliRuntime } from '../utils/brotli-runtime-guard'
import type { AdfWorkspace } from './adf-workspace'
import type { LoopEntryRow } from './adf-database'

const brotliDecompressAsync = promisify(brotliDecompress)

/** Loop rows per archived page (the live scroll-back's default window). */
export const ARCHIVE_PAGE_ROWS = 200
/**
 * Largest decompressed snapshot read. Blobs come with the file (an imported
 * .adf is untrusted), so the decoder stops here instead of inflating a
 * compression bomb onto the main or daemon process's heap.
 */
export const ARCHIVE_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
/** Decoded snapshots kept for the next page (audit rows never change). */
const CACHE_MAX_BYTES = 64 * 1024 * 1024

/** Studio's DOC_GET_CHAT_ARCHIVED: one page of a loop's archived history. */
export interface ArchivedChatPage {
  /** Display entries, oldest first; ids `audit-…`, `metadata.archived` set. */
  uiLog: DisplayEntry[]
  /** Cursor for the next (older) page; null when there is none. */
  cursor: string | null
  /** Whether archived rows older than this page may exist. */
  hasMore: boolean
  /** Snapshots skipped because they could not be read (too large or corrupt). */
  unreadable: number
}

interface Position { key: number; seq: number }
type ArchivedRow = { row: LoopEntryRow; auditId: number }
type Snapshot = { rows: LoopEntryRow[]; seekable: boolean; bytes: number }

const cache = new Map<string, Snapshot>()
let cacheBytes = 0

function cacheGet(id: string): Snapshot | undefined {
  const hit = cache.get(id)
  if (hit) { cache.delete(id); cache.set(id, hit) }
  return hit
}

function cachePut(id: string, snapshot: Snapshot): void {
  if (snapshot.bytes > CACHE_MAX_BYTES) return
  // Two page requests can miss the cache and finish decoding the same snapshot.
  cacheBytes -= cache.get(id)?.bytes ?? 0
  cache.delete(id)
  cache.set(id, snapshot)
  cacheBytes += snapshot.bytes
  for (const [oldId, old] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break
    cache.delete(oldId)
    cacheBytes -= old.bytes
  }
}

const isRow = (e: unknown): e is LoopEntryRow => {
  const r = e as Partial<LoopEntryRow> | null
  return !!r && typeof r.seq === 'number' && (r.role === 'user' || r.role === 'assistant') && Array.isArray(r.content_json)
}

/** Display order of loop rows: ord when set (a compaction summary sorts before its tail), then seq. */
const rowKey = (row: LoopEntryRow): number => row.ord ?? row.seq
const keyOf = (row: LoopEntryRow): Position => ({ key: rowKey(row), seq: row.seq })
const before = (a: Position, b: Position): boolean => a.key < b.key || (a.key === b.key && a.seq < b.seq)
const compareRows = (a: LoopEntryRow, b: LoopEntryRow): number => {
  const aKey = rowKey(a)
  const bKey = rowKey(b)
  if (aKey < bKey || (aKey === bKey && a.seq < b.seq)) return -1
  if (bKey < aKey || (aKey === bKey && b.seq < a.seq)) return 1
  return 0
}

/** Writer snapshots are already ordered and unique. Keep imported duplicates in their original order. */
function orderSnapshot(rows: LoopEntryRow[]): boolean {
  const seqs = new Set<number>()
  let needsSort = false
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!Number.isSafeInteger(row.seq) || !Number.isSafeInteger(rowKey(row)) || seqs.has(row.seq)) return false
    seqs.add(row.seq)
    if (i > 0 && compareRows(rows[i - 1], row) > 0) needsSort = true
  }
  if (needsSort) rows.sort(compareRows)
  return true
}

/** First row at or above the cursor in an ordered snapshot. */
function seekSnapshot(rows: LoopEntryRow[], start: Position): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (before(keyOf(rows[mid]), start)) lo = mid + 1
    else hi = mid
  }
  return lo
}

function newestRows(rows: LoopEntryRow[], until: number, liveSeqs: ReadonlySet<number>, cap: number): LoopEntryRow[] {
  const newest: LoopEntryRow[] = []
  for (let i = until - 1; i >= 0 && newest.length < cap; i--) {
    if (!liveSeqs.has(rows[i].seq)) newest.push(rows[i])
  }
  return newest
}

export function encodeArchiveCursor(p: Position): string {
  return `${p.key}:${p.seq}`
}

export function decodeArchiveCursor(cursor: string): Position | null {
  const m = /^(-?\d+):(-?\d+)$/.exec(cursor)
  if (!m) return null
  const key = Number(m[1])
  const seq = Number(m[2])
  return Number.isSafeInteger(key) && Number.isSafeInteger(seq) ? { key, seq } : null
}

async function readSnapshot(workspace: AdfWorkspace, meta: { id: number; size_bytes: number }): Promise<Snapshot | null> {
  const cacheId = `${workspace.getFilePath()}\u0000${meta.id}`
  const hit = cacheGet(cacheId)
  if (hit) return hit
  // size_bytes is the recorded JSON length — untrusted, so only a fast path;
  // maxOutputLength is the guard.
  if (meta.size_bytes > ARCHIVE_MAX_SNAPSHOT_BYTES) return null
  const blob = workspace.getAuditBlob(meta.id)
  if (!blob) return null
  try {
    // Off the event loop (zlib threadpool), unlike the sync decode used inside transactions.
    const json = await brotliDecompressAsync(blob, { maxOutputLength: ARCHIVE_MAX_SNAPSHOT_BYTES })
    const parsed = JSON.parse(json.toString('utf-8')) as unknown
    const rows = (Array.isArray(parsed) ? parsed : []).filter(isRow)
    const snapshot = { rows, seekable: orderSnapshot(rows), bytes: json.length }
    cachePut(cacheId, snapshot)
    return snapshot
  } catch (error) {
    console.warn(`[archived-loop-page] audit ${meta.id} unreadable:`, error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * One page of the archived history of the loop the workspace is bound to:
 * rows that compactions and clears moved into `adf_audit`, older (in display
 * order) than `cursor` — or, with no cursor, than the oldest live row.
 *
 * Every snapshot of the loop is one source of rows; the page merges them by
 * display order (ord, then seq), keeps one copy of a seq archived twice
 * (a rebuild re-audits rows that a later compaction archives again), and
 * leaves out rows still live. So overlapping snapshots neither repeat nor
 * shadow each other, and the cursor is a row position, not a snapshot.
 *
 * Rows archived from inside or after the live window (a slice cleared from
 * the middle or the tail) sort after the live head and are not offered.
 *
 * `peek` answers only whether older snapshots exist, from metadata, without
 * decompressing anything (a snapshot holding only still-live rows can make
 * it true when the page then comes back empty).
 */
export async function readArchivedChatPage(
  workspace: AdfWorkspace,
  cursor: string | null,
  opts: { peek?: boolean; limit?: number } = {}
): Promise<ArchivedChatPage> {
  const empty: ArchivedChatPage = { uiLog: [], cursor: null, hasMore: false, unreadable: 0 }
  const live = workspace.getLoopOrderKeys()
  let start: Position
  if (cursor !== null) {
    const decoded = decodeArchiveCursor(cursor)
    if (!decoded) throw new Error(`Invalid archive cursor "${cursor}"`)
    start = decoded
  } else {
    start = { key: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER }
    for (const row of live) if (before(row, start)) start = { key: row.key, seq: row.seq }
  }
  // A snapshot can hold rows before `start` only if its first archived seq is
  // at or before start.key (a row's key never exceeds its seq).
  const candidates = workspace.listLoopArchiveMeta().filter((meta) => meta.start_seq <= start.key)
  if (opts.peek) return { ...empty, hasMore: candidates.length > 0 }
  if (candidates.length === 0) return empty

  assertSafeBrotliRuntime()
  const limit = Math.min(Math.max(opts.limit ?? ARCHIVE_PAGE_ROWS, 1), 500)
  const liveSeqs = new Set(live.map((row) => row.seq))
  const rows = new Map<number, ArchivedRow>()
  let page: ArchivedRow[] | undefined
  let moreRows = false
  let unreadable = 0
  let visited = 0
  for (const meta of candidates) {
    // Candidates come newest-first by end_seq, and no row's key exceeds its
    // snapshot's end_seq: once `limit` rows newer than this snapshot's newest
    // are collected, it and every later candidate can only add older rows.
    if (rows.size >= limit) {
      const ordered = [...rows.values()].sort((a, b) => compareRows(a.row, b.row))
      if (rowKey(ordered[ordered.length - limit].row) > meta.end_seq) break
    }
    visited++
    const snapshot = await readSnapshot(workspace, meta)
    if (!snapshot) { unreadable++; continue }
    const until = snapshot.seekable ? seekSnapshot(snapshot.rows, start) : snapshot.rows.length
    if (rows.size === 0 && snapshot.seekable && Number.isInteger(limit)) {
      const newest = newestRows(snapshot.rows, until, liveSeqs, limit + 1)
      const following = candidates[visited]
      // One snapshot supplies this page if it is the last candidate or the
      // normal end_seq cutoff would stop before the next candidate.
      if (!following || (newest.length >= limit && rowKey(newest[limit - 1]) > following.end_seq)) {
        page = newest.slice(0, limit).reverse().map((row) => ({ row, auditId: meta.id }))
        moreRows = newest.length > limit
        break
      }
    }
    for (let i = 0; i < until; i++) {
      const row = snapshot.rows[i]
      if (liveSeqs.has(row.seq) || (!snapshot.seekable && !before(keyOf(row), start))) continue
      const seen = rows.get(row.seq)
      // A seq archived twice: keep the earliest snapshot's copy (the row as
      // written, before a rebuild stripped it).
      if (!seen || meta.id < seen.auditId) rows.set(row.seq, { row, auditId: meta.id })
    }
  }

  if (!page) {
    const ordered = [...rows.values()].sort((a, b) => compareRows(a.row, b.row))
    page = ordered.slice(Math.max(0, ordered.length - limit))
    moreRows = ordered.length > limit
  }
  if (page.length === 0) return { ...empty, unreadable }
  const next = keyOf(page[0].row)
  const hasMore = moreRows || candidates.slice(visited).some((meta) => meta.start_seq <= next.key)

  // One parse for the page, so a tool_result finds its call's name; ids are
  // re-keyed by the source snapshot (seqs can repeat across snapshots).
  const auditBySeq = new Map(page.map(({ row, auditId }) => [row.seq, auditId]))
  const uiLog = parseLoopToDisplay(page.map(({ row }) => row)).map((entry) => {
    const seq = entry.metadata?.seq as number | undefined
    return {
      ...entry,
      id: `audit-${seq !== undefined ? auditBySeq.get(seq) ?? 0 : 0}-${entry.id}`,
      metadata: { ...entry.metadata, archived: true }
    }
  })
  return { uiLog, cursor: encodeArchiveCursor(next), hasMore, unreadable }
}
