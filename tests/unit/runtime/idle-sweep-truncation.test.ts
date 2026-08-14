/**
 * Regression tests for the idle-sweep context-truncation incident (2026-08-14):
 * sweepIdleAgents() reset an in-memory session while an LLM turn was in flight.
 * The response landed in the emptied session, so every later request silently
 * ran on a truncated context while the loop table kept the full history.
 *
 * Two invariants:
 * 1. The sweep only releases sessions whose EXECUTOR is between turns — the
 *    old guard compared managed.state (display states, where thinking/tool_use
 *    map to 'active') against executor-internal names and never fired.
 * 2. dispatch() rehydrates an empty session from the loop AFTER host hooks and
 *    before the turn, so a released session never produces a truncated LLM
 *    request — regardless of which host attachment dispatched the turn.
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

// Typed against the real managed-entry shape so field renames or new sweep
// reads break at compile time instead of silently diverging in the stubs.
type SweepEntry = Pick<BackgroundManagedAgent, 'state' | 'executor' | 'session' | 'workspace' | 'assembledAgent'>

/** A fake managed-agent entry the sweep can iterate without a real runtime. */
function fakeManaged(executorState: string, messageCount: number, opts?: { inFlight?: boolean }) {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `m${i}` }],
  }))
  const flushToLoop = vi.fn()
  const reset = vi.fn(() => { messages.length = 0 })
  const insertLog = vi.fn()
  const entry: SweepEntry = {
    state: 'active', // display state during a live turn — must NOT gate the sweep
    executor: { getState: () => executorState } as unknown as SweepEntry['executor'],
    session: { getMessages: () => messages, flushToLoop, reset } as unknown as SweepEntry['session'],
    workspace: { insertLog } as unknown as SweepEntry['workspace'],
    assembledAgent: { hasInFlightDispatch: () => opts?.inFlight ?? false } as unknown as SweepEntry['assembledAgent'],
  }
  return { entry, messages, flushToLoop, reset, insertLog }
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
    // Between-turns states are releasable; 51/50 pins the >50 threshold.
    const idleLarge = fakeManaged('idle', 51)
    const idleSmall = fakeManaged('idle', 50)
    const stopped = fakeManaged('stopped', 60)
    const errored = fakeManaged('error', 60)
    const all = { midTurn, toolUse, awaitingApproval, awaitingAsk, suspended, idleInFlight, idleLarge, idleSmall, stopped, errored }
    for (const [name, fake] of Object.entries(all)) {
      agentsMap.set(`C:\\fake\\${name}.adf`, fake.entry)
    }

    // No lastActivityTime entries → every agent reads as long-idle (the stale
    // clock that let the incident happen). The executor gate must still hold.
    ;(manager as unknown as { sweepIdleAgents(): void }).sweepIdleAgents()

    for (const fake of [midTurn, toolUse, awaitingApproval, awaitingAsk, suspended, idleInFlight, idleSmall]) {
      expect(fake.reset).not.toHaveBeenCalled()
      expect(fake.flushToLoop).not.toHaveBeenCalled()
      expect(fake.insertLog).not.toHaveBeenCalled()
    }
    expect(midTurn.messages).toHaveLength(60)
    expect(idleSmall.messages).toHaveLength(50)

    for (const fake of [idleLarge, stopped, errored]) {
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
