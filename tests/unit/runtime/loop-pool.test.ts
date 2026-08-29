/**
 * LoopPool against a real .adf: create → derive → send → delete.
 *
 * The pool is where the loop contract stops being types and starts being rows,
 * so these tests drive it through an actual workspace rather than a mock —
 * every assertion here is about what ends up in (or leaves) the file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { LoopPool, withLoopEssentialDeclarations, stripLoopNameMarker } from '../../../src/main/runtime/loop-pool'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import type { AgentConfig, LoopConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfBatchDispatch, AdfEventDispatch } from '../../../src/shared/types/adf-event.types'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'

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
 * Most tests never run a turn — the executor only needs a shape. The ones that
 * DO (the delivery-duplication and turn-boundary tests, which are about what
 * the model actually ends up seeing) set `respond` first.
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

function buildPool(mutate?: (config: AgentConfig) => void): LoopPool {
  const config = ws.getAgentConfig()
  // fs_read: an ordinary enabled host tool a loop may ask for.
  const fsRead = config.tools.find(t => t.name === 'fs_read')
  if (fsRead) fsRead.enabled = true
  // db_execute stands in for a host tool the owner marked restricted.
  const dbExecute = config.tools.find(t => t.name === 'db_execute')
  if (dbExecute) { dbExecute.enabled = true; dbExecute.restricted = true }
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
  rootDir = mkdtempSync(join(tmpdir(), 'adf-loop-pool-'))
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
  try { ws.close() } catch { /* already closed by a test */ }
  clearAllUmbilicalBuses()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('LoopPool — roster', () => {
  it('always lists main first, as the host loop, with the agent instructions as its goal', () => {
    const loops = pool.listLoops()
    expect(loops).toHaveLength(1)
    expect(loops[0]).toMatchObject({ name: 'main', isMain: true, enabled: true, status: 'idle' })
    expect(pool.hasLoop('main')).toBe(true)
    // main is implicit: it has no LoopConfig to return.
    expect(pool.getLoop('main')).toBeUndefined()
  })
})

describe('LoopPool — createLoop', () => {
  it('persists the loop, spins up a runtime, and reports the EFFECTIVE tools', async () => {
    const result = await pool.createLoop(loop({ tools: ['fs_read'] }))

    // The effective set is what the executor actually got: the request,
    // intersected with the host, plus the hardwired essentials.
    expect(result.effectiveTools).toContain('fs_read')
    expect(result.effectiveTools).toContain('loop_send')
    expect(result.effectiveTools).toContain('loop_list')
    expect(result.effectiveTools).not.toContain('sys_update_config')

    // Config write landed in the file, not just in memory.
    expect(ws.getAgentConfig().loops?.map(l => l.name)).toEqual(['reflector'])
    // ...and the runtime followed it.
    const runtime = pool.getRuntime('reflector')
    expect(runtime).toBeDefined()
    expect(runtime!.workspace.getLoopName()).toBe('reflector')
    expect(runtime!.derived.metadata?.loop_name).toBe('reflector')
    expect(pool.listLoops().map(l => l.name)).toEqual(['main', 'reflector'])
  })

  it('rejects an unknown tool name instead of silently subtracting it', async () => {
    await expect(pool.createLoop(loop({ tools: ['fs_read', 'not_a_tool'] })))
      .rejects.toThrow(/not_a_tool/)
    // Nothing was written: a rejected create leaves no half-loop behind.
    expect(ws.getAgentConfig().loops ?? []).toHaveLength(0)
    expect(pool.getRuntime('reflector')).toBeUndefined()
  })

  it('rejects a restricted host tool — a loop has no channel to answer HIL', async () => {
    await expect(pool.createLoop(loop({ tools: ['db_execute'] })))
      .rejects.toThrow(/never grantable/)
  })

  it('rejects a duplicate itself, whatever the caller checked first', async () => {
    await pool.createLoop(loop())
    await expect(pool.createLoop(loop({ goal: 'different goal' })))
      .rejects.toThrow(/already exists/)
    expect(ws.getAgentConfig().loops).toHaveLength(1)
  })

  it('refuses to create "main"', async () => {
    await expect(pool.createLoop(loop({ name: 'main' }))).rejects.toThrow(/main/)
  })

  it('gives a disabled loop a config entry and no runtime', async () => {
    await pool.createLoop(loop({ enabled: false }))
    expect(pool.hasLoop('reflector')).toBe(true)
    expect(pool.listLoops().find(l => l.name === 'reflector')).toMatchObject({ enabled: false })
    expect(pool.getRuntime('reflector')).toBeUndefined()
  })
})

