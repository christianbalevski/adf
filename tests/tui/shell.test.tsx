import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render as renderInk } from 'ink-testing-library'
import { Text } from 'ink'
import { App } from '../../src/main/tui/app/App'
import { createTheme, ThemeContext } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { VIEWS } from '../../src/main/tui/views/registry'
import { collectCommands } from '../../src/main/tui/commands/registry'
import { BUILTIN_COMMANDS } from '../../src/main/tui/commands/builtin/index'
import { Markdown } from '../../src/main/tui/ui/Markdown'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', ctrlK: '\u000b', down: '\u001b[B' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store.stop()
  await mock.close()
})

async function mount(size?: { columns?: number; rows?: number }) {
  const theme = createTheme({ mono: true })
  ui = renderTui(<App store={store} theme={theme} />, size)
  await store.start()
  return ui
}

describe('TUI shell', () => {
  it('renders the header, the fleet/loop sidebar and the status bar against the daemon', async () => {
    const tui = await mount()
    const frame = await tui.waitFor(f => f.includes('consolidator') && f.includes('live'))
    expect(frame).toContain('ADF')
    expect(frame).toContain('1 Chat')
    expect(frame).toMatch(/agent-1 ›\s+1 Chat .*│ 5 Fleet/)
    expect(frame).toContain('FLEET')
    expect(frame).toContain('agent-1')
    expect(frame).toContain('agent-2')
    expect(frame).toContain('researcher')
    expect(frame).toMatch(/agent-1 › ↻ main/)
    expect(frame).toContain('Ctrl+K palette')
    expect(frame).toContain('!1 pending')
  })

  it('switches views by hotkey and chats with an inner loop end-to-end', async () => {
    const tui = await mount()
    await tui.waitFor('consolidator')
    // Pick the consolidator loop from the Loops view, then open it in Chat.
    await tui.press('3')
    await tui.waitFor('Loops of agent-1')
    await tui.press(KEY.down)
    await tui.waitFor(f => /agent-1 › ↻ consolidator/.test(f))
    await tui.press('1')
    await tui.waitFor('Merged 3 notes into mind.md.')

    // Entering Chat focuses the prompt.
    await tui.waitFor(() => store.getState().focus === 'input')
    for (const ch of 'tidy the notes') await tui.press(ch)
    await tui.press(KEY.enter)
    await tui.waitFor('Working on it in consolidator')
    const rows = mock.agents.get(store.getState().selectedAgentId!)?.history.consolidator ?? []
    expect(rows.some(row => row.content_json[0].text === 'tidy the notes')).toBe(true)
    expect(mock.agents.get(store.getState().selectedAgentId!)?.history.main.some(row => row.content_json[0].text === 'tidy the notes')).toBe(false)
  })

  it('runs slash commands from the prompt and opens the palette', async () => {
    const tui = await mount()
    await tui.waitFor('consolidator')
    // Focus starts on the main pane; Tab cycles main → prompt → sidebar.
    await tui.press(KEY.tab)
    for (const ch of '/view inspect') await tui.press(ch)
    await tui.press(KEY.enter)
    await tui.waitFor('Identities')
    await tui.press(KEY.esc)
    await tui.press(KEY.ctrlK)
    await tui.waitFor('Command palette')
    await tui.press(KEY.esc)
    const frame = await tui.waitFor(f => !f.includes('Command palette'))
    expect(frame).toContain('Identities')
  })

  it('creates and deletes an inner loop from the prompt, confirming the delete', async () => {
    const tui = await mount()
    await tui.waitFor('consolidator')
    await tui.press(KEY.tab)
    await tui.type('/loop new critic Review drafts before main sends them')
    await tui.press(KEY.enter)
    await tui.waitFor('Loop critic created')
    await tui.waitFor(f => /↻ critic/.test(f))
    expect(mock.agents.get(store.getState().selectedAgentId!)?.loops.map(l => l.name)).toContain('critic')

    await tui.type('/loop rm critic')
    await tui.press(KEY.enter)
    await tui.waitFor('Delete loop')
    await tui.press('y')
    await tui.waitFor('Loop critic deleted')
    expect(mock.agents.get(store.getState().selectedAgentId!)?.loops.map(l => l.name)).not.toContain('critic')
  }, 15000)

  it('prefills the prompt with / from the main pane', async () => {
    const tui = await mount()
    await tui.waitFor('consolidator')
    await tui.press('/')
    for (const ch of 'hel') await tui.press(ch)
    const frame = await tui.waitFor('/help')
    expect(frame).toContain('Keys, commands and what loops are')
    expect(store.getState().focus).toBe('input')
  })

  it('connects once the daemon comes up after the TUI started', async () => {
    const port = Number(new URL(mock.url).port)
    await mock.close()
    store.stop()
    store = createTuiStore({ client: new DaemonClient({ baseUrl: `http://127.0.0.1:${port}` }) })
    const tui = await mount()
    await tui.waitFor(f => /retry|offline|reconnecting/.test(f))
    mock = await startMockDaemon({ port, stepMs: 5 })
    const frame = await tui.waitFor(f => f.includes('consolidator') && f.includes('live'), 12000)
    expect(frame).toContain('agent-2')
    expect(frame).toContain('Connected to daemon')
  }, 20000)

  it('keeps working in a narrow terminal (sidebar collapses)', async () => {
    const tui = await mount({ columns: 60, rows: 20 })
    const frame = await tui.waitFor('agent-1')
    expect(frame).not.toContain('FLEET')
    expect(frame).toContain('ADF')
  })
})

describe('prompt input bursts', () => {
  it('Enter in the same tick as the typed text submits that text (no stale value)', async () => {
    const tui = await mount()
    await tui.waitFor('consolidator')
    await tui.press('/')
    await tui.waitFor(f => f.includes('› /'))
    tui.raw('view loops')
    tui.raw('\r')
    await tui.waitFor(() => store.getState().activeView === 'loops')
  })
})

describe('contracts', () => {
  it('registers the six feature views with unique ids and hotkeys, and commands without collisions', () => {
    expect(VIEWS.map(v => v.id)).toEqual(['chat', 'files', 'loops', 'inspect', 'fleet', 'runtime'])
    expect(VIEWS.map(v => v.key)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(VIEWS.map(v => v.group)).toEqual(['agent', 'agent', 'agent', 'agent', 'app', 'app'])
    expect(new Set(VIEWS.map(v => v.key)).size).toBe(VIEWS.length)
    const registry = collectCommands(VIEWS, [BUILTIN_COMMANDS])
    expect(registry.conflicts).toEqual([])
    expect(registry.find('loop')?.view).toBe('loops')
    expect(registry.find('help')?.view).toBe('builtin')
  })

  it('renders markdown-lite with ink-testing-library', () => {
    const { lastFrame, unmount } = renderInk(
      <ThemeContext.Provider value={createTheme({ mono: true })}>
        <Markdown text={'# Title\n\n- **bold** item\n- `code`\n\n```ts\nconst x = 1\n```'} />
        <Text>end</Text>
      </ThemeContext.Provider>,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Title')
    expect(frame).toContain('• bold item')
    expect(frame).toContain('const x = 1')
    unmount()
  })
})

void React
