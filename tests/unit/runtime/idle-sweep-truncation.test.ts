/**
 * Regression tests for the idle-sweep context-truncation incident (2026-08-14):
 * sweepIdleAgents() reset an in-memory session while an LLM turn was in flight.
 * The response landed in the emptied session, so every later request silently
 * ran on a truncated context while the loop table kept the full history.
 *
 * Invariants:
 * 1. The sweep only releases sessions whose EXECUTOR is between turns — the
 *    old guard compared managed.state (display states, where thinking/tool_use
 *    map to 'active') against executor-internal names and never fired.
 * 2. dispatch() rehydrates an empty session from the loop AFTER host hooks and
 *    before the turn, so a released session never produces a truncated LLM
 *    request — regardless of which host attachment dispatched the turn.
 * 3. Re-entrant turns (interrupt restart, unconsumed interrupt, queued-trigger
 *    drain) are scheduled on process.nextTick and never pass through dispatch(),
 *    so neither getState() nor hasInFlightDispatch() sees them. The executor's
 *    own turn counter closes that window and rehydrates the successor.
 * 4. Releasing must not destroy state that lives ONLY in memory: undelivered
 *    loop_inject queue entries, and retry-buffered loop writes whose flush failed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-sweep-test-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-sweep-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { BackgroundAgentManager, type BackgroundManagedAgent } from '../../../src/main/runtime/background-agent-manager'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import { assembleAgent, type AssembledAgent } from '../../../src/main/runtime/assemble-agent'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMMessage } from '../../../src/main/providers/provider.interface'
import type { SettingsService } from '../../../src/main/services/settings.service'

// The token-usage service resolves its storage through defaultUserDataPath();
// without this override the test writes into the developer's live app profile.
const previousUserDataDir = process.env.ADF_USER_DATA_DIR

function makeSettings(): SettingsService {
  return {
    get: (_key: string) => undefined,
    getProvider: (id: string) => ({ id: id || 'mock', type: 'anthropic', name: 'mock-provider', apiKey: 'test-key' }),
  } as unknown as SettingsService
}

function chatDispatch(message: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test:idle-sweep',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text' as const, text: message }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

// Typed against the real managed-entry shape so field renames or new sweep
// reads break at compile time instead of silently diverging in the stubs.
type SweepEntry = Pick<BackgroundManagedAgent, 'state' | 'executor' | 'session' | 'workspace' | 'assembledAgent'>

interface FakeOpts {
  /** Lifecycle-tracked dispatch (host hooks + turn) still settling. */
  inFlight?: boolean
  /** Executor-internal turn in flight or already committed via nextTick. */
  turnActive?: boolean
  /** Code-authored context queued but not yet delivered to the model. */
  /** Undelivered context injections held in memory. `true` = an unkeyed
   *  loop_inject entry (never replayable); 'replayable' = a persisted
   *  loop_send row (seq, no wake) the rehydrate brings back; 'wake' = a
   *  loop_send with a boundary kick still owed (release would downgrade it). */
  pendingInjections?: boolean | 'replayable' | 'wake'
  /** flushToLoop's transaction failed and kept its retry buffer. */
  pendingWrites?: boolean
}

/** A fake managed-agent entry the sweep can iterate without a real runtime. */
function fakeManaged(executorState: string, messageCount: number, opts?: FakeOpts) {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `m${i}` }],
  }))
  const flushToLoop = vi.fn()
  const reset = vi.fn(() => { messages.length = 0 })
  const insertLog = vi.fn()
  const entry: SweepEntry = {
    state: 'active', // display state during a live turn — must NOT gate the sweep
    executor: {
      getState: () => executorState,
      isTurnActive: () => opts?.turnActive ?? false,
    } as unknown as SweepEntry['executor'],
    session: {
      getMessages: () => messages,
      flushToLoop,
      reset,
      hasPendingWrites: () => opts?.pendingWrites ?? false,
      peekPendingContextInjections: () => {
        const kind = opts?.pendingInjections
        if (!kind) return []
        if (kind === true) return [{ role: 'user', text: 'x', category: 'code', origin: 'loop_inject' }]
        return [{ role: 'user', text: 'x', category: 'loop', origin: 'loop_send', seq: 7, wake: kind === 'wake' }]
      },
    } as unknown as SweepEntry['session'],
    workspace: { insertLog } as unknown as SweepEntry['workspace'],
    assembledAgent: { hasInFlightDispatch: () => opts?.inFlight ?? false } as unknown as SweepEntry['assembledAgent'],
  }
  return { entry, messages, flushToLoop, reset, insertLog }
}

