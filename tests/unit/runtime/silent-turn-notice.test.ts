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
      tools: ['sys_set_state', 'say', 'fs_list', 'fs_write', 'adf_shell'].map(n => ({ name: n, enabled: true, visible: true, restricted: false })),
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
  beforeCall?: (index: number) => Promise<void> | void

  constructor(private readonly script: Array<() => LLMResponse>) {}

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push([...opts.messages])
    await this.beforeCall?.(this.calls.length - 1)
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

async function run(
  type: 'chat' | 'timer',
  script: Array<() => LLMResponse>,
  beforeCall?: (index: number, executor: { executeTurn(d: ReturnType<typeof dispatch>): Promise<unknown> }) => Promise<void> | void,
) {
  const { filePath, workspace } = makeWorkspace('agent')
  const provider = new ScriptedProvider(script)
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config: workspace.getAgentConfig(), provider })
  if (beforeCall) provider.beforeCall = index => beforeCall(index, agent.executor)
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
    expect(JSON.stringify(rows[0].content_json)).toContain('[System] You ended the turn')
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

  // A status line is visible output shown before the agent has seen any tool
  // results: it does not answer the chat. Work tools are anything but say,
  // ask and sys_set_state.
  const statusThenTools = () => response([text('Checking your files first.'), tool('fs_list', {})])

  it('a status line, a tool round, then a thinking-only idle gets the notice', async () => {
    const { provider, workspace } = await run('chat', [
      statusThenTools,
      () => response([thinking('The plan is an HN post on Oct 21.'), idle()]),
      () => response([text('HN post on Oct 21.')]),
    ])
    expect(provider.calls).toHaveLength(3)
    expect(sawNotice(provider.calls[2])).toBe(true)
    expect(noticeRows(workspace)).toHaveLength(1)
  })

  it('no notice when a status line and tool round end with a say', async () => {
    const { provider, workspace } = await run('chat', [
      statusThenTools,
      () => response([tool('say', { message: 'HN post on Oct 21.' }), idle()]),
    ])
    expect(provider.calls).toHaveLength(2)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('no notice when a say is followed by a bare sys_set_state in its own response', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('say', { message: 'HN post on Oct 21.' })]),
      () => response([idle()]),
    ])
    expect(provider.calls).toHaveLength(2)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('a status say in its own response, a tool round, then a thinking-only idle gets the notice', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('say', { message: 'Checking your files first.' })]),
      () => response([tool('fs_list', {})]),
      () => response([thinking('The plan is an HN post on Oct 21.'), idle()]),
      () => response([text('HN post on Oct 21.')]),
    ])
    expect(provider.calls).toHaveLength(4)
    expect(sawNotice(provider.calls[3])).toBe(true)
    expect(noticeRows(workspace)).toHaveLength(1)
  })

  // Work after the answer (an inbox check, a log write) does not undo it: only
  // what the owner saw before the agent's first tool results was a status.
  it('no notice when the answer follows work and more work follows the answer', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('fs_list', {})]),
      () => response([tool('say', { message: 'HN post on Oct 21.' })]),
      () => response([tool('fs_list', {})]),
      () => response([idle()]),
    ])
    expect(provider.calls).toHaveLength(4)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('no notice when the answer after work is sent alongside more work', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('fs_list', {})]),
      () => response([tool('say', { message: 'HN post on Oct 21.' }), tool('fs_list', {})]),
      () => response([idle()]),
    ])
    expect(provider.calls).toHaveLength(3)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  // Accepted cost: a reply sent with the turn's first work reads as a status
  // line, so a silent ending after that work gets the (once-per-turn) notice.
  it('a reply sent with the first work of the turn, then a bare idle, gets the notice', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('say', { message: 'HN post on Oct 21.' }), tool('fs_list', {})]),
      () => response([idle()]),
    ])
    expect(provider.calls).toHaveLength(3)
    expect(sawNotice(provider.calls[2])).toBe(true)
    expect(noticeRows(workspace)).toHaveLength(1)
  })

  // The response that ends the turn is an answer: the model never sees its
  // tool results, so its text cannot be a status line. Turn-ending is the
  // executor's own decision (the tool result's endTurn), so the shell's
  // `state idle` counts the same as sys_set_state.
  it('no notice when an answer ends the turn through the shell', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([text('HN post on Oct 21.'), tool('adf_shell', { command: 'state idle' })]),
    ])
    expect(provider.calls).toHaveLength(1)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('no notice when an answer, a log write and sys_set_state share the turn-ending response', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([text('HN post on Oct 21.'), tool('fs_write', { path: 'log.md', content: 'answered' }), idle()]),
    ])
    expect(provider.calls).toHaveLength(1)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('no notice when a say is followed by the shell ending the turn', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('say', { message: 'HN post on Oct 21.' })]),
      () => response([tool('adf_shell', { command: 'state idle' })]),
    ])
    expect(provider.calls).toHaveLength(2)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  // Accepted cost: an answer said before any work, then work, then a bare
  // idle has the same shape as a status say, a tool round and a silent idle,
  // so it gets the (once-per-turn) notice.
  it('a say before any work, a tool round, then a bare idle gets the notice', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('say', { message: 'HN post on Oct 21.' })]),
      () => response([tool('fs_list', {})]),
      () => response([idle()]),
    ])
    expect(provider.calls).toHaveLength(4)
    expect(sawNotice(provider.calls[3])).toBe(true)
    expect(noticeRows(workspace)).toHaveLength(1)
  })

  // A chat delivered mid-turn has not been worked on yet: a status line for
  // it, sent with the first work after it arrives, does not answer it.
  it('a chat delivered mid-turn resets the guard: its status line and tool round, then a silent idle, get the notice', async () => {
    const { provider, workspace } = await run('chat', [
      () => response([tool('fs_list', {})]),
      () => response([tool('say', { message: 'HN post on Oct 21.' })]),
      () => response([tool('say', { message: 'Checking the budget too.' }), tool('fs_list', {})]),
      () => response([thinking('Budget is $2k.'), idle()]),
      () => response([text('Budget is $2k.')]),
    ], async (index, executor) => {
      if (index === 1) await executor.executeTurn(dispatch('chat', 'and the budget?'))
    })
    expect(provider.calls).toHaveLength(5)
    expect(JSON.stringify(provider.calls[2])).toContain('and the budget?')
    expect(sawNotice(provider.calls[4])).toBe(true)
    expect(noticeRows(workspace)).toHaveLength(1)
  })

  it('no notice for a timer turn with a status line, a tool round and a silent idle', async () => {
    const { provider, workspace } = await run('timer', [
      statusThenTools,
      () => response([thinking('nothing to report'), idle()]),
    ])
    expect(provider.calls).toHaveLength(2)
    expect(noticeRows(workspace)).toHaveLength(0)
  })

  it('no notice for a turn nobody asked a question in (timer)', async () => {
    const { provider, workspace } = await run('timer', [() => response([idle()])])
    expect(provider.calls).toHaveLength(1)
    expect(noticeRows(workspace)).toHaveLength(0)
  })
})
