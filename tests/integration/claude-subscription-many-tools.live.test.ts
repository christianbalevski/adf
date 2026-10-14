/**
 * Live: an agent with a large tool set (like one with several MCP servers)
 * and many sequential requests on one session. Opt-in:
 *
 *   ADF_CLAUDE_LIVE=1 npx vitest run tests/integration/claude-subscription-many-tools.live.test.ts
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createClaudeSubscriptionProvider } from '../../src/main/providers/claude-subscription'
import { closeAllClaudeSessions } from '../../src/main/providers/claude-subscription/provider'
import { ClaudeCodeSession } from '../../src/main/providers/claude-subscription/session'
import type { LLMMessage, LLMResponse } from '../../src/shared/types/provider.types'
import type { ToolProviderFormat } from '../../src/shared/types/tool.types'

const live = process.env.ADF_CLAUDE_LIVE === '1'
const model = process.env.ADF_CLAUDE_LIVE_MODEL ?? 'claude-haiku-4-5'

// 180 tools, MCP-style names with hyphens, like `mcp_google-drive_<op>`.
const tools: ToolProviderFormat[] = Array.from({ length: 180 }, (_, i) => ({
  name: i === 137 ? 'mcp_google-drive_counter_increment' : `mcp_server-${i % 7}_operation_${i}`,
  description: i === 137 ? 'Increment the counter and return its new value.' : `Unrelated operation number ${i}.`,
  input_schema: { type: 'object', properties: { note: { type: 'string' } } },
}))

const toolUses = (r: LLMResponse) => r.content.filter((b) => b.type === 'tool_use')

describe.skipIf(!live)('claude-subscription many tools / many requests (live)', () => {
  afterAll(() => closeAllClaudeSessions())

  it('calls a tool among 180 and runs 12 sequential tool steps on one session', async () => {
    const provider = createClaudeSubscriptionProvider({ providerId: 'test', displayName: 'Claude', modelId: model })
    const starts = vi.spyOn(ClaudeCodeSession, 'start')
    const system = 'You are a test agent. Follow instructions exactly. Call exactly one tool per step.'
    const messages: LLMMessage[] = [{ role: 'user', content: 'Call mcp_google-drive_counter_increment once now. After each result, call it again, until the counter reaches 12; then reply with just the final number.' }]
    let counter = 0
    for (let step = 0; step < 20; step++) {
      const r = await provider.createMessage({ system, messages, tools, signal: AbortSignal.timeout(90_000) })
      messages.push({ role: 'assistant', content: r.content })
      if (r.stop_reason !== 'tool_use') {
        expect(r.content.map((b) => b.text ?? '').join('')).toMatch(/12/)
        break
      }
      const calls = toolUses(r)
      expect(calls.map((c) => c.name)).toEqual(calls.map(() => 'mcp_google-drive_counter_increment'))
      messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result' as const, tool_use_id: c.id!, content: String(++counter) })) })
    }
    expect(counter).toBeGreaterThanOrEqual(12)
    expect(starts).toHaveBeenCalledTimes(1)
    starts.mockRestore()
  }, 600_000)
})
