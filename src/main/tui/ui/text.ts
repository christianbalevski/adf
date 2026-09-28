// Plain-text helpers for fixed-width layout. No ANSI in, none out.

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\uD83C-\uD83E][\uDC00-\uDFFF]/
/** Combining marks, zero-width spaces/joiners, variation selectors. */
function isZeroWidth(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)
}

/** Terminal cell width of a string (wide CJK/emoji = 2, combining marks = 0). */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    if (isZeroWidth(ch)) continue
    width += WIDE.test(ch) ? 2 : 1
  }
  return width
}

/**
 * Truncate to `max` cells, ending with `ellipsis` when cut. For one-line
 * layout: line breaks become spaces (a multi-line goal must not wrap a row).
 */
export function truncate(input: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return ''
  const text = input.includes('\n') ? input.replace(/\s*\r?\n\s*/g, ' ') : input
  if (displayWidth(text) <= max) return text
  const room = Math.max(0, max - displayWidth(ellipsis))
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = isZeroWidth(ch) ? 0 : WIDE.test(ch) ? 2 : 1
    if (width + w > room) break
    out += ch
    width += w
  }
  return out + ellipsis
}

/** Pad (or truncate) to exactly `width` cells. */
export function fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const cut = truncate(text, width)
  const pad = ' '.repeat(Math.max(0, width - displayWidth(cut)))
  return align === 'right' ? pad + cut : cut + pad
}

/** First line only, whitespace collapsed — for one-line previews. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Rows a block of text occupies when wrapped at `width` cells. */
export function wrappedHeight(text: string, width: number): number {
  if (width <= 0) return 1
  let rows = 0
  for (const line of text.split('\n')) rows += Math.max(1, Math.ceil(displayWidth(line) / width))
  return rows
}

/** 1234 → 1.2k, 1234567 → 1.2M. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "3s", "4m", "2h", "5d" ago-style duration. */
export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** HH:MM:SS in local time. */
export function formatClock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** "every 1h", "cron 0 * * * *", "once 14:00" — human timer schedule. */
export function formatEveryMs(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

/** JSON preview on one line, capped. */
export function previewJson(value: unknown, max = 120): string {
  if (value === undefined) return ''
  let text: string
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
  return truncate(oneLine(text ?? ''), max)
}
