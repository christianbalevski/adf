/**
 * Pure measurement helpers behind AgentExecutor.getContextBreakdown() and the
 * pre-flight overhead fix. Token counting is injected as a pre-bound function
 * (provider-specific tokenizer) so these stay side-effect-free and testable.
 *
 * Cost discipline: callers invoke these only when the corresponding executor
 * cache (system prompt / tool snapshot) is REBUILT — never per turn — because
 * real tokenizers over a 40k-token MCP schema payload are not free.
 */

import { renderInjectedFile } from './prompt-file-injection'
import { McpTool } from '../tools/mcp-tool'
import type { ToolProviderFormat } from '../../shared/types/tool.types'
import type {
  ContextBreakdown,
  ContextBreakdownFileEntry,
  ContextBreakdownToolGroup,
} from '../../shared/types/ipc.types'

/** Provider-bound token counter, e.g. `(t) => counter.countTokens(t, providerId)`. */
export type CountTokensFn = (text: string) => number

/**
 * Per-file token share of the system prompt for every {{path}}-injected file.
 * Measures the RENDERED `<injected_file …>` form — that is what actually
 * occupies the prompt, wrapper tags included (missing files render as a short
 * self-closing marker and are measured as such).
 */
export function measureInjectedFiles(
  snapshot: Map<string, string>,
  count: CountTokensFn
): ContextBreakdownFileEntry[] {
  return [...snapshot.keys()]
    .sort()
    .map((path) => ({ path, tokens: count(renderInjectedFile(path, snapshot.get(path)!)) }))
}

/**
 * Tool schema token cost grouped by source: 'built-in' for local tools, the
 * MCP server name for McpTool instances (instanceof — never name-prefix
 * parsing, which would misfile a built-in that happens to start with `mcp_`).
 * Each entry pairs a FINAL provider-format schema (after any augmentation)
 * with the Tool instance it came from; measurement is over the serialized
 * JSON, since that is what ships in the request.
 */
export function measureToolSchemas(
  entries: Array<{ schema: ToolProviderFormat; tool: unknown }>,
  count: CountTokensFn
): { groups: ContextBreakdownToolGroup[]; totalTokens: number } {
  const bySource = new Map<string, ContextBreakdownToolGroup>()
  let totalTokens = 0
  for (const { schema, tool } of entries) {
    const source = tool instanceof McpTool ? tool.getServerName() : 'built-in'
    const tokens = count(JSON.stringify(schema))
    totalTokens += tokens
    let group = bySource.get(source)
    if (!group) {
      group = { source, tokens: 0, tools: [] }
      bySource.set(source, group)
    }
    group.tokens += tokens
    group.tools.push({ name: schema.name, tokens })
  }
  return { groups: [...bySource.values()], totalTokens }
}

/**
 * Combine the cached expensive figures with the cheap per-read ones.
 * `overhead_tokens` is the fixed per-request cost — system prompt + tool
 * schemas — i.e. what a message-only estimate omits.
 */
export function assembleContextBreakdown(parts: {
  systemPromptTokens: number
  injectedFiles: ContextBreakdownFileEntry[]
  toolGroups: ContextBreakdownToolGroup[]
  toolsTotalTokens: number
  dynamicInstructionsTokens: number
  messagesTokens: number
  now?: number
}): ContextBreakdown {
  return {
    system_prompt_tokens: parts.systemPromptTokens,
    injected_files: parts.injectedFiles,
    tool_groups: parts.toolGroups,
    tools_total_tokens: parts.toolsTotalTokens,
    dynamic_instructions_tokens: parts.dynamicInstructionsTokens,
    messages_tokens: parts.messagesTokens,
    overhead_tokens: parts.systemPromptTokens + parts.toolsTotalTokens,
    computed_at: parts.now ?? Date.now(),
  }
}
