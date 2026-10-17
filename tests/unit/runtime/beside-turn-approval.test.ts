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
 * running. An approval the executor itself waits on (requestHilApproval,
 * e.g. a protection override from sandboxed code) is ended by the chat:
 * denied, and the chat queued. An approval raised beside the turn
 * (requestApproval with restoreState, the daemon's deferred MCP sign-in)
 * blocks nothing: the chat runs as a turn and the approval stays open.
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
  it('an executor approval (characterization): the chat denies it and is queued, no turn runs', async () => {
    const { executor, provider, dispose } = await build()
    try {
      const approval = executor.requestHilApproval('compute_exec', { code: '1' })
      expect(executor.getState()).toBe('awaiting_approval')
      await executor.executeTurn(chat('hello'))
      expect((await approval).approved).toBe(false)
      expect(provider.requests).toHaveLength(0)
    } finally {
      await dispose()
    }
  })
})
