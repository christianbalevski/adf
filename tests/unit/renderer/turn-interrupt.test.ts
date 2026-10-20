/**
 * Studio's turn controls: the composer's Stop (and Esc) ends the running
 * turn through the runtime interrupt; the title bar's Off unloads the agent.
 * Esc gating is tested on plain objects; the controls are static checks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { escStopsTurn } from '../../../src/renderer/utils/keyboard'
import { BUILTIN_COMMANDS } from '../../../src/renderer/utils/slash-commands'
import { SHORTCUT_SECTIONS } from '../../../src/shared/constants/keyboard-shortcuts'
import { IPC } from '../../../src/shared/constants/ipc-channels'

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

  it('calls the runtime interrupt for this file and loop, one click, and says a refusal', () => {
    expect(loop).toContain('window.adfApi?.interruptTurn(filePath, loop)')
    expect(loop).not.toMatch(/interruptTurn[\s\S]{0,200}confirm\(/)
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
