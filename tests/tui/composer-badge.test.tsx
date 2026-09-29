// The agent's status line as a sticky note on the composer's top border:
// right-aligned, at most 40% of the width, only border cells, live, and a
// click opens Inspect › Status.

import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { statusBadgeText } from '../../src/main/tui/app/ComposerTop'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { readInspectState } from '../../src/main/tui/views/inspect/state'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

describe('statusBadgeText', () => {
  it('pads, truncates to 40% of the composer and hides when empty', () => {
    expect(statusBadgeText('Quiet; next 44 30 Sep 07:00Z', 100, false)).toBe(' Quiet; next 44 30 Sep 07:00Z ')
    const cut = statusBadgeText('A very long status line that keeps going well past the limit', 50, false)!
    expect(cut.length).toBe(20)
    expect(cut.endsWith('… ')).toBe(true)
    expect(statusBadgeText('', 100, false)).toBeNull()
    expect(statusBadgeText('   ', 100, false)).toBeNull()
    expect(statusBadgeText(undefined, 100, false)).toBeNull()
    // Too narrow for a readable note: none.
    expect(statusBadgeText('Quiet', 12, false)).toBeNull()
  })

  it('mono: [ status ] carries it without colour; multi-line statuses become one line', () => {
    expect(statusBadgeText('Quiet', 100, true)).toBe('[ Quiet ]')
    expect(statusBadgeText('line one\nline two', 100, true)).toBe('[ line one line two ]')
    expect(statusBadgeText('x'.repeat(80), 60, true, '...')).toBe(`[ ${'x'.repeat(17)}... ]`)
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

async function mountChat(columns: number, rows = 30) {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns, rows })
  await store.start()
  await ui.waitFor(f => f.includes('What did we decide'))
  return ui
}

const lines = (frame: string) => frame.split('\n')
/** The composer: its top border row and the text row under it. */
function composer(frame: string): { top: string; text: string } {
  const rows = lines(frame)
  const at = rows.findIndex(r => r.includes('› Message') || r.includes('› hello'))
  return { top: rows[at - 1] ?? '', text: rows[at] ?? '' }
}

describe('composer badge', () => {
  it('120 columns: right-aligned on the top border, the text row untouched', async () => {
    const tui = await mountChat(120)
    const frame = await tui.waitFor('[ Merging API notes into mind.md ]')
    const { top, text } = composer(frame)
    expect(top).toMatch(/╭─+\[ Merging API notes into mind\.md \]─╮$/)
    expect(text).not.toContain('Merging')
    // Typed text stays on its own row.
    await tui.type('hello there')
    const typed = composer(await tui.waitFor('hello there'))
    expect(typed.text).toContain('hello there')
    expect(typed.top).toContain('[ Merging API notes into mind.md ]')
  })

  it('80 columns: truncated to 40% of the composer', async () => {
    const tui = await mountChat(80)
    const frame = await tui.waitFor(f => /\[ Merging.*… \]/.test(f))
    const { top } = composer(frame)
    const badge = top.match(/\[ .* \]/)![0]
    expect(badge.length).toBeLessThanOrEqual(Math.floor(top.length * 0.4) + 1)
    expect(top).toMatch(/─╮$/)
  })

  it('hides when the agent has no status and updates live', async () => {
    const tui = await mountChat(120)
    await tui.waitFor('[ Merging API notes into mind.md ]')
    const agent = mock!.agents.get(AGENT_1_ID)!
    ;(agent as { status?: string }).status = 'Quiet; next 44 30 Sep 07:00Z'
    await store!.actions.refreshWeb()
    await tui.waitFor('[ Quiet; next 44 30 Sep 07:00Z ]')
    ;(agent as { status?: string }).status = ''
    await store!.actions.refreshWeb()
    const frame = await tui.waitFor(f => !f.includes('[ Quiet'))
    expect(composer(frame).top).toMatch(/^.*╭─+╮$/)
  })

  it('an inner loop shows its agent’s status (loops carry none of their own)', async () => {
    const tui = await mountChat(120)
    store!.actions.selectLoop(AGENT_1_ID, 'researcher')
    const frame = await tui.waitFor(f => f.includes('› researcher') || f.includes('Message agent-1 › researcher'))
    expect(frame).toContain('[ Merging API notes into mind.md ]')
  })

  it('a click on the badge opens Inspect › Status', async () => {
    const tui = await mountChat(120)
    const frame = await tui.waitFor('[ Merging API notes into mind.md ]')
    const rows = lines(frame)
    const y = rows.findIndex(r => r.includes('[ Merging'))
    const x = rows[y].indexOf('[ Merging') + 3
    tui.raw(`\u001b[<0;${x + 1};${y + 1}M`)
    tui.raw(`\u001b[<0;${x + 1};${y + 1}m`)
    await tui.waitFor(() => store!.getState().activeView === 'inspect')
    expect(readInspectState(store!.getState()).tab).toBe('diag')
  })
})

void React
