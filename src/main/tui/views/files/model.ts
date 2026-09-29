// Pure helpers for the files view: targets, tree rows, fuzzy match, content
// preparation (binary detection, JSON pretty, line styling), line diff.

import type { FileListEntry } from '../../api/types'

/** What the viewer / editor can open: the agent document, its mind, or a file. */
export type FileTarget =
  | { kind: 'document' }
  | { kind: 'mind' }
  | { kind: 'file'; path: string }

export const DOCUMENT_KEY = 'doc:'
export const MIND_KEY = 'mind:'

export function targetKey(target: FileTarget): string {
  return target.kind === 'document' ? DOCUMENT_KEY : target.kind === 'mind' ? MIND_KEY : `file:${target.path}`
}

export function targetFromKey(key: string | undefined | null): FileTarget | null {
  if (!key) return null
  if (key === DOCUMENT_KEY) return { kind: 'document' }
  if (key === MIND_KEY) return { kind: 'mind' }
  if (key.startsWith('file:')) return { kind: 'file', path: key.slice(5) }
  return null
}

export function targetLabel(target: FileTarget): string {
  return target.kind === 'document' ? 'document' : target.kind === 'mind' ? 'mind' : target.path
}

/** File name used for the temp copy handed to $EDITOR (keeps the extension for syntax). */
export function targetFileName(target: FileTarget): string {
  if (target.kind === 'document') return 'document.md'
  if (target.kind === 'mind') return 'mind.md'
  const base = target.path.split('/').pop() || 'file'
  return base.replace(/[<>:"\\|?*\x00-\x1f]/g, '_')
}

// --- tree -----------------------------------------------------------------

export type TreeRowKind = 'document' | 'mind' | 'dir' | 'file'

export interface TreeRow {
  key: string
  kind: TreeRowKind
  /** Display name (basename in tree mode, full path in filter mode). */
  name: string
  /** File path, or folder prefix without trailing slash. '' for pinned rows. */
  path: string
  depth: number
  entry?: FileListEntry
  /** Folder: files beneath it, and their total size. */
  fileCount?: number
  size?: number
  expanded?: boolean
}

interface DirNode {
  name: string
  path: string
  dirs: Map<string, DirNode>
  files: FileListEntry[]
  count: number
  size: number
}

function newDir(name: string, path: string): DirNode {
  return { name, path, dirs: new Map(), files: [], count: 0, size: 0 }
}

export function buildTree(files: FileListEntry[]): DirNode {
  const root = newDir('', '')
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node = root
    node.count++
    node.size += file.size
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = node.dirs.get(parts[i])
      if (!next) {
        next = newDir(parts[i], path)
        node.dirs.set(parts[i], next)
      }
      next.count++
      next.size += file.size
      node = next
    }
    node.files.push(file)
  }
  return root
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

export const PINNED_ROWS: TreeRow[] = [
  { key: DOCUMENT_KEY, kind: 'document', name: 'document', path: '', depth: 0 },
  { key: MIND_KEY, kind: 'mind', name: 'mind', path: '', depth: 0 },
]

/**
 * Visible rows: the pinned document + mind, then the folder tree (folders
 * first). With a query, matching files are listed flat by full path instead.
 */
export function buildRows(files: FileListEntry[], collapsed: ReadonlySet<string>, query = ''): TreeRow[] {
  const q = query.trim()
  if (q) {
    const pinned = PINNED_ROWS.filter(row => fuzzyScore(q, row.name) !== null)
    const matches = files
      .map(entry => ({ entry, score: fuzzyScore(q, entry.path) }))
      .filter((m): m is { entry: FileListEntry; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score || byName(a.entry.path, b.entry.path))
      .map(({ entry }) => ({ key: `file:${entry.path}`, kind: 'file' as const, name: entry.path, path: entry.path, depth: 0, entry, size: entry.size }))
    return [...pinned, ...matches]
  }
  const rows: TreeRow[] = [...PINNED_ROWS]
  const walk = (node: DirNode, depth: number) => {
    for (const dir of [...node.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
      const expanded = !collapsed.has(dir.path)
      rows.push({ key: `dir:${dir.path}`, kind: 'dir', name: dir.name, path: dir.path, depth, fileCount: dir.count, size: dir.size, expanded })
      if (expanded) walk(dir, depth + 1)
    }
    for (const file of [...node.files].sort((a, b) => byName(a.path, b.path))) {
      rows.push({ key: `file:${file.path}`, kind: 'file', name: file.path.split('/').pop() || file.path, path: file.path, depth, entry: file, size: file.size })
    }
  }
  walk(buildTree(files), 0)
  return rows
}

/** Parent folder of a path ('' at the root). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}K`
  return `${(n / (1024 * 1024)).toFixed(1)}M`
}

/** Short protection marker: `ro` read_only, `nd` no_delete, '' none. */
export function protectionMark(protection: string | undefined): string {
  if (protection === 'read_only') return 'ro'
  if (protection === 'no_delete') return 'nd'
  return ''
}

export const PROTECTION_CYCLE = ['none', 'read_only', 'no_delete'] as const
export type Protection = (typeof PROTECTION_CYCLE)[number]

export function nextProtection(current: string | undefined): Protection {
  const i = PROTECTION_CYCLE.indexOf((current ?? 'none') as Protection)
  return PROTECTION_CYCLE[(i + 1) % PROTECTION_CYCLE.length]
}

// --- fuzzy ----------------------------------------------------------------

/**
 * Subsequence match score (higher is better), or null when `query` is not a
 * subsequence of `text`. Substrings, basename hits and word starts rank first.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  const base = t.slice(t.lastIndexOf('/') + 1)
  if (t === q || base === q) return 1000 - t.length
  const sub = t.indexOf(q)
  if (sub >= 0) return 500 + (base.includes(q) ? 200 : 0) - sub - t.length / 100
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    if (at === prev + 1) score += 5
    if (at === 0 || /[/._\-\s]/.test(t[at - 1])) score += 3
    score -= Math.min(3, at - ti)
    prev = at
    ti = at + 1
  }
  return score - t.length / 100
}

/** Best fuzzy match among candidates (null when nothing matches). */
export function fuzzyBest(query: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestScore = -Infinity
  for (const candidate of candidates) {
    const score = fuzzyScore(query, candidate)
    if (score !== null && score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

export function fuzzyRank(query: string, candidates: string[], limit = 20): string[] {
  return candidates
    .map(c => ({ c, s: fuzzyScore(query, c) }))
    .filter((m): m is { c: string; s: number } => m.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(m => m.c)
}

// --- content --------------------------------------------------------------

export type Lang = 'markdown' | 'json' | 'code' | 'text'

export function langOf(name: string): Lang {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (name === 'document' || name === 'mind' || ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'json' || ext === 'jsonc' || ext === 'webmanifest') return 'json'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'sh', 'bash', 'ps1', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'cs', 'rb', 'yaml', 'yml', 'toml', 'sql', 'css', 'html', 'xml', 'ini'].includes(ext)) return 'code'
  return 'text'
}

/** A text body contains NUL or mostly control bytes → treat as binary. */
export function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true
  const sample = text.slice(0, 4096)
  if (!sample) return false
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) control++
  }
  return control / sample.length > 0.1
}

export interface PreparedContent {
  lines: string[]
  lang: Lang
  /** JSON reformatted for display (the stored file is untouched). */
  pretty: boolean
}

/** Normalize for display: CRLF → LF, tabs → 2 spaces, other control chars → '.'. */
export function displayLine(line: string): string {
  return line.replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '.')
}

export function prepareContent(text: string, name: string): PreparedContent {
  const lang = langOf(name)
  let body = text.replace(/\r\n?/g, '\n')
  let pretty = false
  if (lang === 'json' && body.trim() && body.trim().split('\n').length < 3) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2)
      pretty = true
    } catch { /* show as-is */ }
  }
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return { lines: body.split('\n').map(displayLine), lang, pretty }
}

