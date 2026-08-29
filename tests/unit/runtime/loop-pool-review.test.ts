/**
 * The second half of the LoopPool contract: the parts that only show up under
 * concurrency, under a cold session, or when something fails.
 *
 * loop-pool.test.ts covers the happy shapes (create → derive → send → delete).
 * This file covers what the adversarial review found missing — dispatch routing
 * while a delete is archiving, config edits racing that archive, a woken loop
 * being shown its message twice, wakes discarded by a refusal, and errors that
 * would have handed the model raw SQL.
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
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { AgentConfig, LoopConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfBatchDispatch, AdfEventDispatch } from '../../../src/shared/types/adf-event.types'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

let rootDir: string
let filePath: string
let ws: AdfWorkspace
let pool: LoopPool
let events: AgentExecutionEvent[]
let mainSession: AgentSession
let mainBusy: boolean
let mainState: string
let mainDispatches: Array<AdfEventDispatch | AdfBatchDispatch>

/**
 * Most tests here never run a turn. The ones that DO — the delivery-duplication
 * tests, which are about what the model actually ends up being shown — set
 * `respond` first.
 */
let respond: (() => Promise<LLMResponse>) | null = null

const provider: LLMProvider = {
  name: 'stub',
  providerId: 'stub',
  modelId: 'stub-model',
  createMessage: async () => {
    if (!respond) throw new Error('no turns in this test')
    return respond()
  },
  validateConfig: async () => ({ valid: true }),
}

/** A turn that says one thing and stops. */
function replyOnce(text = 'noted'): () => Promise<LLMResponse> {
  return async () => ({
    id: 'reply',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** How many times `needle` appears in the history the model would be sent. */
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

function chatDispatch(id: string, text = 'hi'): AdfEventDispatch {
  return {
    event: {
      id, type: 'chat', source: 'test', time: '',
      data: {
        message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() },
      } as never,
    },
    scope: 'agent',
  } as AdfEventDispatch
}

function buildPool(mutate?: (config: AgentConfig) => void): LoopPool {
  const config = ws.getAgentConfig()
  const fsRead = config.tools.find(t => t.name === 'fs_read')
  if (fsRead) fsRead.enabled = true
  // Provider-error auto-retry would schedule a second turn behind the one under
  // test and make the settle count nondeterministic.
  config.recovery = { ...(config.recovery ?? {}), auto_retry: false }
  // A real host provider: the default .adf ships `provider: ''`, and an unset
  // host provider is (correctly) no constraint on a loop's model override.
  config.model = { ...config.model, provider: 'anthropic', model_id: 'claude-test' }
  mutate?.(config)
  ws.setAgentConfig(config)

  const registry = new ToolRegistry()
  registerBuiltInTools(registry)

  let live = ws.getAgentConfig()
  events = []
  return new LoopPool({
    workspace: ws,
    registry,
    getProvider: () => provider,
    basePrompt: '',
    toolPrompts: {},
    adfCallHandler: null,
    codeSandboxService: null,
    mcpManager: null,
    getHostConfig: () => live,
    saveConfig: (next) => {
      ws.setAgentConfig(next)
      live = next
      pool.reconcile(next)
    },
    onLoopEvent: (event) => { events.push(event) },
    main: {
      session: mainSession,
      isBusy: () => mainBusy,
      dispatch: async (value) => { mainDispatches.push(value) },
      getState: () => mainState,
    },
  })
}

const loop = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  name: 'reflector',
  goal: 'Notice what main missed.',
  enabled: true,
  tools: [],
  ...over,
})

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-loop-review-'))
  filePath = join(rootDir, 'agent.adf')
  ws = AdfWorkspace.create(filePath, { name: 'pooled' })
  mainSession = new AgentSession(ws)
  mainBusy = false
  mainState = 'idle'
  mainDispatches = []
  respond = null
  pool = buildPool()
})

afterEach(() => {
  vi.restoreAllMocks()
  try { pool.dispose() } catch { /* already disposed */ }
  try { ws.close() } catch { /* a test may have closed it */ }
  clearAllUmbilicalBuses()
  rmSync(rootDir, { recursive: true, force: true })
})

// ===========================================================================
// Refusals the pool owns
// ===========================================================================

