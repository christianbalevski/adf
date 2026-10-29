import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

class RecordingProvider implements LLMProvider {
  readonly name = 'recording-provider'
  readonly modelId = 'recording-model'
  readonly calls: { system: string; dynamic?: string; messages: string }[] = []

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push({
      system: options.system,
      dynamic: options.dynamicInstructions,
      messages: JSON.stringify(options.messages),
    })
    return {
      id: `reply-${this.calls.length}`,
      content: [{ type: 'text', text: 'My previous batch is complete.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig() { return { valid: true } }
}

describe('autonomous runtime guidance sent to the provider', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it.each(['enabled', 'hidden', 'disabled', 'absent'] as const)(
    'only recommends state control when granted (%s)', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'adf-autonomous-guidance-'))
      const filePath = join(dir, 'agent.adf')
      createHeadlessAgent({ filePath, name: 'agent', provider: new MockLLMProvider() }).dispose()
      const workspace = AdfWorkspace.open(filePath)
      const config = workspace.getAgentConfig()
      config.autonomous = true
      config.instructions = 'Continue investigating after each completed batch.'
      config.tools = config.tools.filter(t => t.name !== 'sys_set_state')
      if (mode !== 'absent') {
        config.tools.push({ name: 'sys_set_state', enabled: mode !== 'disabled', visible: mode !== 'hidden' })
      }
      workspace.setAgentConfig(config)
      const provider = new RecordingProvider()
      const agent = await new AgentRuntimeBuilder({ basePrompt: '', toolPrompts: {} }).build({
        workspace, filePath, config, provider,
      })
      try {
        await agent.executor.executeTurn(createDispatch(createEvent({
          type: 'chat', source: 'test', data: {
            message: {
              seq: 0, role: 'user', content_json: [{ type: 'text', text: 'Find the next experiment.' }],
              created_at: Date.now(),
            },
          },
        }), { scope: 'agent' }))

        // Both continuation levels reach the provider, and the existing
        // narration breaker still bounds an agent that refuses to act.
        expect(provider.calls).toHaveLength(4)
        expect(provider.calls[1].messages).toContain('Continue working autonomously')
        expect(provider.calls[2].messages).toContain('You have responded 2 times')
        expect(provider.calls[2].messages).toContain('Reassess your latest instructions')
        for (const call of provider.calls) {
          expect(call.system).not.toContain('no human input this session')
          expect(call.system).not.toContain('sys_set_state')
          if (mode === 'disabled' || mode === 'absent') {
            expect(call.dynamic ?? '').not.toContain('sys_set_state')
            expect(call.messages).not.toContain('sys_set_state')
          } else {
            expect(call.dynamic).toContain('sys_set_state')
          }
        }
        if (mode === 'enabled' || mode === 'hidden') {
          expect(provider.calls[1].messages).toContain('Use sys_set_state to yield only when consistent')
        }
      } finally {
        await agent.disposeAsync()
      }
    },
  )
})
