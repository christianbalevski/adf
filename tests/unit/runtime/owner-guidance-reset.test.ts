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

function chat(text: string) {
  return createDispatch(createEvent({
    type: 'chat', source: 'test', data: {
      message: {
        seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now(),
      },
    },
  }), { scope: 'agent' })
}

class RecordingProvider implements LLMProvider {
  readonly name = 'recording-provider'
  readonly modelId = 'recording-model'
  readonly requests: string[] = []

  constructor(private readonly silentReplies = 0) {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(JSON.stringify(options.messages))
    return {
      id: `reply-${this.requests.length}`,
      content: this.requests.length <= this.silentReplies
        ? [{ type: 'thinking', thinking: 'Considering the request.' }]
        : [{ type: 'text', text: 'My previous batch is complete.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig() { return { valid: true } }
}

async function buildAgent(autonomous: boolean, provider: LLMProvider) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-owner-guidance-'))
  const filePath = join(dir, 'agent.adf')
  createHeadlessAgent({ filePath, name: 'agent', provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const config = { ...workspace.getAgentConfig(), autonomous }
  workspace.setAgentConfig(config)
  return new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
}

describe('new owner instructions reset continuation bookkeeping', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it('gives a newly delivered instruction its own narration recovery window', async () => {
    const provider = new RecordingProvider()
    const agent = await buildAgent(true, provider)
    let queued: Promise<void> | undefined
    agent.executor.on('event', event => {
      // Arrive after the old response's pending-chat check, but before the
      // next provider call: this exercises safe-boundary delivery itself.
      if (event.type === 'context_injected'
        && event.payload.content.includes('[You have responded 3 times') && !queued) {
        queued = agent.executor.executeTurn(chat('New direction: investigate the unexplained result.'))
      }
    })
    try {
      await agent.executor.executeTurn(chat('Run the first batch.'))
      await queued
      expect(queued).toBeDefined()
      expect(provider.requests[3]).toContain('New direction: investigate the unexplained result.')
      // Three old replies, then four new replies before the unchanged breaker.
      expect(provider.requests).toHaveLength(7)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('gives the new owner message its own chance to recover a silent reply', async () => {
    const provider = new RecordingProvider(2)
    const agent = await buildAgent(false, provider)
    let queued: Promise<void> | undefined
    let silentNotices = 0
    agent.executor.on('event', event => {
      if (event.type === 'context_injected'
        && event.payload.content.includes('You ended the turn without replying to your principal')) {
        silentNotices++
        if (!queued) queued = agent.executor.executeTurn(chat('New question: what did you find?'))
      }
    })
    try {
      await agent.executor.executeTurn(chat('Inspect the result.'))
      await queued
      expect(provider.requests[1]).toContain('New question: what did you find?')
      expect(silentNotices).toBe(2)
      expect(provider.requests).toHaveLength(3)
    } finally {
      await agent.disposeAsync()
    }
  })
})