/** Classic 16-byte hex dump of the first `max` bytes. */
export function hexDump(bytes: Uint8Array, max = 256): string[] {
  const out: string[] = []
  const n = Math.min(bytes.length, max)
  for (let off = 0; off < n; off += 16) {
    const chunk = Array.from(bytes.subarray(off, Math.min(n, off + 16)))
    const hex = chunk.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)
    const ascii = chunk.map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    out.push(`${off.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`)
  }
  return out
}

// --- line styling -----------------------------------------------------------

export type Tone = 'text' | 'muted' | 'dim' | 'accent' | 'live' | 'info' | 'success' | 'warn' | 'loop'

export interface Segment {
  text: string
  tone?: Tone
  bold?: boolean
  italic?: boolean
  /** Search hit (current = the one n/N is on). */
  match?: 'hit' | 'current'
}

function inlineMarkdown(text: string, base: Tone = 'text'): Segment[] {
  const out: Segment[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), tone: base })
    if (m[1]) out.push({ text: m[0], tone: 'live' })
    else if (m[2]) out.push({ text: m[0], tone: base, bold: true })
    else out.push({ text: m[0], tone: 'info' })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), tone: base })
  return out
}

/** Per-line syntax-light styling. Keeps every character (segments join to the line). */
export function styleLines(lines: string[], lang: Lang): Segment[][] {
  if (lang === 'markdown') {
    let fence = false
    return lines.map(line => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence
        return [{ text: line, tone: 'dim' }]
      }
      if (fence) return [{ text: line, tone: 'live' }]
      const heading = line.match(/^(#{1,6}\s)(.*)$/)
      if (heading) return [{ text: heading[1], tone: 'dim' }, { text: heading[2], tone: 'accent', bold: true }]
      const list = line.match(/^(\s*(?:[-*+]|\d+[.)])\s(?:\[[ xX]\]\s)?)(.*)$/)
      if (list) return [{ text: list[1], tone: 'accent' }, ...inlineMarkdown(list[2])]
      const quote = line.match(/^(\s*>\s?)(.*)$/)
      if (quote) return [{ text: quote[1], tone: 'dim' }, ...inlineMarkdown(quote[2], 'muted')]
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [{ text: line, tone: 'dim' }]
      return inlineMarkdown(line)
    })
  }
  if (lang === 'json') {
    return lines.map(line => {
      const out: Segment[] = []
      const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g
      let last = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(line))) {
        if (m.index > last) out.push({ text: line.slice(last, m.index), tone: 'text' })
        if (m[1] && m[2]) { out.push({ text: m[1], tone: 'info' }); out.push({ text: m[2], tone: 'dim' }) }
        else if (m[1]) out.push({ text: m[1], tone: 'success' })
        else if (m[3] || m[4]) out.push({ text: m[0], tone: 'warn' })
        else out.push({ text: m[0], tone: 'dim' })
        last = m.index + m[0].length
      }
      if (last < line.length) out.push({ text: line.slice(last), tone: 'text' })
      return out
    })
  }
  if (lang === 'code') {
    return lines.map(line => {
      const comment = line.match(/^(.*?)(\s*(?:\/\/|#(?!!)|--\s).*)$/)
      const [code, rest] = comment && !/["'`]/.test(comment[1]) ? [comment[1], comment[2]] : [line, '']
      const out: Segment[] = []
      const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g
      let last = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(code))) {
        if (m.index > last) out.push({ text: code.slice(last, m.index), tone: 'text' })
        out.push({ text: m[0], tone: 'success' })
        last = m.index + m[0].length
      }
      if (last < code.length) out.push({ text: code.slice(last), tone: 'text' })
      if (rest) out.push({ text: rest, tone: 'dim', italic: true })
      return out
    })
  }
  return lines.map(line => [{ text: line, tone: 'text' }])
}

/** Case-insensitive search hits as [line, start, end]. */
export function findMatches(lines: string[], query: string): Array<{ line: number; start: number; end: number }> {
  const q = query.toLowerCase()
  if (!q) return []
  const out: Array<{ line: number; start: number; end: number }> = []
  lines.forEach((line, i) => {
    const lower = line.toLowerCase()
    let at = lower.indexOf(q)
    while (at >= 0) {
      out.push({ line: i, start: at, end: at + q.length })
      at = lower.indexOf(q, at + Math.max(1, q.length))
    }
  })
  return out
}

/** Split segments at [start,end) ranges and mark them as matches. */
export function markRanges(segments: Segment[], ranges: Array<{ start: number; end: number; current: boolean }>): Segment[] {
  if (ranges.length === 0) return segments
  const out: Segment[] = []
  let pos = 0
  for (const seg of segments) {
    const segStart = pos
    const segEnd = pos + seg.text.length
    let cursor = segStart
    for (const r of ranges) {
      if (r.end <= cursor || r.start >= segEnd) continue
      const s = Math.max(r.start, cursor)
      const e = Math.min(r.end, segEnd)
      if (s > cursor) out.push({ ...seg, text: seg.text.slice(cursor - segStart, s - segStart) })
      out.push({ ...seg, text: seg.text.slice(s - segStart, e - segStart), match: r.current ? 'current' : 'hit' })
      cursor = e
    }
    if (cursor < segEnd) out.push({ ...seg, text: seg.text.slice(cursor - segStart) })
    pos = segEnd
  }
  return out
}

/** Wrap one styled line into rows of at most `width` characters (never drops text). */
export function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const w = Math.max(1, width)
  const rows: Segment[][] = [[]]
  let used = 0
  for (const seg of segments) {
    let text = seg.text
    while (text.length > 0) {
      const room = w - used
      if (room <= 0) {
        rows.push([])
        used = 0
        continue
      }
      const piece = Array.from(text).slice(0, room).join('')
      rows[rows.length - 1].push({ ...seg, text: piece })
      used += Array.from(piece).length
      text = text.slice(piece.length)
    }
  }
  return rows
}

