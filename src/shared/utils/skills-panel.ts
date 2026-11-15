/**
 * Pure helpers behind the Skills panel (Studio) and the terminal app's /skills
 * dialog (src/main/tui/skills).
 *
 * Everything here is I/O-free and independently testable: the panel owns the
 * IPC and the React state, this module owns the decisions those depend on —
 * how a state-file edit merges, what a catalog row has to look like before it
 * is worth persisting, and how much of a runtime-generated document is safe to
 * paint into the UI.
 */

import { ADF_SKILLS_REGISTRY_URL } from '../constants/adf-defaults'
import { MAX_SKILL_FILE_BYTES } from '../schemas/skills-catalog.schema'
import type { DiscoveredSkillPackage, DiscoveredSkillSource, SkillCatalogEntry } from '../schemas/skills-catalog.schema'

export const SKILLS_REGISTRY_PATH = 'skills-registry.json'
export const SKILLS_STATE_PATH = 'skills-state.json'

/** Matches a skill package manifest. Mirrors `SKILL_FILE_PATH` in src/main/adf/skill-indexer.ts. */
export const SKILL_MANIFEST = /^skills\/([^/]+)\/SKILL\.md$/

/** Indexer bounds, restated for the panel's diagnostics (src/main/adf/skill-indexer.ts). */
export const MAX_SKILLS = 48
export const MAX_REGISTRY_BYTES = 32 * 1024
export { MAX_SKILL_FILE_BYTES }

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
  /** Packages a GitHub URL resolved to, listed before their SKILL.md is read. */
  discovered?: DiscoveredSkillSource
}

/**
 * One source's fetch answer as a result row: entries, publisher, dropped
 * count and, for a GitHub source, its discovered packages. Shared by the
 * Studio browser and the terminal app.
 */
export function toCatalogSourceResult(
  url: string,
  result: { ok: true; entries: SkillCatalogEntry[]; publisher?: string; dropped: number; discovered?: DiscoveredSkillSource } | { ok: false; error: string } | null | undefined,
): CatalogSourceResult {
  if (!result?.ok) return { url, ok: false, entries: [], error: (result && !result.ok && result.error) || 'Unavailable' }
  return { url, ok: true, entries: result.entries, publisher: result.publisher, dropped: result.dropped, ...(result.discovered ? { discovered: result.discovered } : {}) }
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

/* -------------------------------------------------------------------------- */
/* Installed packages vs. the registry                                        */
/* -------------------------------------------------------------------------- */

/** Package names present on disk: every `skills/<name>/SKILL.md` in the file list. */
export function installedSkillNames(files: ReadonlyArray<{ path: string }>): Set<string> {
  const names = new Set<string>()
  for (const file of files) {
    const match = SKILL_MANIFEST.exec(file.path)
    if (match) names.add(match[1])
  }
  return names
}

/** A package (or other path) the indexer did not publish, and why when it said. */
export interface SkillProblem {
  key: string
  label: string
  path: string
  /** The indexer's own reason; null when the package is simply absent from the registry. */
  reason: string | null
  isPackage: boolean
}

/**
 * Everything the indexer refused: packages on disk missing from the registry,
 * plus the registry's own `rejected` rows (authoritative, and including paths
 * that are not packages at all). Sorted by key. Empty while there is no
 * readable registry — the caller says that instead. Same rule as the Skills
 * panel's list of problems.
 */
export function skillProblems(installedNames: ReadonlySet<string>, registry: ParsedRegistry | null): SkillProblem[] {
  if (!registry) return []
  const indexed = new Set(registry.entries.map((s) => s.name))
  const rows = new Map<string, Omit<SkillProblem, 'key'>>()
  for (const name of installedNames) {
    if (indexed.has(name)) continue
    rows.set(name, { label: name, path: `skills/${name}/SKILL.md`, reason: null, isPackage: true })
  }
  for (const rejection of registry.rejected) {
    const key = rejection.name ?? rejection.path
    if (rejection.name && indexed.has(rejection.name)) continue
    rows.set(key, {
      label: rejection.name ?? rejection.path,
      path: rejection.path,
      reason: rejection.reason,
      isPackage: rejection.name !== null
    })
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, row]) => ({ key, ...row }))
}

/** The checklist shown for a package the indexer skipped without a stated reason. */
export function unindexedHint(): string {
  return 'not indexed — the folder name must be lowercase kebab-case and match the frontmatter name, ' +
    'description must be one line under 500 characters, and the file must be under ' +
    `${Math.round(MAX_SKILL_FILE_BYTES / 1024)} KB. The catalog also stops at ${MAX_SKILLS} skills or ` +
    `${Math.round(MAX_REGISTRY_BYTES / 1024)} KB, whichever comes first.`
}

/* -------------------------------------------------------------------------- */
/* Browser cards: catalog entries and discovered packages                     */
/* -------------------------------------------------------------------------- */

/** What a loaded SKILL.md says it is (skill-import.ts, `ok` decisions only). */
export interface LoadedManifestName {
  name: string
  description: string
}

/**
 * One card of the browser. A catalog entry is identified by its validated
 * name, as before. A discovered package is identified by its source and
 * folder (`pkg.id`) — never by a name, which is the manifest's and unknown
 * until it loads — so two folders of one repository that claim the same name
 * are two cards, told apart by path.
 */
export type CatalogCard =
  | { kind: 'entry'; key: string; sourceUrl: string; sourceLabel: string; manifestUrl: string; entry: MergedCatalogEntry }
  | {
      kind: 'package'
      key: string
      sourceUrl: string
      sourceLabel: string
      manifestUrl: string
      pkg: DiscoveredSkillPackage
      source: DiscoveredSkillSource
    }

