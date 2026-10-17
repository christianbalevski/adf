import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/**
 * A chat that arrives while the agent waits on an approval with no turn
 * running: an approval raised beside the turn (requestApproval with
 * restoreState, the daemon's deferred MCP sign-in) or with no agent turn
 * running (a protection override from a system-scope lambda) blocks
 * nothing. The chat runs as a turn, the approval stays open, and the agent
 * reads awaiting_approval while it is. (The first test characterized the
 * old behaviour, 23eaefe0: the chat denied it and was queued; review
 * 4300792038 follow-up changed it.)
 */

function chat(text: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
    }),
    { scope: 'agent' },
  )
}

class CountingProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  readonly requests: CreateMessageOptions[] = []
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.requests.push(opts)
    return { id: `r${this.requests.length}`, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
  }
  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true }
  }
}

const dirs: string[] = []
beforeEach(() => { clearAllUmbilicalBuses() })
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function build() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-beside-turn-'))
  dirs.push(dir)
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const provider = new CountingProvider()
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  const dispose = async () => {
    await agent.dispose?.()
    try { workspace.close() } catch { /* disposed with the agent */ }
  }
  return { agent, executor: agent.executor, provider, workspace, dispose }
}

describe('a chat while an approval waits with no turn running', () => {
  it('an executor approval raised with no agent turn: the chat runs and the approval stays open', async () => {
    const { executor, provider, dispose } = await build()
    try {
      void executor.requestHilApproval('compute_exec', { code: '1' })
      expect(executor.getState()).toBe('awaiting_approval')
      await executor.executeTurn(chat('hello'))
      expect(provider.requests).toHaveLength(1)
      expect(executor.getPendingApprovals().map((p) => p.name)).toEqual(['compute_exec'])
    } finally {
      await dispose()
    }
  })

  it('a protection override from outside a turn never wedges the agent: chats run before and after it is decided', async () => {
    const { executor, provider, dispose } = await build()
    try {
      const approval = executor.requestProtectionApproval('fs_write', { path: 'x' }, { kind: 'file', path: 'x', description: 'd' } as never, { timeoutMs: null })
      await executor.executeTurn(chat('hello'))
      expect(provider.requests).toHaveLength(1)
      executor.resolveApproval(executor.getPendingApprovals()[0].requestId, false)
      expect((await approval).approved).toBe(false)
      expect(executor.getState()).toBe('idle')
      await executor.executeTurn(chat('second'))
      expect(provider.requests).toHaveLength(2)
      expect(executor.getState()).toBe('idle')
    } finally {
      await dispose()
    }
  })

  it('the owner\'s hibernate with only a beside-turn approval open is kept, and the approval stays open', async () => {
    const { executor, dispose } = await build()
    const states: string[] = []
    executor.on('event', (e: { type: string; payload: { state?: string } }) => { if (e.type === 'state_changed') states.push(e.payload.state!) })
    try {
      const approval = executor.requestApproval('mcp_oauth_authorize', { server: 'fs' }, { canAlwaysApprove: false, restoreState: true })
      executor.endTurnAndSetState('hibernate')
      expect(states.at(-1)).toBe('hibernate')
      executor.resolveApproval(executor.getPendingApprovals()[0].requestId, true)
      expect(await approval).toBe(true)
      expect(states.at(-1)).toBe('hibernate')
    } finally {
      await dispose()
    }
  })

  it('an approval raised beside the turn: the chat runs as a turn and the approval stays open', async () => {
    const { executor, provider, dispose } = await build()
    try {
      const approval = executor.requestApproval('mcp_oauth_authorize', { server: 'fs' }, { canAlwaysApprove: false, restoreState: true })
      expect(executor.getState()).toBe('awaiting_approval')
      await executor.executeTurn(chat('hello'))
      expect(provider.requests).toHaveLength(1)
      // Still open, and still shown as waiting on the owner (the fleet's approval badge).
      expect(executor.getState()).toBe('awaiting_approval')
      const pending = executor.getPendingApprovals()
      expect(pending.map((p) => p.name)).toEqual(['mcp_oauth_authorize'])
      executor.resolveApproval(pending[0].requestId, true)
      expect(await approval).toBe(true)
      expect(executor.getState()).toBe('idle')
    } finally {
      await dispose()
    }
  })
})
