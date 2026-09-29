import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { VIEWS } from '../../src/main/tui/views/registry'
import { collectCommands } from '../../src/main/tui/commands/registry'
import { BUILTIN_COMMANDS, createQuitGuard, normalizeDaemonUrl } from '../../src/main/tui/commands/builtin/index'
import { buildEntries, fuzzyScore, helpLines, needsArgs, rankEntries, recordRecentFile, scoreEntry } from '../../src/main/tui/app/palette'
import { filterHelpLines } from '../../src/main/tui/app/palette/help'
import { rememberRun, resetPaletteMemory } from '../../src/main/tui/app/palette/entries'
import { lineText } from '../../src/main/tui/views/inspect/format'
import { AGENT_1_ID, AGENT_2_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createInspectFixture } from './fixtures/inspect-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', ctrlK: '\u000b', down: '\u001b[B', pgdn: '\u001b[6~' }
const registry = collectCommands(VIEWS, [BUILTIN_COMMANDS])
const noop = () => {}

describe('palette search', () => {
  it('scores contiguous and word-start matches above scattered ones', () => {
    expect(fuzzyScore('', 'anything')).toBe(1)
    expect(fuzzyScore('xyz', 'agent-1')).toBe(0)
    expect(fuzzyScore('cons', 'agent-1 @ consolidator')).toBeGreaterThan(fuzzyScore('cns', 'agent-1 @ consolidator'))
    expect(fuzzyScore('con', 'agent-1 @ consolidator')).toBeGreaterThan(fuzzyScore('con', 'reconnect'))
    expect(scoreEntry('agent-1 cons', 'agent-1 @ consolidator', '')).toBeGreaterThan(0)
    expect(scoreEntry('agent-1 zzz', 'agent-1 @ consolidator', '')).toBe(0)
  })

  it('treats <x> as a required argument and [x] as optional', () => {
    expect(needsArgs({ name: 'view', args: '<fleet|chat>', description: '', run: noop })).toBe(true)
    expect(needsArgs({ name: 'theme', args: '[name]', description: '', run: noop })).toBe(false)
    expect(needsArgs({ name: 'help', description: '', run: noop })).toBe(false)
  })

  it('arms Ctrl+C once, then quits on the second press inside the window', () => {
    let t = 0
    const press = createQuitGuard(1500, () => t)
    const notes: string[] = []
    let exited = 0
    expect(press(() => exited++, n => notes.push(n))).toBe(false)
    expect(notes[0]).toContain('Ctrl+C again')
    t = 1000
    expect(press(() => exited++, n => notes.push(n))).toBe(true)
    expect(exited).toBe(1)
    t = 5000
    expect(press(() => exited++, n => notes.push(n))).toBe(false)
  })

  it('normalizes daemon URLs for /url', () => {
    expect(normalizeDaemonUrl('127.0.0.1:7385')).toBe('http://127.0.0.1:7385')
    expect(normalizeDaemonUrl('https://daemon.example.test/adf/')).toBe('https://daemon.example.test/adf')
    expect(normalizeDaemonUrl('ftp://x')).toBeNull()
    expect(normalizeDaemonUrl('')).toBeNull()
  })
})