/**
 * Cards for every source, in SOURCE-LIST order (a pasted source is first, so
 * its cards are first). Within a source, catalog entries by name, then its
 * discovered packages by folder. A name a catalog document lists that an
 * earlier source's catalog already listed is left out, as before; packages
 * are never merged away. Two cards may name the same skill: both install into
 * the same slot, `skills/<name>/`, and the slot rule asks before replacing.
 */
export function buildCatalogCards(results: CatalogSourceResult[]): CatalogCard[] {
  const cards: CatalogCard[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (!result.ok) continue
    const sourceLabel = catalogSourceLabel(result.url, result.publisher)
    const entries = result.entries.filter((entry) => !seen.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      seen.add(entry.name)
      cards.push({ kind: 'entry', key: `entry:${entry.name}`, sourceUrl: result.url, sourceLabel, manifestUrl: entry.raw_url, entry: { ...entry, sourceUrl: result.url, sourceLabel } })
    }
    for (const pkg of result.discovered?.packages ?? []) {
      cards.push({ kind: 'package', key: pkg.id, sourceUrl: result.url, sourceLabel, manifestUrl: pkg.raw_url, pkg, source: result.discovered! })
    }
  }
  return cards
}

/** The name a card installs under, when it is known: a catalog entry's, or a loaded manifest's. */
export function cardName(card: CatalogCard, loaded: LoadedManifestName | null): string | null {
  return card.kind === 'entry' ? card.entry.name : loaded?.name ?? null
}

/** The folder a discovered package lives in, for display (`<repo>/<dir>`). */
export function cardPath(card: CatalogCard): string | null {
  if (card.kind !== 'package') return card.entry.path ?? null
  return card.pkg.dir ? `${card.source.repository}/${card.pkg.dir}` : card.source.repository
}

/**
 * Search over cards: name, then description, then path. A discovered package
 * whose manifest has not loaded matches on its path only, which is why the
 * browser says how many descriptions are loaded.
 */
export function filterCatalogCards(
  cards: CatalogCard[],
  query: string,
  loaded: (manifestUrl: string) => LoadedManifestName | null,
): CatalogCard[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return cards
  const byName: CatalogCard[] = []
  const byOther: CatalogCard[] = []
  for (const card of cards) {
    const manifest = card.kind === 'package' ? loaded(card.manifestUrl) : null
    const name = cardName(card, manifest)
    const description = card.kind === 'entry' ? card.entry.description : manifest?.description ?? ''
    const path = cardPath(card) ?? ''
    if (name && name.toLowerCase().includes(needle)) byName.push(card)
    else if (description.toLowerCase().includes(needle) || path.toLowerCase().includes(needle)) byOther.push(card)
  }
  return [...byName, ...byOther]
}

/** Cards shown per page of the browser; "Show more" adds another page. */
export const CATALOG_PAGE_SIZE = 24

/* -------------------------------------------------------------------------- */
/* The browser's one source list                                               */
/* -------------------------------------------------------------------------- */

/**
 * One source the catalog browser reads: a configured one (Settings → Skills)
 * or a transient one pasted into the browser for this dialog-open only (never
 * saved). `request` names the fetch whose answer the row is waiting for; a
 * late answer to an older request, or for a row removed meanwhile, is dropped.
 */
export interface BrowserSource {
  url: string
  transient: boolean
  request: number
  /** null while the fetch is in flight. */
  result: CatalogSourceResult | null
}

/** The configured list, every row waiting for its fetch. */
export function configuredBrowserSources(urls: string[], request: (url: string) => number): BrowserSource[] {
  return urls.map((url) => ({ url, transient: false, request: request(url), result: null }))
}

/**
 * Add a pasted URL ahead of everything else, so its cards come first. A URL
 * already in the list is not added twice: its row is fetched again in place,
 * configured or not.
 */
export function addBrowserSource(sources: BrowserSource[], url: string, request: number): BrowserSource[] {
  if (sources.some((s) => s.url === url)) return sources.map((s) => (s.url === url ? { ...s, request, result: null } : s))
  return [{ url, transient: true, request, result: null }, ...sources]
}

/** Record a fetch's answer, only if the row still exists and still waits for that request. */
export function settleBrowserSource(sources: BrowserSource[], url: string, request: number, result: CatalogSourceResult): BrowserSource[] {
  return sources.map((s) => (s.url === url && s.request === request ? { ...s, result } : s))
}

/** Remove a pasted source; configured ones are removed in Settings. */
export function removeBrowserSource(sources: BrowserSource[], url: string): BrowserSource[] {
  return sources.filter((s) => !(s.url === url && s.transient))
}

/** The answered rows, in list order: what the cards are built from. */
export function browserResults(sources: BrowserSource[]): CatalogSourceResult[] {
  return sources.flatMap((s) => (s.result ? [s.result] : []))
}

/**
 * What a card says about where it would install. A name only names a slot,
 * `skills/<name>/`: a slot already holding files is "Name in use", never
 * "Installed", because nothing records which package put them there (another
 * package with the same name, a newer version, or local edits all look alike).
 * Installing into it is an explicit replacement of the files the package
 * ships; files it does not ship are kept.
 */
export function installSlot(name: string | null, installedNames: ReadonlySet<string>): { inUse: boolean; badge: string | null; action: string; title: string | undefined } {
  const inUse = name !== null && installedNames.has(name)
  return inUse
    ? { inUse, badge: 'Name in use', action: 'Replace existing files', title: `skills/${name}/ already has files. Installing replaces the ones this package ships (asks first) and keeps the rest.` }
    : { inUse, badge: null, action: 'Install', title: name ? `Write skills/${name}/` : undefined }
}
