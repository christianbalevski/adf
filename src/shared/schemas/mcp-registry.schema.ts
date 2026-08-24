import { z } from 'zod'
import type { McpRegistryEntry } from '../constants/mcp-registry'

/**
 * Zod schema for a single curated-registry entry — mirrors McpRegistryEntry
 * (src/shared/constants/mcp-registry.ts). Unknown extra fields are stripped,
 * not fatal: a newer registry document may carry fields this build does not
 * know yet, and the entry stays usable without them.
 */
export const McpRegistryEntrySchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  npmPackage: z.string().min(1).optional(),
  pypiPackage: z.string().min(1).optional(),
  runtime: z.enum(['node', 'python']).optional(),
  args: z.array(z.string()).optional(),
  url: z.string().min(1).optional(),
  headerEnv: z.array(z.object({ header: z.string().min(1), env: z.string().min(1) })).optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  description: z.string().min(1),
  category: z.enum(['tools', 'data', 'dev', 'communication', 'web', 'search', 'productivity', 'infra', 'ai']),
  requiredEnvKeys: z.array(z.string()),
  optionalEnvKeys: z.array(z.string()).optional(),
  repo: z.string().optional(),
  verified: z.boolean(),
  iconKey: z.string().optional(),
  auth: z.boolean().optional(),
  authArgs: z.array(z.string()).optional(),
  credentialFiles: z.array(z.object({
    path: z.string().min(1),
    required: z.boolean().optional(),
    writeBack: z.boolean().optional()
  })).optional(),
  prerequisite: z.string().optional(),
  deprecated: z.string().optional(),
  advisory: z.string().optional()
}).refine(
  (e) => !!(e.npmPackage || e.pypiPackage || e.url),
  { message: 'entry needs at least one of npmPackage / pypiPackage / url' }
)

/** Parsed registry document: the entries that validated, plus what got dropped. */
export interface ParsedMcpRegistryDocument {
  entries: McpRegistryEntry[]
  updatedAt?: string
  dropped: number
}

/**
 * Tolerant parser for an mcp-registry.json document (bundled fallback,
 * GitHub-raw fetch, or agent-side fetch).
 *
 * Returns `null` only when the document as a whole cannot be trusted: not an
 * object, no `entries` array, or a `schemaVersion` that is missing, not a
 * number, or newer than this build understands (> 1). Otherwise entries are
 * validated INDIVIDUALLY — an invalid entry is dropped (counted in `dropped`)
 * instead of failing the whole document, so one bad upstream edit never blanks
 * the registry.
 */
export function parseMcpRegistryDocument(json: unknown): ParsedMcpRegistryDocument | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  const doc = json as Record<string, unknown>
  if (typeof doc.schemaVersion !== 'number' || doc.schemaVersion > 1) return null
  if (!Array.isArray(doc.entries)) return null

  const entries: McpRegistryEntry[] = []
  let dropped = 0
  for (const raw of doc.entries) {
    const result = McpRegistryEntrySchema.safeParse(raw)
    if (result.success) {
      entries.push(result.data)
    } else {
      dropped++
    }
  }

  return {
    entries,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : undefined,
    dropped
  }
}
