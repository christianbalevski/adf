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
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/**
 * A chat sent while the agent is working is delivered at the next safe step
 * (between tool results, before the next model call) — it never aborts the
 * model call or the tools in flight.
 */

function chat(text: string, turnId?: string) {
  return {
    ...createDispatch(
      createEvent({
        type: 'chat',
        source: 'test',
        data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
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

describe('chat while the agent is working', () => {
  beforeEach(() => { clearAllUmbilicalBuses() })

  it('is delivered with the tool results at the next model call, without interrupting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-chat-next-step-'))
    const filePath = join(dir, 'agent-1.adf')
    createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const config = workspace.getAgentConfig()
    const provider = new ToolThenAnswerProvider()
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
    const events: Array<{ event_type: string; turn_id?: string; payload: Record<string, unknown> }> = []
    ensureUmbilicalBus(config.id).subscribe((e) => { events.push(e as never) })

    provider.onFirstCall = () => { void agent.executor.executeTurn(chat('also check the logs', 'turn_b')) }
    try {
      await agent.executor.executeTurn(chat('list my files', 'turn_a'))
      await new Promise((r) => setTimeout(r, 50))

      expect(provider.aborted).toBe(0)
      // One turn, two model calls; the chat rides the second, after the tool result.
      expect(provider.requests.length).toBe(2)
      // The history array is shared and grows after the call; find the step.
      const results = provider.requests[1].messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))!
      const blocks = results.content as Array<{ type: string; text?: string }>
      expect(blocks[0].type).toBe('tool_result')
      expect(blocks.slice(1).map((b) => b.text ?? '').join('\n')).toContain('also check the logs')
      const completed = events.filter((e) => e.event_type === 'turn.completed')
      expect(completed.map((e) => e.payload.interrupted === true)).toEqual([false])
      expect(completed[0].payload.absorbed_turn_ids).toEqual(['turn_b'])
    } finally {
      await agent.disposeAsync()
    }
  })
})
