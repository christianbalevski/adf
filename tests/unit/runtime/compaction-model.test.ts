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
import type { ModelConfig } from '../../../src/shared/types/adf-v02.types'

const isCompaction = (opts: CreateMessageOptions) => opts.messages.some(m =>
  typeof m.content === 'string'
    ? m.content.includes('<transcript>')
    : Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text?.includes('<transcript>')))

/** Answers chats with "ok" and compactions with a summary naming itself. */
class CountingProvider implements LLMProvider {
  readonly name: string
  compactionCalls = 0
  constructor(readonly modelId: string) { this.name = modelId }

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    if (isCompaction(opts)) {
      this.compactionCalls++
      return {
        id: `compaction-${this.compactionCalls}`,
        content: [{ type: 'text', text: `summary by ${this.modelId}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }
    }
    return { id: 'reply', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

const COMPACTION_MODEL: ModelConfig = { provider: 'cheap-provider', model_id: 'cheap-model' }

async function build(name: string, main: LLMProvider) {
  const dir = mkdtempSync(join(tmpdir(), `adf-compactmodel-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const baseConfig = workspace.getAgentConfig()
  const agent = await new AgentRuntimeBuilder().build({
    workspace,
    filePath,
    config: { ...baseConfig, context: { ...baseConfig.context, compaction_model: COMPACTION_MODEL } },
    provider: main,
  })
  return { agent, workspace }
}

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

const loopTexts = (workspace: AdfWorkspace) => workspace.getLoop().map(e => JSON.stringify(e.content_json))

describe('AgentExecutor — context.compaction_model', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('summarizes with the configured model, not the agent model', async () => {
    const main = new CountingProvider('main-model')
    const cheap = new CountingProvider('cheap-model')
    const { agent, workspace } = await build('override', main)
    const requested: ModelConfig[] = []
    agent.executor.setModelProviderFactory((model) => { requested.push(model); return cheap })

    try {
      await agent.executor.executeTurn(chatDispatch('hi'))
      const result = await agent.executor.compactNow('test')
      expect(result.success).toBe(true)
      expect(requested).toEqual([COMPACTION_MODEL])
      expect(cheap.compactionCalls).toBe(1)
      expect(main.compactionCalls).toBe(0)
      expect(loopTexts(workspace).some(t => t.includes('summary by cheap-model'))).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('fails plainly when the compaction model cannot be built — no fallback to the agent model', async () => {
    const main = new CountingProvider('main-model')
    const { agent, workspace } = await build('unavailable', main)
    agent.executor.setModelProviderFactory(() => { throw new Error('Provider "cheap-provider" has no API key') })

    try {
      await agent.executor.executeTurn(chatDispatch('hi'))
      const result = await agent.executor.compactNow('test')
      expect(result.success).toBe(false)
      expect(result.error).toContain('cheap-provider/cheap-model')
      expect(main.compactionCalls).toBe(0)
      // History kept.
      expect(loopTexts(workspace).some(t => t.includes('[Loop Compacted'))).toBe(false)
      expect(loopTexts(workspace).some(t => t.includes('hi'))).toBe(true)
      const failLog = workspace.getLogs().find(l => l.event === 'compaction_failed')
      expect(failLog?.message).toContain('has no API key')
    } finally {
      await agent.disposeAsync()
    }
  })
})
