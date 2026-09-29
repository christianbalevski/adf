import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { editInstructionsExternally } from '../../src/main/tui/views/inspect/settings-ops'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createInspectFixture, type InspectFixture } from './fixtures/inspect-daemon'
import { createSettingsFixture, type SettingsFixture } from './fixtures/settings-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', ctrlS: '\u0013' }

/** Top-level keys whose values differ between two configs. */
function changed(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort()
}

describe('Inspect › Settings against the mock daemon', () => {
  let mock: MockDaemon
  let inspect: InspectFixture
  let settings: SettingsFixture
  let store: TuiStore
  let ui: RenderedTui | null = null

  beforeEach(async () => {
    mock = await startMockDaemon({ stepMs: 5 })
    inspect = createInspectFixture(mock.url)
    // agent-1 has an MCP server with two advertised tools, one declared gated.
    const cfg = inspect.configs.get(AGENT_1_ID) as Record<string, unknown> & { tools: Array<Record<string, unknown>> }
    cfg.autonomous = false
    delete cfg.autostart
    cfg.mcp = { servers: [{ name: 'github', transport: 'stdio', command: 'npx', args: [], available_tools: [{ name: 'search', description: 'Search issues and pull requests' }, { name: 'comment', description: 'Comment on an issue' }] }] }
    cfg.tools.push({ name: 'mcp_github_search', enabled: true, visible: true, restricted: true }, { name: 'mcp_github_comment', enabled: false, visible: false, restricted: true })
    settings = createSettingsFixture(inspect)
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: settings.fetch }) })
  })

  afterEach(async () => {
    ui?.unmount()
    ui = null
    store.stop()
    await mock.close()
  })

  async function mount(size = { columns: 120, rows: 34 }) {
    ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, size)
    await store.start()
    await ui.waitFor('consolidator')
    store.actions.selectAgent(AGENT_1_ID)
    return ui
  }

  async function slash(tui: RenderedTui, command: string) {
    store.actions.prefillPrompt('')
    await tui.waitFor(() => store.getState().focus === 'input')
    await tui.type(command)
    await tui.press(KEY.enter)
  }

  async function focusMain() {
    store.actions.setFocus('main')
    await new Promise(resolve => setTimeout(resolve, 60))
  }

  function answerConfirms(answers: boolean[]) {
    const seen = new Set<string>()
    return store.subscribe(() => {
      const top = store.getState().overlays.at(-1)
      if (top?.kind !== 'confirm' || seen.has(top.id)) return
      seen.add(top.id)
      const answer = answers.shift() ?? false
      setTimeout(() => store.resolveConfirm(top.id, answer), 0)
    })
  }

  const config = () => inspect.configs.get(AGENT_1_ID) as Record<string, unknown>
  const lastPut = () => inspect.configPuts.at(-1)?.body as Record<string, unknown>
  const toolOf = (c: Record<string, unknown>, name: string) => (c.tools as Array<Record<string, unknown>>).find(t => t.name === name)

  it('shows the settings and flips switches with minimal writes (autonomous asks first)', async () => {
    const tui = await mount()
    await slash(tui, '/inspect settings')
    const frame = await tui.waitFor(f => f.includes('Instructions') && f.includes('in use 42k'))
    expect(frame).toContain('1 line, 34 chars')
    expect(frame).toContain('main at 100k (default)')
    expect(frame).toMatch(/Tools\s+\d+\/\d+ enabled · \d+ need approval · 1 MCP server/)
    expect(frame).toContain('Host access')
    expect(frame).toContain('instructions in $EDITOR') // status bar hint
    await focusMain()

    // Autostart (row 5): Space flips it; only autostart moves.
    const before = JSON.parse(JSON.stringify(config())) as Record<string, unknown>
    for (let i = 0; i < 4; i++) await tui.press(KEY.down)
    await tui.press(' ')
    await tui.waitFor(() => inspect.configPuts.length === 1)
    expect(changed(before, lastPut())).toEqual(['autostart'])
    await tui.waitFor('Autostart: on')

    // Autonomous asks; "no" writes nothing, "yes" turns it on.
    await tui.press(KEY.up)
    const stop = answerConfirms([false, true])
    await tui.press(' ')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(inspect.configPuts).toHaveLength(1)
    await tui.press(' ')
    await tui.waitFor(() => inspect.configPuts.length === 2)
    stop()
    expect(lastPut().autonomous).toBe(true)
    await tui.waitFor(f => f.includes('Keeps making LLM calls'))

    // l locks the section for the agent (locked_fields), visibly.
    await tui.press(KEY.up) // Compaction
    await tui.press('l')
    await tui.waitFor(() => inspect.configPuts.length === 3)
    expect(lastPut().locked_fields).toEqual(expect.arrayContaining(['context']))
    await tui.waitFor('(42%) [locked]')
  }, 15000)

  it('/tools: grouped list, filter, enable, approval, lock refusal, MCP tools', async () => {
    const tui = await mount()
    await slash(tui, '/tools')
    let frame = await tui.waitFor(f => f.includes('Tools ·') && f.includes('Filesystem'))
    expect(frame).toMatch(/\[x\] ADF Shell|\[ \] ADF Shell/)
    expect(frame).toContain('approval')

    // Filter to fs_delete, enable it: enabled + shown, nothing else moves.
    await tui.press('/')
    await tui.type('fs_del')
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('fs_delete') && !f.includes('fs_read'))
    await tui.press(KEY.down) // header → the tool
    const before = JSON.parse(JSON.stringify(config())) as Record<string, unknown>
    await tui.press(' ')
    await tui.waitFor(() => inspect.configPuts.length === 1)
    expect(changed(before, lastPut())).toEqual(['tools'])
    expect(toolOf(lastPut(), 'fs_delete')).toMatchObject({ enabled: true, visible: true })
    await tui.waitFor('fs_delete enabled')

    // r requires approval, l locks, then Space is refused (a toast, no write).
    await tui.press('r')
    await tui.waitFor(() => inspect.configPuts.length === 2)
    expect(toolOf(lastPut(), 'fs_delete')?.restricted).toBe(true)
    await tui.press('l')
    await tui.waitFor(() => inspect.configPuts.length === 3)
    expect(toolOf(lastPut(), 'fs_delete')?.locked).toBe(true)
    await tui.waitFor(f => f.includes('locked') && f.includes('required'))
    await tui.press(' ')
    await tui.waitFor('fs_delete is locked: unlock it first')
    expect(inspect.configPuts).toHaveLength(3)

    // MCP tools: grouped under their server, with descriptions.
    await tui.press(KEY.esc) // clear the filter
    await tui.press('/')
    await tui.type('github')
    await tui.press(KEY.enter)
    frame = await tui.waitFor(f => f.includes('MCP github') && f.includes('search') && f.includes('comment'))
    await tui.press(KEY.down)
    await tui.press(KEY.down)
    await tui.waitFor('Comment on an issue')
    await tui.press(KEY.esc)
    await tui.press(KEY.esc)
    await tui.waitFor(() => !store.getState().overlays.some(o => o.kind === 'inspect.tools'))
  }, 15000)

  it('/instructions: edit in place, Ctrl+S saves; asks when the daemon copy moved', async () => {
    const tui = await mount()
    await slash(tui, '/instructions')
    await tui.waitFor(f => f.includes('Instructions ·') && f.includes('Keep the standings API notes tidy.'))
    await new Promise(resolve => setTimeout(resolve, 60)) // the editor's key handler registers after its first frame
    await tui.type(' Always cite sources.')
    await tui.waitFor('tidy. Always cite sources.')
    await tui.press(KEY.enter) // a newline, not a save
    await tui.type('Be brief.')
    expect(inspect.configPuts).toHaveLength(0)
    const before = JSON.parse(JSON.stringify(config())) as Record<string, unknown>
    await tui.press(KEY.ctrlS)
    await tui.waitFor(() => inspect.configPuts.length === 1)
    expect(changed(before, lastPut())).toEqual(['instructions'])
    expect(lastPut().instructions).toBe('Keep the standings API notes tidy. Always cite sources.\nBe brief.')
    await tui.waitFor(() => !store.getState().overlays.some(o => o.kind === 'inspect.instructions'))

    // Someone else changes them while the dialog is open: confirm before overwriting.
    await slash(tui, '/instructions')
    await tui.waitFor('Be brief.')
    await new Promise(resolve => setTimeout(resolve, 60))
    config().instructions = 'Changed by the agent.'
    await tui.type('!')
    const stop = answerConfirms([false])
    await tui.press(KEY.ctrlS)
    await tui.waitFor('Instructions edit discarded')
    stop()
    expect(inspect.configPuts).toHaveLength(1)
    expect(config().instructions).toBe('Changed by the agent.')
  }, 15000)

  it('/compaction: main via the config, an inner loop via PATCH, bounds checked', async () => {
    const tui = await mount()
    await slash(tui, '/compaction')
    let frame = await tui.waitFor(f => f.includes('Compaction ·') && f.includes('consolidator'))
    expect(frame).toMatch(/main\s+100k \(default\)/)
    expect(frame).toMatch(/consolidator\s+100k \(inherits main\)/)
    expect(frame).toContain('42k 42%')

    // main: 80k → context.compact_threshold only.
    const before = JSON.parse(JSON.stringify(config())) as Record<string, unknown>
    await tui.press(KEY.enter)
    await tui.waitFor('New threshold for main')
    await tui.type('lots')
    await tui.press(KEY.enter)
    await tui.waitFor('A whole number of tokens')
    expect(inspect.configPuts).toHaveLength(0)
    for (let i = 0; i < 4; i++) await tui.press('\u007f')
    await tui.type('80k')
    await tui.press(KEY.enter)
    await tui.waitFor(() => inspect.configPuts.length === 1)
    expect(changed(before, lastPut())).toEqual(['context'])
    expect((lastPut().context as Record<string, unknown>).compact_threshold).toBe(80000)

    // consolidator: its own override through the loop pool.
    await tui.press(KEY.down)
    await tui.press('e')
    await tui.type('50000')
    await tui.press(KEY.enter)
    await tui.waitFor(() => settings.loopPatches.length === 1)
    expect(settings.loopPatches[0]).toMatchObject({ loop: 'consolidator', body: { compact_threshold: 50000 } })
    frame = await tui.waitFor(f => /consolidator\s+50k/.test(f))
    // d: back to inheriting main's.
    await tui.press('d')
    await tui.waitFor(() => settings.loopPatches.length === 2)
    expect(settings.loopPatches[1].body).toEqual({ compact_threshold: null })
    await tui.press(KEY.esc)

    // /compaction <tokens> sets the selected loop's directly.
    await slash(tui, '/compaction default')
    await tui.waitFor(() => inspect.configPuts.length === 2)
    expect('compact_threshold' in (lastPut().context as Record<string, unknown>)).toBe(false)
  }, 15000)

  it('fits 80x24: settings rows and the tools dialog stay readable', async () => {
    const tui = await mount({ columns: 80, rows: 24 })
    await slash(tui, '/inspect settings')
    const frame = await tui.waitFor(f => f.includes('Instructions') && f.includes('Tools'))
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    await slash(tui, '/tools')
    const tools = await tui.waitFor(f => f.includes('Filesystem'))
    for (const line of tools.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  }, 15000)

  it('the $EDITOR round trip returns the edited text without the editor’s final newline', async () => {
    const toasts: string[] = []
    const actions = { toast: (text: string) => { toasts.push(text) } } as never
    const suspend = async (fn: () => void | Promise<void>) => { await fn() }
    expect(await editInstructionsExternally(actions, 'agent-1', 'old', suspend, async () => ({ text: 'new text\n', changed: true, editor: 'fake' }))).toBe('new text')
    expect(await editInstructionsExternally(actions, 'agent-1', 'old', suspend, async () => ({ text: 'old\n', changed: false, editor: 'fake' }))).toBe('old')
    expect(await editInstructionsExternally(actions, 'agent-1', 'old', suspend, async () => ({ text: null, changed: false, editor: 'fake', error: 'not found' }))).toBeNull()
    expect(toasts[0]).toContain('not found')
  })
})
