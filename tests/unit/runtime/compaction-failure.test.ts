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

/** High-usage provider (chatTokens lands over any small compact_threshold on
 *  the next turn) whose compaction calls return NO text — models a reasoning
 *  model burning the whole output budget before emitting the summary. */
class EmptySummaryProvider implements LLMProvider {
  readonly name = 'empty-summary-provider'
  readonly modelId = 'empty-summary-model-v1'
  compactionCalls = 0

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    const isCompaction = opts.messages.some(m =>
      typeof m.content === 'string'
        ? m.content.includes('<transcript>')
        : Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text?.includes('<transcript>')))
    if (isCompaction) {
      this.compactionCalls++
      return {
        id: `compaction-${this.compactionCalls}`,
        content: [],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 14_000, output_tokens: 2048 },
      }
    }
    return {
      id: 'reply',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 205_000, output_tokens: 10 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-compactfail-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text', text }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

function loopTexts(workspace: AdfWorkspace): string[] {
  return workspace.getLoop().map(e => JSON.stringify(e.content_json))
}

describe('AgentExecutor — compaction summarizer failure', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('aborts compaction on an empty summary: history preserved, error note + adf_logs row', async () => {
    const { filePath, workspace } = makeWorkspace('empty')
    const provider = new EmptySummaryProvider()
    const baseConfig = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: { ...baseConfig, context: { ...baseConfig.context, compact_threshold: 200_000 } },
      provider,
    })

    try {
      // Turn 1: fresh loop, under threshold. Turn 2: over threshold → grace
      // turn (nudge). Turn 3: compaction attempt → empty summary → abort.
      await agent.executor.executeTurn(chatDispatch('hi'))
      await agent.executor.executeTurn(chatDispatch('more'))
      await agent.executor.executeTurn(chatDispatch('again'))

      expect(provider.compactionCalls).toBeGreaterThanOrEqual(1)

      const texts = loopTexts(workspace)
      // Not compacted — earlier history survives, no summary marker.
      expect(texts.some(t => t.includes('[Loop Compacted'))).toBe(false)
      expect(texts.some(t => t.includes('hi'))).toBe(true)
      // The failure note reached the loop.
      expect(texts.some(t => t.includes('Compaction failed'))).toBe(true)
      // Durable record in adf_logs.
      const logs = workspace.getLogs()
      const failLog = logs.find(l => l.event === 'compaction_failed')
      expect(failLog).toBeDefined()
      expect(failLog!.level).toBe('error')
      expect(failLog!.message).toContain('no text')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('retries compaction on the next threshold crossing and succeeds when the summarizer recovers', async () => {
    const { filePath, workspace } = makeWorkspace('recover')
    const provider = new EmptySummaryProvider()
    const baseConfig = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: { ...baseConfig, context: { ...baseConfig.context, compact_threshold: 200_000 } },
      provider,
    })

    try {
      await agent.executor.executeTurn(chatDispatch('hi'))
      await agent.executor.executeTurn(chatDispatch('more'))
      await agent.executor.executeTurn(chatDispatch('again')) // failed attempt
      expect(loopTexts(workspace).some(t => t.includes('[Loop Compacted'))).toBe(false)

      // Summarizer recovers: next turn is still over threshold and compacts.
      const original = provider.createMessage.bind(provider)
      provider.createMessage = async (opts: CreateMessageOptions) => {
        const res = await original(opts)
        if (res.content.length === 0) {
          return { ...res, content: [{ type: 'text' as const, text: 'recovered summary' }], stop_reason: 'end_turn' as const }
        }
        return res
      }
      await agent.executor.executeTurn(chatDispatch('once more'))
      const texts = loopTexts(workspace)
      expect(texts.some(t => t.includes('[Loop Compacted'))).toBe(true)
      expect(texts.some(t => t.includes('recovered summary'))).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })
})