describe('LoopPool — sendToLoop (RT-F6 delivery)', () => {
  beforeEach(async () => {
    await pool.createLoop(loop({ tools: ['fs_read'] }))
  })

  it('appends a stamped row to the TARGET stream and leaves main untouched', async () => {
    const result = await pool.sendToLoop('main', 'reflector', 'look at the last hour', false)

    expect(result).toMatchObject({ delivered: true, woke: false })
    const target = ws.forLoop('reflector').getLoop()
    expect(target).toHaveLength(1)
    expect(target[0].role).toBe('user')
    expect(target[0].content_json[0].text).toBe('[from loop:main] look at the last hour')
    // The sender's own stream never sees the message.
    expect(ws.getLoop()).toHaveLength(0)
  })

  it('wakes with the appended row\'s seq and does NOT re-send the content as a new row', async () => {
    const runtime = pool.getRuntime('reflector')!
    // Intercept the turn: what matters here is the dispatch the executor is
    // handed, not what a model would do with it.
    const executeTurn = vi.spyOn(runtime.executor, 'executeTurn').mockResolvedValue(undefined)

    const result = await pool.sendToLoop('main', 'reflector', 'wake up', true)
    expect(result).toMatchObject({ delivered: true, woke: true })

    const rows = ws.forLoop('reflector').getLoop()
    // Exactly ONE row: appended at send time, never again at dispatch.
    expect(rows).toHaveLength(1)

    expect(executeTurn).toHaveBeenCalledTimes(1)
    const dispatch = executeTurn.mock.calls[0][0] as {
      loop?: string
      event: { type: string; data: { loop_seq?: number; skip_loop_append?: boolean } }
    }
    expect(dispatch.loop).toBe('reflector')
    expect(dispatch.event.type).toBe('chat')
    // The RT-F6 contract: skip the loop write, carry the row's seq so the
    // inlined session message keeps its [S<seq>] marker.
    expect(dispatch.event.data.skip_loop_append).toBe(true)
    expect(dispatch.event.data.loop_seq).toBe(rows[0].seq)
  })

  it('holds a pending wake while the target is mid-turn and fires it at the turn boundary', async () => {
    const runtime = pool.getRuntime('reflector')!
    let release: () => void = () => {}
    const firstTurn = new Promise<void>(resolve => { release = resolve })
    const executeTurn = vi.spyOn(runtime.executor, 'executeTurn')
      .mockImplementationOnce(() => firstTurn)
      .mockResolvedValue(undefined)

    // Occupy the loop.
    void runtime.dispatch({ event: { id: 'e', type: 'chat', source: 'test', time: '', data: {} as never }, scope: 'agent' })
    expect(runtime.isBusy()).toBe(true)

    const result = await pool.sendToLoop('main', 'reflector', 'while you are busy', true)
    // Delivered but not woken — and the reason is honest about what happens next.
    expect(result).toMatchObject({ delivered: true, woke: false })
    expect(result.reason).toMatch(/mid-turn/)
    // The row is already durable, which is what makes "it will read this" true.
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(1)
    expect(executeTurn).toHaveBeenCalledTimes(1)

    // The turn-boundary hook drains the pending wake. With executeTurn stubbed
    // the executor's own onTurnSettled never fires, so what runs here is the
    // runtime's dispatch-settled hook — the second of the two deliberately
    // redundant paths (see LoopRuntime.onTurnBoundary). Draining is idempotent,
    // so either one alone delivers exactly one wake.
    release()
    await firstTurn
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    expect(executeTurn).toHaveBeenCalledTimes(2)
    // Still one row: the pending wake replays the SAME row, it does not add one.
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(1)
  })

  it('does not wake a loop while the agent is suspended — suspend cascades', async () => {
    mainState = 'suspended'
    const runtime = pool.getRuntime('reflector')!
    const executeTurn = vi.spyOn(runtime.executor, 'executeTurn').mockResolvedValue(undefined)

    const result = await pool.sendToLoop('main', 'reflector', 'not now', true)

    expect(result).toMatchObject({ delivered: true, woke: false })
    expect(result.reason).toMatch(/suspended/)
    expect(executeTurn).not.toHaveBeenCalled()
    // The message still landed — a suspended agent loses no mail.
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(1)
  })

  it('appends for a disabled loop but never wakes it, and says which it was', async () => {
    await pool.updateLoop('reflector', { enabled: false })
    const result = await pool.sendToLoop('main', 'reflector', 'still listening?', true)
    expect(result).toEqual({ delivered: true, woke: false, reason: 'loop disabled' })
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(1)
  })

  it('reaches main as a peer: appends to main\'s stream and wakes it through the host', async () => {
    const result = await pool.sendToLoop('reflector', 'main', 'you missed something', true)

    expect(result).toMatchObject({ delivered: true, woke: true })
    const mainStream = ws.getLoop()
    expect(mainStream).toHaveLength(1)
    expect(mainStream[0].content_json[0].text).toBe('[from loop:reflector] you missed something')
    expect(mainDispatches).toHaveLength(1)
    const dispatch = mainDispatches[0] as AdfEventDispatch & {
      event: { data: { loop_seq?: number; skip_loop_append?: boolean } }
    }
    expect(dispatch.loop).toBe('main')
    expect(dispatch.event.data.skip_loop_append).toBe(true)
    expect(dispatch.event.data.loop_seq).toBe(mainStream[0].seq)
  })

  it('injects into a busy main instead of queueing behind its turn', async () => {
    mainSession.addMessage({ role: 'user', content: [{ type: 'text', text: 'earlier' }] })
    mainBusy = true

    const result = await pool.sendToLoop('reflector', 'main', 'while you work', true)

    expect(result).toMatchObject({ delivered: true, woke: false })
    expect(mainDispatches).toHaveLength(0)
    // Delivered into the live session, to be drained at the next model
    // boundary — and NOT as a second row.
    expect(mainSession.hasPendingContextInjections()).toBe(true)
    expect(ws.getLoop().filter(e => e.content_json[0].text?.startsWith('[from loop:'))).toHaveLength(1)
  })

  it('validates fromLoop rather than trusting it — the stamp is not free text', async () => {
    await expect(pool.sendToLoop('ghost', 'reflector', 'hi', false)).rejects.toThrow(/ghost/)
    await expect(pool.sendToLoop('main', 'ghost', 'hi', false)).rejects.toThrow(/ghost/)
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(0)
  })
})

