import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { ContentBlock, LLMResponse } from '../../../src/shared/types/provider.types'

/**
 * A chat sent while the agent is working is delivered at the next safe step
 * (between tool results, before the next model call) — it never aborts the
 * model call or the tools in flight.
 */

function chat(text: string, turnId?: string, extra: ContentBlock[] = []) {
  return {
    ...createDispatch(
      createEvent({
        type: 'chat',
        source: 'test',
        data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }, ...extra], created_at: Date.now() } },
      }),
      { scope: 'agent' },
    ),
    ...(turnId ? { turnId } : {}),
  }
}

/** First call: a tool call (and, while "generating", the owner chats). Then end_turn. */
class ToolThenAnswerProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  readonly requests: CreateMessageOptions[] = []
  aborted = 0
  onFirstCall?: () => void

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(opts)
    opts.signal?.addEventListener('abort', () => { this.aborted++ })
    if (this.requests.length === 1) {
      this.onFirstCall?.()
      await new Promise((r) => setTimeout(r, 30))
      return {
        id: 'r1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'fs_list', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    }
    return { id: `r${this.requests.length}`, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
  }

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

describe('output limit reached before any reply', () => {
  beforeEach(() => { clearAllUmbilicalBuses() })

  it('is reported in the loop instead of ending quietly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-output-limit-'))
    const filePath = join(dir, 'agent-1.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    const provider: LLMProvider = {
      name: 'scripted', modelId: 'scripted-v1',
      createMessage: async () => ({ id: 'r', content: [{ type: 'thinking', thinking: 'hmm…' }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 4096 } }),
      validateConfig: async () => ({ valid: true }),
    }
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
    try {
      await agent.executor.executeTurn(chat('hello'))
      expect(JSON.stringify(workspace.getLoop())).toMatch(/reached the output limit/)
      expect(workspace.getLogs().some((l) => l.event === 'output_limit_reached')).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('chat while the agent is working', () => {
  beforeEach(() => { clearAllUmbilicalBuses() })

  it.each([true, false])('is delivered with the tool results without interrupting (image input enabled: %s)', async (imageEnabled) => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-chat-next-step-'))
    const filePath = join(dir, 'agent-1.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    config.model.multimodal = { image: imageEnabled }
    const provider = new ToolThenAnswerProvider()
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
    const events: Array<{ event_type: string; turn_id?: string; payload: Record<string, unknown> }> = []
    ensureUmbilicalBus(config.id).subscribe((e) => { events.push(e as never) })

    const image: ContentBlock = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    provider.onFirstCall = () => { void agent.executor.executeTurn(chat('also check the logs', 'turn_b', [image])) }
    try {
      await agent.executor.executeTurn(chat('list my files', 'turn_a'))
      await new Promise((r) => setTimeout(r, 50))

      expect(provider.aborted).toBe(0)
      // One turn, two model calls; the chat rides the second, after the tool result.
      expect(provider.requests.length).toBe(2)
      // The history array is shared and grows after the call; find the step.
      const msgs = provider.requests[1].messages
      const at = msgs.findIndex((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
      const results = msgs[at].content as Array<{ type: string }>
      expect(results.every((b) => b.type === 'tool_result')).toBe(true)
      // The chat follows tool results as its own user row, with media projected
      // for the current model rather than bypassing its configured policy.
      const next = msgs[at + 1]
      expect(next.role).toBe('user')
      expect(JSON.stringify(next.content)).toContain('also check the logs')
      if (imageEnabled) expect(JSON.stringify(next.content)).toContain('image_url')
      else expect(JSON.stringify(next.content)).toContain('image attachment omitted')
      expect(JSON.stringify(agent.session.getMessages())).toContain('image_url')
      const completed = events.filter((e) => e.event_type === 'turn.completed')
      expect(completed.map((e) => e.payload.interrupted === true)).toEqual([false])
      expect(completed[0].payload.absorbed_turn_ids).toEqual(['turn_b'])
    } finally {
      await agent.disposeAsync()
    }
  })
})
