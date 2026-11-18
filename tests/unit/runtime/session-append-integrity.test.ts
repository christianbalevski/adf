/**
 * Session integrity for rows appended to a loop's stream from outside the
 * running turn (a timer fired at the tick, loop_send, an owner append).
 *
 * H1: such a row can land between an assistant tool_use and its tool_result.
 *     A restore must move it to just after the tool_result, or the provider
 *     sees tool-call, user, tool and rejects the request.
 * H2: a restore while that row's injection is still pending must not deliver
 *     it twice (once restored from the stream, once drained).
 * H3: compaction must not delete an appended row whose injection has not been
 *     drained yet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { LoopPool } from '../../../src/main/runtime/loop-pool'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { LLMMessage, LLMResponse } from '../../../src/shared/types/provider.types'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'

const text = (t: string) => [{ type: 'text' as const, text: t }]
const shape = (s: AgentSession) => s.getMessages().map(m => [m.role, (m.content as { type: string; text?: string }[]).map(b => b.type === 'text' ? b.text : b.type).join(',')])
const copies = (s: AgentSession, needle: string) => s.getMessages().filter(m => JSON.stringify(m.content).includes(needle)).length

describe('H1: a row appended inside an open tool pair', () => {
  it('is moved to just after the tool_result on restore', () => {
    const s = new AgentSession({ appendToLoop: () => 1 } as never)
    s.restoreMessages([
      { role: 'user', content: text('go'), seq: 1 },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'sys_code', input: {} }], seq: 2 },
      { role: 'user', content: text('[Timer] remind me'), seq: 3 },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], seq: 4 },
    ] as LLMMessage[])
    expect(shape(s)).toEqual([
      ['user', 'go'],
      ['assistant', 'tool_use'],
      ['user', 'tool_result'],
      ['user', '[Timer] remind me'],
    ])
  })

  it('keeps the tool pair and the row when the results arrive in two messages', () => {
    const s = new AgentSession({ appendToLoop: () => 1 } as never)
    s.restoreMessages([
      { role: 'user', content: text('go') },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'tool_use', id: 'b', name: 'y', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      { role: 'user', content: text('ROW') },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] },
      { role: 'assistant', content: text('done') },
    ] as LLMMessage[])
    expect(shape(s)).toEqual([
      ['user', 'go'],
      ['assistant', 'tool_use,tool_use'],
      ['user', 'tool_result'],
      ['user', 'tool_result'],
      ['user', 'ROW'],
      ['assistant', 'done'],
    ])
  })
})

describe('H2: a restore while the row\'s injection is pending', () => {
  it('delivers the row once', () => {
    const s = new AgentSession({ appendToLoop: () => 99 } as never)
    s.restoreMessages([{ role: 'user', content: text('go'), seq: 1 }] as LLMMessage[])
    s.queueContextInjection({ role: 'user', text: '[Timer] remind', category: 'loop', origin: 'timer:1', seq: 5, wake: true })
    s.restoreMessages([
      { role: 'user', content: text('go'), seq: 1 },
      { role: 'user', content: text('[Timer] remind'), seq: 5 },
    ] as LLMMessage[])
    s.drainContextInjections()
    expect(copies(s, '[Timer] remind')).toBe(1)
    expect(s.hasPendingContextInjections()).toBe(false)
  })

  it('keeps an injection whose row is not among the restored messages', () => {
    const s = new AgentSession({ appendToLoop: () => 99 } as never)
    s.queueContextInjection({ role: 'user', text: 'LATER', category: 'loop', origin: 'loop:x', seq: 7 })
    s.restoreMessages([{ role: 'user', content: text('go'), seq: 1 }] as LLMMessage[])
    expect(s.peekPendingContextInjections().map(i => i.seq)).toEqual([7])
  })
})

describe('H3: compaction while an appended row is undrained', () => {
  let rootDir: string
  let ws: AdfWorkspace
  let pool: LoopPool
  let respond: (() => Promise<LLMResponse>) | null = null
  const provider = {
    name: 'stub', providerId: 'stub', modelId: 'stub-model',
    createMessage: async () => { if (!respond) throw new Error('no turns'); return respond() },
    validateConfig: async () => ({ valid: true }),
  } as unknown as LLMProvider

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'adf-h3-'))
    ws = AdfWorkspace.create(join(rootDir, 'agent.adf'), { name: 'h3' })
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)
    let live = ws.getAgentConfig()
    pool = new LoopPool({
      workspace: ws, registry, getProvider: () => provider, basePrompt: '', toolPrompts: {},
      adfCallHandler: null, codeSandboxService: null, mcpManager: null,
      getHostConfig: () => live,
      saveConfig: (next) => { ws.setAgentConfig(next); live = next; pool.reconcile(next) },
      onLoopEvent: () => {},
      main: { session: new AgentSession(ws), isBusy: () => false, dispatch: async () => {}, getState: () => 'idle', modelSeenSeq: () => 0 },
    } as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try { pool.dispose() } catch { /* disposed */ }
    try { ws.close() } catch { /* closed */ }
    clearAllUmbilicalBuses()
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('keeps a row appended while compactLoop is awaiting its I/O (round 6 F1)', async () => {
    await pool.createLoop({ name: 'reflector', goal: 'g', enabled: true, tools: [] } as never)
    const runtime = pool.getRuntime('reflector')!
    for (const t of ['first thought', 'second thought']) runtime.session.addMessage({ role: 'user', content: text(t) })
    let release: () => void = () => {}
    const firstTurn = new Promise<void>(r => { release = r })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => firstTurn)
    void runtime.dispatch({ event: { id: 'e', type: 'chat', source: 'test', time: '', data: {} as never }, scope: 'agent' })

    // The preserved set is fixed before compactLoop's awaits (backup, brotli);
    // a timer or loop_send row appended in that window must survive.
    const view = runtime.session.getWorkspace()
    const original = view.compactLoop.bind(view)
    view.compactLoop = (async (...args: Parameters<typeof original>) => {
      await new Promise(r => setTimeout(r, 0))
      await pool.sendToLoop('main', 'reflector', 'DURING-COMPACT', true)
      return original(...args)
    }) as typeof original
    respond = async () => ({ id: 'r', content: text('summary'), stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    await (runtime.executor as unknown as { forceCompact: (r: string) => Promise<number> }).forceCompact('test')

    const rows = ws.forLoop('reflector').getLoop()
    expect(rows.filter(r => JSON.stringify(r.content_json).includes('DURING-COMPACT'))).toHaveLength(1)
    // the summary still sorts before the kept row
    const summaryAt = rows.findIndex(r => JSON.stringify(r.content_json).includes('Loop Compacted'))
    const keptAt = rows.findIndex(r => JSON.stringify(r.content_json).includes('DURING-COMPACT'))
    expect(summaryAt).toBeGreaterThanOrEqual(0)
    expect(summaryAt).toBeLessThan(keptAt)
    runtime.session.drainContextInjections()
    expect(copies(runtime.session, 'DURING-COMPACT')).toBe(1)
    release()
    await firstTurn
  })

  it('keeps an undrained row older than the summarized range: the turn wrote more rows after it (round 6)', async () => {
    await pool.createLoop({ name: 'reflector', goal: 'g', enabled: true, tools: [] } as never)
    const runtime = pool.getRuntime('reflector')!
    for (const t of ['first thought', 'second thought']) runtime.session.addMessage({ role: 'user', content: text(t) })
    let release: () => void = () => {}
    const firstTurn = new Promise<void>(r => { release = r })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => firstTurn)
    void runtime.dispatch({ event: { id: 'e', type: 'chat', source: 'test', time: '', data: {} as never }, scope: 'agent' })

    // Appended mid-call and queued for the next boundary...
    await pool.sendToLoop('main', 'reflector', 'OLDER-PENDING', true)
    // ...then the turn writes its reply, so the summary's range ends after the row.
    runtime.session.addMessage({ role: 'assistant', content: text('reply after the row') })
    respond = async () => ({ id: 'r', content: text('summary'), stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    await (runtime.executor as unknown as { forceCompact: (r: string) => Promise<number> }).forceCompact('test')

    expect(ws.forLoop('reflector').getLoop().filter(r => JSON.stringify(r.content_json).includes('OLDER-PENDING'))).toHaveLength(1)
    runtime.session.drainContextInjections()
    expect(copies(runtime.session, 'OLDER-PENDING')).toBe(1)
    release()
    await firstTurn
  })

  it('a source message whose write was buffered is archived with its summary, not kept after it (round 7 F2)', async () => {
    await pool.createLoop({ name: 'reflector', goal: 'g', enabled: true, tools: [] } as never)
    const runtime = pool.getRuntime('reflector')!
    runtime.session.addMessage({ role: 'user', content: text('first thought') })
    // The next write fails once (DB busy) and falls back to the retry buffer.
    const view = runtime.session.getWorkspace()
    const append = view.appendToLoop.bind(view)
    let failOnce = true
    view.appendToLoop = ((...args: Parameters<typeof append>) => {
      if (failOnce) { failOnce = false; throw new Error('SQLITE_BUSY') }
      return append(...args)
    }) as typeof append
    runtime.session.addMessage({ role: 'user', content: text('BUFFERED-SOURCE') })
    expect(runtime.session.hasPendingWrites()).toBe(true)
    runtime.session.addMessage({ role: 'assistant', content: text('reply') })
    respond = async () => ({ id: 'r', content: text('summary'), stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    await (runtime.executor as unknown as { forceCompact: (r: string) => Promise<number> }).forceCompact('test')
    const rows = ws.forLoop('reflector').getLoop()
    expect(rows.filter(r => JSON.stringify(r.content_json).includes('BUFFERED-SOURCE'))).toHaveLength(0)
  })

  it('keeps the row in the stream and puts it in the session once', async () => {
    await pool.createLoop({ name: 'reflector', goal: 'g', enabled: true, tools: [] } as never)
    const runtime = pool.getRuntime('reflector')!
    for (const t of ['first thought', 'second thought']) runtime.session.addMessage({ role: 'user', content: text(t) })
    let release: () => void = () => {}
    const firstTurn = new Promise<void>(r => { release = r })
    vi.spyOn(runtime.executor, 'executeTurn').mockImplementationOnce(() => firstTurn)
    void runtime.dispatch({ event: { id: 'e', type: 'chat', source: 'test', time: '', data: {} as never }, scope: 'agent' })

    await pool.sendToLoop('main', 'reflector', 'KEEP-ME', true)
    respond = async () => ({ id: 'r', content: text('summary'), stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    await (runtime.executor as unknown as { forceCompact: (r: string) => Promise<number> }).forceCompact('test')

    const rows = ws.forLoop('reflector').getLoop().filter(r => JSON.stringify(r.content_json).includes('KEEP-ME'))
    expect(rows).toHaveLength(1)
    runtime.session.drainContextInjections()
    expect(copies(runtime.session, 'KEEP-ME')).toBe(1)
    release()
    await firstTurn
  })
})