describe('LoopPool — updateLoop', () => {
  beforeEach(async () => {
    await pool.createLoop(loop({ tools: [] }))
  })

  it('re-derives in place: the executor gets the DERIVED config, never the host config', async () => {
    await pool.updateLoop('reflector', { goal: 'a new charter', tools: ['fs_read'] })

    const runtime = pool.getRuntime('reflector')!
    // Instructions = the standing loop preamble + the new goal (derive-loop-config).
    expect(runtime.derived.instructions).toContain('a new charter')
    expect(runtime.derived.instructions).toContain('You are the "reflector" loop')
    expect(runtime.executor.getConfig().instructions).toBe(runtime.derived.instructions)
    expect(runtime.executor.getConfig().metadata?.loop_name).toBe('reflector')
    // Attenuation survives the update.
    expect(runtime.executor.getConfig().loops).toEqual([])
    const enabled = runtime.derived.tools.filter(t => t.enabled).map(t => t.name)
    expect(enabled).toContain('fs_read')
    expect(enabled).not.toContain('sys_update_config')
    expect(ws.getAgentConfig().loops?.[0].goal).toBe('a new charter')
  })

  it('rejects an ungrantable tool without touching the stored loop', async () => {
    await expect(pool.updateLoop('reflector', { tools: ['db_execute'] })).rejects.toThrow(/never grantable/)
    expect(ws.getAgentConfig().loops?.[0].tools).toEqual([])
  })
})

