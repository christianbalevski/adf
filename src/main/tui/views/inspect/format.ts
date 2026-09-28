// Pure formatting for the inspector and the report dialogs: any JSON value →
// display lines, either as a readable tree (YAML-ish) or as raw JSON (/json).
// Secret-looking values are redacted before anything is rendered.

export type Tone = 'text' | 'key' | 'string' | 'number' | 'bool' | 'null' | 'muted' | 'dim' | 'heading' | 'accent' | 'loop' | 'live' | 'success' | 'warn' | 'error'

export interface Segment {
  text: string
  tone?: Tone
  bold?: boolean
}

export type Line = Segment[]

export const REDACTED = '[redacted]'

const SECRET_KEY = /(^|[_-])(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|passphrase|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|session[_-]?token|token|credentials?)$/i
const SECRET_CAMEL = /(apiKey|ApiKey|Secret|Password|PrivateKey|AccessToken|RefreshToken|IdToken|AuthToken|BearerToken|SessionToken)$/
/** Containers whose values are secrets by construction (env vars, HTTP headers). */
const SECRET_CONTAINER = /^(env|headers|secrets|credentials)$/i

export function isSecretKey(key: string): boolean {
  if (/(EnvVar|_env_var|Env)$/.test(key)) return false
  return SECRET_KEY.test(key) || SECRET_CAMEL.test(key)
}

/** Deep copy with secret-looking values replaced. Never mutates the input. */
export function redactSecrets(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, parentKey))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  const containerIsSecret = SECRET_CONTAINER.test(parentKey)
  for (const [key, child] of Object.entries(value)) {
    if ((containerIsSecret && typeof child === 'string') || (isSecretKey(key) && isSecretValue(child))) {
      out[key] = child === '' ? '' : REDACTED
    } else {
      out[key] = redactSecrets(child, key)
    }
  }
  return out
}

function isSecretValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || (isPlainObject(value) && Object.keys(value).length > 0)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- tree ---------------------------------------------------------------------

const INLINE_ARRAY_MAX = 72

function scalar(value: unknown): Segment {
  if (value === null || value === undefined) return { text: String(value), tone: 'null' }
  if (typeof value === 'string') return { text: value === '' ? '""' : value, tone: value === REDACTED ? 'warn' : 'string' }
  if (typeof value === 'number') return { text: String(value), tone: 'number' }
  if (typeof value === 'boolean') return { text: String(value), tone: 'bool' }
  return { text: String(value), tone: 'text' }
}

function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object'
}

function inlineArray(value: unknown[]): string | null {
  if (!value.every(v => isScalar(v) && !(typeof v === 'string' && v.includes('\n')))) return null
  const text = `[${value.map(v => (typeof v === 'string' ? v : String(v))).join(', ')}]`
  return text.length <= INLINE_ARRAY_MAX ? text : null
}

/** A readable, indented tree. Multi-line strings keep their lines. */
export function treeLines(value: unknown, indent = 0): Line[] {
  const pad = (n: number): Segment => ({ text: ' '.repeat(n) })
  if (isScalar(value)) return stringLines(value, indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [[pad(indent), { text: '[]', tone: 'muted' }]]
    const lines: Line[] = []
    for (const item of value) {
      const child = isScalar(item) ? stringLines(item, indent + 2) : treeLines(item, indent + 2)
      if (child.length === 0) continue
      const [first, ...rest] = child
      lines.push([pad(indent), { text: '- ', tone: 'muted' }, ...first.slice(1)], ...rest)
    }
    return lines
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return [[pad(indent), { text: '{}', tone: 'muted' }]]
  const lines: Line[] = []
  for (const [key, child] of entries) {
    const keySeg: Segment = { text: `${key}:`, tone: 'key' }
    if (isScalar(child)) {
      if (typeof child === 'string' && child.includes('\n')) {
        lines.push([pad(indent), keySeg, { text: ' |', tone: 'muted' }], ...stringLines(child, indent + 2))
      } else {
        lines.push([pad(indent), keySeg, { text: ' ' }, scalar(child)])
      }
    } else if (Array.isArray(child)) {
      const inline = child.length === 0 ? '[]' : inlineArray(child)
      if (inline) lines.push([pad(indent), keySeg, { text: ' ' }, { text: inline, tone: child.length ? 'string' : 'muted' }])
      else lines.push([pad(indent), keySeg], ...treeLines(child, indent + 2))
    } else if (Object.keys(child as object).length === 0) {
      lines.push([pad(indent), keySeg, { text: ' {}', tone: 'muted' }])
    } else {
      lines.push([pad(indent), keySeg], ...treeLines(child, indent + 2))
    }
  }
  return lines
}

function stringLines(value: unknown, indent: number): Line[] {
  const pad: Segment = { text: ' '.repeat(indent) }
  if (typeof value === 'string' && value.includes('\n')) {
    return value.split('\n').map(line => [pad, { text: line, tone: 'string' as Tone }])
  }
  return [[pad, scalar(value)]]
}

// --- raw JSON -------------------------------------------------------------------

const JSON_LINE = /^(\s*)("(?:[^"\\]|\\.)*")(:\s?)?(.*)$/

