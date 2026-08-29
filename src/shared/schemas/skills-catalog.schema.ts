import { z } from 'zod'

/**
 * Skill catalog documents — the install side of file-backed skills.
 *
 * A catalog is a plain JSON document published at a URL (the first-party one
 * lives at ADF_SKILLS_REGISTRY_URL; `skills/registry.json` in this repo is the
 * source of that instance). It is discovery metadata only: fetching it never
 * installs anything, and installing only writes files under `skills/<name>/`
 * into the VFS — the runtime indexer picks the package up from there.
 *
 * Do not confuse it with `skills-registry.json`, the DERIVED per-agent catalog
 * the indexer generates from installed packages (src/main/adf/skill-indexer.ts).
 * Same domain, opposite direction: catalog = what you could install, registry =
 * what this agent has.
 */

/** Same kebab shape the indexer enforces — a catalog entry that can never index is not an entry. */
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/**
 * Segments a package resource path may carry. Deliberately narrow — no spaces,
 * no traversal, no absolute paths — because every one of these becomes a VFS
 * write under `skills/<name>/` when someone clicks Install.
 */
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

/** Resources per package, SKILL.md excluded — it is always fetched from `raw_url`. */
export const MAX_PACKAGE_FILES = 32

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
 * Map a catalog-declared resource path into the package it belongs to, or null
 * when it escapes. Returns the PACKAGE-RELATIVE path (`scripts/run.js`), which
 * is what both the preview list and the installer append to `skills/<name>/`.
 *
 * Accepts the package-relative form and the fully-qualified form a catalog
 * already uses for `path` (`skills/<name>/scripts/run.js`). Refuses absolute
 * paths, `..` anywhere, backslash smuggling, odd segment characters, and
 * `SKILL.md` itself — the manifest is fetched from `raw_url` and written last,
 * by the installer, never as a resource. Mirrors the confinement the deleted
 * `skill_install` tool enforced, which is the strictness this data deserves:
 * every entry here is remote text that becomes a file write.
 */
export function resolvePackageFilePath(name: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const directory = `skills/${name}/`
  let candidate = raw.trim().replace(/\\/g, '/')
  if (!candidate) return null
  while (candidate.startsWith('./')) candidate = candidate.slice(2)
  if (candidate.startsWith('/')) return null
  const relative = candidate.startsWith(directory) ? candidate.slice(directory.length) : candidate
  if (!relative) return null
  const segments = relative.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    return null
  }
  if (relative === 'SKILL.md') return null
  return relative
}

/** One resource a package ships beside its manifest. */
const SkillPackageFileSchema = z.object({
  path: z.string().min(1).refine(safeText, UNSAFE_TEXT_MESSAGE),
  raw_url: z.string().url()
})

/**
 * One catalog entry. Unknown extra fields are stripped rather than fatal: a
 * newer catalog may carry metadata this build does not know yet and the entry
 * stays installable without it.
 *
 * `files` is the optional package manifest: the resources — scripts, references,
 * `agents/openai.yaml` — that ship beside SKILL.md. Absent means the entry is
 * SKILL.md and nothing else, which is every schema-1 catalog written before this
 * field existed. Present, it is validated as a whole: one unconfinable path
 * drops the ENTRY, the same all-or-nothing rule every other field here follows,
 * because a publisher who cannot spell its own paths has not earned a partial
 * install. Paths are normalized to package-relative on the way out.
 */
export const SkillCatalogEntrySchema = z.object({
  name: z.string().regex(SKILL_NAME),
  description: z.string().min(1).max(500).refine(safeText, UNSAFE_TEXT_MESSAGE),
  /** Path inside the publishing repo — display only. */
  path: z.string().min(1).refine(safeText, UNSAFE_TEXT_MESSAGE).optional(),
  /** Where the SKILL.md body is fetched from on install. */
  raw_url: z.string().url(),
  /** Resources installed beside SKILL.md, package-relative after parsing. */
  files: z.array(SkillPackageFileSchema).max(MAX_PACKAGE_FILES).optional()
})
  .superRefine((entry, ctx) => {
    if (!entry.files) return
    const seen = new Set<string>()
    entry.files.forEach((file, index) => {
      const relative = resolvePackageFilePath(entry.name, file.path)
      if (!relative) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: `must stay inside skills/${entry.name}/ and cannot be SKILL.md`
        })
        return
      }
      if (seen.has(relative)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'duplicate package path'
        })
        return
      }
      seen.add(relative)
    })
  })
  .transform((entry) => (
    entry.files
      ? {
          ...entry,
          files: entry.files.map((file) => ({
            ...file,
            path: resolvePackageFilePath(entry.name, file.path) as string
          }))
        }
      : entry
  ))

export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>

/** One resource a package ships, as the preview lists it and the installer writes it. */
export type SkillPackageFile = NonNullable<SkillCatalogEntry['files']>[number]

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
 * other than 1. An ABSENT `schema` is accepted as 1: catalogs in the wild omit
 * it, and refusing them would make the browser show nothing for a document an
 * agent fetching the same URL with `sys_fetch` would read fine.
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
