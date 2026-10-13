/**
 * End-to-end: a real ADF agent (full prompt, built-in tools, executor loop)
 * running on the user's Claude plan through Claude Code. Opt-in:
 *
 *   ADF_CLAUDE_LIVE=1 npx vitest run tests/integration/claude-subscription-agent.live.test.ts
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../src/shared/types/adf-event.types'
import { createClaudeSubscriptionProvider } from '../../src/main/providers/claude-subscription'
import { closeAllClaudeSessions } from '../../src/main/providers/claude-subscription/provider'
import { ClaudeCodeSession } from '../../src/main/providers/claude-subscription/session'
import type { CreateMessageOptions, LLMProvider } from '../../src/main/providers/provider.interface'

const live = process.env.ADF_CLAUDE_LIVE === '1'
const model = process.env.ADF_CLAUDE_LIVE_MODEL ?? 'claude-haiku-4-5'

function chatDispatch(text: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
    }),
    { scope: 'agent' },
  )
}

/** Records each call's tool-name list while delegating to the real provider. */
function recording(inner: LLMProvider) {
  const calls: CreateMessageOptions[] = []
  const provider: LLMProvider = {
    name: inner.name,
    providerId: inner.providerId,
    providerType: inner.providerType,
    modelId: inner.modelId,
    createMessage: (o) => { calls.push(o); return inner.createMessage(o) },
    validateConfig: () => inner.validateConfig(),
  }
  return { provider, calls }
}

describe.skipIf(!live)('claude-subscription agent (live)', () => {
  afterAll(() => closeAllClaudeSessions())

  it('runs ADF tools from a Claude-driven turn and keeps one session across turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-claude-live-'))
    const filePath = join(dir, 'claude-agent.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    const { provider, calls } = recording(createClaudeSubscriptionProvider({ providerId: 'claude', displayName: 'Claude', modelId: model }))
    const starts = vi.spyOn(ClaudeCodeSession, 'start')
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })

    try {
      await agent.executor.executeTurn(chatDispatch(
        'Use your file tools to create a file named hello.txt containing exactly: hi from claude. Then reply with the single word DONE.',
      ))
      expect(workspace.readFile('hello.txt')?.trim()).toBe('hi from claude')
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[0].tools?.length).toBeGreaterThan(0)

      await agent.executor.executeTurn(chatDispatch('What was the name of the file you created? Reply with just the file name.'))
      const loop = JSON.stringify(workspace.getLoop())
      expect(loop).toMatch(/hello\.txt/)
      // Claude Code's own additions are visible in the loop.
      expect(loop).toMatch(/\[Context: provider_context\][^"]*date is/)
      // Every call of both turns ran on one Claude Code process.
      expect(starts).toHaveBeenCalledTimes(1)
    } finally {
      starts.mockRestore()
      await agent.disposeAsync()
    }
  }, 240_000)

  it('delivers a chat sent mid-turn at the next step, on the same session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-claude-live-'))
    const filePath = join(dir, 'claude-agent.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    const inner = createClaudeSubscriptionProvider({ providerId: 'claude', displayName: 'Claude', modelId: model })
    let sent = false
    const starts = vi.spyOn(ClaudeCodeSession, 'start')
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider: {
      ...recording(inner).provider,
      createMessage: async (o) => {
        const r = await inner.createMessage(o)
        // The owner chats while the agent's tools are about to run.
        if (!sent && r.stop_reason === 'tool_use') {
          sent = true
          void agent.executor.executeTurn(chatDispatch('Also: end your final reply with the word PINEAPPLE.'))
        }
        return r
      },
    } })
    try {
      await agent.executor.executeTurn(chatDispatch('Use your file tools to list the files in your workspace, then tell me how many there are.'))
      await new Promise((r) => setTimeout(r, 200))
      expect(sent).toBe(true)
      const loop = JSON.stringify(workspace.getLoop())
      expect(loop).toMatch(/USER INTERRUPT/)
      expect(loop).toMatch(/PINEAPPLE[^"]*"\}\]/i)
      expect(starts).toHaveBeenCalledTimes(1)
    } finally {
      starts.mockRestore()
      await agent.disposeAsync()
    }
  }, 240_000)
})
