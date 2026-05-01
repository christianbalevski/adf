import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { AlfAgentCard, Visibility } from '../../../shared/types/adf-v02.types'

const VisibilityEnum = z.enum(['directory', 'localhost', 'lan', 'off'])

const InputSchema = z.object({
  scope: z
    .enum(['local', 'all'])
    .optional()
    .default('local')
    .describe('Discovery scope. "local" (default) returns only agents on this runtime. "all" also includes LAN-discovered agents when mDNS is enabled (reserved; today behaves as "local").'),
  visibility: z
    .array(VisibilityEnum)
    .optional()
    .describe('If provided, return only agents whose declared visibility tier is in this list.'),
  handle: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring match on the agent handle.'),
  description: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring match on the agent description.'),
  include_subdirectories: z
    .boolean()
    .optional()
    .default(true)
    .describe('(Backward-compat for the "local" scope branch.) When false, excludes agents in subdirectories.')
})

export type DirectoryEntrySource = 'local-runtime' | 'mdns'

export type DirectoryEntry = AlfAgentCard & {
  in_subdirectory: boolean
  visibility: Visibility
  source: DirectoryEntrySource
  runtime_did?: string
}

export type GetDirectoryFn = () => DirectoryEntry[]
export type GetRemoteDirectoryFn = () => Promise<DirectoryEntry[]>

/**
 * Returns agent cards visible to the calling agent's scope.
 *
 * Visibility enforcement: the runtime's per-caller closure already filters
 * out agents the caller couldn't reach (directory-tier agents outside the
 * ancestor chain, off-tier agents, etc.). This tool only applies user-provided
 * filters on top of that.
 */
export class AgentDiscoverTool implements Tool {
  readonly name = 'agent_discover'
  readonly description =
    'Discover agents reachable from this agent. Returns signed agent cards (did, handle, description, endpoints, public_key, policies, visibility, source, runtime_did). The visibility tier of each card indicates how broadly the agent is exposed. Filter by visibility tier, handle substring, or description substring. Use scope="local" (default) for same-runtime only; "all" also includes mDNS-discovered LAN peers (silently empty when mDNS is unavailable).'
  readonly inputSchema = InputSchema
  readonly category = 'communication' as const

  private getDirectoryFn: GetDirectoryFn
  private getRemoteDirectoryFn: GetRemoteDirectoryFn | null

  constructor(getDirectoryFn: GetDirectoryFn, getRemoteDirectoryFn?: GetRemoteDirectoryFn) {
    this.getDirectoryFn = getDirectoryFn
    this.getRemoteDirectoryFn = getRemoteDirectoryFn ?? null
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    let agents: DirectoryEntry[] = this.getDirectoryFn()

    if (parsed.scope === 'all' && this.getRemoteDirectoryFn) {
      const remote = await this.getRemoteDirectoryFn()
      agents = agents.concat(remote)
    }

    if (!parsed.include_subdirectories) {
      agents = agents.filter((a) => !a.in_subdirectory)
    }

    if (parsed.visibility?.length) {
      const allowed = new Set(parsed.visibility)
      agents = agents.filter((a) => allowed.has(a.visibility))
    }

    if (parsed.handle) {
      const needle = parsed.handle.toLowerCase()
      agents = agents.filter((a) => a.handle.toLowerCase().includes(needle))
    }

    if (parsed.description) {
      const needle = parsed.description.toLowerCase()
      agents = agents.filter((a) => a.description?.toLowerCase().includes(needle))
    }

    if (agents.length === 0) {
      return {
        content: 'No other agents are reachable from your current scope.',
        isError: false
      }
    }

    return {
      content: JSON.stringify(agents, null, 2),
      isError: false
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