describe('LoopPool — refusals the pool owns', () => {
  beforeEach(async () => {
    await pool.createLoop(loop())
  })

  it('refuses a self-send at the POOL, not just in the tool', async () => {
    // The tool checks too, for a better message — but the pool is the check
    // every non-tool caller also crosses, and a loop talking to itself is an
    // append plus a wake into the turn already running.
    await expect(pool.sendToLoop('reflector', 'reflector', 'hi', true))
      .rejects.toThrow(/that is the sending loop/)
    await expect(pool.sendToLoop('main', 'main', 'hi', true))
      .rejects.toThrow(/that is the sending loop/)
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(0)
    expect(ws.getLoop()).toHaveLength(0)
  })

  it('never lets a raw driver message reach the model', async () => {
    // The loop tools surface error.message verbatim, so a better-sqlite3
    // sentence here would put SQL text and a file path into the context window.
    vi.spyOn(ws, 'appendToLoop').mockImplementation(() => {
      throw new Error(`SqliteError: no such table: main.adf_loop --- ${filePath}`)
    })

    const message = await pool.sendToLoop('main', 'reflector', 'hi', false)
      .then(() => 'did not throw', (error: Error) => error.message)

    expect(message).toMatch(/loop_send failed for an internal reason/)
    expect(message).not.toMatch(/sqlite|adf_loop|no such table/i)
    expect(message).not.toContain(filePath)
  })

  it('rejects a cross-provider model override on create AND update', async () => {
    // providerForModel builds the new provider from the HOST's config and
    // credentials, so honouring another vendor would silently cross-wire them.
    const host = ws.getAgentConfig()
    expect(host.model.provider).toBe('anthropic')
    const crossProvider = { provider: 'openai', model_id: 'gpt-whatever' } as never

    await expect(pool.createLoop(loop({ name: 'critic', model: crossProvider })))
      .rejects.toThrow(/may change the model, not the provider/)
    expect(ws.getAgentConfig().loops?.map(l => l.name)).toEqual(['reflector'])

    await expect(pool.updateLoop('reflector', { model: crossProvider }))
      .rejects.toThrow(/may change the model, not the provider/)
    expect(ws.getAgentConfig().loops?.[0].model).toBeUndefined()

    // Same provider, different model id — the point of a per-loop model.
    await pool.updateLoop('reflector', {
      model: { provider: host.model.provider, model_id: 'a-cheaper-model' } as never,
    })
    expect(ws.getAgentConfig().loops?.[0].model?.model_id).toBe('a-cheaper-model')
  })
})

// ===========================================================================
// updateLoop against a running turn
// ===========================================================================

describe('LoopPool — updateLoop against a running turn', () => {
  it('disables a RUNNING loop at the turn boundary, never under its own turn', async () => {
    await pool.createLoop(loop())
    const runtime = pool.getRuntime('reflector')!
    let release: () => void = () => {}
    const turn = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => turn)
    const running = runtime.dispatch(chatDispatch('e1'))

    await pool.updateLoop('reflector', { enabled: false })

    // The in-flight turn is not interrupted; nothing new starts on it.
    expect(runtime.disposeAfterTurn).toBe(true)
    expect(pool.getRuntime('reflector')).toBe(runtime)
    expect(pool.dispatchToLoop('reflector', chatDispatch('e2'))).toMatchObject({ ok: false })
    // Still a real, addressable loop: appends land, wakes do not.
    expect(await pool.sendToLoop('main', 'reflector', 'later', true))
      .toEqual({ delivered: true, woke: false, reason: 'loop disabled' })

    release()
    await running
    await new Promise(resolve => setImmediate(resolve))
    expect(pool.getRuntime('reflector')).toBeUndefined()
    expect(pool.hasLoop('reflector')).toBe(true)
  })
})

// ===========================================================================
// deleteLoop under concurrency (review M3)
// ===========================================================================