describe('palette + help against the mock daemon', () => {
  let mock: MockDaemon
  let store: TuiStore
  let ui: RenderedTui | null = null

  beforeEach(async () => {
    resetPaletteMemory()
    mock = await startMockDaemon({ stepMs: 5 })
    const fixture = createInspectFixture(mock.url)
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: fixture.fetch }) })
  })

  afterEach(async () => {
    ui?.unmount()
    ui = null
    store.stop()
    await mock.close()
  })

  async function mount() {
    ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 34 })
    await store.start()
    await ui.waitFor('consolidator')
    return ui
  }

  async function palette(tui: RenderedTui, query: string) {
    await tui.press(KEY.ctrlK)
    await tui.waitFor('Command palette')
    await tui.type(query)
    await tui.waitFor(f => f.includes(`› ${query}`))
  }

  it('lists views, agents, every loop, all registered commands and actions, and recent files', async () => {
    await mount()
    store.actions.selectAgent(AGENT_1_ID)
    recordRecentFile(AGENT_1_ID, 'notes/api.md')
    const entries = buildEntries({ store, views: VIEWS, registry, exit: noop, loopGlyph: '@', files: [{ path: 'mind.md', size: 1, protection: 'none', authorized: false, created_at: '', updated_at: '' } as never] })
    const titles = entries.map(e => e.title)
    for (const view of VIEWS) expect(titles).toContain(`Go to ${view.title}`)
    expect(titles).toContain('agent-2')
    expect(titles).toContain('agent-1 @ consolidator')
    expect(titles).toContain('agent-1 @ researcher')
    expect(titles).toContain('agent-2 @ main')
    expect(titles).toContain('Open notes/api.md')
    expect(titles).toContain('Open mind.md')
    const commandIds = new Set(entries.filter(e => e.group === 'Commands').map(e => e.id))
    for (const command of registry.commands) {
      if (command.available && !command.available({ ...store, actions: store.actions, client: store.client, state: store.getState, agentId: AGENT_1_ID, loop: 'main', print: noop, exit: noop } as never)) continue
      expect(commandIds.has(`cmd:${command.name}`)).toBe(true)
    }
    for (const action of registry.actions) {
      if (action.available) continue
      expect(entries.some(e => e.id === `action:${action.id}`)).toBe(true)
    }

    expect(rankEntries(entries, 'agent-2')[0]).toMatchObject({ title: 'agent-2', group: 'Agents' })
    expect(rankEntries(entries, 'switch to agent-2')[0]).toMatchObject({ title: 'agent-2', group: 'Agents' })
    expect(rankEntries(entries, 'researcher')[0].title).toBe('agent-1 @ researcher')
    rememberRun('view:loops')
    const ranked = rankEntries(entries, '')
    expect(ranked[0]).toMatchObject({ id: 'view:loops', group: 'Recent' })
  })

  it('switches agent and loop from the palette, and runs or prefills commands', async () => {
    const tui = await mount()
    await palette(tui, 'agent-2')
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().selectedAgentId === AGENT_2_ID)

    await palette(tui, 'agent-1 researcher')
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().selectedAgentId === AGENT_1_ID && store.getState().selectedLoop[AGENT_1_ID] === 'researcher')
    await tui.waitFor('agent-1 › ↻ researcher')

    // Daemon pages open their Runtime tab (a view, not a dialog).
    await palette(tui, '/status')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('Status') && f.includes('health'))
    expect(store.getState().activeView).toBe('runtime')

    await palette(tui, '/view')
    await tui.press(KEY.enter)
    await tui.waitFor(() => store.getState().focus === 'input')
    await tui.waitFor('/view')

    // Recently run entries come first on an empty query.
    await tui.press(KEY.esc)
    await tui.press(KEY.ctrlK)
    const frame = await tui.waitFor('Command palette')
    const firstRow = frame.split('\n').find(line => line.includes('›') && line.includes('/view'))
    expect(firstRow).toContain('Recent')
  }, 15000)

  it('shows every view’s keys and commands in /help, grouped, with the loops explainer', async () => {
    const tui = await mount()
    const lines = helpLines(VIEWS, registry, store, noop, 'inspect').map(lineText).join('\n')
    expect(lines).toContain('parallel chat sessions')
    expect(lines).toContain('Shell commands')
    for (const view of VIEWS) expect(lines).toContain(`${view.key} ${view.title}`)
    for (const command of registry.commands) expect(lines).toContain(`/${command.name}`)
    expect(lines).toMatch(/5 Inspect\s+\(current view\)/)

    store.actions.prefillPrompt('')
    await tui.waitFor(() => store.getState().focus === 'input')
    await tui.type('/help')
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('ADF keys & commands') && f.includes('parallel chat sessions'))
    await tui.press(KEY.pgdn)
    await tui.press(KEY.pgdn)
    await tui.waitFor(f => /\d+-\d+ of \d+/.test(f) && !f.includes('parallel chat sessions'))
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('ADF keys & commands'))
  }, 15000)

  it('help filters as you type (matches marked), Esc clears then closes, Ctrl+K swaps to the palette', async () => {
    const tui = await mount()
    const all = helpLines(VIEWS, registry, store, noop)
    const filtered = filterHelpLines(all, 'sidebar').map(lineText)
    expect(filtered.length).toBeGreaterThan(2)
    expect(filtered.join('\n')).toContain('/sidebar')
    expect(filtered.join('\n')).not.toContain('parallel chat sessions')
    // A matching heading keeps its section (Sidebar: the fleet tree → its keys).
    expect(filtered.join('\n')).toContain('Type to filter agents and loops')
    expect(filterHelpLines(all, 'zzqqxx')).toEqual([])

    await tui.press('?')
    await tui.waitFor(f => f.includes('ADF keys & commands') && f.includes('type to filter'))
    await tui.type('mouse')
    const frame = await tui.waitFor(f => f.includes('Search: mouse') && !f.includes('parallel chat sessions'))
    expect(frame).toContain('/mouse')
    await tui.press(KEY.esc)
    await tui.waitFor(f => f.includes('type to filter') && f.includes('parallel chat sessions'))
    // Ctrl+K from help: the palette, legacy (^K) and kitty (CSI 107;5u) alike.
    await tui.press(KEY.ctrlK)
    await tui.waitFor(f => f.includes('Command palette') && !f.includes('ADF keys & commands'))
    await tui.type('runtime')
    await tui.waitFor(f => f.includes('› runtime') && f.includes('Go to Runtime'))
    expect(tui.lastFrame()).not.toContain('Go to Fleet')
    await tui.press(KEY.esc)
    await tui.press('\u001b[107;5u')
    await tui.waitFor('Command palette')
    await tui.press(KEY.esc)
    await tui.press('?')
    await tui.waitFor('ADF keys & commands')
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('ADF keys & commands'))
  }, 15000)

  it('reports the daemon URL, refuses a dead one and switches daemons live with /url', async () => {
    const tui = await mount()
    const run = async (text: string) => {
      store.actions.prefillPrompt('')
      await tui.waitFor(() => store.getState().focus === 'input')
      await tui.type(text)
      await tui.press(KEY.enter)
    }
    await run('/url')
    await tui.waitFor(`Daemon ${mock.url}`)
    await run(`/url ${mock.url}`)
    await tui.waitFor('Already connected')
    await run('/url 127.0.0.1:1')
    await tui.waitFor('is not answering')
    expect(store.getState().daemonUrl).toBe(mock.url)

    const other = await startMockDaemon({ stepMs: 5 })
    try {
      other.agents.delete(AGENT_2_ID)
      await run(`/url ${other.url}`)
      await tui.waitFor('Switched from')
      expect(store.getState().daemonUrl).toBe(other.url)
      await tui.waitFor(() => store.getState().agentOrder.length === 1)
      expect(store.getState().agents[AGENT_2_ID]).toBeUndefined()
    } finally {
      await other.close()
    }
  }, 20000)

  it('has no command name collisions across the builtins and all six views', () => {
    expect(registry.conflicts).toEqual([])
    expect(registry.find('events')?.view).toBe('runtime')
    expect(registry.find('status')?.view).toBe('runtime')
    expect(registry.find('inspect')?.view).toBe('inspect')
    expect(registry.find('sidebar')?.view).toBe('builtin')
    expect(registry.find('terminal-setup')?.view).toBe('builtin')
  })
})

void React
