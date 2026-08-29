/**
 * Pure helpers behind the Skills panel.
 *
 * Everything here is I/O-free and independently testable: the panel owns the
 * IPC and the React state, this module owns the decisions those depend on —
 * how a state-file edit merges, what a catalog row has to look like before it
 * is worth persisting, and how much of a runtime-generated document is safe to
 * paint into the UI.
 */

import { ADF_SKILLS_REGISTRY_URL } from '../../shared/constants/adf-defaults'
import type { SkillCatalogEntry } from '../../shared/schemas/skills-catalog.schema'

export const SKILLS_REGISTRY_PATH = 'skills-registry.json'
export const SKILLS_STATE_PATH = 'skills-state.json'

/** Matches a skill package manifest. Mirrors `SKILL_FILE_PATH` in src/main/adf/skill-indexer.ts. */
export const SKILL_MANIFEST = /^skills\/([^/]+)\/SKILL\.md$/

/** Indexer bounds, restated for the panel's diagnostics (src/main/adf/skill-indexer.ts). */
export const MAX_SKILLS = 48
export const MAX_REGISTRY_BYTES = 32 * 1024
export const MAX_SKILL_FILE_BYTES = 256 * 1024

export interface RegistryEntry {
  name: string
  description?: string
  path: string
  enabled: boolean
}

/** One indexer rejection, as the registry publishes it. */
export interface RegistryRejection {
  path: string
  reason: string
  /** Package directory the path names, when it has the manifest shape. */
  name: string | null
}

export interface ParsedRegistry {
  entries: RegistryEntry[]
  rejected: RegistryRejection[]
}

/**
 * Tolerant read of the derived catalog. A registry we can't parse is treated as
 * absent — the panel then says so rather than rendering half a document.
 *
 * `rejected` is optional: an older registry, or one written before the indexer
 * started publishing reasons, simply carries none.
 */
export function parseSkillsRegistry(text: string | null | undefined): ParsedRegistry | null {
  if (!text) return null
  try {
    const doc = JSON.parse(text) as { schema?: unknown; skills?: unknown; rejected?: unknown }
    if (doc?.schema !== 1 || typeof doc.skills !== 'object' || doc.skills === null) return null
    const entries: RegistryEntry[] = []
    for (const value of Object.values(doc.skills as Record<string, unknown>)) {
      const skill = value as Partial<RegistryEntry>
      if (typeof skill?.name !== 'string' || typeof skill?.path !== 'string') continue
      entries.push({
        name: skill.name,
        description: typeof skill.description === 'string' ? skill.description : undefined,
        path: skill.path,
        enabled: skill.enabled !== false
      })
    }
    const rejected: RegistryRejection[] = []
    if (Array.isArray(doc.rejected)) {
      for (const raw of doc.rejected) {
        const row = raw as { path?: unknown; reason?: unknown }
        if (typeof row?.path !== 'string' || typeof row?.reason !== 'string') continue
        rejected.push({ path: row.path, reason: row.reason, name: SKILL_MANIFEST.exec(row.path)?.[1] ?? null })
      }
    }
    return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), rejected }
  } catch {
    return null
  }
}

/**
 * Apply one mute/unmute to `skills-state.json` and return the bytes to write.
 *
 * Merges into the parsed document rather than replacing it: a key this build
 * does not know about (a newer schema field, an agent's own annotation) has to
 * survive a human clicking a checkbox. Only `disabled` is authored here.
 *
 * A document that is not a JSON object is not merge-able and is replaced — the
 * alternative is refusing every toggle until a human repairs the file by hand.
 */
export function mergeDisabledList(
  existingText: string | null | undefined,
  name: string,
  enabled: boolean
): string {
  let doc: Record<string, unknown> = {}
  if (existingText) {
    try {
      const parsed: unknown = JSON.parse(existingText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>
      }
    } catch { /* corrupt state file: replaced rather than merged */ }
  }
  const current = Array.isArray(doc.disabled)
    ? doc.disabled.filter((entry: unknown): entry is string => typeof entry === 'string')
    : []
  const next = new Set(current)
  if (enabled) next.delete(name)
  else next.add(name)
  return JSON.stringify({ ...doc, schema: 1, disabled: [...next].sort() }, null, 2) + '\n'
}

/**
 * Characters that can lie about what a string says: C0/C1 controls, and the
 * bidi overrides/isolates that can make a name render as something other than
 * what it is (a U+202E before `gnp.dm` paints it as `md.png`). Catalog
 * text and SKILL.md frontmatter are remote data, so strip them before painting
 * a row. (The main-side schemas reject the worst of it too; this is the second
 * layer, not the only one.)
 */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/** Render-safe single line: controls and bidi marks removed, whitespace collapsed. */
export function sanitizeDisplayText(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(UNSAFE_DISPLAY_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Is this a catalog URL the main-side fetch will even attempt? guarded-fetch.ts
 * refuses anything but https, so the browser's URL box can say so before the
 * round trip rather than after it.
 */
export function isCatalogUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    return new URL(trimmed).protocol === 'https:'
  } catch {
    return false
  }
}

