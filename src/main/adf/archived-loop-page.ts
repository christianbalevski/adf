import { brotliDecompress } from 'zlib'
import { promisify } from 'util'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
import type { DisplayEntry } from '../../shared/types/adf-v02.types'
import { assertSafeBrotliRuntime } from '../utils/brotli-runtime-guard'
import type { AdfWorkspace } from './adf-workspace'
import type { AdfDatabase, LoopEntryRow } from './adf-database'
import { archiveBefore as before, archivePosition as keyOf, indexArchiveRows, isArchiveRow, type ArchivePosition as Position, type ArchiveRows } from './archive-snapshot-index'

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
const LARGE_CACHE_IDLE_MS = 2 * 60_000

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

type ArchivedRow = Position & { snapshot: Snapshot; index: number; auditId: number }
type Snapshot = ArchiveRows & { seekable: boolean }

const cache = new Map<string, { snapshot: Snapshot; bytes: number }>()
let cacheBytes = 0
// A single large index holds decoded bytes and offsets, never the parsed
// snapshot. Keep it separate so small overlapping audits cannot evict it.
let largeCache: { id: string; snapshot: Snapshot; timer: NodeJS.Timeout } | undefined
const pending = new Map<string, Promise<Snapshot | null>>()
const workspaceIds = new WeakMap<AdfDatabase, number>()
let nextWorkspaceId = 0

function snapshotKey(workspace: AdfWorkspace, auditId: number): string {
  const db = workspace.getDatabase()
  let id = workspaceIds.get(db)
  if (id === undefined) {
    id = nextWorkspaceId++
    workspaceIds.set(db, id)
  }
  return `${id}:${auditId}`
}

function cacheGet(id: string): Snapshot | undefined {
  if (largeCache?.id === id) {
    largeCache.timer.refresh()
    return largeCache.snapshot
  }
  const hit = cache.get(id)
  if (hit) { cache.delete(id); cache.set(id, hit) }
  return hit?.snapshot
}

function cachePut(id: string, snapshot: Snapshot, bytes: number): void {
  cache.set(id, { snapshot, bytes })
  cacheBytes += bytes
  for (const [oldId, old] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break
    cache.delete(oldId)
    cacheBytes -= old.bytes
  }
}

function keepLargeIndex(id: string, snapshot: Snapshot): void {
  if (largeCache) clearTimeout(largeCache.timer)
  const timer = setTimeout(() => { largeCache = undefined }, LARGE_CACHE_IDLE_MS).unref()
  largeCache = { id, snapshot, timer }
}

/** Display order of loop rows: ord when set (a compaction summary sorts before its tail), then seq. */
const comparePositions = (a: Position, b: Position): number => before(a, b) ? -1 : before(b, a) ? 1 : 0
const rowKey = (row: LoopEntryRow): number => row.ord ?? row.seq
const compareRows = (a: LoopEntryRow, b: LoopEntryRow): number => rowKey(a) - rowKey(b) || a.seq - b.seq

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
function seekSnapshot(snapshot: Snapshot, start: Position): number {
  let lo = 0
  let hi = snapshot.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (before(snapshot.positionAt(mid), start)) lo = mid + 1
    else hi = mid
  }
  return lo
}

