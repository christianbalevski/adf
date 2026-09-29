// The composer's completion menu: Enter takes the highlighted item (a ready
// /command runs, one that needs arguments is inserted), Tab completes without
// running, Enter with the menu closed submits as before.

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { menuEnter, slashEnterAction } from '../../src/main/tui/app/Prompt'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import type { SlashCommand } from '../../src/main/tui/commands/types'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', tab: '\t', down: '\u001b[B', esc: '\u001b' }
const cmd = (name: string, args?: string): SlashCommand => ({ name, args, description: name, run: () => {} })

describe('menuEnter (pure)', () => {
  it('runs a command whose required arguments are all there, inserts one that needs more', () => {
    expect(menuEnter('/he', { value: '/help ' }, cmd('help'))).toEqual({ submit: '/help' })
    expect(menuEnter('/co', { value: '/copy ' }, cmd('copy', '[n]'))).toEqual({ submit: '/copy' })
    expect(menuEnter('/ag', { value: '/agent ' }, cmd('agent', '<handle|id> [loop]'))).toEqual({ insert: '/agent ' })
    expect(menuEnter('/agent ag', { value: '/agent agent-1 ' }, cmd('agent', '<handle|id> [loop]'))).toEqual({ submit: '/agent agent-1' })
    expect(menuEnter('/timer re', { value: '/timer researcher ' }, cmd('timer', '<loop> <every>'))).toEqual({ insert: '/timer researcher ' })
  })

  it('keeps completing a path, runs a path typed in full, submits free text past the suggestions', () => {
    expect(menuEnter('/load C:\\ag', { value: '/load C:\\agents\\' }, cmd('load', '<file>'))).toEqual({ insert: '/load C:\\agents\\' })
    expect(menuEnter('/track /srv/team', { value: '/track /srv/team/' }, cmd('track', '<dir>'))).toEqual({ submit: '/track /srv/team' })
    expect(menuEnter('/loop new critic Review drafts', { value: '/loop new ' }, cmd('loop', '<verb>'))).toEqual({ submit: '/loop new critic Review drafts' })
    // Typed exactly: a command still needing arguments waits for them.
    expect(menuEnter('/agent', { value: '/agent ' }, cmd('agent', '<handle|id>'))).toEqual({ insert: '/agent ' })
    expect(slashEnterAction('/help', cmd('help'))).toEqual({ run: '/help' })
  })

  it('an @mention is inserted, not sent', () => {
    expect(menuEnter('read @no', { value: 'read @notes/api.md ', cursor: 19 })).toEqual({ insert: 'read @notes/api.md ', cursor: 19 })
    expect(menuEnter('read @notes/api.md', { value: 'read @notes/api.md ' })).toEqual({ submit: 'read @notes/api.md' })
  })
})

let mock: MockDaemon | null = null
let store: TuiStore | null = null
let ui: RenderedTui | null = null

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  store = null
  await mock?.close()
  mock = null
})

async function mountChat() {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 34 })
  await store.start()
  await ui.waitFor(f => f.includes('consolidator') && f.includes('What did we decide'))
  await ui.waitFor(() => store!.getState().focus === 'input')
  return ui
}

const typeKeys = async (tui: RenderedTui, text: string) => { for (const ch of text) await tui.press(ch) }
const promptLine = (frame: string) => frame.split('\n').find(l => l.includes('› /') || l.includes('› read')) ?? ''

describe('completion menu in the composer', () => {
  it('Enter on a highlighted command without arguments runs it', async () => {
    const tui = await mountChat()
    await typeKeys(tui, '/hel')
    await tui.waitFor('Keys, commands and what loops are')
    await tui.press(KEY.enter)
    await tui.waitFor('ADF keys & commands')
    expect(store!.getState().overlays.at(-1)?.kind).toBe('help')
  })

  it('Enter on a command that needs arguments inserts it with a space; Tab completes without running', async () => {
    const tui = await mountChat()
    await typeKeys(tui, '/swi')
    await tui.waitFor('Jump to an agent')
    await tui.press(KEY.enter)
    let frame = await tui.waitFor(f => /› \/switch\s+│/.test(promptLine(f)))
    expect(store!.getState().overlays).toHaveLength(0)
    // Its argument menu: ↓ moves the highlight, Enter picks and runs it.
    frame = await tui.waitFor('agent-2')
    expect(frame).toContain('/switch agent-1')
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    await tui.waitFor(() => store!.getState().agents[store!.getState().selectedAgentId!]?.summary.handle === 'agent-2')
    // Tab only completes.
    store!.actions.setFocus('input')
    await typeKeys(tui, '/hel')
    await tui.waitFor('Keys, commands and what loops are')
    await tui.press(KEY.tab)
    frame = await tui.waitFor(f => /› \/help\s+│/.test(promptLine(f)))
    expect(store!.getState().overlays).toHaveLength(0)
  })

  it('Enter on an @file mention inserts the path and keeps the message unsent', async () => {
    const tui = await mountChat()
    await typeKeys(tui, 'read @no')
    await tui.waitFor('@notes/api.md')
    const before = mock!.requests.filter(r => r.startsWith('POST') && r.includes('/chat')).length
    await tui.press(KEY.enter)
    await tui.waitFor(f => promptLine(f).includes('read @notes/api.md'))
    expect(mock!.requests.filter(r => r.startsWith('POST') && r.includes('/chat')).length).toBe(before)
    // The menu is gone: the next Enter sends.
    await tui.press(KEY.enter)
    await tui.waitFor(() => mock!.requests.filter(r => r.startsWith('POST') && r.includes('/chat')).length === before + 1)
  })

  it('Enter with the menu closed submits the typed text as before', async () => {
    const tui = await mountChat()
    // Plain text: no menu, Enter sends.
    const chats = () => mock!.requests.filter(r => r.startsWith('POST') && r.includes('/chat')).length
    const before = chats()
    await typeKeys(tui, 'hello there')
    await tui.press(KEY.enter)
    await tui.waitFor(() => chats() === before + 1)
    // A menu closed with Esc: Enter submits what is typed (here a complete command).
    await typeKeys(tui, '/view fleet')
    await tui.press(KEY.esc)
    await tui.press(KEY.enter)
    await tui.waitFor(() => store!.getState().activeView === 'fleet')
  })
})

void React