/** Rough prompt cost of the injected catalog — bytes are all the panel can see. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4)
}

/* -------------------------------------------------------------------------- */
/* Catalog sources                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The catalog browser reads a LIST of sources, not one URL. The list is a
 * user/app preference (persisted in app settings under `skillCatalogSources`),
 * never per-agent config: which registries a human likes to browse says nothing
 * about the agent they happen to have open, and the deliberately-removed
 * `skills.catalogs` config field is not coming back (design doc §8.2).
 *
 * ADF_SKILLS_REGISTRY_URL is a DEFAULT, not a fixture: it is where an unconfigured
 * install starts, and nothing more. Once the preference exists it is the whole
 * truth — the first-party registry sits in it as an ordinary row, at whatever
 * position the human left it, and removing it is allowed. Nobody has to carry a
 * registry they did not choose.
 */

/**
 * How many sources the list may hold. Every one of them is a concurrent network
 * fetch each time the browser opens, so the list is bounded rather than
 * unbounded — and a preference file someone hand-edited past the bound is
 * truncated on read instead of trusted.
 */
export const MAX_CATALOG_SOURCES = 8

/**
 * Read the stored preference into the list the browser fetches.
 *
 * ABSENT (undefined, or any non-array a settings file might hold) means never
 * configured, and resolves to the first-party registry alone — the back-compat
 * default, which is why no migration is needed. PRESENT means exactly the list
 * the human left: it may name the default anywhere in it, omit it entirely, or
 * be empty. Non-strings, non-https values and duplicates are dropped and the
 * result is capped, uniformly, with no row treated as special.
 */
export function normalizeCatalogSources(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [ADF_SKILLS_REGISTRY_URL]
  const sources: string[] = []
  const seen = new Set<string>()
  for (const raw of stored) {
    if (typeof raw !== 'string') continue
    const url = raw.trim()
    if (!isCatalogUrl(url) || seen.has(url)) continue
    seen.add(url)
    sources.push(url)
    if (sources.length >= MAX_CATALOG_SOURCES) break
  }
  return sources
}

export type AddCatalogSourceResult =
  | { ok: true; sources: string[] }
  | { ok: false; error: string }

/**
 * Validate one typed URL and return the list it would produce. Every refusal
 * carries the sentence the dialog shows, so the component never composes error
 * text of its own.
 *
 * The first-party registry is not special here: it appends like any other URL,
 * which is what makes "Add default registry" a one-liner after someone has
 * removed it.
 */
export function addCatalogSource(sources: string[], raw: string): AddCatalogSourceResult {
  const url = raw.trim()
  if (!url) return { ok: false, error: 'Enter a catalog URL.' }
  if (!isCatalogUrl(url)) return { ok: false, error: 'A catalog source must be an https:// URL.' }
  if (sources.includes(url)) return { ok: false, error: 'That source is already listed.' }
  if (sources.length >= MAX_CATALOG_SOURCES) {
    return { ok: false, error: `At most ${MAX_CATALOG_SOURCES} catalog sources.` }
  }
  return { ok: true, sources: [...sources, url] }
}

/** What one source's fetch came back with — success or failure, never a throw. */
export interface CatalogSourceResult {
  url: string
  ok: boolean
  entries: SkillCatalogEntry[]
  /** `publisher` from the catalog document, when it named one. */
  publisher?: string
  /** Entries the main-side schema parser rejected individually. */
  dropped?: number
  error?: string
}

/** A catalog entry plus the source it came from, for the badge on its card. */
export interface MergedCatalogEntry extends SkillCatalogEntry {
  sourceUrl: string
  sourceLabel: string
}

/**
 * How a source identifies itself on an entry's badge: the publisher it declared,
 * else the host serving it. Publisher is remote text, so it is sanitized here
 * rather than trusted — an empty result falls back to the hostname, which comes
 * from the URL a human typed.
 */
export function catalogSourceLabel(url: string, publisher?: string): string {
  const named = sanitizeDisplayText(publisher)
  if (named) return named
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Merge every source into one list, FIRST-WINS by name — the same rule the
 * single-source browser applied to duplicates within one document, now applied
 * across documents in SOURCE-LIST ORDER. So a source listed earlier in Settings
 * outranks a later one claiming the same skill name, and precedence is a thing
 * the human arranges rather than a thing this module pins.
 *
 * Failed sources contribute nothing and block nothing. The merged list is
 * sorted by name; the source each entry survived from rides along for its badge.
 */
export function mergeCatalogResults(results: CatalogSourceResult[]): MergedCatalogEntry[] {
  const merged: MergedCatalogEntry[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (!result.ok) continue
    const sourceLabel = catalogSourceLabel(result.url, result.publisher)
    for (const entry of result.entries) {
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      merged.push({ ...entry, sourceUrl: result.url, sourceLabel })
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Live search over the merged list: case-insensitive substring on name or
 * description, with NAME matches ranked above description-only matches. Someone
 * typing a skill they already know the name of should not have to scroll past
 * every entry that merely mentions it. Order within each group is preserved
 * (the merge already sorted it), and an empty query is the identity filter.
 */
export function filterCatalogEntries<T extends { name: string; description: string }>(
  entries: T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  const byName: T[] = []
  const byDescription: T[] = []
  for (const entry of entries) {
    if (entry.name.toLowerCase().includes(needle)) byName.push(entry)
    else if (entry.description.toLowerCase().includes(needle)) byDescription.push(entry)
  }
  return [...byName, ...byDescription]
}
