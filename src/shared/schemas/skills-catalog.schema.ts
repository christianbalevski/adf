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
 * Characters a catalog string may never contain.
 *
 * A catalog entry is remote text that ends up rendered in Studio and, once
 * installed, in the agent's prompt. C0/C1 controls (including the `\r\n\0` the
 * indexer already rejects in a description) and the Unicode bidi overrides
 * U+061C, U+200E-F, U+202A-E and U+2066-9 let a publisher make a name or a
 * description display as something other than what it is. Reject rather than
 * strip: a description that needs those characters is not a description.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/

const safeText = (value: string): boolean => !UNSAFE_TEXT.test(value)
const UNSAFE_TEXT_MESSAGE = 'must not contain control or bidirectional-override characters'

/**
 * One catalog entry. Unknown extra fields are stripped rather than fatal: a
 * newer catalog may carry metadata this build does not know yet and the entry
 * stays installable without it.
 */
export const SkillCatalogEntrySchema = z.object({
  name: z.string().regex(SKILL_NAME),
  description: z.string().min(1).max(500).refine(safeText, UNSAFE_TEXT_MESSAGE),
  /** Path inside the publishing repo — display only. */
  path: z.string().min(1).refine(safeText, UNSAFE_TEXT_MESSAGE).optional(),
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
 * object, no `skills` array, or a `schema` that is present and is anything
 * other than 1. An ABSENT `schema` is accepted as 1 — the same rule
 * `skill_install` applies (skill-install.tool.ts), so a catalog the tool
 * installs from is never one the Studio browser refuses to show, or vice versa.
 * Otherwise entries are validated INDIVIDUALLY — an invalid entry is dropped
 * (counted in `dropped`) instead of failing the whole document, so one bad
 * upstream edit never blanks the browser. Duplicate names collapse to the first
 * occurrence.
 */
export function parseSkillsCatalogDocument(json: unknown): ParsedSkillsCatalog | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const doc = json as Record<string, unknown>
  if (doc.schema !== undefined && doc.schema !== 1) return null
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
