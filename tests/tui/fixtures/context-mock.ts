// GET /agents/:id/context for the mock daemon: a fixed, realistic breakdown
// (built-in tools, a github MCP server, one injected file) whose conversation
// grows with the loop's history. Categories come from the same shared helper
// the real route uses.

import { contextCategories, contextTotal } from '../../../src/shared/utils/context-breakdown'
import type { ContextBreakdown } from '../../../src/shared/types/ipc.types'

const BUILT_IN = ['fs_read', 'fs_write', 'fs_list', 'fs_delete', 'db_query', 'db_execute', 'msg_send', 'msg_list', 'sys_code', 'sys_lambda', 'sys_set_state', 'sys_get_config', 'loop_send', 'loop_list', 'loop_manage', 'ask', 'sys_fetch', 'sys_create_adf']
const GITHUB = Array.from({ length: 26 }, (_, i) => `mcp_github_tool_${String(i + 1).padStart(2, '0')}`)

export function mockBreakdown(rows: number, now = Date.now()): ContextBreakdown {
  const tool = (name: string, i: number, base: number) => ({ name, tokens: base + ((i * 37) % 220) })
  const builtIn = BUILT_IN.map((name, i) => tool(name, i, 180))
  const github = GITHUB.map((name, i) => tool(name, i, 260))
  const sum = (list: Array<{ tokens: number }>) => list.reduce((n, t) => n + t.tokens, 0)
  const injected = [{ path: 'mind.md', tokens: 1840 }]
  const system = 5200 + 1840
  return {
    system_prompt_tokens: system,
    system_prompt_parts: { base_and_sections: 3900, runtime_blocks: 450, instructions: 820 },
    injected_files: injected,
    tool_groups: [
      { source: 'built-in', tokens: sum(builtIn), tools: builtIn },
      { source: 'github', tokens: sum(github), tools: github },
    ],
    tools_total_tokens: sum(builtIn) + sum(github),
    dynamic_instructions_tokens: 140,
    messages_tokens: 2000 + rows * 600,
    overhead_tokens: system + sum(builtIn) + sum(github),
    computed_at: now,
  }
}

/** `rows` null = the loop has no running executor (disabled). */
export function mockContext(agentId: string, loop: string, rows: number | null, modelId: string, items = 12) {
  const threshold = loop === 'consolidator' ? { value: 60000, source: 'loop' as const } : { value: 100000, source: 'default' as const }
  const breakdown = rows === null ? null : mockBreakdown(rows)
  const total = breakdown ? contextTotal(breakdown) : null
  return {
    agentId,
    loop,
    available: breakdown !== null,
    model: { provider: 'mock', modelId },
    compactThreshold: threshold.value,
    compactThresholdSource: threshold.source,
    agentCompactThreshold: 100000,
    totalTokens: total,
    percent: total === null ? null : Math.round((total / threshold.value) * 100),
    categories: breakdown ? contextCategories(breakdown, items) : [],
    breakdown,
  }
}
