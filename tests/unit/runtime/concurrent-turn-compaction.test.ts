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
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import type { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import { createDispatch, createEvent, type AdfEventDispatch } from '../../../src/shared/types/adf-event.types'
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
  /** Ordinary turn calls wait this long (abortable, like a real stream). */
  turnDelayMs = 0
  /** User-row texts each ordinary turn call was sent, in order. */
  turnRequests: string[][] = []

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
    this.turnRequests.push(opts.messages.filter(m => m.role === 'user').map(messageText))
    if (this.turnDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.turnDelayMs)
        opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
      })
    }
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

function messageText(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('')
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

/**
 * Owner chats that arrive while a turn holds the slot queue FIFO. The first
 * interrupts; the burst replays as one turn whose trigger is the oldest chat
 * and whose other chats follow as consecutive user rows. Each id completes
 * (turn_id, or absorbed_turn_ids). Only stop/unload discards, visibly.
 * Regression: a single pendingInterrupt slot kept only the LAST chat.
 */
describe('AgentExecutor — queued owner chats', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  interface BusEvent { event_type: string; turn_id?: string; loop?: string; payload: Record<string, unknown> }

  function chatWithId(text: string, turnId: string) {
    return { ...chatDispatch(text), turnId }
  }

  /** Studio's IPC chat (AGENT_INVOKE): echoed into the panel, no turnId. */
  function studioChat(text: string) {
    return createDispatch(
      createEvent({
        type: 'chat',
        source: 'system',
        data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() }, echoed: true },
      }),
      { scope: 'agent' },
    )
  }

  async function queueAgent(name: string) {
    const provider = new SlowCompactionProvider()
    provider.turnInputTokens = 1_000
    const built = await buildAgent(name, provider)
    await built.agent.executor.executeTurn(chatDispatch('warm'))
    provider.calls.length = 0
    provider.turnRequests.length = 0
    const events: BusEvent[] = []
    ensureUmbilicalBus(built.workspace.getAgentConfig().id).subscribe(e => { events.push(e as BusEvent) })
    return { provider, events, ...built }
  }

  /** Ids that reached a completed state: a non-interrupted turn.completed or its absorbed list. */
  function completedIds(events: BusEvent[]): string[] {
    const ids: string[] = []
    for (const e of events) {
      if (e.event_type !== 'turn.completed' || e.payload.interrupted === true) continue
      if (e.turn_id) ids.push(e.turn_id)
      if (Array.isArray(e.payload.absorbed_turn_ids)) ids.push(...(e.payload.absorbed_turn_ids as string[]))
    }
    return ids
  }

  function userRows(workspace: AdfWorkspace): string[] {
    return workspace.getLoop().filter(e => e.role === 'user').map(e => messageText({ content: e.content_json }))
  }

  /** Start a turn whose model call stays in flight until aborted or 150ms pass. */
  function startSlowTurn(executor: AgentExecutor, provider: SlowCompactionProvider, first: AdfEventDispatch): Promise<void> {
    provider.turnDelayMs = 150
    return executor.executeTurn(first)
  }

  /** Exactly one turn call, and it follows the compaction. */
  function expectTurnAfterCompaction(calls: string[]) {
    expect(calls).toEqual(['compaction:start', 'compaction:end', 'turn'])
  }

  it('2 Studio chats during a running turn: both delivered, in order, one interrupt', async () => {
    const { agent, provider, workspace } = await queueAgent('queue-two')
    try {
      const running = startSlowTurn(agent.executor, provider, studioChat('first'))
      await waitFor(() => provider.turnRequests.length === 1)
      void agent.executor.executeTurn(studioChat('second'))
      void agent.executor.executeTurn(studioChat('third'))
      provider.turnDelayMs = 0
      await running
      await waitFor(() => !agent.executor.isTurnActive())

      // One interrupted call, one replay: a burst interrupts once.
      expect(provider.turnRequests.length).toBe(2)
      expect(provider.turnRequests[1].slice(-3)).toEqual(['first', 'second', 'third'])
      expect(userRows(workspace).slice(-3)).toEqual(['first', 'second', 'third'])
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('3 daemon chats during a running turn: all delivered in order and every id completes', async () => {
    const { agent, provider, workspace, events } = await queueAgent('queue-three')
    try {
      const running = startSlowTurn(agent.executor, provider, chatWithId('first', 'turn_1'))
      await waitFor(() => provider.turnRequests.length === 1)
      void agent.executor.executeTurn(chatWithId('second', 'turn_2'))
      void agent.executor.executeTurn(chatWithId('third', 'turn_3'))
      void agent.executor.executeTurn(chatWithId('fourth', 'turn_4'))
      provider.turnDelayMs = 0
      await running
      await waitFor(() => !agent.executor.isTurnActive())

      expect(provider.turnRequests.length).toBe(2)
      expect(provider.turnRequests[1].slice(-4)).toEqual(['first', 'second', 'third', 'fourth'])
      expect(userRows(workspace).slice(-4)).toEqual(['first', 'second', 'third', 'fourth'])
      // The replay runs under the oldest queued id; the rest are delivered at its start.
      const delivered = events.find(e => e.event_type === 'chat.delivered')
      expect(delivered?.turn_id).toBe('turn_2')
      expect(delivered?.payload).toMatchObject({ delivery: 'turn_start', count: 2, turn_ids: ['turn_3', 'turn_4'] })
      expect(completedIds(events).sort()).toEqual(['turn_1', 'turn_2', 'turn_3', 'turn_4'])
      // The cut-short first turn ends interrupted, never as answered on its own.
      const firstEnds = events.filter(e => e.event_type === 'turn.completed' && e.turn_id === 'turn_1')
      expect(firstEnds.length).toBeGreaterThan(0)
      expect(firstEnds.every(e => e.payload.interrupted === true)).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('chats queued during a manual compaction all replay after it, in order', async () => {
    const { agent, provider, workspace, events } = await queueAgent('queue-compaction')
    try {
      provider.onCompaction = async () => {
        void agent.executor.executeTurn(chatWithId('c1', 'turn_c1'))
        void agent.executor.executeTurn(chatWithId('c2', 'turn_c2'))
        void agent.executor.executeTurn(chatWithId('c3', 'turn_c3'))
      }
      expect(await agent.executor.compactNow('manual: queue')).toEqual({ success: true })
      await waitFor(() => !agent.executor.isTurnActive())

      expectTurnAfterCompaction(provider.calls)
      expect(provider.turnRequests[0].slice(-3)).toEqual(['c1', 'c2', 'c3'])
      const rows = userRows(workspace)
      const summaryAt = rows.findIndex(t => t.includes('[Loop Compacted'))
      expect(summaryAt).toBeGreaterThanOrEqual(0)
      expect(rows.slice(summaryAt + 1).filter(t => !t.startsWith('[Context'))).toEqual(['c1', 'c2', 'c3'])
      expect(completedIds(events).sort()).toEqual(['turn_c1', 'turn_c2', 'turn_c3'])
    } finally {
      await agent.disposeAsync()
    }
  })

  it('an owner interrupt while chats are queued keeps the queue', async () => {
    const { agent, provider, events } = await queueAgent('queue-owner-interrupt')
    try {
      provider.onCompaction = async () => {
        void agent.executor.executeTurn(chatWithId('i1', 'turn_i1'))
        void agent.executor.executeTurn(chatWithId('i2', 'turn_i2'))
        // Esc / POST …/interrupt lands while nothing is mid-turn.
        agent.executor.endTurnAndSetState('idle')
      }
      expect(await agent.executor.compactNow('manual: interrupt')).toEqual({ success: true })
      await waitFor(() => !agent.executor.isTurnActive())
      expect(provider.turnRequests[0].slice(-2)).toEqual(['i1', 'i2'])
      expect(completedIds(events).sort()).toEqual(['turn_i1', 'turn_i2'])

      // Mid-turn: the burst interrupts, the owner interrupt follows; the queue still runs.
      provider.turnRequests.length = 0
      const running = startSlowTurn(agent.executor, provider, chatWithId('m1', 'turn_m1'))
      await waitFor(() => provider.turnRequests.length === 1)
      void agent.executor.executeTurn(chatWithId('m2', 'turn_m2'))
      void agent.executor.executeTurn(chatWithId('m3', 'turn_m3'))
      agent.executor.endTurnAndSetState('idle')
      provider.turnDelayMs = 0
      await running
      await waitFor(() => !agent.executor.isTurnActive())
      expect(provider.turnRequests.at(-1)!.slice(-3)).toEqual(['m1', 'm2', 'm3'])
      expect(completedIds(events)).toEqual(expect.arrayContaining(['turn_m1', 'turn_m2', 'turn_m3']))
    } finally {
      await agent.disposeAsync()
    }
  })

  it('stop discards the queue visibly: event, live notice, log and loop row', async () => {
    const { agent, provider, workspace, events } = await queueAgent('queue-stop')
    try {
      const notices: string[] = []
      agent.executor.on('event', (e: { type: string; payload?: { content?: unknown } }) => {
        if (e.type === 'context_injected' && typeof e.payload?.content === 'string') notices.push(e.payload.content)
      })
      const running = startSlowTurn(agent.executor, provider, chatWithId('s1', 'turn_s1'))
      await waitFor(() => provider.turnRequests.length === 1)
      void agent.executor.executeTurn(chatWithId('s2', 'turn_s2'))
      void agent.executor.executeTurn(chatWithId('s3', 'turn_s3'))
      agent.executor.abort()
      await running
      await waitFor(() => !agent.executor.isTurnActive())

      const discarded = events.filter(e => e.event_type === 'chat.discarded')
      expect(discarded.length).toBe(1)
      expect(discarded[0].payload).toMatchObject({ reason: 'stopped', count: 2, turn_ids: ['turn_s2', 'turn_s3'], unanswered_turn_ids: ['turn_s1'] })
      expect(notices.some(n => n.includes('2 queued owner messages were discarded undelivered') && n.includes('"s2"') && n.includes('"s3"'))).toBe(true)
      expect(workspace.getLogs().some(l => l.event === 'chat_discarded' && l.level === 'warn')).toBe(true)
      await waitFor(() => userRows(workspace).some(t => t.includes('discarded undelivered')))
      // Never delivered to the model.
      expect(provider.turnRequests.flat().some(t => t === 's2' || t === 's3')).toBe(false)
      expect(agent.executor.getState()).toBe('stopped')

      // A chat that reaches the stopped executor (or a replay scheduled just
      // before the stop) is reported the same way, never swallowed.
      await agent.executor.executeTurn(chatWithId('late', 'turn_late'))
      const late = events.filter(e => e.event_type === 'chat.discarded').at(-1)!
      expect(late.payload).toMatchObject({ reason: 'stopped', count: 1, turn_ids: ['turn_late'] })
      await waitFor(() => userRows(workspace).some(t => t.includes('"late"')))
    } finally {
      await agent.disposeAsync()
    }
  })

  it('the next model call carries every queued chat, oldest first, never only the last', async () => {
    const { agent, provider, events } = await queueAgent('queue-order')
    try {
      const running = startSlowTurn(agent.executor, provider, chatWithId('o0', 'turn_o0'))
      await waitFor(() => provider.turnRequests.length === 1)
      const texts = ['o1', 'o2', 'o3', 'o4', 'o5']
      for (const text of texts) void agent.executor.executeTurn(chatWithId(text, `turn_${text}`))
      provider.turnDelayMs = 0
      await running
      await waitFor(() => !agent.executor.isTurnActive())

      expect(provider.turnRequests.length).toBe(2)
      expect(provider.turnRequests[1].slice(-6)).toEqual(['o0', ...texts])
      const delivered = events.filter(e => e.event_type === 'chat.delivered')
      expect(delivered.map(e => e.payload.turn_ids)).toEqual([['turn_o2', 'turn_o3', 'turn_o4', 'turn_o5']])
      const final = events.filter(e => e.event_type === 'turn.completed' && e.payload.interrupted !== true)
      expect(final.length).toBe(1)
      expect(final[0].turn_id).toBe('turn_o1')
      expect(final[0].payload.absorbed_turn_ids).toEqual(['turn_o0', 'turn_o2', 'turn_o3', 'turn_o4', 'turn_o5'])
    } finally {
      await agent.disposeAsync()
    }
  })

  it('applies to an inner loop executor the same way', async () => {
    const { agent, provider, events } = await queueAgent('queue-side-loop')
    try {
      await agent.loopPool.createLoop({ name: 'reflector', goal: 'Notice what main missed.', enabled: true })
      const runtime = agent.loopPool.getRuntime('reflector')!
      const side = runtime.executor
      await side.executeTurn(chatDispatch('side warm'))
      provider.turnRequests.length = 0

      const running = startSlowTurn(side, provider, chatWithId('l1', 'turn_l1'))
      await waitFor(() => provider.turnRequests.length === 1)
      void side.executeTurn(chatWithId('l2', 'turn_l2'))
      void side.executeTurn(chatWithId('l3', 'turn_l3'))
      provider.turnDelayMs = 0
      await running
      await waitFor(() => !side.isTurnActive())

      expect(provider.turnRequests.at(-1)!.slice(-3)).toEqual(['l1', 'l2', 'l3'])
      expect(userRows(runtime.workspace).slice(-3)).toEqual(['l1', 'l2', 'l3'])
      const sideEvents = events.filter(e => e.loop === 'reflector' && e.turn_id?.startsWith('turn_l'))
      expect(completedIds(sideEvents).sort()).toEqual(['turn_l1', 'turn_l2', 'turn_l3'])
      expect(agent.executor.isTurnActive()).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })
})
