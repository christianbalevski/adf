import { setImmediate } from 'node:timers/promises'
import type { LoopEntryRow } from './adf-database'

export interface ArchivePosition { key: number; seq: number }

export interface ArchiveRows {
  length: number
  positionAt(index: number): ArchivePosition
  rowAt(index: number): LoopEntryRow
}

type RowSpan = ArchivePosition & { start: number; end: number }

// At most 6 MB of typed-array metadata for the retained large snapshot.
const MAX_INDEX_ROWS = 250_000
const YIELD_BYTES = 4 * 1024 * 1024

export const isArchiveRow = (value: unknown): value is LoopEntryRow => {
  const row = value as Partial<LoopEntryRow> | null
  return !!row && typeof row.seq === 'number' && (row.role === 'user' || row.role === 'assistant') && Array.isArray(row.content_json)
}

export function archivePosition(row: LoopEntryRow): ArchivePosition {
  return { key: row.ord ?? row.seq, seq: row.seq }
}

export function archiveBefore(a: ArchivePosition, b: ArchivePosition): boolean {
  return a.key < b.key || (a.key === b.key && a.seq < b.seq)
}

function skipSpace(json: Buffer, start: number): number {
  while (start < json.length) {
    const byte = json[start]
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break
    start++
  }
  return start
}

/** Find the end of a JSON string without walking its UTF-8 content byte by byte. */
function closingQuote(json: Buffer, opening: number): number {
  for (let quote = json.indexOf(0x22, opening + 1); quote !== -1; quote = json.indexOf(0x22, quote + 1)) {
    let slash = quote - 1
    while (json[slash] === 0x5c) slash--
    if ((quote - slash - 1) % 2 === 0) return quote
  }
  return -1
}

/** Locate one root array value. JSON.parse validates the resulting slice. */
function valueEnd(json: Buffer, start: number): number {
  let depth = 0
  for (let i = start; i < json.length; i++) {
    switch (json[i]) {
      case 0x22: // "
        i = closingQuote(json, i)
        if (i === -1) return -1
        break
      case 0x7b: // {
      case 0x5b: // [
        depth++
        break
      case 0x7d: // }
        if (depth === 0) return -1
        depth--
        break
      case 0x5d: // ]
        if (depth === 0) return i
        depth--
        break
      case 0x2c: // ,
        if (depth === 0) return i
        break
    }
  }
  return -1
}

/**
 * Keep decoded bytes and only enough metadata to seek into the array. Validate
 * all slices once, retaining parsed rows only when a page actually needs them.
 * Legacy duplicate or unsafe positions use the existing whole-JSON reader.
 */
export async function indexArchiveRows(json: Buffer): Promise<ArchiveRows | null> {
  const first = skipSpace(json, 0)
  if (json[first] !== 0x5b) return null
  let start = skipSpace(json, first + 1)
  const spans: RowSpan[] = []
  const seqs = new Set<number>()
  let needsSort = false
  let yieldAt = start + YIELD_BYTES
  if (json[start] !== 0x5d) {
    for (;;) {
      const end = valueEnd(json, start)
      if (end === -1) throw new SyntaxError('Invalid archive array')
      const row: unknown = JSON.parse(json.toString('utf8', start, end))
      if (isArchiveRow(row)) {
        const position = archivePosition(row)
        if (!Number.isSafeInteger(position.key) || !Number.isSafeInteger(position.seq) || seqs.has(position.seq) || spans.length === MAX_INDEX_ROWS) return null
        seqs.add(position.seq)
        const previous = spans.at(-1)
        if (previous && archiveBefore(position, previous)) needsSort = true
        spans.push({ ...position, start, end })
      }
      if (json[end] === 0x5d) {
        start = end
        break
      }
      start = skipSpace(json, end + 1)
      if (start >= yieldAt) {
        await setImmediate()
        yieldAt = start + YIELD_BYTES
      }
    }
  }
  if (skipSpace(json, start + 1) !== json.length) throw new SyntaxError('Invalid archive array suffix')
  if (needsSort) spans.sort((a, b) => a.key - b.key || a.seq - b.seq)

  const positions = new Float64Array(spans.length * 2)
  const offsets = new Uint32Array(spans.length * 2)
  spans.forEach(({ key, seq, start, end }, i) => {
    positions[i * 2] = key
    positions[i * 2 + 1] = seq
    offsets[i * 2] = start
    offsets[i * 2 + 1] = end
  })
  return {
    length: positions.length / 2,
    positionAt: (i) => ({ key: positions[i * 2], seq: positions[i * 2 + 1] }),
    rowAt: (i) => JSON.parse(json.toString('utf8', offsets[i * 2], offsets[i * 2 + 1])) as LoopEntryRow,
  }
}
