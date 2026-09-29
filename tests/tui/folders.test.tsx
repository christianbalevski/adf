import React from 'react'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import fleet from '../../src/main/tui/views/fleet/index'
import runtime from '../../src/main/tui/views/runtime/index'
import { completeFolder } from '../../src/main/tui/views/fleet/folders'
import { openRuntime } from '../../src/main/tui/views/runtime/state'
import { MOCK_AGENTS_DIR, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, wrapped, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null
let tmp: string

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  // Real folders for Tab completion; the mock daemon "has" them too.
  tmp = mkdtempSync(join(tmpdir(), 'adf-tui-folders-'))
  mkdirSync(join(tmp, 'team-agents'))
  mkdirSync(join(tmp, 'other'))
  mock.existingDirs.add(join(tmp, 'team-agents'))
  mock.existingDirs.add(join(tmp, 'other'))
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  await mock.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function mount() {
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} views={[fleet, runtime]} builtins={[]} />, { columns: 130, rows: 34 })
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('agent-2'))
  return ui
}

const toasts = () => store.getState().toasts.map(t => t.text).join('\n')
const until = (check: () => boolean, ms = 3000) => new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + ms
  const tick = () => (check() ? resolve() : Date.now() > deadline ? reject(new Error('condition not met in time')) : setTimeout(tick, 10))
  tick()
})

async function runCommand(tui: RenderedTui, text: string) {
  store.actions.setFocus('input')
  await new Promise(resolve => setTimeout(resolve, 50))
  await tui.type(text)
  await tui.press(KEY.enter)
}

describe('tracked folders', () => {
  it('completes folders only', () => {
    const result = completeFolder(join(tmp, 'te'))
    expect(result.value).toBe(join(tmp, 'team-agents') + sep)
    expect(completeFolder(`${tmp}${sep}`).candidates.sort()).toEqual([`other${sep}`, `team-agents${sep}`])
  })

  it('f opens "Track a folder": Tab completes, Enter tracks, a duplicate stays in the dialog', async () => {
    const tui = await mount()
    store.actions.setViewState('fleet.track.lastDir', `${tmp}${sep}te`)
    await tui.press('f')
    await tui.waitFor('Track a folder')
    await tui.press(KEY.tab)
    await tui.waitFor(wrapped('team-agents'))
    await tui.press(KEY.enter)
    await tui.waitFor(f => !f.includes('Track a folder'))
    const dir = join(tmp, 'team-agents')
    expect(mock.trackedDirs).toEqual([MOCK_AGENTS_DIR, dir])
    await until(() => toasts().includes(`Tracking ${dir}`))
    expect(toasts()).toContain('loaded 0')

    // Same folder again: the 409 shows in the dialog, which stays open.
    store.actions.setViewState('fleet.track.lastDir', dir)
    await tui.press('f')
    await tui.waitFor('Track a folder')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('Already tracked')
    expect(frame).toContain('Track a folder')
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('Track a folder'))
  })

  it('/track <dir> tracks directly; /untrack asks, can unload the folder’s agents', async () => {
    const tui = await mount()
    const dir = join(tmp, 'other')
    await runCommand(tui, `/track ${dir}`)
    await until(() => mock.trackedDirs.includes(dir))
    await runCommand(tui, '/track relative/nope')
    await until(() => toasts().includes('path does not exist') || toasts().includes('Track folder'))

    await runCommand(tui, `/untrack ${dir}`)
    await tui.waitFor('Stop tracking folder')
    await tui.press('n')
    await tui.waitFor(f => !f.includes('Stop tracking folder'))
    expect(mock.trackedDirs).toContain(dir)

    await runCommand(tui, `/untrack ${MOCK_AGENTS_DIR}`)
    await tui.waitFor('Files are not touched')
    await tui.press('u')
    await tui.waitFor('[✓] also unload its agents')
    await tui.press('y')
    await until(() => !mock.trackedDirs.includes(MOCK_AGENTS_DIR))
    await until(() => toasts().includes('unloaded 2'))
    expect(mock.agents.size).toBe(0)
  })

  it('Runtime › Folders lists folders; a adds, d asks to stop tracking', async () => {
    const tui = await mount()
    openRuntime(store.actions, store.getState(), { tab: 'folders' })
    store.actions.setFocus('main')
    let frame = await tui.waitFor(f => f.includes('FOLDER') && f.includes(MOCK_AGENTS_DIR))
    expect(frame).toMatch(/\/agents\s+yes\s+2\s+2/)
    await tui.press('d')
    await tui.waitFor(`Stop tracking ${MOCK_AGENTS_DIR}?`)
    await tui.press('y')
    frame = await tui.waitFor(f => f.includes('No tracked folders'))
    expect(mock.agents.size).toBe(2) // default: agents keep running
    await tui.press('a')
    await tui.waitFor('Track a folder')
    await tui.press(KEY.esc)
  })
})
