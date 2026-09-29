/**
 * Double compaction from concurrent turns (aom 2026-09-03).
 *
 * Two agent-scope dispatches landed in one tick (Telegram catch-up). The
 * executor's concurrent-turn guard read `state`, which is still 'idle' during a
 * turn's pre-thinking awaits, so both ran interleaved on one shared session,
 * both crossed the compaction threshold together, and both called forceCompact.
 * The loser's summarizer returned 37s after the winner committed and archived
 * the winner's summary plus every row written since (adf_audit 841).
 *
 * Two independent defenses, each tested on its own:
 *  1. executeTurnImpl gates on activeTurnCount, so the second dispatch queues.
 *  2. compactLoop refuses a summary whose source rows are already archived
 *     (LoopCompactionSupersededError) and forceCompact resyncs the session
 *     instead of committing over the winner.
 */
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await sleep(10)
  }
}

/** Turn calls report 205k tokens (over the 200k threshold on the next turn).
 *  Compaction calls are SLOW, so two in-flight compactions can overlap, and
 *  each returns a distinct summary so the test can tell which one committed. */
class SlowCompactionProvider implements LLMProvider {
  readonly name = 'slow-compaction-provider'
  readonly modelId = 'slow-compaction-model-v1'
  compactionCalls = 0
  compactionDelayMs = 60
  /** Input tokens each ordinary turn call reports. */
  turnInputTokens = 205_000
  /** Summarizer calls throw instead of returning a summary. */
  failCompaction = false
  /** Call order: 'compaction:start' / 'compaction:end' / 'turn'. */
  calls: string[] = []
  /** Runs inside the summarizer call, before it returns. */
  onCompaction?: (n: number) => Promise<void>

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    const isCompaction = opts.messages.some(m =>
      typeof m.content === 'string'
        ? m.content.includes('<transcript>')
        : Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text?.includes('<transcript>')))
    if (isCompaction) {
      const n = ++this.compactionCalls
      this.calls.push('compaction:start')
      try {
        await sleep(this.compactionDelayMs)
        await this.onCompaction?.(n)
        if (this.failCompaction) throw new Error('summarizer exploded')
      } finally {
        this.calls.push('compaction:end')
      }
      return {
        id: `compaction-${n}`,
        content: [{ type: 'text', text: `summary #${n}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 14_000, output_tokens: 200 },
      }
    }
    this.calls.push('turn')
    return {
      id: 'reply',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: this.turnInputTokens, output_tokens: 10 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-doublecompact-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
    }),
    { scope: 'agent' },
  )
}

/** Agent-scope inbox dispatch as an adapter (non-owner) message produces. */
function inboxDispatch(id: string) {
  return createDispatch(
    createEvent({
      type: 'inbox',
      source: 'adapter:telegram',
      data: {
        message: {
          id, from: 'telegram:1', content: `msg ${id}`, source: 'telegram',
          received_at: Date.now(), status: 'unread' as const,
        },
      },
    }),
    { scope: 'agent' },
  )
}

function loopTexts(workspace: AdfWorkspace): string[] {
  return workspace.getLoop().map(e => JSON.stringify(e.content_json))
}

async function buildAgent(name: string, provider: LLMProvider) {
  const { filePath, workspace } = makeWorkspace(name)
  const baseConfig = workspace.getAgentConfig()
  const agent = await new AgentRuntimeBuilder().build({
    workspace,
    filePath,
    config: { ...baseConfig, context: { ...baseConfig.context, compact_threshold: 200_000 } },
    provider,
  })
  return { agent, workspace }
}

describe('AgentExecutor — concurrent turns and compaction', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('two dispatches in one tick run as one turn plus a queued turn, compacting once', async () => {
    const provider = new SlowCompactionProvider()
    const { agent, workspace } = await buildAgent('guard', provider)
    try {
      // Turn 1 lands 205k on the loop; turn 2 is the memory-flush grace turn.
      // The NEXT turn compacts at the top of its loop — a pre-thinking await
      // during which the state machine still reads 'idle'.
      await agent.executor.executeTurn(chatDispatch('warm'))
      await agent.executor.executeTurn(chatDispatch('flush'))
      expect(provider.compactionCalls).toBe(0)

      // Something unread, so the queued trigger is not dropped as stale.
      workspace.addToInbox({ from: 'telegram:1', content: 'hello', source: 'telegram', received_at: Date.now(), status: 'unread' })

      await Promise.all([
        agent.executor.executeTurn(inboxDispatch('a')),
        agent.executor.executeTurn(inboxDispatch('b')),
      ])
      // The queued trigger drains as a re-entrant turn after the first ends.
      await waitFor(() => !agent.executor.isTurnActive())

      expect(provider.compactionCalls).toBe(1)
      const texts = loopTexts(workspace)
      const summaries = texts.filter(t => t.includes('[Loop Compacted'))
      expect(summaries.length).toBe(1)
      expect(summaries[0]).toContain('summary #1')
      // Work after the compaction survived: the loop is more than the summary.
      expect(texts.length).toBeGreaterThan(1)
      // The first trigger's row was swept into the summary; the queued one ran
      // AFTER the compaction as its own turn, so its row sorts behind the summary.
      const summaryAt = texts.findIndex(t => t.includes('[Loop Compacted'))
      const triggerAt = texts.findIndex(t => t.includes('[Inbox notification]'))
      expect(triggerAt).toBeGreaterThan(summaryAt)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('discards a compaction whose source rows were archived while it summarized', async () => {
    const provider = new SlowCompactionProvider()
    const { agent, workspace } = await buildAgent('superseded', provider)
    try {
      await agent.executor.executeTurn(chatDispatch('warm'))
      await agent.executor.executeTurn(chatDispatch('flush'))

      // While the executor's summarizer call is in flight, another compaction
      // commits on the same loop (what the losing turn saw on 2026-09-03).
      provider.onCompaction = async () => {
        await workspace.compactLoop([], { content: [{ type: 'text', text: '[Loop Compacted] external winner' }] })
      }
      await agent.executor.executeTurn(chatDispatch('go'))

      expect(provider.compactionCalls).toBe(1)
      const texts = loopTexts(workspace)
      // The winner's summary stands; the stale one was never committed.
      expect(texts.some(t => t.includes('external winner'))).toBe(true)
      expect(texts.some(t => t.includes('summary #1'))).toBe(false)
      expect(texts.filter(t => t.includes('[Loop Compacted')).length).toBe(1)
      // The turn carried on from the winner's context and completed normally.
      expect(agent.executor.getState()).not.toBe('error')
      expect(texts.length).toBeGreaterThan(1)
      // Durable record of the refusal.
      const log = workspace.getLogs().find(l => l.event === 'compaction_superseded')
      expect(log).toBeDefined()
      expect(log!.level).toBe('warn')
    } finally {
      await agent.disposeAsync()
    }
  })
})

/**
 * Manual compaction (Studio /compact, POST /agents/:id/compact) runs outside
 * the turn loop. compactNow claims a turn slot for the whole summarizer call,
 * so nothing else can run on — or reset — the session while it is in flight.
 */
describe('AgentExecutor.compactNow — claims the turn slot', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  async function warmAgent(name: string) {
    const provider = new SlowCompactionProvider()
    provider.turnInputTokens = 1_000 // stay far below the auto-compact threshold
    const built = await buildAgent(name, provider)
    await built.agent.executor.executeTurn(chatDispatch('warm'))
    provider.calls.length = 0
    return { provider, ...built }
  }

  /** Exactly one turn call, and it follows the compaction. */
  function expectTurnAfterCompaction(calls: string[]) {
    expect(calls).toEqual(['compaction:start', 'compaction:end', 'turn'])
  }

  it('refuses a second concurrent compactNow without a second LLM call', async () => {
    const { agent, provider, workspace } = await warmAgent('manual-concurrent')
    try {
      const [a, b] = await Promise.all([
        agent.executor.compactNow('manual: a'),
        agent.executor.compactNow('manual: b'),
      ])
      expect(a).toEqual({ success: true })
      expect(b.success).toBe(false)
      expect(b.error).toMatch(/already in progress/)
      expect(provider.compactionCalls).toBe(1)
      expect(loopTexts(workspace).filter(t => t.includes('[Loop Compacted')).length).toBe(1)
      expect(agent.executor.isTurnActive()).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('reports mid-compaction as an active turn and emits a visible notice', async () => {
    const { agent, provider } = await warmAgent('manual-visible')
    try {
      const notices: string[] = []
      agent.executor.on('event', (e: { type: string; payload?: { content?: unknown } }) => {
        if (e.type === 'context_injected' && typeof e.payload?.content === 'string') notices.push(e.payload.content)
      })
      let activeDuring: boolean | undefined
      provider.onCompaction = async () => { activeDuring = agent.executor.isTurnActive() }
      expect(await agent.executor.compactNow('manual: visible')).toEqual({ success: true })
      expect(activeDuring).toBe(true)
      expect(notices.some(n => n.startsWith('Compacting conversation history'))).toBe(true)
      expect(agent.executor.isTurnActive()).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('queues a trigger that arrives mid-compaction and runs it after', async () => {
    const { agent, provider, workspace } = await warmAgent('manual-trigger')
    try {
      workspace.addToInbox({ from: 'telegram:1', content: 'hello', source: 'telegram', received_at: Date.now(), status: 'unread' })
      let triggerTurn: Promise<void> | undefined
      provider.onCompaction = async () => { triggerTurn = agent.executor.executeTurn(inboxDispatch('mid')) }

      expect(await agent.executor.compactNow('manual: trigger')).toEqual({ success: true })
      await triggerTurn
      await waitFor(() => !agent.executor.isTurnActive())

      expectTurnAfterCompaction(provider.calls)
      const texts = loopTexts(workspace)
      const summaryAt = texts.findIndex(t => t.includes('[Loop Compacted'))
      const triggerAt = texts.findIndex(t => t.includes('[Inbox notification]'))
      expect(summaryAt).toBeGreaterThanOrEqual(0)
      expect(triggerAt).toBeGreaterThan(summaryAt)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('replays a chat that arrives mid-compaction without aborting the compaction', async () => {
    const { agent, provider, workspace } = await warmAgent('manual-chat')
    try {
      let chatTurn: Promise<void> | undefined
      provider.onCompaction = async () => { chatTurn = agent.executor.executeTurn(chatDispatch('mid-compaction chat')) }

      expect(await agent.executor.compactNow('manual: chat')).toEqual({ success: true })
      await chatTurn
      await waitFor(() => !agent.executor.isTurnActive())

      expectTurnAfterCompaction(provider.calls)
      const texts = loopTexts(workspace)
      const summaryAt = texts.findIndex(t => t.includes('[Loop Compacted'))
      expect(summaryAt).toBeGreaterThanOrEqual(0)
      expect(texts[summaryAt]).toContain('summary #1')
      expect(texts.findIndex(t => t.includes('mid-compaction chat'))).toBeGreaterThan(summaryAt)
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('releases the claim when summarization fails and reports the failure', async () => {
    const { agent, provider, workspace } = await warmAgent('manual-fail')
    try {
      provider.failCompaction = true
      const result = await agent.executor.compactNow('manual: fail')
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/summarizer exploded/)
      expect(agent.executor.isTurnActive()).toBe(false)
      expect(loopTexts(workspace).some(t => t.includes('[Loop Compacted'))).toBe(false)

      // The slot is free: a turn runs, and a retry compacts.
      await agent.executor.executeTurn(chatDispatch('after failure'))
      expect(provider.calls.filter(c => c === 'turn').length).toBe(1)
      provider.failCompaction = false
      expect(await agent.executor.compactNow('manual: retry')).toEqual({ success: true })
      expect(agent.executor.isTurnActive()).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('applies to a side loop executor the same way', async () => {
    const { agent, provider } = await warmAgent('manual-side-loop')
    try {
      await agent.loopPool.createLoop({ name: 'reflector', goal: 'Notice what main missed.', enabled: true })
      const runtime = agent.loopPool.getRuntime('reflector')!
      const side = runtime.executor
      await side.executeTurn(chatDispatch('side warm'))
      provider.calls.length = 0

      let chatTurn: Promise<void> | undefined
      provider.onCompaction = async () => { chatTurn = side.executeTurn(chatDispatch('side mid chat')) }
      const [a, b] = await Promise.all([side.compactNow('manual: side a'), side.compactNow('manual: side b')])
      expect(a).toEqual({ success: true })
      expect(b.success).toBe(false)
      expect(provider.compactionCalls).toBe(1)
      await chatTurn
      await waitFor(() => !side.isTurnActive())

      expectTurnAfterCompaction(provider.calls)
      const texts = loopTexts(runtime.workspace)
      const summaryAt = texts.findIndex(t => t.includes('[Loop Compacted'))
      expect(summaryAt).toBeGreaterThanOrEqual(0)
      expect(texts.findIndex(t => t.includes('side mid chat'))).toBeGreaterThan(summaryAt)
      expect(agent.executor.isTurnActive()).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })
})