describe('LoopPool — deleteLoop under concurrency', () => {
  beforeEach(async () => {
    await pool.createLoop(loop())
  })

  it('condemns the runtime BEFORE the archive and keeps concurrent config edits', async () => {
    ws.forLoop('reflector').appendToLoop('user', [{ type: 'text', text: 'a thought' }])

    let releaseClear: () => void = () => {}
    const clearing = new Promise<void>(resolve => { releaseClear = resolve })
    vi.spyOn(ws, 'clearLoop').mockImplementation(async () => {
      await clearing
      return { archivedEntries: 1 } as never
    })

    const deleting = pool.deleteLoop('reflector')
    await new Promise(resolve => setImmediate(resolve))

    // Nothing may start a turn on a loop whose stream is being archived — the
    // archive would wipe that turn's writes.
    expect(pool.dispatchToLoop('reflector', chatDispatch('e1')))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/being deleted/) })

    // A config change lands DURING the multi-second archive. Writing back the
    // snapshot taken before it would silently revert this.
    await pool.createLoop(loop({ name: 'critic', goal: 'Disagree usefully.' }))

    releaseClear()
    await deleting

    expect(ws.getAgentConfig().loops?.map(l => l.name)).toEqual(['critic'])
    expect(pool.getRuntime('reflector')).toBeUndefined()
    expect(pool.getRuntime('critic')).toBeDefined()
  })

  it('abandons the delete (and un-condemns) when a turn slipped in before the archive', async () => {
    const runtime = pool.getRuntime('reflector')!
    let releaseClear: () => void = () => {}
    const clearing = new Promise<void>(resolve => { releaseClear = resolve })
    vi.spyOn(ws, 'clearLoop').mockImplementation(async () => {
      await clearing
      return { archivedEntries: 0 } as never
    })

    const deleting = pool.deleteLoop('reflector')
    await new Promise(resolve => setImmediate(resolve))

    // The gap between the isBusy() check and the condemn: simulate the turn
    // that got in by dispatching straight at the runtime, past the router.
    let releaseTurn: () => void = () => {}
    const turn = new Promise<void>(resolve => { releaseTurn = resolve })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => turn)
    const running = runtime.dispatch(chatDispatch('e1'))

    releaseClear()
    await expect(deleting).rejects.toThrow(/abandoned/)

    // The loop survives — and, critically, can take work again.
    expect(ws.getAgentConfig().loops?.map(l => l.name)).toEqual(['reflector'])
    expect(runtime.condemned).toBe(false)

    releaseTurn()
    await running
    expect(pool.dispatchToLoop('reflector', chatDispatch('e2'))).toMatchObject({ ok: true })
  })
})

// ===========================================================================
// reconcile completes a removal (review m8)
// ===========================================================================

describe('LoopPool — reconcile removes a loop completely', () => {
  it('drops the timers of a loop deleted by a config edit, not just by loop_manage', async () => {
    await pool.createLoop(loop())
    const mainTimer = ws.addTimer({ mode: 'interval', every_ms: 60_000 }, Date.now() + 60_000, undefined, ['agent'])
    const loopTimer = ws.forLoop('reflector').addTimer(
      { mode: 'interval', every_ms: 60_000 }, Date.now() + 60_000, undefined, ['agent']
    )

    // Studio (or a hand edit) removes the loop: no loop_manage, no deleteLoop,
    // just a reconcile.
    const next: AgentConfig = { ...ws.getAgentConfig(), loops: [] }
    ws.setAgentConfig(next)
    pool.reconcile(next)

    const remaining = ws.getTimers().map(t => t.id)
    expect(remaining).toContain(mainTimer)
    // A surviving orphan re-points at main the moment the router cannot find
    // its loop, and a loop later recreated under the same name inherits it.
    expect(remaining).not.toContain(loopTimer)
  })

  it('drops the timers of a DISABLED loop too — it has no runtime to find it by', async () => {
    await pool.createLoop(loop({ enabled: false }))
    const loopTimer = ws.forLoop('reflector').addTimer(
      { mode: 'interval', every_ms: 60_000 }, Date.now() + 60_000, undefined, ['agent']
    )

    const next: AgentConfig = { ...ws.getAgentConfig(), loops: [] }
    ws.setAgentConfig(next)
    pool.reconcile(next)

    expect(ws.getTimers().map(t => t.id)).not.toContain(loopTimer)
  })
})

// ===========================================================================
// Pending wakes survive a refusal (review m10)
// ===========================================================================