/** Register `entry` plus enough padding to clear the sweep's `size < 5` guard. */
function seedSweepMap(manager: BackgroundAgentManager, entry: SweepEntry, label: string): void {
  const agentsMap = (manager as unknown as { agents: Map<string, SweepEntry> }).agents
  agentsMap.set(`C:\\fake\\${label}.adf`, entry)
  for (let i = 0; i < 4; i++) {
    agentsMap.set(`C:\\fake\\${label}-padding-${i}.adf`, fakeManaged('idle', 0).entry)
  }
}

function runSweep(manager: BackgroundAgentManager): void {
  ;(manager as unknown as { sweepIdleAgents(): void }).sweepIdleAgents()
}

const managers: BackgroundAgentManager[] = []
const agents: Array<AssembledAgent<'headlessLive'>> = []
const tempDirs: string[] = []

beforeAll(() => {
  process.env.ADF_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adf-sweep-userdata-'))
})

afterAll(() => {
  if (previousUserDataDir === undefined) delete process.env.ADF_USER_DATA_DIR
  else process.env.ADF_USER_DATA_DIR = previousUserDataDir
})

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    ;(manager as unknown as { agents: Map<string, unknown> }).agents.clear()
    manager.dispose()
  }
  for (const agent of agents.splice(0)) {
    try { agent.dispose() } catch { /* best effort */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  vi.restoreAllMocks()
})

