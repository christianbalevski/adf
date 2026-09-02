/**
 * Owner messages, N loops (review M5).
 *
 * `deliverOwnerMessage` writes the owner's message into a cognition stream at
 * DELIVERY time so it is visible immediately, then fires `on_inbox`. One event,
 * N dispatches: the row landed in exactly one stream, so "already appended" is
 * not a property of the event, it is a property of the (event, loop) pair.
 *
 * Get that wrong and a side loop skips its own write, answers from a stream that
 * never held the message, and loses it entirely on the next rehydrate — while
 * main holds a row it never processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { inboxPreAppendLoop } from '../../../src/main/runtime/mesh-manager'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { AgentConfig, TriggerTarget } from '../../../src/shared/types/adf-v02.types'
import type { AdfEventDispatch } from '../../../src/shared/types/adf-event.types'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'

let dir: string
let ws: AdfWorkspace

const provider: LLMProvider = {
  name: 'stub',
  providerId: 'stub',
  modelId: 'stub-model',
  createMessage: async () => ({
    id: 'reply',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  validateConfig: async () => ({ valid: true }),
}

function withInboxTargets(targets: TriggerTarget[]): AgentConfig {
  return {
    triggers: { on_inbox: { enabled: true, targets } },
  } as AgentConfig
}

/** An owner-sourced inbox dispatch, as deliverOwnerMessage's trigger produces. */
function ownerInboxDispatch(opts: {
  loop?: string
  loopSeq?: number
  preAppendedLoop?: string
}): AdfEventDispatch {
  return {
    event: {
      id: 'e1', type: 'inbox', source: 'adapter:user', time: '',
      data: {
        ...(opts.loopSeq !== undefined ? { loop_seq: opts.loopSeq } : {}),
        ...(opts.preAppendedLoop !== undefined ? { pre_appended_loop: opts.preAppendedLoop } : {}),
        message: {
          id: 'm1', from: 'did:owner', content: 'look at this',
          source: 'user', received_at: Date.now(), status: 'unread',
        },
      } as never,
    },
    scope: 'agent',
    ...(opts.loop !== undefined ? { loop: opts.loop } : {}),
  } as AdfEventDispatch
}

function executorFor(loopName: string, config: AgentConfig): { executor: AgentExecutor; session: AgentSession } {
  const view = ws.forLoop(loopName)
  const session = new AgentSession(view)
  const executor = new AgentExecutor(config, provider, new ToolRegistry(), session, '', {})
  return { executor, session }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-owner-inbox-'))
  ws = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'inboxed', start_in_state: 'idle' })
})

afterEach(() => {
  try { ws.close() } catch { /* already closed */ }
  clearAllUmbilicalBuses()
  rmSync(dir, { recursive: true, force: true })
})

describe('inboxPreAppendLoop — which stream gets the delivery-time row', () => {
  it('uses main when on_inbox has no agent-scope target at all', () => {
    // The trigger may be disabled or entirely system-scope; the owner's message
    // must still be visible in the membrane-facing stream.
    expect(inboxPreAppendLoop(withInboxTargets([]))).toBe('main')
    expect(inboxPreAppendLoop(withInboxTargets([{ scope: 'system' } as TriggerTarget]))).toBe('main')
    expect(inboxPreAppendLoop({} as AgentConfig)).toBe('main')
  })

  it('uses the single named loop when the routing is unambiguous', () => {
    expect(inboxPreAppendLoop(withInboxTargets([
      { scope: 'agent', loop: 'reflector' } as TriggerTarget,
    ]))).toBe('reflector')
    expect(inboxPreAppendLoop(withInboxTargets([
      { scope: 'agent' } as TriggerTarget,
    ]))).toBe('main')
  })

  it('uses main when main is one of several targets', () => {
    expect(inboxPreAppendLoop(withInboxTargets([
      { scope: 'agent', loop: 'reflector' } as TriggerTarget,
      { scope: 'agent' } as TriggerTarget,
    ]))).toBe('main')
  })

  it('pre-appends NOWHERE when several side loops and no main are targeted', () => {
    // Pre-appending to main here would leave main a row it never processes
    // while the loops that DO run answer from streams that never held it.
    expect(inboxPreAppendLoop(withInboxTargets([
      { scope: 'agent', loop: 'reflector' } as TriggerTarget,
      { scope: 'agent', loop: 'critic' } as TriggerTarget,
    ]))).toBeNull()
  })
})

describe('owner inbox turn — who writes the row', () => {
  it('does not write a second row in the stream that was pre-appended', async () => {
    const seq = ws.appendToLoop('user', [{ type: 'text', text: 'look at this' }])
    const { executor, session } = executorFor('main', ws.getAgentConfig())
    session.restoreMessages(ws.getLoop().map(e => ({
      role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq,
    })))

    await executor.executeTurn(ownerInboxDispatch({ loopSeq: seq, preAppendedLoop: 'main' }))

    expect(ws.getLoop().filter(r => r.content_json[0]?.text === 'look at this')).toHaveLength(1)
  })

  it('DOES write its own row in a side loop that was not the pre-appended one', async () => {
    // The row went to main; the reflector's turn must persist its own copy or
    // the message is gone from that loop the moment its session is released.
    const seq = ws.appendToLoop('user', [{ type: 'text', text: 'look at this' }])
    const { executor } = executorFor('reflector', ws.getAgentConfig())

    await executor.executeTurn(ownerInboxDispatch({
      loop: 'reflector', loopSeq: seq, preAppendedLoop: 'main',
    }))

    const reflectorRows = ws.forLoop('reflector').getLoop()
    expect(reflectorRows.filter(r => r.content_json.some(b => b.text?.includes('look at this')))).toHaveLength(1)
    // Main's copy is untouched: one row, not two.
    expect(ws.getLoop().filter(r => r.content_json[0]?.text === 'look at this')).toHaveLength(1)
  })

  it('honours a side-loop pre-append: the unambiguous single-target case', async () => {
    const view = ws.forLoop('reflector')
    const seq = view.appendToLoop('user', [{ type: 'text', text: 'look at this' }])
    const { executor, session } = executorFor('reflector', ws.getAgentConfig())
    session.restoreMessages(view.getLoop().map(e => ({
      role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq,
    })))

    await executor.executeTurn(ownerInboxDispatch({
      loop: 'reflector', loopSeq: seq, preAppendedLoop: 'reflector',
    }))

    expect(view.getLoop().filter(r => r.content_json[0]?.text === 'look at this')).toHaveLength(1)
  })

  it('writes its own row when nothing was pre-appended anywhere', async () => {
    // The multi-side-loop case: every woken loop is responsible for its own
    // durable copy.
    const { executor } = executorFor('critic', ws.getAgentConfig())

    await executor.executeTurn(ownerInboxDispatch({ loop: 'critic' }))

    expect(ws.forLoop('critic').getLoop()
      .filter(r => r.content_json.some(b => b.text?.includes('look at this')))).toHaveLength(1)
    expect(ws.getLoop()).toHaveLength(0)
  })
})