describe('LoopPool — a refused wake is not a lost wake', () => {
  it('re-queues a wake the router refused at the turn boundary', async () => {
    await pool.createLoop(loop())
    const runtime = pool.getRuntime('reflector')!
    let release: () => void = () => {}
    const turn = new Promise<void>(resolve => { release = resolve })
    const executeTurn = vi.spyOn(runtime.executor, 'executeTurn')
      .mockImplementationOnce(() => turn)
      .mockResolvedValue(undefined)

    const running = runtime.dispatch(chatDispatch('e1'))
    await pool.sendToLoop('main', 'reflector', 'read me', true)
    expect(runtime.hasPendingWake()).toBe(true)

    // Suspended between the turn boundary and the drain: the router refuses,
    // and the wake must NOT be discarded — nothing else would ever wake the
    // loop on that row.
    mainState = 'suspended'
    release()
    await running
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    expect(executeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.hasPendingWake()).toBe(true)

    // Resumed: the next boundary delivers it.
    mainState = 'idle'
    await runtime.dispatch(chatDispatch('e2'))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(executeTurn).toHaveBeenCalledTimes(3)
    expect(runtime.hasPendingWake()).toBe(false)
  })
})

// ===========================================================================
// Idle sweep vs. pending injections (review m11)
// ===========================================================================

describe('LoopPool — idle sweep and pending injections', () => {
  beforeEach(async () => {
    await pool.createLoop(loop())
  })

  it('releases a session whose only pending injection is a durable loop_send row', async () => {
    const runtime = pool.getRuntime('reflector')!
    runtime.session.addMessage({ role: 'user', content: [{ type: 'text', text: 'earlier' }] })

    await pool.sendToLoop('main', 'reflector', 'no rush', false)
    expect(runtime.session.hasPendingContextInjections()).toBe(true)

    // wake:false would otherwise pin this session open indefinitely. Dropping
    // the injection is safe BECAUSE the row was appended at send time: the
    // rehydrate replays it as an ordinary user message.
    expect(pool.sweepIdle(0, 0)).toBe(1)
    expect(runtime.session.getMessages()).toHaveLength(0)
    expect(ws.forLoop('reflector').getLoop()
      .some(r => r.content_json[0]?.text === '[from loop:main] no rush')).toBe(true)
  })

  it('still refuses to release when a non-replayable injection is queued', async () => {
    const runtime = pool.getRuntime('reflector')!
    runtime.session.addMessage({ role: 'user', content: [{ type: 'text', text: 'earlier' }] })
    // An unkeyed one-shot notice lives ONLY in the queue — its loop row is
    // audit-only and is deliberately never replayed.
    runtime.session.queueContextInjection({
      role: 'user', text: 'one-shot notice', category: 'note', origin: 'code',
    })

    expect(pool.sweepIdle(0, 0)).toBe(0)
    expect(runtime.session.getMessages()).toHaveLength(1)
  })
})

// ===========================================================================
// Bound-tool rebinding (review m7)
// ===========================================================================

describe('LoopPool — a tool the loop is granted but the pool cannot build', () => {
  it("unregisters main's bound instance instead of leaving it in the loop registry", async () => {
    // sys_code is granted, but this pool has no sandbox, so the per-loop
    // instance cannot be built. Main's instance — bound to MAIN's call handler
    // — must not be what the loop finds under that name.
    pool.dispose()
    pool = buildPool(config => {
      const sysCode = config.tools.find(t => t.name === 'sys_code')
      if (sysCode) sysCode.enabled = true
    })
    await pool.createLoop(loop({ tools: ['sys_code'] }))

    const runtime = pool.getRuntime('reflector')!
    expect(runtime.derived.tools.find(t => t.name === 'sys_code')?.enabled).toBe(true)
    expect(runtime.registry.get('sys_code')).toBeUndefined()
    // loop_manage never reaches a loop registry either — loops do not nest.
    expect(runtime.registry.get('loop_manage')).toBeUndefined()
  })
})

// ===========================================================================
// What the model actually sees (review M6 / RT-F6)
// ===========================================================================