describe('idle sweep vs live turns', () => {
  it('releases only large sessions whose executor is between turns, and flushes before resetting', () => {
    const manager = new BackgroundAgentManager(makeSettings(), '', {})
    managers.push(manager)
    const agentsMap = (manager as unknown as { agents: Map<string, unknown> }).agents

    // States holding a live turn must never be released.
    const midTurn = fakeManaged('thinking', 60)
    const toolUse = fakeManaged('tool_use', 60)
    const awaitingApproval = fakeManaged('awaiting_approval', 60)
    const awaitingAsk = fakeManaged('awaiting_ask', 60)
    const suspended = fakeManaged('suspended', 60)
    // An accepted dispatch between its pre-thinking awaits reads 'idle' —
    // the in-flight gate must still protect it.
    const idleInFlight = fakeManaged('idle', 60, { inFlight: true })
    // A re-entrant turn scheduled on nextTick is invisible to BOTH the executor
    // state and the lifecycle's in-flight set — only the turn counter sees it.
    const idleTurnActive = fakeManaged('idle', 60, { turnActive: true })
    // Undelivered loop_inject entries exist only in memory.
    const idlePendingInjection = fakeManaged('idle', 60, { pendingInjections: true })
    // A loop_send whose wake:true kick is still owed must not be released either.
    const idlePendingWake = fakeManaged('idle', 60, { pendingInjections: 'wake' })
    // A persisted, non-wake loop_send IS replayable: rehydrate brings it back.
    const idleReplayable = fakeManaged('idle', 60, { pendingInjections: 'replayable' })
    // flushToLoop kept its buffer (transaction failed) — reset would drop rows.
    const idlePendingWrites = fakeManaged('idle', 60, { pendingWrites: true })
    // Between-turns states are releasable; 51/50 pins the >50 threshold.
    const idleLarge = fakeManaged('idle', 51)
    const idleSmall = fakeManaged('idle', 50)
    const stopped = fakeManaged('stopped', 60)
    const errored = fakeManaged('error', 60)
    const all = {
      midTurn, toolUse, awaitingApproval, awaitingAsk, suspended, idleInFlight,
      idleTurnActive, idlePendingInjection, idlePendingWake, idlePendingWrites,
      idleReplayable, idleLarge, idleSmall, stopped, errored,
    }
    for (const [name, fake] of Object.entries(all)) {
      agentsMap.set(`C:\\fake\\${name}.adf`, fake.entry)
    }

    // No lastActivityTime entries → every agent reads as long-idle (the stale
    // clock that let the incident happen). The executor gate must still hold.
    runSweep(manager)

    for (const fake of [midTurn, toolUse, awaitingApproval, awaitingAsk, suspended, idleInFlight, idleTurnActive, idlePendingInjection, idlePendingWake, idleSmall]) {
      expect(fake.reset).not.toHaveBeenCalled()
      expect(fake.flushToLoop).not.toHaveBeenCalled()
      expect(fake.insertLog).not.toHaveBeenCalled()
    }
    expect(midTurn.messages).toHaveLength(60)
    expect(idleTurnActive.messages).toHaveLength(60)
    expect(idlePendingInjection.messages).toHaveLength(60)
    expect(idleSmall.messages).toHaveLength(50)

    // A failed flush is only detectable AFTER attempting it: the sweep must
    // still try, then abandon the release instead of resetting the buffer away.
    expect(idlePendingWrites.flushToLoop).toHaveBeenCalled()
    expect(idlePendingWrites.reset).not.toHaveBeenCalled()
    expect(idlePendingWrites.insertLog).not.toHaveBeenCalled()
    expect(idlePendingWrites.messages).toHaveLength(60)

    for (const fake of [idleLarge, idleReplayable, stopped, errored]) {
      expect(fake.flushToLoop).toHaveBeenCalled()
      expect(fake.reset).toHaveBeenCalled()
      // Buffered writes die in reset() — the flush must come first.
      expect(fake.flushToLoop.mock.invocationCallOrder[0]).toBeLessThan(fake.reset.mock.invocationCallOrder[0])
      expect(fake.messages).toHaveLength(0)
    }
    expect(idleLarge.insertLog).toHaveBeenCalledWith(
      'info', 'runtime', 'session_released', null, expect.stringMatching(/\b51\b/),
    )
  })

  it('dispatch rehydrates a released session from the loop after host hooks, without inventing or duplicating content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-sweep-rehydrate-'))
    tempDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), {
      name: 'sweep-rehydrate-test',
      autonomous: false,
      start_in_state: 'active',
    })

    let capturedMessages: LLMMessage[] | null = null
    const provider = new (class extends MockLLMProvider {
      override async createMessage(opts: CreateMessageOptions) {
        if (!capturedMessages) capturedMessages = opts.messages.map(m => ({ ...m }))
        return super.createMessage(opts)
      }
    })({ tokensPerResponse: 4 })

    const registry = new ToolRegistry()
    registerBuiltInTools(registry)
    const agent = assembleAgent({
      profile: 'headlessLive',
      workspace,
      config: workspace.getAgentConfig(),
      provider,
      registry,
    })
    agents.push(agent)
    await agent.start()

    // Loop holds history the in-memory session no longer has — the exact
    // post-sweep state. Realistic content: plain turns, a paired tool
    // exchange, and a UI-only [Context: ...] row that must NOT reach the LLM.
    for (let i = 0; i < 60; i++) {
      const role = i % 2 === 0 ? 'user' as const : 'assistant' as const
      workspace.appendToLoop(role, [{ type: 'text', text: `history-${i}` }])
    }
    workspace.appendToLoop('user', [{ type: 'text', text: '[Context: system_prompt] ui-only row' }])
    workspace.appendToLoop('assistant', [{ type: 'tool_use', id: 'tu-1', name: 'fs_read', input: { path: 'x' } }])
    workspace.appendToLoop('user', [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'tool output' }])
    expect(agent.session.getMessages()).toHaveLength(0)

    // A host hook that empties the session mid-dispatch (a host-side release
    // racing the turn): the rehydrate must run AFTER hooks, or this dispatch
    // goes out truncated.
    agent.attachHost({ beforeDispatch: () => { agent.session.reset() } })

    await agent.dispatch(chatDispatch('are you still with me?'))

    // 60 text turns + 2 tool-exchange messages restored (context row filtered)
    // + the chat trigger. Exact count: double-loads and dropped rows both fail.
    expect(capturedMessages).not.toBeNull()
    const msgs = capturedMessages! as LLMMessage[]
    expect(msgs).toHaveLength(63)
    const textOf = (m: LLMMessage) =>
      Array.isArray(m.content) ? m.content.map(b => ('text' in b && b.text) || '').join('') : String(m.content)
    expect(textOf(msgs[0])).toBe('history-0')
    expect(textOf(msgs[59])).toBe('history-59')
    expect(textOf(msgs[62])).toContain('are you still with me?')
    expect(msgs.filter(m => textOf(m) === 'history-0')).toHaveLength(1)
    expect(msgs.some(m => textOf(m).includes('[Context:'))).toBe(false)
    // The paired tool exchange survives rehydrate repair untouched.
    expect(msgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.id === 'tu-1'))).toBe(true)
    expect(msgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'tu-1'))).toBe(true)
  })
})

