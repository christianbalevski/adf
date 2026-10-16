/**
 * Pure helpers behind Studio's context breakdown (ContextBreakdownModal, the
 * status-bar gauge) and the daemon's GET /agents/:id/context, which the
 * terminal app's /context dialog reads.
 *
 * The measurement itself stays in the executor (AgentExecutor
 * .getContextBreakdown(), src/main/runtime/context-breakdown.ts); this module
 * owns what is derived from it: which compact threshold applies to a loop and
 * how the measured parts split into non-overlapping categories.
 */

import type { AgentConfig } from '../types/adf-v02.types'
import type { ContextBreakdown, ContextCalibration } from '../types/ipc.types'

/** The executor's fallback auto-compact trigger point. */
export const DEFAULT_COMPACT_THRESHOLD = 100000

/** Where a loop's compact threshold comes from. */
export type CompactThresholdSource = 'loop' | 'agent' | 'model' | 'default'

export interface CompactThreshold {
  value: number
  source: CompactThresholdSource
}

function hostThreshold(config: AgentConfig | null | undefined, model: { compact_threshold?: number | null } | undefined): CompactThreshold {
  const context = config?.context?.compact_threshold
  if (context != null) return { value: context, source: 'agent' }
  const fromModel = model?.compact_threshold
  if (fromModel != null) return { value: fromModel, source: 'model' }
  return { value: DEFAULT_COMPACT_THRESHOLD, source: 'default' }
}

/**
 * One loop's auto-compact trigger point, in the executor's own resolution
 * order. `derive-loop-config` writes an explicit per-loop `compact_threshold`
 * into the derived `context`; absent that, the loop inherits the host's
 * `context` value, which still SHADOWS a `compact_threshold` riding inside a
 * per-loop `model` override, exactly as it does at derive time.
 */
export function resolveCompactThreshold(config: AgentConfig | null | undefined, loop?: string): CompactThreshold {
  if (!loop || loop === 'main') return hostThreshold(config, config?.model)
  const declared = config?.loops?.find((l) => l.name === loop)
  if (!declared) return hostThreshold(config, config?.model)
  if (declared.compact_threshold != null) return { value: declared.compact_threshold, source: 'loop' }
  return hostThreshold(config, declared.model ?? config?.model)
}

/** The host loop's auto-compact trigger point. */
export function resolveHostThreshold(config: AgentConfig | null | undefined): number {
  return resolveCompactThreshold(config).value
}

/** One loop's auto-compact trigger point (main or undeclared = the host's). */
export function resolveLoopThreshold(config: AgentConfig | null | undefined, loop?: string): number {
  return resolveCompactThreshold(config, loop).value
}

export interface ContextCategoryItem {
  name: string
  tokens: number
  /** e.g. the MCP server a tool comes from */
  detail?: string
}

export type ContextCategoryKey = 'system' | 'files' | 'tools' | 'mcp' | 'dynamic' | 'messages' | 'recent'

export interface ContextCategory {
  /** Stable id: the key, or `mcp:<server>` for one MCP server's tools. */
  id: string
  key: ContextCategoryKey
  label: string
  tokens: number
  /** Number of items behind the category (tools, files); absent for single blocks. */
  count?: number
  /** Biggest items first, at most `maxItems`. */
  items: ContextCategoryItem[]
  /** One line on what the category is. */
  note: string
  /** True when `tokens` is an estimate, not calibrated to a call's real usage. */
  estimated: boolean
}

/**
 * The per-request total: what the next request would carry. Equals the sum of
 * `contextCategories` (injected files are carved out of the system prompt).
 */
export function contextTotal(b: ContextBreakdown): number {
  return b.system_prompt_tokens + b.tools_total_tokens + b.messages_tokens + b.dynamic_instructions_tokens
}

/** Tokens added after the last call's reply: the only estimated part of a calibrated total. */
export function estimatedSinceTokens(cal: ContextCalibration): number {
  return Math.max(0, cal.since_last_call_tokens - cal.reply_tokens)
}

/**
 * One line on how the total was measured and how it relates to the context
 * gauge, which shows the last call's prompt + reply (input + output).
 */
