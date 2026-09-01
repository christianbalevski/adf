/**
 * Regressions for the inter-loop `loop_send` delivery model — the busy-target
 * path, where the message is appended at send time (RT-F6), injected for
 * mid-turn pickup, and a boundary "kick" turn runs only if the turn ended
 * before the injection was drained.
 *
 * These drive a REAL side-loop turn (the stub provider answers once, so the
 * executor actually reaches `drainContextInjections`) against a REAL workspace,
 * because every defect here was invisible at the level of "what dispatch did
 * the pool hand the executor?" — they only showed up in what the model ends up
 * seeing and in what the queue is left holding.
 *
 * C1 — the kick used to inline its own trigger message on top of the drained
 *      injection: one row, but the same text twice in the session, and two
 *      cards in the tab (`context_injected` + `trigger_message`).
 * C3 — the boundary consumed ONE queued kick per turn while a single model
 *      boundary drains ALL pending injections, so leftovers accumulated and
 *      `hasPendingWake()` pinned the loop's session against the idle sweep.
 * C2 — mid-turn compaction reset the session and destroyed the undelivered
 *      wake injection (and its row), after which the boundary read the missing
 *      flag as "already read" and dropped the kick: a silent total loss.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { LoopPool } from '../../../src/main/runtime/loop-pool'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import type { LoopConfig } from '../../../src/shared/types/adf-v02.types'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'

let rootDir: string
let ws: AdfWorkspace
let pool: LoopPool
let events: AgentExecutionEvent[]
let mainSession: AgentSession

/** Every turn in this file is a real one, so the provider always answers. */
let respond: (() => Promise<LLMResponse>) | null = null
const provider = {
  name: 'stub',
  providerId: 'stub',
  modelId: 'stub-model',
  createMessage: async () => {
    if (!respond) throw new Error('no turns in this test')
    return respond()
  },
  validateConfig: async () => ({ valid: true }),
} as unknown as LLMProvider

/** A turn that says one thing and stops. */
function replyOnce(text = 'noted'): () => Promise<LLMResponse> {
  return async () => ({
    id: 'reply',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** Occurrences of `needle` in the session the model would be shown. */
function occurrencesInSession(session: AgentSession, needle: string): number {
  let count = 0
  for (const message of session.getMessages()) {
    const text = typeof message.content === 'string'
      ? message.content
      : (message.content as { type: string; text?: string }[])
        .map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
    if (text.includes(needle)) count++
  }
  return count
}

/** Rows in a loop's stream whose content mentions `needle`. */
function rowsMentioning(loopName: string, needle: string): number {
  return ws.forLoop(loopName).getLoop()
    .filter(row => JSON.stringify(row.content_json).includes(needle)).length
}

/** Executor/pool events for one loop that would render `needle` in the tab. */
function renderEventsFor(needle: string): string[] {
  return events
    .filter(event =>
      (event.type === 'context_injected' || event.type === 'trigger_message')
      && JSON.stringify(event.payload).includes(needle))
    .map(event => event.type)
}

/** Let every setImmediate/microtask the boundary schedules run to completion. */
async function settleBoundary(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve))
}

const loop = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  name: 'reflector',
  goal: 'Notice what main missed.',
  enabled: true,
  tools: [],
  ...over,
})