describe('idle sweep vs re-entrant turns', () => {
  it('holds the session across the nextTick gap between a finished turn and the queued trigger it drains', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-sweep-reentrant-'))
    tempDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent-1.adf'), {
      name: 'agent-1',
      autonomous: false,
      start_in_state: 'active',
    })
    for (let i = 0; i < 60; i++) {
      const role = i % 2 === 0 ? 'user' as const : 'assistant' as const
      workspace.appendToLoop(role, [{ type: 'text', text: `history-${i}` }])
    }

    // Each provider call parks until the test releases it, so the turn boundary
    // is observable instead of raced.
    const entered = [deferred(), deferred()]
    const gate = [deferred(), deferred()]
    const seen: LLMMessage[][] = []
    let call = 0
    const provider = new (class extends MockLLMProvider {
      override async createMessage(opts: CreateMessageOptions) {
        const index = call++
        seen.push(opts.messages.map(m => ({ ...m })))
        entered[index]?.resolve()
        await gate[index]?.promise
        return super.createMessage(opts)
      }
    })({ tokensPerResponse: 4 })

    const registry = new ToolRegistry()
    registerBuiltInTools(registry)
    const agent = assembleAgent({
      profile: 'headlessLive',
      workspace,
      config: workspace.getAgentConfig(),
      provider,
      registry,
      restoreLoop: true,
    })
    agents.push(agent)
    expect(agent.session.getMessages()).toHaveLength(60)
    await agent.start()

    const manager = new BackgroundAgentManager(makeSettings(), '', {})
    managers.push(manager)
    seedSweepMap(manager, {
      state: 'active',
      executor: agent.executor,
      session: agent.session,
      workspace,
      assembledAgent: agent as unknown as SweepEntry['assembledAgent'],
    }, 'agent-1')

    const turn1 = agent.dispatch(chatDispatch('first'))
    await entered[0].promise

    // A background trigger arriving mid-turn is QUEUED by the executor, not
    // dispatched — so the turn that eventually runs it never enters the
    // lifecycle's in-flight set.
    await agent.dispatch(createDispatch(
      createEvent({ type: 'file_change', source: 'test:idle-sweep', data: { path: 'notes.md', operation: 'modified' } }),
      { scope: 'agent' },
    ))

    gate[0].resolve()
    await turn1

    // The exact window the sweep used to walk into: the executor reports
    // 'idle', the lifecycle has no in-flight dispatch, yet a successor turn is
    // already committed on the nextTick queue.
    expect(agent.executor.getState()).toBe('idle')
    expect(agent.hasInFlightDispatch()).toBe(false)
    expect(agent.executor.isTurnActive()).toBe(true)

    const messagesBefore = agent.session.getMessages().length
    expect(messagesBefore).toBeGreaterThan(50)
    runSweep(manager)
    expect(agent.session.getMessages()).toHaveLength(messagesBefore)

    // The successor runs on the full history, not a post-release stub.
    await entered[1].promise
    const textOf = (m: LLMMessage) =>
      Array.isArray(m.content) ? m.content.map(b => ('text' in b && b.text) || '').join('') : String(m.content)
    expect(seen[1].length).toBeGreaterThan(50)
    expect(textOf(seen[1][0])).toBe('history-0')

    gate[1].resolve()
    await vi.waitFor(() => expect(agent.executor.isTurnActive()).toBe(false))
  })

  it('rehydrates a re-entrant turn that starts on an already-released session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-sweep-reentrant-rehydrate-'))
    tempDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent-2.adf'), {
      name: 'agent-2',
      autonomous: false,
      start_in_state: 'active',
    })
    for (let i = 0; i < 60; i++) {
      const role = i % 2 === 0 ? 'user' as const : 'assistant' as const
      workspace.appendToLoop(role, [{ type: 'text', text: `history-${i}` }])
    }

    const entered = [deferred(), deferred()]
    const seen: LLMMessage[][] = []
    let call = 0
    const provider = new (class extends MockLLMProvider {
      override async createMessage(opts: CreateMessageOptions) {
        const index = call++
        seen.push(opts.messages.map(m => ({ ...m })))
        entered[index]?.resolve()
        // Release the session exactly the way an idle sweep would, mid-turn, so
        // the successor scheduled by this turn starts on an empty session.
        if (index === 0) agent.session.reset()
        return super.createMessage(opts)
      }
    })({ tokensPerResponse: 4 })

    const registry = new ToolRegistry()
    registerBuiltInTools(registry)
    const agent = assembleAgent({
      profile: 'headlessLive',
      workspace,
      config: workspace.getAgentConfig(),
      provider,
      registry,
      restoreLoop: true,
    })
    agents.push(agent)
    await agent.start()

    const turn1 = agent.dispatch(chatDispatch('first'))
    await entered[0].promise
    await agent.dispatch(createDispatch(
      createEvent({ type: 'file_change', source: 'test:idle-sweep', data: { path: 'notes.md', operation: 'modified' } }),
      { scope: 'agent' },
    ))
    await turn1

    await entered[1].promise
    const textOf = (m: LLMMessage) =>
      Array.isArray(m.content) ? m.content.map(b => ('text' in b && b.text) || '').join('') : String(m.content)
    // Without the executor-side rehydrate the drained trigger would run on a
    // one-message context; the loop table's history must be back.
    expect(seen[1].length).toBeGreaterThan(50)
    expect(textOf(seen[1][0])).toBe('history-0')
    await vi.waitFor(() => expect(agent.executor.isTurnActive()).toBe(false))
  })
})