export function calibrationNote(cal: ContextCalibration | undefined, fmt: (n: number) => string, approx = '≈'): string {
  if (!cal) return `${approx} estimate: no call to calibrate to (none recorded yet, or the prompt, tools or model changed since).`
  const head = `Calibrated to the last call: ${fmt(cal.last_call_tokens)} prompt + ${fmt(cal.reply_tokens)} reply, as the gauge shows`
  const newer = estimatedSinceTokens(cal)
  return newer > 0 ? `${head}; ${approx}${fmt(newer)} added since is an estimate the gauge counts after the next call.` : `${head}.`
}

const byTokens = <T extends { tokens: number }>(list: T[]): T[] => [...list].sort((a, b) => b.tokens - a.tokens)

/**
 * Split a breakdown into non-overlapping categories that sum to
 * `contextTotal(b)`: system prompt (minus the injected files, which get their
 * own row, as Studio's bar carves them out), built-in tools, one row per MCP
 * server, dynamic instructions, conversation and, when calibrated, what was
 * added since the last call. Zero-token categories are kept: a row that says
 * 0 answers "is it in there?". Sorted biggest first.
 */
export function contextCategories(b: ContextBreakdown, maxItems = 12): ContextCategory[] {
  const fileTokens = b.injected_files.reduce((sum, f) => sum + f.tokens, 0)
  const parts = b.system_prompt_parts
  const cal = b.calibration
  const estimated = !cal
  const out: Array<Omit<ContextCategory, 'estimated'>> = [
    {
      id: 'system',
      key: 'system',
      label: 'System prompt',
      tokens: Math.max(0, b.system_prompt_tokens - fileTokens),
      items: parts
        ? byTokens([
            { name: 'Base prompt and capability sections', tokens: parts.base_and_sections },
            { name: 'Agent instructions', tokens: parts.instructions },
            { name: 'Identity, loop roster, runtime blocks', tokens: parts.runtime_blocks },
          ]).filter((i) => i.tokens > 0)
        : [],
      note: 'Base prompt, instructions and runtime blocks: sent with every request.',
    },
  ]
  if (b.injected_files.length > 0) {
    out.push({
      id: 'files',
      key: 'files',
      label: 'Injected files',
      tokens: fileTokens,
      count: b.injected_files.length,
      items: byTokens(b.injected_files.map((f) => ({ name: f.path, tokens: f.tokens }))).slice(0, maxItems),
      note: '{{path}} files rendered into the system prompt.',
    })
  }
  const builtIn = b.tool_groups.filter((g) => g.source === 'built-in')
  const builtInTools = builtIn.flatMap((g) => g.tools)
  out.push({
    id: 'tools',
    key: 'tools',
    label: 'Tools',
    tokens: builtIn.reduce((sum, g) => sum + g.tokens, 0),
    count: builtInTools.length,
    items: byTokens(builtInTools).slice(0, maxItems),
    note: 'Built-in tool schemas: sent with every request.',
  })
  for (const group of b.tool_groups) {
    if (group.source === 'built-in') continue
    out.push({
      id: `mcp:${group.source}`,
      key: 'mcp',
      label: `MCP ${group.source}`,
      tokens: group.tokens,
      count: group.tools.length,
      items: byTokens(group.tools).slice(0, maxItems),
      note: `Tool schemas from the ${group.source} MCP server.`,
    })
  }
  out.push({
    id: 'dynamic',
    key: 'dynamic',
    label: 'Dynamic instructions',
    tokens: b.dynamic_instructions_tokens,
    items: [],
    note: 'Per-turn runtime notes (context pressure, reminders).',
  })
  out.push({
    id: 'messages',
    key: 'messages',
    label: 'Conversation',
    tokens: b.messages_tokens - (cal?.since_last_call_tokens ?? 0),
    items: [],
    note: 'This loop’s history, compaction summary included.',
  })
  const categories: ContextCategory[] = out.map((c) => ({ ...c, estimated }))
  if (cal) {
    categories.push({
      id: 'recent',
      key: 'recent',
      label: 'Since last call',
      tokens: cal.since_last_call_tokens,
      items: [],
      note: 'The last call’s reply (its reported output) plus anything added after it (estimated).',
      estimated: estimatedSinceTokens(cal) > 0,
    })
  }
  return byTokens(categories)
}
