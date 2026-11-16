/**
 * Importing a SKILL.md someone else wrote: what it declares, whether the ADF
 * skill index reads it, and — only when it does not — an explicit, previewed
 * adjustment of the description.
 *
 * The index's own parser (src/main/adf/skill-indexer.ts `parseSkillFrontmatter`)
 * is the public contract, the authority here, and is NOT changed. A file it
 * already reads installs byte-for-byte, whatever a YAML parser would make of
 * its other lines. It reads `name` and a single-line `description` of at most
 * SKILL_DESCRIPTION_MAX characters. Packages from other ecosystems commonly use a YAML block
 * scalar (`description: |`) or a longer description; only then does rewriting
 * require strict YAML (duplicate keys refused, so nothing is silently lost).
 * Import then rewrites only the `description` entry of the
 * frontmatter, keeps the full original text at the top of the body, and adds a
 * notice that the file was adjusted on install and where it came from. Every
 * other byte of the file is kept. Nothing is translated, no `adf` marker is
 * ever added, and no tool or path in the instructions is adapted.
 *
 * Pure and I/O-free. Its callers run in main (skills-catalog-fetch.ts) and in
 * the terminal app; the index parser is passed in so this shared module does
 * not import main-process code.
 */

import { load as loadYaml, CORE_SCHEMA, FAILSAFE_SCHEMA } from 'js-yaml'
import { MAX_SKILL_FILE_BYTES as MAX_MANIFEST_BYTES, SKILL_DESCRIPTION_MAX, SKILL_NAME, indexScalar, safeText } from '../schemas/skills-catalog.schema'

/** The index's parser, as skill-indexer.ts exports it. */
export type SkillIndexParser = (source: string) => { name: string; description: string } | { error: string }


const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** `adf` compatibility as a manifest declares it. Only a valid declaration is "native". */
export type AdfCompat =
  | { native: true; range: string }
  | { native: false; reason: 'absent' | 'invalid' | 'unreadable'; detail?: string }

/**
 * A version or range the label accepts: comparators (`>=`, `>`, `<=`, `<`,
 * `=`, `^`, `~`, or none) on dotted numeric versions of one to three parts —
 * the shape compareVersions (main/utils/version-compare.ts) and the
 * first-party catalog (`adf: ">=0.2"`) use — optionally two of them separated
 * by a space for a bounded range. Anything else is not a declaration.
 */
const VERSION = String.raw`(?:>=|<=|>|<|=|\^|~)?\s*v?\d{1,6}(?:\.\d{1,6}){0,2}`
const ADF_RANGE = new RegExp(`^${VERSION}(?:\\s+${VERSION})?$`)

/** Parse a SKILL.md's frontmatter as YAML. Duplicate keys are an error, never a silent last-wins. */
export function readSkillFrontmatter(text: string, schema = CORE_SCHEMA): { ok: true; data: Record<string, unknown>; block: string } | { ok: false; error: string } {
  const match = FRONTMATTER.exec(text)
  if (!match) return { ok: false, error: 'missing YAML frontmatter' }
  let data: unknown
  try {
    data = loadYaml(match[1], { schema })
  } catch (err) {
    const reason = (err as { reason?: string }).reason ?? (err instanceof Error ? err.message : String(err))
    return { ok: false, error: `frontmatter is not valid YAML: ${reason}` }
  }
  if (data === null || data === undefined) data = {}
  if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'frontmatter is not a YAML mapping' }
  return { ok: true, data: data as Record<string, unknown>, block: match[1] }
}

/**
 * The label of a SKILL.md's text: native only for a valid explicit `adf`
 * declaration. Read valid YAML as a mapping, preserving scalar spellings
 * (version 0.20 must not become number 0.2). For non-YAML indexable manifests,
 * fall back to the index's single-line scalar rule. Duplicate keys are refused.
 */