/** A dispatch that just occupies the loop, so `isBusy()` is true. */
const occupyingDispatch = {
  event: { id: 'e', type: 'chat', source: 'test', time: '', data: {} as never },
  scope: 'agent' as const,
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-loop-delivery-'))
  ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'pooled' })
  mainSession = new AgentSession(ws)
  respond = null
  events = []

  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  let live = ws.getAgentConfig()
  pool = new LoopPool({
    workspace: ws,
    registry,
    getProvider: () => provider,
    basePrompt: '',
    toolPrompts: {},
    adfCallHandler: null,
    codeSandboxService: null,
    mcpManager: null,
    getHostConfig: () => live,
    saveConfig: (next) => { ws.setAgentConfig(next); live = next; pool.reconcile(next) },
    onLoopEvent: (event) => { events.push(event) },
    main: {
      session: mainSession,
      isBusy: () => false,
      dispatch: async () => {},
      getState: () => 'idle',
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  try { pool.dispose() } catch { /* already disposed */ }
  try { ws.close() } catch { /* already closed by a test */ }
  clearAllUmbilicalBuses()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('LoopPool — C1: the boundary kick delivers exactly once', () => {
  it('adds no trigger message of its own: one session message, one card, one row', async () => {
    await pool.createLoop(loop())
    const runtime = pool.getRuntime('reflector')!
    // A LIVE, non-empty session is what makes this the injected path: an empty
    // one rehydrates from the stream instead (the empty-but-busy race).
    runtime.session.addMessage({ role: 'user', content: [{ type: 'text', text: 'prior' }] })

    // Occupy the loop for the first turn only; the boundary kick then runs the
    // REAL executor, which is where the duplicate used to appear.
    let release: () => void = () => {}
    const firstTurn = new Promise<void>(resolve => { release = resolve })
    const executeTurn = vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => firstTurn)
    void runtime.dispatch(occupyingDispatch)
    expect(runtime.isBusy()).toBe(true)

    events.length = 0
    const result = await pool.sendToLoop('main', 'reflector', 'BEACON-ONE', true)
    expect(result).toMatchObject({ delivered: true, woke: false })
    // Injected for mid-turn pickup, and the kick is owed until it is drained.
    expect(runtime.session.hasPendingWakeInjection()).toBe(true)

    // The turn ends WITHOUT reaching a model boundary, so nothing drained it.
    respond = replyOnce('ok')
    release()
    await firstTurn
    await settleBoundary()

    // The kick DID run — this is the delivery, not a no-op.
    expect(executeTurn).toHaveBeenCalledTimes(2)
    expect(runtime.session.hasPendingWakeInjection()).toBe(false)

    // Exactly once in context. The kick suppresses its trigger message while the
    // injection is pending, so only the drain puts the row into the session.
    expect(occurrencesInSession(runtime.session, 'BEACON-ONE')).toBe(1)
    // Exactly once in the stream: appended at send, never re-appended.
    expect(rowsMentioning('reflector', 'BEACON-ONE')).toBe(1)
    // Exactly once in the tab: the send-time card, and no second card from a
    // trigger_message the kick would otherwise emit.
    expect(renderEventsFor('BEACON-ONE')).toEqual(['context_injected'])
  })
})

describe('LoopPool — C3: one boundary drains the whole kick queue', () => {
  it('leaves no stale kick (and runs no redundant turn) when both sends were read mid-turn', async () => {
    await pool.createLoop(loop())
    const runtime = pool.getRuntime('reflector')!
    runtime.session.addMessage({ role: 'user', content: [{ type: 'text', text: 'prior' }] })

    let release: () => void = () => {}
    const firstTurn = new Promise<void>(resolve => { release = resolve })
    const executeTurn = vi.spyOn(runtime.executor, 'executeTurn')
      .mockImplementationOnce(() => firstTurn)
      .mockResolvedValue(undefined)
    void runtime.dispatch(occupyingDispatch)

    await pool.sendToLoop('main', 'reflector', 'ALPHA', true)
    await pool.sendToLoop('main', 'reflector', 'BRAVO', true)
    expect(runtime.hasPendingWake()).toBe(true)

    // The running turn reaches a model boundary and drains BOTH — one drain
    // takes the whole queue, which is exactly why one kick was ever owed.
    runtime.session.drainContextInjections()
    expect(runtime.session.hasPendingWakeInjection()).toBe(false)
    expect(occurrencesInSession(runtime.session, 'ALPHA')).toBe(1)
    expect(occurrencesInSession(runtime.session, 'BRAVO')).toBe(1)

    release()
    await firstTurn
    await settleBoundary()

    // Nothing left to deliver ⇒ no kick turn at all.
    expect(executeTurn).toHaveBeenCalledTimes(1)
    // ...and nothing left in the queue. A leftover entry here would report the
    // loop as "wake pending" forever and pin its session against sweepIdle.
    expect(runtime.hasPendingWake()).toBe(false)
    expect(pool.sweepIdle(0, 0)).toBe(1)
  })
})

describe('LoopPool — C2: an undelivered wake survives mid-turn compaction', () => {
  it('keeps the queued injection across the session reset compaction performs', async () => {
    await pool.createLoop(loop())
    const runtime = pool.getRuntime('reflector')!
    // Compaction summarizes the session and rebuilds it from the stream, so the
    // loop needs history in both.
    for (const text of ['first thought', 'second thought']) {
      runtime.session.addMessage({ role: 'user', content: [{ type: 'text', text }] })
    }

    let release: () => void = () => {}
    const firstTurn = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => firstTurn)
    void runtime.dispatch(occupyingDispatch)

    await pool.sendToLoop('main', 'reflector', 'CARRY-ME', true)
    expect(runtime.session.hasPendingWakeInjection()).toBe(true)

    // Compaction lands mid-turn: it clears the stream (taking the send-time row
    // with it) and resets the session, so the queued injection is the ONLY copy
    // of this message left anywhere.
    respond = replyOnce('summary of the conversation so far')
    await (runtime.executor as unknown as {
      forceCompact: (reason: string) => Promise<number>
    }).forceCompact('test')

    // Still owed, so the boundary still knows a kick is needed.
    expect(runtime.session.hasPendingWakeInjection()).toBe(true)
    expect(runtime.session.peekPendingContextInjections()
      .some(injection => injection.text.includes('CARRY-ME'))).toBe(true)

    // ...and the next model boundary actually delivers it.
    runtime.session.drainContextInjections()
    expect(occurrencesInSession(runtime.session, 'CARRY-ME')).toBe(1)

    release()
    await firstTurn
    await settleBoundary()
  })
})
