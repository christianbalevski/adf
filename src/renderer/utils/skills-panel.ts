/**
 * Pure helpers behind the Skills panel.
 *
 * Everything here is I/O-free and independently testable: the panel owns the
 * IPC and the React state, this module owns the decisions those depend on —
 * how a state-file edit merges, what a catalog row has to look like before it
 * is worth persisting, and how much of a runtime-generated document is safe to
 * paint into the UI.
 */

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
