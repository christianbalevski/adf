/**
 * Studio's turn controls: the composer's Stop (and Esc) ends the running
 * turn through the runtime interrupt; the title bar's Off unloads the agent.
 * Esc gating is tested on plain objects; the controls are static checks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { escStopsTurn } from '../../../src/renderer/utils/keyboard'
import { BUILTIN_COMMANDS } from '../../../src/renderer/utils/slash-commands'
import { SHORTCUT_SECTIONS } from '../../../src/shared/constants/keyboard-shortcuts'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { parseLoopToDisplay, parseLoopWithToolPairs } from '../../../src/shared/utils/loop-parser'
import { interruptedBlockIndexes } from '../../../src/renderer/hooks/live-seq'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const src = (rel: string) => readFileSync(join(__dirname, '../../../src', rel), 'utf-8')

/** An element-shaped object: its tag, and the selectors its ancestors match. */
function el(tagName: string, opts: { matches?: string[]; inside?: boolean } = {}) {
  return {
    tagName,
    isContentEditable: false,
    inside: opts.inside ?? true,
    closest: (selector: string) => (opts.matches ?? []).some((m) => selector.includes(m)) ? {} : null,
  }
}
const root = { contains: (node: unknown) => !!(node as { inside?: boolean })?.inside }
// The composer is a textarea with role="combobox".
const composer = el('TEXTAREA', { matches: ['[role="combobox"]'] })
const base = { turnRunning: true, composer, composerEmpty: true, paletteOpen: false, root }

describe('Esc stops the turn', () => {
  it('from the empty composer', () => {
    expect(escStopsTurn({ ...base, target: composer })).toBe(true)
  })

  it('never from a composer holding a draft or an open palette', () => {
    expect(escStopsTurn({ ...base, target: composer, composerEmpty: false })).toBe(false)
    expect(escStopsTurn({ ...base, target: composer, paletteOpen: true })).toBe(false)
  })

  it('from the loop view itself (the stream, a row button)', () => {
    expect(escStopsTurn({ ...base, target: el('DIV') })).toBe(true)
    expect(escStopsTurn({ ...base, target: el('BUTTON') })).toBe(true)
  })

  it('never from another field, a dialog or a menu, or outside the loop view', () => {
    expect(escStopsTurn({ ...base, target: el('INPUT') })).toBe(false)
    expect(escStopsTurn({ ...base, target: el('TEXTAREA') })).toBe(false)
    expect(escStopsTurn({ ...base, target: el('BUTTON', { matches: ['[role="dialog"]'] }) })).toBe(false)
    expect(escStopsTurn({ ...base, target: el('BUTTON', { matches: ['[role="menu"]'] }) })).toBe(false)
    expect(escStopsTurn({ ...base, target: el('DIV', { inside: false }) })).toBe(false)
    expect(escStopsTurn({ ...base, target: null })).toBe(false)
  })

  it('never while no turn runs', () => {
    expect(escStopsTurn({ ...base, turnRunning: false, target: composer })).toBe(false)
    expect(escStopsTurn({ ...base, turnRunning: false, target: el('DIV') })).toBe(false)
  })

  it('is listed with the chat shortcuts', () => {
    const chat = SHORTCUT_SECTIONS.find((s) => s.title === 'Chat')!
    expect(chat.rows.some((r) => r.keys.includes('Esc'))).toBe(true)
  })
})

