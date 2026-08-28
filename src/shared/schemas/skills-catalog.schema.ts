import { z } from 'zod'

/**
 * Skill catalog documents — the install side of file-backed skills.
 *
 * A catalog is a plain JSON document published at a URL (the first-party one
 * lives at ADF_SKILLS_REGISTRY_URL; `skills/registry.json` in this repo is the
 * source of that instance). It is discovery metadata only: fetching it never
 * installs anything, and installing only writes `skills/<name>/SKILL.md` into
 * the VFS — the runtime indexer picks the package up from there.
 *
 * Do not confuse it with `skills-registry.json`, the DERIVED per-agent catalog
 * the indexer generates from installed packages (src/main/adf/skill-indexer.ts).
 * Same domain, opposite direction: catalog = what you could install, registry =
 * what this agent has.
 */

/** Same kebab shape the indexer enforces — a catalog entry that can never index is not an entry. */
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Ceiling for a fetched catalog document, mirroring the registry's own 32KB cap generously. */
export const MAX_CATALOG_BYTES = 512 * 1024

/** Ceiling for one fetched SKILL.md — the indexer rejects anything larger anyway. */
export const MAX_SKILL_PACKAGE_BYTES = 256 * 1024

/**
 * One catalog entry. Unknown extra fields are stripped rather than fatal: a
 * newer catalog may carry metadata this build does not know yet and the entry
 * stays installable without it.
 */
export const SkillCatalogEntrySchema = z.object({
  name: z.string().regex(SKILL_NAME),
  description: z.string().min(1).max(500),
  /** Path inside the publishing repo — display only. */
  path: z.string().min(1).optional(),
  /** Where the SKILL.md body is fetched from on install. */
  raw_url: z.string().url()
})

export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>

/** Parsed catalog document: the entries that validated, plus what got dropped. */
export interface ParsedSkillsCatalog {
  entries: SkillCatalogEntry[]
  publisher?: string
  repository?: string
  dropped: number
}

/**
 * Tolerant parser for a catalog document.
 *
 * Returns `null` only when the document as a whole cannot be trusted: not an
 * object, no `skills` array, or a `schema` that is missing, not a number, or
 * newer than this build understands (> 1). Otherwise entries are validated
 * INDIVIDUALLY — an invalid entry is dropped (counted in `dropped`) instead of
 * failing the whole document, so one bad upstream edit never blanks the
 * browser. Duplicate names collapse to the first occurrence.
 */
export function parseSkillsCatalogDocument(json: unknown): ParsedSkillsCatalog | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const doc = json as Record<string, unknown>
  if (typeof doc.schema !== 'number' || doc.schema > 1) return null
  if (!Array.isArray(doc.skills)) return null

  const entries: SkillCatalogEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const raw of doc.skills) {
    const result = SkillCatalogEntrySchema.safeParse(raw)
    if (!result.success || seen.has(result.data.name)) {
      dropped++
      continue
    }
    seen.add(result.data.name)
    entries.push(result.data)
  }

  return {
    entries,
    publisher: typeof doc.publisher === 'string' ? doc.publisher : undefined,
    repository: typeof doc.repository === 'string' ? doc.repository : undefined,
    dropped
  }
}
