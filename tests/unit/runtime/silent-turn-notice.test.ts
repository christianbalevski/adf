import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { ContentBlock, LLMMessage, LLMResponse } from '../../../src/shared/types/provider.types'

/**
 * A turn answering an owner chat that is about to end with nothing the owner
 * can see (only thinking, or a bare sys_set_state) gets one notice, written to
 * the loop like any other model input, and one more call to reply.
 */

const NOTICE_MARK = 'You ended the turn without replying to your principal.'
const cleanupDirs: string[] = []

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-silent-turn-${name}-`))
  cleanupDirs.push(dir)
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions: {
      tools: ['sys_set_state', 'say'].map(n => ({ name: n, enabled: true, visible: true, restricted: false })),
    },
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function dispatch(type: 'chat' | 'timer', text = 'what is the launch plan?') {
  const data = type === 'chat'
    ? { message: { seq: 0, role: 'user', content_json: [{ type: 'text' as const, text }], created_at: Date.now() } }
    : {
        timer: {
          id: 1, schedule: { mode: 'once', at: Date.now() }, next_wake_at: Date.now(),
          payload: 'tick', scope: ['agent'], run_count: 0, created_at: Date.now(),
        },
      }
  return createDispatch(createEvent({ type, source: 'test', data } as never), { scope: 'agent' })
}

function response(content: ContentBlock[]): LLMResponse {
  return {
    id: `r-${Math.random()}`,
    content,
    stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

const thinking = (t: string): ContentBlock => ({ type: 'thinking', thinking: t })
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
let toolSeq = 0
const tool = (name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id: `tu-${++toolSeq}`, name, input })
const idle = () => tool('sys_set_state', { state: 'idle' })

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  readonly calls: LLMMessage[][] = []

  constructor(private readonly script: Array<() => LLMResponse>) {}

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push([...opts.messages])
    return this.script[Math.min(this.calls.length - 1, this.script.length - 1)]()
  }

  async validateConfig() {
    return { valid: true }
  }
}

function noticeRows(workspace: AdfWorkspace) {
  return workspace.getLoop().filter(row => JSON.stringify(row.content_json).includes(NOTICE_MARK))
}

function sawNotice(messages: LLMMessage[]): boolean {
  return messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes(NOTICE_MARK))
}

async function run(type: 'chat' | 'timer', script: Array<() => LLMResponse>) {
  const { filePath, workspace } = makeWorkspace('agent')
  const provider = new ScriptedProvider(script)
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  try {
    await agent.executor.executeTurn(dispatch(type))
  } finally {
    agent.dispose?.()
  }
  return { provider, workspace }
}

describe('silent turn notice', () => {
  beforeEach(() => clearAllUmbilicalBuses())
  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows file locks */ }
    }
  })

  it('a chat answered only in thinking before sys_set_state gets the notice, in the loop and in the next call', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([thinking('The plan is an HN post on Oct 21.'), idle()]),
      () => response([text('HN post on Oct 21.')]),
    ])
    expect(provider.calls).toHaveLength(2)
    expect(sawNotice(provider.calls[1])).toBe(true)
    const rows = noticeRows(workspace)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0].content_json)).toContain('[Context: System]')
  })

  it('a thinking-only reply to a chat gets the notice too', async () => {
    const { provider } = await run('chat', [
      () => response([thinking('drafting the answer')]),
      () => response([text('Here it is.')]),
    ])
    expect(provider.calls).toHaveLength(2)
    expect(sawNotice(provider.calls[1])).toBe(true)
  })

  it('goes in at most once: a second silent ending ends the turn', async () => {
    const { provider, workspace } = await run('chat', [() => response([idle()])])
    expect(provider.calls).toHaveLength(2)
    expect(noticeRows(workspace)).toHaveLength(1)
  })

  it.each([
    ['a text reply', () => response([text('Done.'), idle()])],
    ['a say', () => response([tool('say', { message: 'Done.' }), idle()])],
  ])('no notice after %s', async (_label, step) => {
    const { provider, workspace } = await run('chat', [step])
    expect(provider.calls).toHaveLength(1)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('no notice when the agent turns itself off', async () => {
    const { provider } = await run('chat', [() => response([tool('sys_set_state', { state: 'off' })])])
    expect(provider.calls).toHaveLength(1)
  })

  it('no notice for a turn nobody asked a question in (timer)', async () => {
    const { provider, workspace } = await run('timer', [() => response([idle()])])
    expect(provider.calls).toHaveLength(1)
    expect(noticeRows(workspace)).toHaveLength(0)
  })
})