function newestRows(snapshot: Snapshot, auditId: number, until: number, liveSeqs: ReadonlySet<number>, cap: number): ArchivedRow[] {
  const newest: ArchivedRow[] = []
  for (let i = until - 1; i >= 0 && newest.length < cap; i--) {
    const position = snapshot.positionAt(i)
    if (!liveSeqs.has(position.seq)) newest.push({ ...position, snapshot, index: i, auditId })
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
  const cacheId = snapshotKey(workspace, meta.id)
  const hit = cacheGet(cacheId)
  if (hit) return hit
  const existing = pending.get(cacheId)
  if (existing) return existing
  const load = loadSnapshot(workspace, meta, cacheId).finally(() => pending.delete(cacheId))
  pending.set(cacheId, load)
  return load
}

async function loadSnapshot(workspace: AdfWorkspace, meta: { id: number; size_bytes: number }, cacheId: string): Promise<Snapshot | null> {
  // size_bytes is the recorded JSON length — untrusted, so only a fast path;
  // maxOutputLength is the guard.
  if (meta.size_bytes > ARCHIVE_MAX_SNAPSHOT_BYTES) return null
  const blob = workspace.getAuditBlob(meta.id)
  if (!blob) return null
  try {
    // Off the event loop (zlib threadpool), unlike the sync decode used inside transactions.
    const json = await brotliDecompressAsync(blob, { maxOutputLength: ARCHIVE_MAX_SNAPSHOT_BYTES })
    if (json.length > CACHE_MAX_BYTES) {
      const indexed = await indexArchiveRows(json)
      if (indexed) {
        const snapshot = { ...indexed, seekable: true }
        keepLargeIndex(cacheId, snapshot)
        return snapshot
      }
    }
    const parsed = JSON.parse(json.toString('utf-8')) as unknown
    const rows = (Array.isArray(parsed) ? parsed : []).filter(isArchiveRow)
    const snapshot = { length: rows.length, seekable: orderSnapshot(rows), positionAt: (i: number) => keyOf(rows[i]), rowAt: (i: number) => rows[i] }
    if (json.length <= CACHE_MAX_BYTES) cachePut(cacheId, snapshot, json.length)
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
  let start: Position
  if (cursor !== null) {
    const decoded = decodeArchiveCursor(cursor)
    if (!decoded) throw new Error(`Invalid archive cursor "${cursor}"`)
    start = decoded
  } else {
    start = { key: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER }
    const oldest = workspace.getOldestLoopOrderKey()
    if (oldest && before(oldest, start)) start = oldest
  }
  // A snapshot can hold rows before `start` only if its first archived seq is
  // at or before start.key (a row's key never exceeds its seq).
  const candidates = workspace.listLoopArchiveMeta().filter((meta) => meta.start_seq <= start.key)
  if (opts.peek) return { ...empty, hasMore: candidates.length > 0 }
  if (candidates.length === 0) return empty

  assertSafeBrotliRuntime()
  const limit = Math.min(Math.max(opts.limit ?? ARCHIVE_PAGE_ROWS, 1), 500)
  const liveSeqs = new Set(workspace.listLoopSeqs())
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
      const ordered = [...rows.values()].sort(comparePositions)
      if (ordered[ordered.length - limit].key > meta.end_seq) break
    }
    visited++
    const snapshot = await readSnapshot(workspace, meta)
    if (!snapshot) { unreadable++; continue }
    const until = snapshot.seekable ? seekSnapshot(snapshot, start) : snapshot.length
    if (rows.size === 0 && snapshot.seekable && Number.isInteger(limit)) {
      const newest = newestRows(snapshot, meta.id, until, liveSeqs, limit + 1)
      const following = candidates[visited]
      // One snapshot supplies this page if it is the last candidate or the
      // normal end_seq cutoff would stop before the next candidate.
      if (!following || (newest.length >= limit && newest[limit - 1].key > following.end_seq)) {
        page = newest.slice(0, limit).reverse()
        moreRows = newest.length > limit
        break
      }
    }
    for (let i = 0; i < until; i++) {
      const position = snapshot.positionAt(i)
      if (liveSeqs.has(position.seq) || (!snapshot.seekable && !before(position, start))) continue
      const seen = rows.get(position.seq)
      // A seq archived twice: keep the earliest snapshot's copy (the row as
      // written, before a rebuild stripped it).
      if (!seen || meta.id < seen.auditId) rows.set(position.seq, { ...position, snapshot, index: i, auditId: meta.id })
    }
  }

  if (!page) {
    const ordered = [...rows.values()].sort(comparePositions)
    page = ordered.slice(Math.max(0, ordered.length - limit))
    moreRows = ordered.length > limit
  }
  if (page.length === 0) return { ...empty, unreadable }
  const next = page[0]
  const hasMore = moreRows || candidates.slice(visited).some((meta) => meta.start_seq <= next.key)

  // One parse for the page, so a tool_result finds its call's name; ids are
  // re-keyed by the source snapshot (seqs can repeat across snapshots).
  const auditBySeq = new Map(page.map(({ seq, auditId }) => [seq, auditId]))
  const uiLog = parseLoopToDisplay(page.map(({ snapshot, index }) => snapshot.rowAt(index))).map((entry) => {
    const seq = entry.metadata?.seq as number | undefined
    return {
      ...entry,
      id: `audit-${seq !== undefined ? auditBySeq.get(seq) ?? 0 : 0}-${entry.id}`,
      metadata: { ...entry.metadata, archived: true }
    }
  })
  return { uiLog, cursor: encodeArchiveCursor(next), hasMore, unreadable }
}