// --- diff -------------------------------------------------------------------

export interface LineChange {
  sign: '+' | '-'
  text: string
  /** 1-based line number in the old (-) or new (+) text. */
  line: number
}

export interface DiffSummary {
  added: number
  removed: number
  changes: LineChange[]
}

const MAX_LCS_CELLS = 4_000_000

/** Line diff: common prefix/suffix trimmed, LCS on the middle (bounded). */
export function diffLines(before: string, after: string): DiffSummary {
  const a = before.replace(/\r\n?/g, '\n').split('\n')
  const b = after.replace(/\r\n?/g, '\n').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const changes: LineChange[] = []
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    midA.forEach((text, i) => changes.push({ sign: '-', text, line: start + i + 1 }))
    midB.forEach((text, i) => changes.push({ sign: '+', text, line: start + i + 1 }))
  } else {
    const n = midA.length
    const m = midB.length
    const table = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] = midA[i] === midB[j]
          ? table[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { i++; j++ }
      else if (j < m && (i >= n || table[i * (m + 1) + j + 1] >= table[(i + 1) * (m + 1) + j])) {
        changes.push({ sign: '+', text: midB[j], line: start + j + 1 })
        j++
      } else {
        changes.push({ sign: '-', text: midA[i], line: start + i + 1 })
        i++
      }
    }
  }
  return {
    added: changes.filter(c => c.sign === '+').length,
    removed: changes.filter(c => c.sign === '-').length,
    changes,
  }
}

/** "+3 −1 lines · 120 → 142 bytes" plus up to `preview` changed lines. */
export function describeDiff(before: string, after: string, preview = 6): { summary: string; lines: string[] } {
  const diff = diffLines(before, after)
  const bytes = (s: string) => Buffer.byteLength(s, 'utf-8')
  const summary = `+${diff.added} -${diff.removed} lines, ${bytes(before)} -> ${bytes(after)} bytes`
  const lines = diff.changes.slice(0, preview).map(c => `${c.sign}${String(c.line).padStart(4)} ${c.text.length > 70 ? `${c.text.slice(0, 69)}…` : c.text}`)
  if (diff.changes.length > preview) lines.push(`  … ${diff.changes.length - preview} more changed lines`)
  return { summary, lines }
}
