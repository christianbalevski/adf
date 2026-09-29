// Tracking a folder shows what happened to each of its agents (loaded, needs
// review, not autostart, failed with the daemon's error) and offers the next
// step: review + accept + load, or load. Runtime › Folders Enter shows the same.

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
import { folderAgentsSummary } from '../../src/main/tui/views/fleet/folders'
import { openRuntime } from '../../src/main/tui/views/runtime/state'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null
let tmp: string
let dir: string

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  tmp = mkdtempSync(join(tmpdir(), 'adf-tui-folders-track-'))
  dir = join(tmp, 'lab')
  mkdirSync(dir)
  mock.existingDirs.add(dir)
  mock.folderFiles.push(
    { filePath: join(dir, 'agent-3.adf'), name: 'agent-3', autostart: true, reviewed: true },
    { filePath: join(dir, 'agent-4.adf'), name: 'agent-4', autostart: true, reviewed: false },
    { filePath: join(dir, 'agent-5.adf'), name: 'agent-5', autostart: false, reviewed: true },
    { filePath: join(dir, 'agent-6.adf'), name: 'agent-6', autostart: true, reviewed: true, loadError: 'Provider "anthropic" not found. Configure it in Settings → Providers.' },
  )
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  await mock.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function mount(columns = 120, rows = 40) {
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} views={[fleet, runtime]} builtins={[]} />, { columns, rows })
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('agent-2'))
  return ui
}

/** The frame as one line: dialog text wraps inside borders. */
const flat = (frame: string) => frame.replace(/[│|]/g, ' ').replace(/\s+/g, ' ')
const has = (text: string) => (frame: string) => flat(frame).includes(text)

const names = () => Object.values(store.getState().agents).map(a => a.summary.name).sort()

describe('tracking a folder shows its agents and the next step', () => {
  it('lists loaded / needs review / failed / not autostart; review + accept loads; the fleet shows each agent', async () => {
    const tui = await mount()
    store.actions.setViewState('fleet.track.lastDir', `${dir}${sep}`)
    await tui.press('f')
    await tui.waitFor('Track a folder')
    await tui.press(KEY.enter)

    let frame = await tui.waitFor('Folder tracked')
    expect(frame).toContain('4 agents: 1 loaded · 1 needs review · 1 failed to load · 1 not autostart')
    expect(frame).toMatch(/agent-3\s+loaded/)
    expect(frame).toMatch(/agent-4\s+needs review/)
    expect(frame).toMatch(/agent-5\s+not autostart/)
    expect(frame).toMatch(/agent-6\s+failed to load/)
    expect(frame).toContain('Provider "anthropic" not found')
    // The reviewed autostart agent is on the fleet already.
    await tui.waitFor(() => names().includes('agent-3'))

    // needs review: Enter shows what it can do; y accepts and loads it.
    await tui.press(KEY.down)
    frame = await tui.waitFor(has('Enter reviews it'))
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('Review agent-4') && f.includes('compute_exec'))
    expect(frame).toContain('compute_exec')
    expect(frame).toContain('host access')
    expect(frame).toContain('Channels: telegram')
    await tui.press('y')
    frame = await tui.waitFor('agent-4 is loaded.')
    await tui.waitFor(f => /agent-4\s+loaded/.test(f))
    expect(mock.folderFiles.find(f => f.name === 'agent-4')?.reviewed).toBe(true)
    expect(names()).toContain('agent-4')

    // not autostart: Enter loads it.
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    await tui.waitFor('agent-5 is loaded.')
    expect(names()).toContain('agent-5')

    // failed: Enter retries and says why it failed again.
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    frame = await tui.waitFor(has('agent-6: Provider "anthropic" not found'))
    expect(names()).not.toContain('agent-6')

    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('Folder tracked'))
    await tui.waitFor(f => f.includes('agent-4') && f.includes('agent-5'))
  }, 20_000)

  it('Runtime › Folders: the new folder shows with its counts; Enter lists its agents', async () => {
    const tui = await mount()
    await store.client.trackDir(dir)
    openRuntime(store.actions, store.getState(), { tab: 'folders' })
    store.actions.setFocus('main')
    let frame = await tui.waitFor(f => f.includes('FOLDER') && /yes\s+4\s+1/.test(f))
    expect(frame).toMatch(/\/agents\s+yes\s+2\s+2/)
    expect(frame).not.toMatch(/^\s*[-·—]\s*A\s*$/m)
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('Tracked folder') && f.includes('needs review'))
    expect(frame).toContain('1 needs review')
    await tui.press(KEY.esc)
    await tui.waitFor(f => !f.includes('Tracked folder'))
  })

  it('fits 80x24', async () => {
    const tui = await mount(80, 24)
    store.actions.setViewState('fleet.track.lastDir', `${dir}${sep}`)
    await tui.press('f')
    await tui.waitFor('Track a folder')
    await tui.press(KEY.enter)
    const frame = await tui.waitFor('Folder tracked')
    for (const name of ['agent-3', 'agent-4', 'agent-5', 'agent-6']) expect(frame).toContain(name)
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  })

  it('summarizes counts', () => {
    expect(folderAgentsSummary([])).toBe('No agent files (.adf) in this folder.')
    expect(folderAgentsSummary([
      { filePath: 'a', name: 'a', status: 'loaded', autostart: true, reviewed: true },
      { filePath: 'b', name: 'b', status: 'stopped', autostart: true, reviewed: true },
    ])).toBe('2 agents: 1 loaded · 1 not loaded')
  })
})
