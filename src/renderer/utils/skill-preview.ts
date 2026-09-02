/**
 * Pure helpers behind the catalog's skill preview.
 *
 * A previewed SKILL.md is remote text nobody in this process has vetted: it was
 * fetched from whatever URL a catalog named, and it is shown BEFORE anyone has
 * decided to install it. So this module does two things and no I/O — split the
 * document into a frontmatter header and a body, and make both safe to paint.
 *
 * The split is for DISPLAY ONLY. It is deliberately more forgiving than
 * `parseSkillFrontmatter` in the indexer (src/main/adf/skill-indexer.ts), which
 * decides whether a package indexes: a preview that refused to render anything
 * the indexer would reject would hide exactly the document a human opened the
 * preview to inspect.
 */

/** One frontmatter row as the preview's header block shows it. */
export interface SkillFrontmatterField {
  key: string
  value: string
}

export interface ParsedSkillDocument {
  /** True only for a document that opens with a terminated `---` block. */
  hasFrontmatter: boolean
  /** Top-level `key: value` rows, in first-appearance order. */
  fields: SkillFrontmatterField[]
  /** Everything after the frontmatter — the whole document when there is none. */
  body: string
}

/** Header rows the preview will paint. A document with more is not a header. */
export const MAX_PREVIEW_FIELDS = 24

/** Longest frontmatter value the header block shows before eliding. */
export const MAX_PREVIEW_FIELD_CHARS = 300

/**
 * Characters that can lie about what a block of text says.
 *
 * The single-line `sanitizeDisplayText` in skills-panel.ts strips C0/C1
 * controls and the bidi overrides, then collapses whitespace — which is right
 * for a name in a table cell and wrong for a document body, where the line
 * breaks and indentation ARE the content. This is the same character set minus
 * TAB (U+0009) and LF (U+000A), which are kept.
 */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNSAFE_BLOCK_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/**
 * Render-safe multi-line text: CR/CRLF normalized to LF, then controls and bidi
 * marks removed with newlines and tabs preserved. A bidi override deleted from a
 * body cannot flip the rest of the paragraph; a deleted control character cannot
 * smuggle a line break the layout does not show.
 */
export function sanitizeDisplayBlock(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\r\n?/g, '\n').replace(UNSAFE_BLOCK_CHARS, '')
}

/**
 * Shorten a long string from the MIDDLE, keeping both ends.
 *
 * For the URL a package is fetched from, the ends are the whole point: the host
 * says who is serving it and the tail says which file, while the middle is the
 * repository path nobody reads. A plain `truncate` would keep the host and hide
 * the filename — the half that answers "is this the skill I clicked?". The full
 * string still rides in the element's `title`.
 */
export function elideMiddle(value: string, max: number): string {
  if (max < 3 || value.length <= max) return value
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return value.slice(0, head) + '…' + value.slice(value.length - (keep - head))
}

/** Strip one layer of matching quotes from a frontmatter value. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Split a SKILL.md into its frontmatter fields and its body.
 *
 * Frontmatter counts only when the document OPENS with `---` on its own line and
 * a later `---` closes it — an unterminated opener is a document that happens to
 * start with a horizontal rule, not a header, and is returned whole as body
 * rather than swallowing the file into a key/value table.
 *
 * Within the block: `key: value` on a top-level line starts a field, an indented
 * continuation line appends to the field above it, and `- item` list rows join
 * with commas so a `requires:` block reads as one row instead of nothing. Blank
 * lines and `#` comments are skipped. A repeated key overwrites in place, which
 * is YAML's own last-wins rule, so the header never shows a key twice.
 *
 * Everything is bounded — MAX_PREVIEW_FIELDS rows, MAX_PREVIEW_FIELD_CHARS per
 * value — because the document is remote and the header block is chrome, not
 * content: the body below it is where a long field belongs.
 */
export function splitSkillDocument(text: string | null | undefined): ParsedSkillDocument {
  const source = sanitizeDisplayBlock(text)
  if (!source) return { hasFrontmatter: false, fields: [], body: '' }

  const match = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(source)
  if (!match) return { hasFrontmatter: false, fields: [], body: source.trim() }

  const fields: SkillFrontmatterField[] = []
  const index = new Map<string, number>()
  let last: SkillFrontmatterField | null = null

  const append = (extra: string): void => {
    if (!last || !extra) return
    last.value = last.value ? `${last.value} ${extra}` : extra
  }

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) { last = null; continue }
    if (line.trim().startsWith('#')) continue

    const indented = /^\s/.test(line)
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem) {
      const item = unquote(listItem[1])
      if (last) last.value = last.value ? `${last.value}, ${item}` : item
      continue
    }
    if (indented) { append(line.trim()); continue }

    const pair = /^([^:]+):\s*(.*)$/.exec(line)
    if (!pair) { append(line.trim()); continue }

    const key = pair[1].trim()
    if (!key) continue
    const value = unquote(pair[2])
    const existing = index.get(key)
    if (existing !== undefined) {
      fields[existing].value = value
      last = fields[existing]
      continue
    }
    if (fields.length >= MAX_PREVIEW_FIELDS) { last = null; continue }
    const field = { key, value }
    index.set(key, fields.length)
    fields.push(field)
    last = field
  }

  for (const field of fields) {
    if (field.value.length > MAX_PREVIEW_FIELD_CHARS) {
      field.value = field.value.slice(0, MAX_PREVIEW_FIELD_CHARS) + '…'
    }
  }

  return { hasFrontmatter: true, fields, body: source.slice(match[0].length).trim() }
}