export function readAdfCompat(text: string | null | undefined): AdfCompat {
  if (!text) return { native: false, reason: 'unreadable' }
  const block = FRONTMATTER.exec(text)?.[1]
  if (block === undefined) return { native: false, reason: 'unreadable', detail: 'missing YAML frontmatter' }
  const parsed = readSkillFrontmatter(text, FAILSAFE_SCHEMA)
  let declaration: unknown
  if (parsed.ok) {
    if (!Object.hasOwn(parsed.data, 'adf')) return { native: false, reason: 'absent' }
    declaration = parsed.data.adf
  } else {
    if (parsed.error.includes('duplicated mapping key')) return { native: false, reason: 'unreadable', detail: parsed.error }
    const lines = block.split(/\r?\n/).flatMap((line) => /^(?:adf|"adf"|'adf'):(.*)$/.exec(line)?.[1] ?? [])
    if (lines.length > 1) return { native: false, reason: 'unreadable', detail: 'duplicate adf' }
    if (lines.length === 0) return { native: false, reason: 'absent' }
    declaration = indexScalar(lines[0])
  }
  const value = typeof declaration === 'string' ? declaration.trim() : null
  if (!value || !ADF_RANGE.test(value)) return { native: false, reason: 'invalid', detail: `adf must be a version such as ">=0.2"` }
  return { native: true, range: value }
}

/** What a label says, and what its tooltip explains. */
export function adfCompatLabel(compat: AdfCompat): { native: boolean; text: string; title: string } {
  if (compat.native) {
    return {
      native: true,
      text: `ADF ${compat.range}`,
      title: `The package declares adf: "${compat.range}" in its SKILL.md frontmatter. This is the publisher's declaration of the ADF version it targets; it is not a review, a trust signal, or a check that it works.`,
    }
  }
  const why = compat.reason === 'absent'
    ? 'Its SKILL.md declares no adf version.'
    : compat.reason === 'invalid'
      ? `Its adf declaration is not a version (${compat.detail ?? 'unreadable'}).`
      : `Its SKILL.md frontmatter could not be read${compat.detail ? ` (${compat.detail})` : ''}.`
  return {
    native: false,
    text: 'Not ADF-native',
    title: `${why} It does not declare ADF compatibility, so its instructions may assume tools, paths or commands an ADF agent does not have. This label is about the declaration only; nothing was adapted.`,
  }
}

/**
 * Shorten a description to the index's bound: the longest prefix ending at a
 * sentence end (`.`, `!`, `?` then a space or the end) within the bound, else
 * the longest whole-word prefix within the bound less one, plus `…`.
 * Deterministic and input-only.
 */
export function shortenDescription(folded: string, max = SKILL_DESCRIPTION_MAX): string {
  if (folded.length <= max) return folded
  let best = -1
  for (let i = 0; i < max; i++) {
    const c = folded[i]
    if ((c === '.' || c === '!' || c === '?') && (i + 1 === folded.length || folded[i + 1] === ' ')) best = i + 1
  }
  if (best > 0) return folded.slice(0, best)
  const window = folded.slice(0, max)
  const space = window.lastIndexOf(' ')
  const cut = space > 0 ? folded.slice(0, space) : folded.slice(0, max - 1)
  return `${cut.replace(/[\s,;:]+$/, '')}…`
}

/** One import decision for a manifest. */
export type ManifestImport =
  | {
      ok: true
      /** The name the package installs under: the frontmatter name. */
      name: string
      /** The description the index will publish. */
      description: string
      /** The bytes to install: the source text, or the adjusted text when `changes` is non-empty. */
      manifest: string
      /** Human sentences for each adjustment; empty when the source installs byte-for-byte. */
      changes: string[]
      /** The description as the source wrote it (YAML value), when it was adjusted. */
      originalDescription?: string
      compat: AdfCompat
    }
  | { ok: false; error: string; compat: AdfCompat }

/**
 * The decision for a catalog entry: a SKILL.md that names another skill than
 * the entry is refused, in one text, for every host.
 */
export function importAs(imp: ManifestImport, expectedName?: string): ManifestImport {
  if (!imp.ok || !expectedName || imp.name === expectedName) return imp
  return { ok: false, compat: imp.compat, error: `The catalog lists "${expectedName}" but its SKILL.md is named "${imp.name}".` }
}

/**
 * Decide how a SKILL.md imports. `source` is where it was fetched from, named
 * in the notice an adjusted file carries.
 */
