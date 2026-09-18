import { z } from 'zod'

/**
 * The agent registry index — `registry/index.json` at the repo root, shipped
 * inside the app next to the `.adf` files it describes, and fetched live from
 * the same path on GitHub for additions made after this build.
 *
 * The `.adf` files ARE the agents. The index is only what a gallery needs
 * before it opens one: ordering, a blurb, the file's hash and size, and the
 * oldest app version that can open it. Everything else (name, icon, tools,
 * channels, README) is read from the file itself.
 */
export const AgentRegistryEntrySchema = z.object({
  /** Stable registry id — the file name without `.adf`. */
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  /** File name inside the registry folder / next to index.json remotely. */
  file: z.string().min(1).regex(/^[^/\\]+\.adf$/, 'a bare file name ending in .adf'),
  /** Display name — mirrors the file's config.name so the gallery needs no peek. */
  name: z.string().min(1),
  /** Emoji shown on the gallery card. */
  icon: z.string().optional(),
  /** One or two sentences about what the agent does. */
  blurb: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  /** sha256 of the .adf bytes, hex. A downloaded file must match before it is used. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Byte size of the .adf — the download cap for this entry. */
  size: z.number().int().positive(),
  /** Bumped when the file changes; lets a newer remote copy supersede the bundled one. */
  version: z.number().int().positive().default(1),
  /** Oldest app version that opens this file (its schema version); omitted = any. */
  min_app_version: z.string().optional(),
  /**
   * What the agent can touch, read from the file by the index script so the
   * gallery can show it before the file is opened. Counts, never names of
   * secrets. Optional: older indexes lack it.
   */
  capabilities: z.object({
    tools: z.number().int().nonnegative(),
    code: z.boolean(),
    channels: z.array(z.string()).default([]),
    skills: z.number().int().nonnegative(),
  }).optional(),
})

export const AgentRegistryIndexSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().min(1),
  agents: z.array(AgentRegistryEntrySchema),
})

export type AgentRegistryEntry = z.infer<typeof AgentRegistryEntrySchema>
export type AgentRegistryIndex = z.infer<typeof AgentRegistryIndexSchema>

export interface ParsedAgentRegistryIndex {
  index: AgentRegistryIndex
  /** Entries dropped because they failed validation — logged, never fatal. */
  dropped: number
}

/**
 * Parse an index document leniently: one malformed entry drops that entry,
 * not the whole document. A document that is not an object with an `agents`
 * array is rejected outright.
 */
export function parseAgentRegistryIndex(document: unknown): ParsedAgentRegistryIndex | null {
  if (!document || typeof document !== 'object') return null
  const raw = document as Record<string, unknown>
  if (raw.version !== 1 || typeof raw.updated_at !== 'string' || !Array.isArray(raw.agents)) return null
  const agents: AgentRegistryEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const candidate of raw.agents) {
    const result = AgentRegistryEntrySchema.safeParse(candidate)
    if (!result.success || seen.has(result.data.id)) {
      dropped++
      continue
    }
    seen.add(result.data.id)
    agents.push(result.data)
  }
  return { index: { version: 1, updated_at: raw.updated_at, agents }, dropped }
}

/**
 * Compare two dotted version strings ("0.6.3" vs "0.10.0"). Non-numeric parts
 * count as 0, and a pre-release/build suffix is dropped, so "0.6.3-beta.1"
 * compares equal to "0.6.3": a tester on the beta of the release that can open
 * a file is not locked out of it, and is not credited with the next release
 * either.
 */
export function compareAppVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
