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

const CHECKPOINT_KEY = 'adf_runtime_turn_checkpoint'

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-turn-checkpoint-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text = 'hello') {
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

class InspectingProvider implements LLMProvider {
  readonly name = 'checkpoint-provider'
  readonly modelId = 'checkpoint-model-v1'
  checkpointDuringCall: unknown = null

  constructor(private readonly workspace: AdfWorkspace) {}

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    this.checkpointDuringCall = JSON.parse(this.workspace.getMeta(CHECKPOINT_KEY) ?? 'null')
    return {
      id: 'reply',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

// Throws on every call so the turn lands in the terminal `error` state.
class ThrowingProvider implements LLMProvider {
  readonly name = 'throwing-provider'
  readonly modelId = 'throwing-model-v1'

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    throw new Error('provider exploded')
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

describe('AgentExecutor — turn checkpoint recovery', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('writes an in-progress checkpoint before provider execution and marks it completed after a clean turn', async () => {
    const { filePath, workspace } = makeWorkspace('complete')
    const provider = new InspectingProvider(workspace)
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider,
    })

    try {
      await agent.executor.executeTurn(chatDispatch())

      expect(provider.checkpointDuringCall).toMatchObject({
        status: 'in_progress',
        event_type: 'chat',
        scope: 'agent',
        replay: 'not_attempted',
      })

      const finalCheckpoint = JSON.parse(workspace.getMeta(CHECKPOINT_KEY) ?? 'null')
      expect(finalCheckpoint).toMatchObject({
        status: 'completed',
        event_type: 'chat',
        scope: 'agent',
      })
      expect(finalCheckpoint.completed_at).toEqual(expect.any(Number))
    } finally {
      agent.dispose()
    }
  })

  it('reconciles a stale in-progress checkpoint on runtime build without replaying the trigger', async () => {
    const { filePath, workspace } = makeWorkspace('recover')
    workspace.setMeta(CHECKPOINT_KEY, JSON.stringify({
      id: 'stale-turn-1',
      status: 'in_progress',
      started_at: Date.now() - 10_000,
      updated_at: Date.now() - 10_000,
      event_type: 'timer',
      scope: 'agent',
      replay: 'not_attempted',
    }), 'readonly')
    workspace.dispose()

    const reopened = AdfWorkspace.open(filePath)
    const provider = new InspectingProvider(reopened)
    const agent = await new AgentRuntimeBuilder().build({
      workspace: reopened,
      filePath,
      config: reopened.getAgentConfig(),
      provider,
      restoreLoop: true,
    })

    try {
      const checkpoint = JSON.parse(reopened.getMeta(CHECKPOINT_KEY) ?? 'null')
      expect(checkpoint).toMatchObject({
        id: 'stale-turn-1',
        status: 'interrupted',
        event_type: 'timer',
        scope: 'agent',
        replay: 'not_replayed',
        reason: 'stale_checkpoint_recovered_on_load',
      })

      const loop = reopened.getLoop()
      expect(loop.some(entry =>
        entry.role === 'user' &&
        entry.content_json.some(block => block.type === 'text' && block.text.includes('was interrupted before clean completion'))
      )).toBe(true)

      const logs = reopened.getLogs(10)
      expect(logs.some(log => log.event === 'turn_checkpoint_recovered')).toBe(true)
      expect(provider.checkpointDuringCall).toBe(null)
    } finally {
      agent.dispose()
    }
  })

  it('marks the checkpoint failed (not completed) when the turn ends in error state', async () => {
    const { filePath, workspace } = makeWorkspace('failed')
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new ThrowingProvider(),
    })

    try {
      await agent.executor.executeTurn(chatDispatch())

      const checkpoint = JSON.parse(workspace.getMeta(CHECKPOINT_KEY) ?? 'null')
      expect(checkpoint).toMatchObject({
        status: 'failed',
        event_type: 'chat',
        scope: 'agent',
        replay: 'not_replayed',
        reason: 'turn_error',
      })
    } finally {
      agent.dispose()
    }
  })

  it('does not reconcile or replay a checkpoint that is already completed', async () => {
    const { filePath, workspace } = makeWorkspace('already-complete')
    workspace.setMeta(CHECKPOINT_KEY, JSON.stringify({
      id: 'done-turn-1',
      status: 'completed',
      started_at: Date.now() - 10_000,
      updated_at: Date.now() - 9_000,
      completed_at: Date.now() - 9_000,
      event_type: 'chat',
      scope: 'agent',
      replay: 'not_attempted',
    }), 'readonly')
    workspace.dispose()

    const reopened = AdfWorkspace.open(filePath)
    const provider = new InspectingProvider(reopened)
    const agent = await new AgentRuntimeBuilder().build({
      workspace: reopened,
      filePath,
      config: reopened.getAgentConfig(),
      provider,
      restoreLoop: true,
    })

    try {
      const checkpoint = JSON.parse(reopened.getMeta(CHECKPOINT_KEY) ?? 'null')
      // Untouched: still completed, no recovery reason stamped.
      expect(checkpoint).toMatchObject({ id: 'done-turn-1', status: 'completed' })
      expect(checkpoint.reason).toBeUndefined()

      const logs = reopened.getLogs(10)
      expect(logs.some(log => log.event === 'turn_checkpoint_recovered')).toBe(false)
      expect(provider.checkpointDuringCall).toBe(null)
    } finally {
      agent.dispose()
    }
  })

  it('injects the interruption notice as real history that survives a reload', async () => {
    const { filePath, workspace } = makeWorkspace('notice')
    workspace.setMeta(CHECKPOINT_KEY, JSON.stringify({
      id: 'stale-turn-2',
      status: 'in_progress',
      started_at: Date.now() - 10_000,
      updated_at: Date.now() - 10_000,
      event_type: 'timer',
      scope: 'agent',
      replay: 'not_attempted',
    }), 'readonly')
    workspace.dispose()

    const reopened = AdfWorkspace.open(filePath)
    const agent = await new AgentRuntimeBuilder().build({
      workspace: reopened,
      filePath,
      config: reopened.getAgentConfig(),
      provider: new MockLLMProvider(),
      restoreLoop: true,
    })

    try {
      // The notice must be a plain user message, NOT a `[Context: …]` audit entry
      // (which restoreMessages strips), so the model actually sees it on reload.
      const loop = reopened.getLoop()
      const notice = loop.find(entry =>
        entry.role === 'user' &&
        entry.content_json.some(block => block.type === 'text' && block.text.includes('was interrupted before clean completion'))
      )
      expect(notice).toBeDefined()
      const noticeText = notice!.content_json
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
      expect(noticeText.startsWith('[Context:')).toBe(false)
      expect(noticeText).toContain('[System notice')
    } finally {
      agent.dispose()
    }
  })
})