export function importSkillManifest(text: string, source: string, indexParse: SkillIndexParser): ManifestImport {
  // The label reads the declaration without changing the installed bytes.
  const compat = readAdfCompat(text)
  // The index's bounds on the file itself, for every source (catalog, GitHub, URL, local).
  if (text.slice(0, 8192).includes('\u0000')) return { ok: false, error: 'SKILL.md is not text', compat }
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) return { ok: false, error: `SKILL.md is over ${MAX_MANIFEST_BYTES / 1024} KB, the ADF index reads at most that`, compat }
  // The index reads it already: install the source bytes, unchanged.
  const indexed = indexParse(text)
  if (!('error' in indexed)) return { ok: true, name: indexed.name, description: indexed.description, manifest: text, changes: [], compat }

  // It needs adapting: only then is the frontmatter read as strict YAML.
  const fm = readSkillFrontmatter(text)
  if (!fm.ok) return { ok: false, error: fm.error === indexed.error ? fm.error : `${indexed.error}; ${fm.error}`, compat }
  const fail = (error: string): ManifestImport => ({ ok: false, error, compat })
  const name = fm.data.name
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
    return fail(`invalid skill name ${JSON.stringify(typeof name === 'string' ? name.slice(0, 80) : name ?? null)}: use lowercase letters, digits and hyphens (at most 64)`)
  }
  const description = fm.data.description
  if (typeof description !== 'string' || !description.trim()) return fail('description must be a non-empty text value')
  if (!safeText(description.replace(/[\t\n\r]/g, ' '))) return fail('description contains control or bidirectional-override characters')

  const folded = description.replace(/\s+/g, ' ').trim()
  const short = shortenDescription(folded)
  const changes: string[] = []
  // Leading or trailing whitespace alone is not a fold: no notice claims one.
  if (folded !== description.trim()) changes.push('description folded onto one line (YAML whitespace only)')
  if (short !== folded) changes.push(`description shortened from ${folded.length} to ${short.length} characters for the ADF index; the full text is kept at the top of the body`)
  if (changes.length === 0) changes.push('description rewritten as a quoted single-line value the ADF index reads')

  const rewritten = rewriteDescription(text, fm.block, short)
  if ('error' in rewritten) return fail(rewritten.error)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const quoted = description.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map((line) => (line ? `> ${line}` : '>')).join(eol)
  const note = [
    `<!-- Adjusted on install by ADF Studio: ${changes.join('; ')}. Source: ${source.replace(/--/g, '-%2D')} -->`,
    '',
    '> **Original description (from the source package):**',
    '>',
    quoted,
    '',
    '',
  ].join(eol)
  const manifest = rewritten.head + note + rewritten.body
  if (Buffer.byteLength(manifest, 'utf8') > MAX_MANIFEST_BYTES) return fail(`SKILL.md would exceed ${MAX_MANIFEST_BYTES} bytes after the description note`)

  const check = indexParse(manifest)
  if ('error' in check) return fail(`the adjusted SKILL.md still does not index: ${check.error}`)
  if (check.name !== name || check.description !== short) return fail('the adjusted SKILL.md does not index as intended')
  return { ok: true, name, description: short, manifest, changes, originalDescription: description, compat }
}

/**
 * Replace the top-level `description` entry (its key line and its indented or
 * blank continuation lines) with one double-quoted line, keeping every other
 * frontmatter line byte-for-byte. Returns the text up to and including the
 * closing `---` line, and the untouched body after it.
 */
function rewriteDescription(text: string, block: string, value: string): { head: string; body: string } | { error: string } {
  const match = FRONTMATTER.exec(text)
  if (!match) return { error: 'missing YAML frontmatter' }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = block.split(/\r?\n/)
  const keys = lines.flatMap((line, index) => (/^description\s*:/.test(line) ? [index] : []))
  if (keys.length !== 1) return { error: 'the description entry is not a plain top-level key the import can rewrite' }
  const start = keys[0]
  let end = start + 1
  let lastContent = start
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) {
    if (lines[end].trim() !== '') lastContent = end
    end++
  }
  const next = [...lines.slice(0, start), `description: ${JSON.stringify(value)}`, ...lines.slice(lastContent + 1)]
  const head = `---${eol}${next.join(eol)}${eol}---${match[2] || eol}`
  return { head, body: text.slice(match[0].length) }
}
