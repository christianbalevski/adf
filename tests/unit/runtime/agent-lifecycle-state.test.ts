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

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-lifecycle-state-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text = 'keep working') {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text' as const, text }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

class CountingProvider implements LLMProvider {
  readonly name = 'counting-provider'
  readonly modelId = 'counting-model'
  calls = 0

  async createMessage(): Promise<LLMResponse> {
    this.calls++
    return {
      id: 'reply',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

class BlockingProvider implements LLMProvider {
  readonly name = 'blocking-provider'
  readonly modelId = 'blocking-model'
  started: Promise<void>
  private markStarted!: () => void

  constructor() {
    this.started = new Promise(resolve => { this.markStarted = resolve })
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.markStarted()
    return await new Promise<LLMResponse>((_resolve, reject) => {
      const abort = () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

describe('AgentExecutor lifecycle states', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it('ignores legacy held metadata and executes an agent-scoped timer turn', async () => {
    const { filePath, workspace } = makeWorkspace('legacy-held')
    workspace.setMeta('held', '1')
    const provider = new CountingProvider()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })

    try {
      await agent.executor.executeTurn(createDispatch(
        createEvent({
          type: 'timer',
          source: 'test',
          data: {
            timer: {
              id: 1,
              schedule: { mode: 'once', at: Date.now() },
              next_wake_at: Date.now(),
              payload: 'run now',
              scope: ['agent'],
              run_count: 0,
              created_at: Date.now(),
            },
          },
        }),
        { scope: 'agent' },
      ))

      expect(provider.calls).toBe(1)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('ends an active turn and enters hibernate without stopping the executor', async () => {
    const { filePath, workspace } = makeWorkspace('active-to-hibernate')
    const provider = new BlockingProvider()
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })
    const states: string[] = []
    agent.executor.on('event', event => {
      if (event.type === 'state_changed') states.push(event.payload.state)
    })

    try {
      const turn = agent.executor.executeTurn(chatDispatch())
      await provider.started
      agent.executor.endTurnAndSetState('hibernate')
      await turn

      expect(agent.executor.getState()).toBe('idle')
      expect(states.at(-1)).toBe('hibernate')
      expect(workspace.getMeta('held')).toBeNull()
    } finally {
      await agent.disposeAsync()
    }
  })
})
