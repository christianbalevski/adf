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
  SystemPromptParts,
} from '../../shared/types/ipc.types'
import type { LoopTokenUsage } from '../../shared/types/adf-v02.types'

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
  systemPromptParts: SystemPromptParts
  injectedFiles: ContextBreakdownFileEntry[]
  toolGroups: ContextBreakdownToolGroup[]
  toolsTotalTokens: number
  dynamicInstructionsTokens: number
  messagesTokens: number
  now?: number
}): ContextBreakdown {
  return {
    system_prompt_tokens: parts.systemPromptTokens,
    system_prompt_parts: parts.systemPromptParts,
    injected_files: parts.injectedFiles,
    tool_groups: parts.toolGroups,
    tools_total_tokens: parts.toolsTotalTokens,
    dynamic_instructions_tokens: parts.dynamicInstructionsTokens,
    messages_tokens: parts.messagesTokens,
    overhead_tokens: parts.systemPromptTokens + parts.toolsTotalTokens,
    computed_at: parts.now ?? Date.now(),
  }
}

/** A message-token figure split into its char-estimated and API-reported parts. */
export interface MessageTokenSplit {
  estimated: number
  reported: number
}

/**
 * Integer split of `total` in proportion to `weights` (largest remainder), so
 * the parts always sum to exactly `total`.
 */
export function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (Math.max(0, w) / sum) * total)
  const out = exact.map(Math.floor)
  let left = total - out.reduce((acc, n) => acc + n, 0)
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++
  return out
}

/**
 * The loop's last call with recorded usage: the session index of the
 * assistant message it produced (every message before it was in that call's
 * prompt) and its real prompt size. `input` is that size on every provider
 * path — each normalizes it to include cache reads and writes. Null — no
 * calibration — when no row recorded usage, the provider reported none (a
 * char estimate), a compaction or clear since (`baselineEstimated`) left the
 * row describing a context that no longer exists, the system prompt, tools,
 * provider or model changed since that call (`fixedPartsMatch` false: the
 * fixed parts measured now are not the ones it sent), or the row's message
 * is no longer in the session.
 */
export function findLastCall(
  rows: Array<{ seq: number; tokens: LoopTokenUsage }>,
  messages: Array<{ seq?: number }>,
  baselineEstimated: boolean,
  fixedPartsMatch: (seq: number) => boolean
): { index: number; promptTokens: number } | null {
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined
  if (!last || last.tokens.estimated || baselineEstimated || !fixedPartsMatch(last.seq)) return null
  const promptTokens = last.tokens.input ?? 0
  if (!(promptTokens > 0)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].seq === last.seq) return { index: i, promptTokens }
  }
  return null
}

/**
 * Real ÷ estimated outside this band means the estimate and the call do not
 * describe the same prompt (or the usage is wrong): no calibration then.
 */
export const CALIBRATION_RATIO_MIN = 0.5
export const CALIBRATION_RATIO_MAX = 3

/**
 * Scale an estimated breakdown to the loop's last call. `lastCallTokens` is
 * the API-reported prompt size of that call; `prior` is the conversation it
 * carried, `since` what was added after. Every estimated part — system
 * prompt, tools, dynamic instructions, prior conversation — is scaled by
 * real ÷ estimated so the parts sum to exactly `lastCallTokens`; API-reported
 * reasoning is kept as is. `since` gets the same ratio and stays an estimate.
 * Returns `b` unchanged (an uncalibrated estimate) when there is nothing to
 * scale or the ratio falls outside [CALIBRATION_RATIO_MIN, CALIBRATION_RATIO_MAX].
 */
export function calibrateContextBreakdown(
  b: ContextBreakdown,
  c: { lastCallTokens: number; prior: MessageTokenSplit; since: MessageTokenSplit }
): ContextBreakdown {
  if (!(c.lastCallTokens > 0)) return b
  const fixed = [b.system_prompt_tokens, b.tools_total_tokens, b.dynamic_instructions_tokens]
  const fixedSum = fixed.reduce((acc, n) => acc + n, 0)
  const ratioFor = (estimated: number, reported: number): number | null => {
    const target = c.lastCallTokens - reported
    if (target <= 0 || estimated <= 0) return null
    const r = target / estimated
    return r >= CALIBRATION_RATIO_MIN && r <= CALIBRATION_RATIO_MAX ? r : null
  }
  let priorEstimated = c.prior.estimated
  let reported = c.prior.reported
  let ratio = ratioFor(fixedSum + priorEstimated, reported)
  // Recorded reasoning the provider did not (fully) resend over-subtracts:
  // the rest no longer fits. Scale it as an estimate instead.
  if (ratio === null && reported > 0) {
    priorEstimated += reported
    reported = 0
    ratio = ratioFor(fixedSum + priorEstimated, 0)
  }
  if (ratio === null) return b
  const target = c.lastCallTokens - reported
  const [system, tools, dynamic, prior] = apportion([...fixed, priorEstimated], target)

  const fileWeights = b.injected_files.map((f) => f.tokens)
  const fileRest = Math.max(0, b.system_prompt_tokens - fileWeights.reduce((acc, n) => acc + n, 0))
  const files = apportion([...fileWeights, fileRest], system)
  const groupTokens = apportion(b.tool_groups.map((g) => g.tokens), tools)
  const scale = (n: number): number => Math.round(n * ratio)
  const since = scale(c.since.estimated) + c.since.reported

  return {
    ...b,
    system_prompt_tokens: system,
    system_prompt_parts: {
      base_and_sections: scale(b.system_prompt_parts.base_and_sections),
      runtime_blocks: scale(b.system_prompt_parts.runtime_blocks),
      instructions: scale(b.system_prompt_parts.instructions),
    },
    injected_files: b.injected_files.map((f, i) => ({ ...f, tokens: files[i] })),
    tool_groups: b.tool_groups.map((g, i) => {
      const toolTokens = apportion(g.tools.map((t) => t.tokens), groupTokens[i])
      return { ...g, tokens: groupTokens[i], tools: g.tools.map((t, j) => ({ ...t, tokens: toolTokens[j] })) }
    }),
    tools_total_tokens: tools,
    dynamic_instructions_tokens: dynamic,
    messages_tokens: prior + reported + since,
    overhead_tokens: system + tools,
    calibration: { last_call_tokens: c.lastCallTokens, ratio, since_last_call_tokens: since },
  }
}