describe('LoopPool — what the model actually sees', () => {
  beforeEach(async () => {
    await pool.createLoop(loop())
    respond = replyOnce()
  })

  it('shows a woken COLD loop the message exactly once', async () => {
    const runtime = pool.getRuntime('reflector')!
    // Cold: the idle sweep released the session while the stream kept the
    // history. This is the normal case after an idle agent wakes, not an
    // exotic one.
    expect(runtime.session.getMessages()).toHaveLength(0)

    await pool.sendToLoop('main', 'reflector', 'ping', true)
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    // Once in the stream...
    expect(ws.forLoop('reflector').getLoop()
      .filter(r => r.content_json[0]?.text === '[from loop:main] ping')).toHaveLength(1)
    // ...and once in the context. The dispatch rehydrated the row; inlining it
    // again on top is what made a woken loop read every message twice.
    expect(occurrencesInSession(runtime.session, '[from loop:main] ping')).toBe(1)
  })

  it('shows a woken WARM loop the message exactly once', async () => {
    const runtime = pool.getRuntime('reflector')!
    runtime.session.addMessage({ role: 'user', content: [{ type: 'text', text: 'earlier' }] })

    await pool.sendToLoop('main', 'reflector', 'ping', true)
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    expect(ws.forLoop('reflector').getLoop()
      .filter(r => r.content_json[0]?.text === '[from loop:main] ping')).toHaveLength(1)
    // A live session never re-reads the stream, so here the inline IS the
    // delivery — and it must still happen exactly once.
    expect(occurrencesInSession(runtime.session, '[from loop:main] ping')).toBe(1)
  })

  it('shows a woken COLD main the message exactly once', async () => {
    // The same bug on main's ingest path: loop_send to main after a sweep.
    expect(mainSession.getMessages()).toHaveLength(0)
    await pool.sendToLoop('reflector', 'main', 'ping', true)
    expect(mainDispatches).toHaveLength(1)

    // Replay what the host's dispatch choke point does: rehydrate the released
    // session from the stream, then run the turn.
    mainSession.restoreMessages(ws.getLoop().map(entry => ({
      role: entry.role, content: entry.content_json, created_at: entry.created_at, seq: entry.seq,
    })))
    const mainExecutor = new AgentExecutor(
      ws.getAgentConfig(), provider, new ToolRegistry(), mainSession, '', {},
    )
    await mainExecutor.executeTurn(mainDispatches[0] as AdfEventDispatch)

    expect(ws.getLoop()
      .filter(r => r.content_json[0]?.text === '[from loop:reflector] ping')).toHaveLength(1)
    expect(occurrencesInSession(mainSession, '[from loop:reflector] ping')).toBe(1)
  })

  it('stamps every forwarded executor event with the loop that produced it', async () => {
    const runtime = pool.getRuntime('reflector')!
    await runtime.dispatch(chatDispatch('e1'))

    expect(events.length).toBeGreaterThan(0)
    // Without the stamp the renderer keys every loop's stream into main's tab.
    expect(events.every(e => e.loop === 'reflector')).toBe(true)
    expect(events.some(e => e.type === 'turn_complete')).toBe(true)
  })

  it("writes its turn checkpoint under a per-loop key, never over main's", async () => {
    const runtime = pool.getRuntime('reflector')!
    await runtime.dispatch(chatDispatch('e1'))

    expect(ws.getMeta('adf_runtime_turn_checkpoint:reflector')).toBeTruthy()
    // Main's record is the one crash recovery actually reads; a side loop's
    // turn must not be what it finds there.
    expect(ws.getMeta('adf_runtime_turn_checkpoint')).toBeFalsy()
  })

  it("fires the executor's turn-settled hook once per settled turn, error path included", async () => {
    const runtime = pool.getRuntime('reflector')!
    const poolHook = runtime.executor.onTurnSettled
    let settled = 0
    runtime.executor.onTurnSettled = () => { settled++; poolHook?.() }

    await runtime.dispatch(chatDispatch('e1'))
    expect(settled).toBe(1)

    // The error path settles too. A turn that died without settling would
    // strand every queued wake behind it forever.
    respond = async () => { throw new Error('provider is down') }
    await runtime.dispatch(chatDispatch('e2')).catch(() => {})
    expect(settled).toBe(2)
  })
})
