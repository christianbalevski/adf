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

// ─────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────

/** Provider whose validateConfig() returns invalid. createMessage should never be called. */
class InvalidKeyProvider implements LLMProvider {
  readonly name = 'invalid-key-provider'
  readonly modelId = 'invalid-key-model-v1'
  createMessageCalls = 0
  validateCalls = 0

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    this.createMessageCalls++
    throw new Error('createMessage should not be reached when validateConfig fails')
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    this.validateCalls++
    return { valid: false, error: '401 Unauthorized — invalid_api_key' }
  }
}

/** Provider whose validateConfig() returns valid; createMessage returns a normal final response. */
class ValidKeyProvider implements LLMProvider {
  readonly name = 'valid-key-provider'
  readonly modelId = 'valid-key-model-v1'
  validateCalls = 0
  createMessageCalls = 0

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    this.createMessageCalls++
    return {
      id: 'reply',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    this.validateCalls++
    return { valid: true }
  }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-preflight-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('AgentExecutor — preflight credential validation', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('aborts the turn with an error event and never enters thinking state when the API key is invalid', async () => {
    const { filePath, workspace } = makeWorkspace('invalid-key')
    const provider = new InvalidKeyProvider()

    const stateTransitions: string[] = []
    const errorEvents: Array<{ error: string }> = []
    const bus = ensureUmbilicalBus(workspace.getAgentConfig().id)
    bus.subscribe(event => {
      if (event.event_type === 'agent.state.changed') {
        stateTransitions.push((event.payload as { state: string }).state)
      }
      if (event.event_type === 'agent.error') {
        // 'agent.error' wraps the raw AgentExecutionEvent: { event: { payload: { error } } }
        const inner = (event.payload as { event?: { payload?: { error?: string } } })?.event
        if (inner?.payload?.error) {
          errorEvents.push({ error: inner.payload.error })
        }
      }
    })

    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })

    try {
      await agent.executor.executeTurn(createDispatch(
        createEvent({
          type: 'chat',
          source: 'test',
          data: {
            message: {
              seq: 0,
              role: 'user',
              content_json: [{ type: 'text', text: 'hello' }],
              created_at: Date.now(),
            },
          },
        }),
        { scope: 'agent' },
      ))

      // Preflight should have been called exactly once
      expect(provider.validateCalls).toBe(1)
      // The real LLM call must NEVER fire when creds are invalid
      expect(provider.createMessageCalls).toBe(0)
      // We should NOT have entered the 'thinking' state — that's the whole UX bug
      expect(stateTransitions).not.toContain('thinking')
      // We SHOULD have ended up in 'error'
      expect(stateTransitions).toContain('error')
      // The user-facing message must clearly point at the provider/credentials
      expect(errorEvents.length).toBeGreaterThan(0)
      const msg = errorEvents[0].error
      expect(msg.toLowerCase()).toContain('authenticated')
      expect(msg.toLowerCase()).toContain('settings')
      // The underlying provider error should be surfaced for debugging
      expect(msg).toContain('invalid_api_key')
    } finally {
      agent.dispose()
    }
  })

  it('validates exactly once across multiple turns when credentials are valid (steady-state zero overhead)', async () => {
    const { filePath, workspace } = makeWorkspace('valid-key-cached')
    const provider = new ValidKeyProvider()

    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })

    const dispatch = () => createDispatch(
      createEvent({
        type: 'chat',
        source: 'test',
        data: {
          message: {
            seq: 0,
            role: 'user',
            content_json: [{ type: 'text', text: 'hello' }],
            created_at: Date.now(),
          },
        },
      }),
      { scope: 'agent' },
    )

    try {
      await agent.executor.executeTurn(dispatch())
      await agent.executor.executeTurn(dispatch())
      await agent.executor.executeTurn(dispatch())

      expect(provider.validateCalls).toBe(1)
      expect(provider.createMessageCalls).toBe(3)
    } finally {
      agent.dispose()
    }
  })

  it('re-validates after updateProvider() so a swapped key is rechecked on the next turn', async () => {
    const { filePath, workspace } = makeWorkspace('rotate-key')
    const firstProvider = new ValidKeyProvider()

    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: firstProvider,
    })

    const dispatch = () => createDispatch(
      createEvent({
        type: 'chat',
        source: 'test',
        data: {
          message: {
            seq: 0,
            role: 'user',
            content_json: [{ type: 'text', text: 'hello' }],
            created_at: Date.now(),
          },
        },
      }),
      { scope: 'agent' },
    )

    try {
      await agent.executor.executeTurn(dispatch())
      expect(firstProvider.validateCalls).toBe(1)

      // User updates the provider — the executor should re-validate on next turn
      const replacement = new ValidKeyProvider()
      agent.executor.updateProvider(replacement)
      await agent.executor.executeTurn(dispatch())

      expect(replacement.validateCalls).toBe(1)
      // First provider should NOT have been re-validated
      expect(firstProvider.validateCalls).toBe(1)
    } finally {
      agent.dispose()
    }
  })
})