/** Pretty-printed JSON, lightly colored (keys vs values). */
export function jsonLines(value: unknown): Line[] {
  let text: string
  try { text = JSON.stringify(value, null, 2) ?? 'undefined' } catch (err) { text = `/* not serializable: ${err instanceof Error ? err.message : String(err)} */` }
  return text.split('\n').map(line => {
    const m = line.match(JSON_LINE)
    if (m && m[3]) return [{ text: m[1] }, { text: m[2], tone: 'key' as Tone }, { text: m[3] }, ...valueSegments(m[4])]
    const lead = line.match(/^\s*/)?.[0] ?? ''
    return [{ text: lead }, ...valueSegments(line.slice(lead.length))]
  })
}

function valueSegments(text: string): Segment[] {
  if (!text) return []
  const trimmed = text.replace(/,$/, '')
  const comma = trimmed.length < text.length ? ',' : ''
  let tone: Tone = 'text'
  if (/^"/.test(trimmed)) tone = trimmed === `"${REDACTED}"` ? 'warn' : 'string'
  else if (/^-?\d/.test(trimmed)) tone = 'number'
  else if (trimmed === 'true' || trimmed === 'false') tone = 'bool'
  else if (trimmed === 'null') tone = 'null'
  else tone = 'muted'
  return comma ? [{ text: trimmed, tone }, { text: comma, tone: 'muted' }] : [{ text: trimmed, tone }]
}

/** Tree or raw JSON, always redacted. */
export function valueLines(value: unknown, raw: boolean): Line[] {
  const safe = redactSecrets(value)
  return raw ? jsonLines(safe) : treeLines(safe)
}

// --- helpers --------------------------------------------------------------------

export function heading(text: string): Line {
  return [{ text, tone: 'heading', bold: true }]
}

export function plain(text: string, tone: Tone = 'text'): Line {
  return [{ text, tone }]
}

export function blank(): Line {
  return [{ text: '' }]
}

export function lineText(line: Line): string {
  return line.map(s => s.text).join('')
}

/** Fixed-width text table as lines (header muted, cells padded). */
export function tableLines(headers: string[], rows: string[][], options: { align?: Array<'left' | 'right'>; maxWidth?: number } = {}): Line[] {
  const widths = headers.map((h, i) => Math.min(options.maxWidth ?? 40, Math.max(h.length, ...rows.map(r => (r[i] ?? '').length))))
  const cell = (text: string, i: number) => {
    const cut = text.length > widths[i] ? `${text.slice(0, Math.max(0, widths[i] - 1))}…` : text
    return options.align?.[i] === 'right' ? cut.padStart(widths[i]) : cut.padEnd(widths[i])
  }
  const out: Line[] = [[{ text: headers.map(cell).join('  ').trimEnd(), tone: 'muted', bold: true }]]
  if (rows.length === 0) out.push(plain('(none)', 'muted'))
  for (const row of rows) out.push([{ text: headers.map((_, i) => cell(row[i] ?? '', i)).join('  ').trimEnd() }])
  return out
}

/** 3725000 → "1h 2m", 42000 → "42s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function formatNumber(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '-'
}