describe('LoopPool — deleteLoop', () => {
  beforeEach(async () => {
    await pool.createLoop(loop())
  })

  it('refuses while the loop is running, and the stream survives the refusal', async () => {
    const runtime = pool.getRuntime('reflector')!
    ws.forLoop('reflector').appendToLoop('user', [{ type: 'text', text: 'mid-turn work' }])
    let release: () => void = () => {}
    const turn = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => turn)
    void runtime.dispatch({ event: { id: 'e', type: 'chat', source: 'test', time: '', data: {} as never }, scope: 'agent' })

    await expect(pool.deleteLoop('reflector')).rejects.toThrow(/running a turn/)
    expect(ws.getAgentConfig().loops).toHaveLength(1)
    expect(ws.forLoop('reflector').getLoop()).toHaveLength(1)

    release()
    await turn
  })

  it('archives the stream to adf_audit under loop:<name>, then clears it', async () => {
    const view = ws.forLoop('reflector')
    view.appendToLoop('user', [{ type: 'text', text: 'first thought' }])
    view.appendToLoop('assistant', [{ type: 'text', text: 'second thought' }])

    const result = await pool.deleteLoop('reflector')

    expect(result.archivedEntries).toBe(2)
    // Archived even though loop auditing is OFF by default: deletion is
    // unrecoverable, so the archive is not optional.
    const audits = ws.listAudits().filter(a => a.source === 'loop:reflector')
    expect(audits).toHaveLength(1)
    expect(audits[0].entry_count).toBe(2)
    // Stream gone, config entry gone, runtime gone.
    expect(view.getLoop()).toHaveLength(0)
    expect(ws.getAgentConfig().loops ?? []).toHaveLength(0)
    expect(pool.getRuntime('reflector')).toBeUndefined()
    expect(pool.hasLoop('reflector')).toBe(false)
  })

  it('drops the deleted loop\'s timers and leaves main\'s alone', async () => {
    const mainTimer = ws.addTimer({ mode: 'interval', every_ms: 60_000 }, Date.now() + 60_000, undefined, ['agent'])
    const loopTimer = ws.forLoop('reflector').addTimer(
      { mode: 'interval', every_ms: 60_000 }, Date.now() + 60_000, undefined, ['agent']
    )

    await pool.deleteLoop('reflector')

    const remaining = ws.getTimers().map(t => t.id)
    expect(remaining).toContain(mainTimer)
    // Never re-pointed at main — an orphan running with main's authority is
    // exactly the escalation the drop exists to prevent.
    expect(remaining).not.toContain(loopTimer)
  })

  it('refuses to delete main', async () => {
    await expect(pool.deleteLoop('main')).rejects.toThrow(/cannot be deleted/)
  })

  it('reports an unknown loop as unknown, not as an internal failure', async () => {
    await expect(pool.deleteLoop('ghost')).rejects.toThrow(/No side loop named "ghost"/)
  })
})

describe('main-side wiring helpers', () => {
  it('injects the essential declarations only once the agent has a loop', () => {
    const config = ws.getAgentConfig()
    // No loops: main's tool schema is exactly what it was before loops existed
    // — not "a copy that happens to match", the same declarations, none added.
    const untouched = withLoopEssentialDeclarations(config)
    expect(untouched.tools.some(t => t.name === 'loop_send')).toBe(false)
    expect(untouched.tools.some(t => t.name === 'loop_list')).toBe(false)
    expect(untouched.tools.map(t => t.name)).toEqual(config.tools.map(t => t.name))

    const withLoop: AgentConfig = { ...config, loops: [loop()] }
    const augmented = withLoopEssentialDeclarations(withLoop)
    expect(augmented.tools.some(t => t.name === 'loop_send' && t.enabled)).toBe(true)
    expect(augmented.tools.some(t => t.name === 'loop_list' && t.enabled)).toBe(true)
    // The stored config is untouched — the declarations are runtime-only.
    expect(withLoop.tools.some(t => t.name === 'loop_send')).toBe(false)
  })

  it('strips a hand-edited metadata.loop_name so it can never bind main to a side stream', () => {
    const config = ws.getAgentConfig()
    config.metadata = { ...config.metadata, loop_name: 'reflector' }
    stripLoopNameMarker(config)
    expect(config.metadata?.loop_name).toBeUndefined()
  })
})