describe('session state that lives only in memory', () => {
  it('restoreMessages preserves undelivered injections and does not double-deliver keyed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-sweep-injections-'))
    tempDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent-1.adf'), {
      name: 'agent-1',
      autonomous: false,
      start_in_state: 'active',
    })

    const session = new AgentSession(workspace)
    // Mirrors loop_inject: the row is persisted first, then queued in memory.
    const keyedText = '[Context: state | loop_inject=v2 | origin=code:test | key=budget] remaining=3'
    const unkeyedText = '[Context: notice | loop_inject=v2 | origin=code:test] one-shot notice'
    workspace.appendToLoop('user', [{ type: 'text', text: keyedText }])
    workspace.appendToLoop('user', [{ type: 'text', text: unkeyedText }])
    session.queueContextInjection({ role: 'user', text: keyedText, category: 'state', origin: 'code:test', key: 'budget' })
    session.queueContextInjection({ role: 'user', text: unkeyedText, category: 'notice', origin: 'code:test' })
    expect(session.hasPendingContextInjections()).toBe(true)

    // The idle-sweep rehydrate path: rebuild from the loop while the queue is
    // still undelivered.
    session.restoreMessages(workspace.getLoop().map(entry => ({
      role: entry.role, content: entry.content_json, created_at: entry.created_at, seq: entry.seq,
    })))
    expect(session.hasPendingContextInjections()).toBe(true)

    const delivered = session.drainContextInjections()
    // Keyed entry survives once (loop replay coalesced with the queued one);
    // the unkeyed entry — which the loop deliberately never replays — is intact.
    expect(delivered.map(d => d.text)).toEqual([keyedText, unkeyedText])
    expect(session.hasPendingContextInjections()).toBe(false)
    // Delivered exactly once each, and the raw [Context: ...] rows themselves
    // never re-enter history as ordinary messages.
    const texts = session.getMessages().map(m =>
      Array.isArray(m.content) ? m.content.map(b => ('text' in b && b.text) || '').join('') : String(m.content))
    expect(texts.filter(t => t === keyedText)).toHaveLength(1)
    expect(texts.filter(t => t === unkeyedText)).toHaveLength(1)
  })

  it('flags a retry buffer that outlived its flush so the sweep can skip the release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-sweep-pending-writes-'))
    tempDirs.push(dir)
    const workspace = AdfWorkspace.create(join(dir, 'agent-1.adf'), {
      name: 'agent-1',
      autonomous: false,
      start_in_state: 'active',
    })

    const session = new AgentSession(workspace)
    expect(session.hasPendingWrites()).toBe(false)

    // Immediate write-through fails → the entry falls back to the retry buffer.
    const appendSpy = vi.spyOn(workspace, 'appendToLoop').mockImplementation(() => { throw new Error('db busy') })
    session.addMessage({ role: 'user', content: [{ type: 'text', text: 'unflushable' }] })
    expect(session.hasPendingWrites()).toBe(true)

    // A failing flush keeps the buffer by contract — reset() would destroy it.
    session.flushToLoop()
    expect(session.hasPendingWrites()).toBe(true)

    appendSpy.mockRestore()
    session.flushToLoop()
    expect(session.hasPendingWrites()).toBe(false)
  })
})