describe('the composer\'s Stop', () => {
  const loop = src('renderer/components/agent/AgentLoop.tsx')

  it('is a one-word control with a tooltip, shown while the loop works or waits, beside Queue message', () => {
    expect(loop).toContain("const turnRunning = state === 'active' || state === 'suspended'")
    expect(loop).toMatch(/\{turnRunning && \(\s*<Tooltip tip="Stop" shortcut="Esc"/)
    expect(loop).toContain('aria-label="Stop"')
    // Queueing stays possible: the send button is still there in the same state.
    expect(loop).toContain("state === 'active' ? 'Queue message'")
  })

  it('is one click that says a refusal', () => {
    expect(loop).toContain('error = await interruptOpenTurn(filePath, loop)')
    expect(loop).not.toMatch(/interruptOpenTurn[\s\S]{0,200}confirm\(/)
    expect(loop).toContain('Turn not interrupted: ')
  })

  it('reaches main through preload and IPC in both backends', () => {
    expect(IPC.AGENT_INTERRUPT).toBe('adf:agent:interrupt')
    expect(src('preload/index.ts')).toContain('interruptTurn: (filePath?: string, loop?: string) => ipcRenderer.invoke(IPC.AGENT_INTERRUPT, { filePath, loop })')
    expect(src('main/ipc/index.ts')).toContain('ipcMain.handle(IPC.AGENT_INTERRUPT')
    expect(src('main/ipc/index.ts')).toContain('interruptLoopTurn(assembled.executor, assembled.loopPool, args?.loop)')
    expect(src('main/backend/daemon-mode/documents/agent-handlers.ts')).toContain('[IPC.AGENT_INTERRUPT]')
  })

  it('/stop is the same interrupt; /off is the title bar\'s Off', () => {
    const stop = BUILTIN_COMMANDS.find((c) => c.key === 'stop')!
    const off = BUILTIN_COMMANDS.find((c) => c.key === 'off')!
    expect(stop.description).toContain('The agent stays on')
    expect(off.description).toContain('Off in the title bar')
    expect(loop).toMatch(/case 'stop': \{\s*\/\/[^\n]*\n\s*await handleInterrupt\(\)/)
  })
})

describe('interruptOpenTurn', () => {
  const g = globalThis as { window?: unknown }
  let before: unknown
  beforeEach(() => { before = g.window; vi.resetModules() })
  afterEach(() => { g.window = before })

  /** A window whose This computer surface and each bound surface record their interrupts. */
  function stubWindow(answers: Record<string, unknown>) {
    const calls: Array<{ runtime: string; filePath: string; loop: string }> = []
    const surface = (runtime: string) => ({
      runtimeId: runtime === 'local' ? undefined : runtime,
      interruptTurn: async (filePath: string, loop: string) => {
        calls.push({ runtime, filePath, loop })
        const answer = answers[runtime]
        if (answer instanceof Error) throw answer
        return answer
      },
    })
    g.window = { location: { search: '' }, adfApi: { ...surface('local'), runtime: (id: string) => surface(id) } }
    return calls
  }

  async function load(runtimeId: string) {
    const { interruptOpenTurn } = await import('../../../src/renderer/utils/turn-interrupt')
    const { useDocumentStore } = await import('../../../src/renderer/stores/document.store')
    useDocumentStore.setState({ runtimeId })
    return interruptOpenTurn
  }

  it('interrupts the loop of the open agent on This computer', async () => {
    const calls = stubWindow({ local: { success: true } })
    expect(await (await load('local'))('/agents/agent-1.adf', 'main')).toBeNull()
    expect(calls).toEqual([{ runtime: 'local', filePath: '/agents/agent-1.adf', loop: 'main' }])
  })

  it('interrupts on the open agent\'s runtime when it is another computer', async () => {
    const calls = stubWindow({ 'remote:host-1': { success: true } })
    expect(await (await load('remote:host-1'))('/srv/agents/agent-1.adf', 'worker')).toBeNull()
    expect(calls).toEqual([{ runtime: 'remote:host-1', filePath: '/srv/agents/agent-1.adf', loop: 'worker' }])
  })

  it('answers the refusal, a thrown error, or no runtime', async () => {
    stubWindow({ local: { success: false, error: 'no turn is running' } })
    expect(await (await load('local'))('/agents/agent-1.adf', 'main')).toBe('no turn is running')
    vi.resetModules()
    stubWindow({ local: new Error('Cannot reach daemon') })
    expect(await (await load('local'))('/agents/agent-1.adf', 'main')).toBe('Cannot reach daemon')
    vi.resetModules()
    stubWindow({ local: undefined })
    expect(await (await load('local'))('/agents/agent-1.adf', 'main')).toBe('no agent runtime')
  })
})

describe('the title bar\'s Off', () => {
  const titleBar = src('renderer/components/layout/TitleBar.tsx')

  it('is one word with the shared tooltip, and is no longer called Stop', () => {
    expect(titleBar).toMatch(/<Tooltip tip="Turn the agent off"[^>]*>\s*<Button\s+onClick=\{handleOff\}/)
    expect(titleBar).toMatch(/\n\s*Off\r?\n\s*<\/Button>/)
    expect(titleBar).not.toMatch(/\n\s*Stop\r?\n\s*<\/Button>/)
  })

  it('unloads at once: no grace in which the turn could start a tool', () => {
    expect(src('main/ipc/index.ts')).toContain("assembled.disposeAsync({ mode: 'immediate' })")
    expect(src('main/runtime/runtime-service.ts')).toContain("await this.unloadAgent(agentId, { mode: 'immediate' })")
  })
})

describe('interrupted output', () => {
  const agentLoop = src('renderer/components/agent/AgentLoop.tsx')

  it('a reload shows the partial text with the one-word label', () => {
    const rows = [
      { seq: 1, role: 'user' as const, content_json: [{ type: 'text' as const, text: 'Write an essay.' }], created_at: 1 },
      { seq: 2, role: 'assistant' as const, content_json: [{ type: 'text' as const, text: 'The essay begins', interrupted: true }], created_at: 2 },
      { seq: 3, role: 'user' as const, content_json: [{ type: 'text' as const, text: '[System] Turn interrupted by user.' }], created_at: 3 },
    ]
    const shown = parseLoopToDisplay(rows as never)
    expect(shown.find((d) => d.type === 'text')?.metadata).toMatchObject({ seq: 2, interrupted: true })
    expect(parseLoopWithToolPairs(rows as never).find((d) => d.type === 'text')?.metadata?.interrupted).toBe(true)
    expect(agentLoop).toContain("const interrupted = entry.metadata?.interrupted === true")
    expect(agentLoop).toMatch(/<Tooltip tip="Cut off when the turn was stopped"[^>]*>\s*<span[^>]*>Interrupted<\/span>/)
  })

  it('live: the streamed text before the interrupt notice gets the row\'s seq and the label, and no quiet marker', () => {
    const g = globalThis as { window?: unknown }
    const before = g.window
    g.window = { adfApi: new Proxy({}, { get: () => async () => ({}) }) }
    try {
      useAgentStore.getState().reset()
      const store = useAgentStore.getState()
      store.addLogEntry({ id: 'u', type: 'user', content: 'Write an essay.', timestamp: 1, metadata: { seq: 1 } })
      store.addLogEntry({ id: 't', type: 'text', content: 'The essay begins', timestamp: 2 })
      store.addLogEntry({ id: 'n', type: 'context', content: '[System] Turn interrupted by user.', timestamp: 3, metadata: { seq: 3, category: 'System' } })
      createAgentEventHandler()({ type: 'turn_complete', payload: { content: [], interrupted: true, partial: true, seq: 2 }, timestamp: 4 } as AgentExecutionEvent)
      const log = useAgentStore.getState().log
      expect(log.find((e) => e.id === 't')?.metadata).toMatchObject({ seq: 2, interrupted: true })
      expect(log.some((e) => e.metadata?.quietTurn)).toBe(false)
      expect(interruptedBlockIndexes(log)).toEqual([])
    } finally {
      g.window = before
    }
  })
})
