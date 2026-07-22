import { describe, expect, it, beforeEach } from 'vitest'
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

/** Provider that records the tools array of every createMessage call. */
class CapturingProvider implements LLMProvider {
  readonly name = 'capturing-provider'
  readonly modelId = 'capture-model-v1'
  captured: Array<string[]> = []

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.captured.push((opts.tools ?? []).map(t => t.name))
    return {
      id: 'reply',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

const chatDispatch = () => createDispatch(
  createEvent({
    type: 'chat',
    source: 'test',
    data: {
      message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'hi' }], created_at: Date.now() },
    },
  }),
  { scope: 'agent' },
)

describe('tool visibility → provider request', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it('stops sending tool schemas after visibility is turned off mid-session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-vis-'))
    const filePath = join(dir, 'vis.adf')
    const created = createHeadlessAgent({ filePath, name: 'vis', provider: new MockLLMProvider() })
    created.dispose()
    const workspace = AdfWorkspace.open(filePath)

    const config = workspace.getAgentConfig()
    // Mirror fred: a set of enabled tools, all visible initially
    config.tools = config.tools.map(t => ({ ...t, enabled: true, visible: true }))
    workspace.setAgentConfig(config)

    const provider = new CapturingProvider()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })

    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(provider.captured.length).toBe(1)
      const before = provider.captured[0]
      expect(before.length).toBeGreaterThan(0)

      // User hides every tool in the config UI → DOC_SET_AGENT_CONFIG path
      const hidden = workspace.getAgentConfig()
      hidden.tools = hidden.tools.map(t => ({ ...t, visible: false }))
      workspace.setAgentConfig(hidden)
      agent.executor.updateConfig(hidden)

      await agent.executor.executeTurn(chatDispatch())
      expect(provider.captured.length).toBe(2)
      const after = provider.captured[1]
      console.log('before:', before.length, before.join(','))
      console.log('after:', after.length, after.join(','))
      expect(after).toEqual([])
    } finally {
      await agent.disposeAsync()
    }
  })
})
