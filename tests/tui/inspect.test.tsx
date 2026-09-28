import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme, type Theme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { REDACTED, jsonLines, lineText, redactSecrets, treeLines, valueLines } from '../../src/main/tui/views/inspect/format'
import { filterEvents, parseTypeFilter } from '../../src/main/tui/views/inspect/events'
import { findTab, readInspectState } from '../../src/main/tui/views/inspect/state'
import { findRuntimeTab, readRuntimeState } from '../../src/main/tui/views/runtime/state'
import { boundedJson, eventRow, summarizePayload } from '../../src/main/tui/views/inspect/events'
import { checkConfigText } from '../../src/main/tui/views/inspect/config-edit'
import { editConfigFlow } from '../../src/main/tui/views/inspect/ConfigTab'
import { resolveEditor } from '../../src/main/tui/util/editor'
import { identityLines, runtimeLines } from '../../src/main/tui/views/inspect/diag-lines'
import type { UmbilicalEvent } from '../../src/main/tui/api/types'
import { AGENT_1_ID, AGENT_2_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createInspectFixture, validConfig, type InspectFixture } from './fixtures/inspect-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { tab: '\t', enter: '\r', esc: '\u001b', right: '\u001b[C', left: '\u001b[D', down: '\u001b[B', up: '\u001b[A', end: '\u001b[F' }
const text = (lines: ReturnType<typeof treeLines>) => lines.map(lineText).join('\n')

describe('inspect formatting', () => {
  it('redacts secret-looking values but keeps counts, flags and env var names', () => {
    const out = redactSecrets({
      apiKey: 'sk-1', api_key: 'sk-2', client_secret: 'c', password: 'p', bot_token: 't', accessToken: 'a',
      max_tokens: 4096, hasApiKey: true, bearerTokenEnvVar: 'MY_TOKEN',
      env: { GITHUB_TOKEN: 'ghp' }, headers: { Authorization: 'Bearer x' },
      nested: [{ secret: 's' }],
    }) as Record<string, unknown>
    expect(out.apiKey).toBe(REDACTED)
    expect(out.api_key).toBe(REDACTED)
    expect(out.client_secret).toBe(REDACTED)
    expect(out.password).toBe(REDACTED)
    expect(out.bot_token).toBe(REDACTED)
    expect(out.accessToken).toBe(REDACTED)
    expect(out.max_tokens).toBe(4096)
    expect(out.hasApiKey).toBe(true)
    expect(out.bearerTokenEnvVar).toBe('MY_TOKEN')
    expect(out.env).toEqual({ GITHUB_TOKEN: REDACTED })
    expect(out.headers).toEqual({ Authorization: REDACTED })
    expect(out.nested).toEqual([{ secret: REDACTED }])
  })

  it('renders a readable tree and raw JSON, both redacted', () => {
    const value = { model: { provider: 'mock', model_id: 'mock-model' }, loops: [{ name: 'consolidator', enabled: true }], tools: ['a', 'b'], apiKey: 'sk-x', note: 'line 1\nline 2' }
    const tree = text(valueLines(value, false))
    expect(tree).toContain('model:\n  provider: mock')
    expect(tree).toContain('loops:\n  - name: consolidator\n    enabled: true')
    expect(tree).toContain('tools: [a, b]')
    expect(tree).toContain('note: |\n  line 1\n  line 2')
    expect(tree).not.toContain('sk-x')
    const raw = text(valueLines(value, true))
    expect(raw).toContain('"model_id": "mock-model"')
    expect(raw).not.toContain('sk-x')
    expect(text(jsonLines([1, null]))).toBe('[\n  1,\n  null\n]')
  })

  it('filters umbilical events by type terms, agent and loop', () => {
    const ev = (event_type: string, agent_id: string | null, loop?: string): UmbilicalEvent => ({ seq: 1, event_type, timestamp: 1, source: 'x', agent_id, ...(loop ? { loop } : {}), payload: {} })
    const events = [ev('tool.started', AGENT_1_ID, 'consolidator'), ev('turn.delta', AGENT_1_ID), ev('turn.completed', AGENT_1_ID), ev('tool.completed', AGENT_2_ID), ev('agent.loaded', null)]
    const scope = { selectedAgentId: AGENT_1_ID, selectedLoop: 'consolidator' }
    const base = { types: '', agent: 'all' as const, loop: 'all' as const, follow: true }
    expect(parseTypeFilter('tool. , -turn.delta turn*')).toEqual({ include: ['tool.', 'turn'], exclude: ['turn.delta'] })
    expect(filterEvents(events, { ...base, types: 'tool.' }, scope).map(e => e.event_type)).toEqual(['tool.started', 'tool.completed'])
    expect(filterEvents(events, { ...base, types: 'turn -turn.delta' }, scope).map(e => e.event_type)).toEqual(['turn.completed'])
    expect(filterEvents(events, { ...base, agent: 'selected' }, scope)).toHaveLength(3)
    expect(filterEvents(events, { ...base, loop: 'selected' }, scope).map(e => e.event_type)).toEqual(['tool.started'])
    expect(filterEvents(events, { ...base, loop: 'selected' }, { ...scope, selectedLoop: 'main' }).map(e => e.event_type)).toEqual(['turn.delta', 'turn.completed'])
    expect(findTab('diag')).toBe('diag')
    expect(findTab('runtime')).toBe('diag')
    expect(findTab('tab')).toBe('tables')
    expect(findTab('nope')).toBeUndefined()
    expect(findRuntimeTab('mesh')).toBe('network')
    expect(findRuntimeTab('events')).toBe('events')
    expect(findRuntimeTab('sign-in')).toBe('auth')
    expect(readInspectState({ viewState: {} } as never).events.agent).toBe('selected')
  })

  it('summarizes huge payloads without serializing all of them, once per event', () => {
    const big = { name: 'fs_read', result: { content: 'x'.repeat(5_000_000), rows: Array.from({ length: 100_000 }, (_, i) => i) } }
    const started = performance.now()
    const text = summarizePayload(big)
    expect(performance.now() - started).toBeLessThan(50)
    expect(text).toContain('name="fs_read"')
    expect(text).toMatch(/result=\{"content":"x+…/)
    expect(boundedJson({ a: [1, 2, { b: 'c' }] }, 100)).toBe('{"a":[1,2,{"b":"c"}]}')
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(boundedJson(cyclic, 100)).toBe('{"a":1,"self":"[circular]"}')
    const event: UmbilicalEvent = { seq: 1, event_type: 'tool.completed', timestamp: 1, source: 'x', agent_id: AGENT_1_ID, payload: big }
    expect(eventRow(event)).toBe(eventRow(event))
  })

  it('shows loops as the agent’s parallel sessions in runtime diagnostics and never identity values', () => {
    const lines = text(runtimeLines({
      agentId: AGENT_1_ID, status: undefined,
      adapters: { agentId: AGENT_1_ID, configured: [], states: [] }, mcp: { agentId: AGENT_1_ID, configured: [], states: [] },
      triggers: { agentId: AGENT_1_ID, displayState: null, configured: [{ type: 'on_timer', enabled: true, targetCount: 1, targets: [{ scope: 'agent', loop: 'consolidator' } as never] }] },
      ws: { configured: [], active: [] },
    }, [
      { info: { name: 'main', goal: 'talks to the owner', status: 'idle', enabled: true, isMain: true, config: null, entryCount: 5, effectiveTools: null } as never },
      { info: { name: 'consolidator', goal: 'Consolidate memories', status: 'running', enabled: true, isMain: false, config: null, entryCount: 2, effectiveTools: ['loop_send'] } as never, executorState: 'thinking' },
    ]))
    expect(lines).toContain('Loops (parallel chat sessions of this agent)')
    expect(lines).toMatch(/consolidator\s+thinking\s+yes\s+2\s+1\s+Consolidate memories/)
    expect(lines).toMatch(/on_timer\s+yes\s+1\s+consolidator/)
    const ids = text(identityLines({ agentId: AGENT_1_ID, identities: [{ purpose: 'adapter:telegram:BOT_TOKEN', encrypted: true, code_access: false }] }))
    expect(ids).toContain('adapter:telegram:BOT_TOKEN')
    expect(ids).toContain('Values are never shown')
  })
})

describe('config edit', () => {
  it('validates edited text against the agent schema', async () => {
    const original = validConfig(AGENT_1_ID, 'agent-1') as never
    expect((await checkConfigText('{ nope', original)).ok).toBe(false)
    const invalid = await checkConfigText(JSON.stringify({ ...validConfig(AGENT_1_ID, 'agent-1'), adf_version: '9' }), original)
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.errors.join(' ')).toContain('adf_version')
    const ok = await checkConfigText(JSON.stringify({ ...validConfig(AGENT_1_ID, 'agent-1'), instructions: 'New instructions.' }), original)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.changedKeys).toEqual(['instructions'])
    const renamed = await checkConfigText(JSON.stringify({ ...validConfig(AGENT_1_ID, 'agent-1'), name: 'agent-9' }), original)
    if (renamed.ok) expect(renamed.warnings.join(' ')).toContain('name changes')
  })

  it('resolves the editor from ADF_EDITOR, VISUAL, EDITOR, then the platform default', () => {
    expect(resolveEditor({ EDITOR: 'nano', VISUAL: 'code --wait' }, 'linux')).toEqual(['code', '--wait'])
    expect(resolveEditor({ ADF_EDITOR: 'hx', EDITOR: 'nano' }, 'linux')).toEqual(['hx'])
    expect(resolveEditor({}, 'win32')).toEqual(['notepad'])
    expect(resolveEditor({ PATH: '' }, 'darwin')).toEqual(['vi'])
  })
})

describe('inspect view against the mock daemon', () => {
  let mock: MockDaemon
  let fixture: InspectFixture
  let store: TuiStore
  let theme: Theme
  let ui: RenderedTui | null = null

  beforeEach(async () => {
    mock = await startMockDaemon({ stepMs: 5 })
    fixture = createInspectFixture(mock.url)
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: fixture.fetch }) })
  })

  afterEach(async () => {
    ui?.unmount()
    ui = null
    store.stop()
    await mock.close()
  })

  async function mount(size: { columns?: number; rows?: number } = { columns: 130, rows: 36 }) {
    theme = createTheme({ mono: true })
    ui = renderTui(<App store={store} theme={theme} />, size)
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

  /** Move focus to the main pane and let the view re-render before keys arrive. */
  async function focusMain() {
    store.actions.setFocus('main')
    await new Promise(resolve => setTimeout(resolve, 60))
  }

  /** Resolve the next confirm dialog with `answer` (drives actions.confirm without keys). */
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

  it('tails every agent\u2019s events in Runtime and filters them by type and loop; Inspect keeps to its agent', async () => {
    const tui = await mount()
    await slash(tui, '/events')
    await tui.waitFor('Umbilical')
    expect(store.getState().activeView).toBe('runtime')
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { name: 'fs_write', id: 'tu_9' } })
    mock.emit({ event_type: 'turn.completed', agent_id: AGENT_2_ID, payload: { content: 'done' } })
    await tui.waitFor(f => f.includes('fs_write') && f.includes('turn.completed'))
    expect(tui.lastFrame()).toMatch(/agent-1\s+consolidator\s+tool\.started/)

    await focusMain()
    await tui.press('t')
    await tui.waitFor('type filter')
    await tui.type('tool.')
    await tui.press(KEY.enter)
    // Closing the filter input toggles bracketed paste off, a bare escape write; nudge a re-render.
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, loop: 'consolidator', payload: { name: 'fs_write', id: 'tu_9' } })
    await tui.waitFor(f => f.includes('type: tool.') && f.includes('tool.completed') && !f.includes('turn.completed'))

    // Loop filter: only the selected agent's selected loop.
    store.actions.selectLoop(AGENT_1_ID, 'main')
    await tui.press('l')
    await tui.waitFor(f => f.includes('No event matches'))
    store.actions.selectLoop(AGENT_1_ID, 'consolidator')
    await tui.waitFor('fs_write')

    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('event_type: tool.completed') && f.includes('loop: consolidator'))
    expect(readRuntimeState(store.getState()).events).toMatchObject({ types: 'tool.', loop: 'selected' })

    // Inspect › Events: the selected agent only (agent-2's event never shows).
    await slash(tui, '/inspect events')
    await tui.waitFor(f => f.includes('Umbilical') && f.includes('agent-1'))
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_2_ID, payload: { name: 'other_agent_tool' } })
    mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { name: 'own_tool' } })
    await tui.waitFor('own_tool')
    expect(tui.lastFrame()).not.toContain('other_agent_tool')
    expect(tui.lastFrame()).not.toContain('a agent')
  }, 15000)

  it('keeps the selection on its event while older events drop off, and End follows again', async () => {
    const tui = await mount({ columns: 130, rows: 30 })
    await slash(tui, '/events')
    for (let i = 0; i < 40; i++) mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { name: `tool_${i}` } })
    await tui.waitFor('tool_39')
    await focusMain()
    for (let i = 0; i < 5; i++) await tui.press(KEY.up)
    await tui.waitFor('scrolled')
    for (let i = 40; i < 60; i++) mock.emit({ event_type: 'tool.started', agent_id: AGENT_1_ID, payload: { name: `tool_${i}` } })
    await tui.waitFor('60/60 events')
    // Scrolled up: new events do not move the view.
    expect(tui.lastFrame()).not.toContain('tool_59')
    expect(tui.lastFrame()).toContain('tool_34')
    await tui.press(KEY.end)
    await tui.waitFor(f => f.includes('tool_59') && f.includes('following'))
  }, 15000)

  it('walks the agent tabs: status, config, usage, MCP, adapters, identities (no secrets)', async () => {
    const tui = await mount()
    await slash(tui, '/inspect status')
    await tui.waitFor('Loops (parallel chat sessions of this agent)')
    expect(tui.lastFrame()).toMatch(/on_timer\s+yes\s+1\s+consolidator/)
    expect(tui.lastFrame()).toContain('agent-1 ›')
    await focusMain()

    await tui.press(KEY.right)
    await tui.waitFor(f => f.includes('model_id: mock-model') && f.includes('loops: main + consolidator, researcher'))

    await tui.press(KEY.right)
    await tui.waitFor(f => f.includes('mock-small') && f.includes('5,490'))

    await tui.press(KEY.right)
    await tui.waitFor(f => f.includes('files-server') && f.includes('connected') && f.includes('listening on stdio'))

    await tui.press(KEY.right)
    await tui.waitFor(f => f.includes('telegram') && f.includes('chat_id'))
    expect(tui.lastFrame()).not.toContain('tg-adapter-secret-4')
    expect(tui.lastFrame()).toContain(REDACTED)

    await tui.press(KEY.right)
    await tui.waitFor('adapter:telegram:BOT_TOKEN')
    expect(tui.lastFrame()).toContain('Values are never shown')

    await slash(tui, '/json on')
    await slash(tui, '/inspect config')
    await tui.waitFor('"model_id": "mock-model"')
  }, 15000)

  it('follows the agent log tail and browses table rows', async () => {
    const tui = await mount()
    await slash(tui, '/inspect logs')
    await tui.waitFor(f => f.includes('files-server restarted') && f.includes('following'))
    fixture.addLog('consolidator merged 2 notes')
    await tui.waitFor('consolidator merged 2 notes', 5000)

    await slash(tui, '/inspect tables')
    await tui.waitFor('local_standings')
    await focusMain()
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('rows 1-3 of 3') && f.includes('north') && f.includes('south'))
    await tui.press(KEY.down)
    await tui.press(KEY.enter)
    await tui.waitFor('team: south')
    await tui.press(KEY.esc)
    await tui.press(KEY.esc)
    await tui.waitFor('local_notes')
  }, 15000)

  it('opens the daemon pages as Runtime tabs with secrets redacted', async () => {
    const tui = await mount()
    await slash(tui, '/status')
    await tui.waitFor(f => f.includes('health') && f.includes('pid') && f.includes('1h 2m'))
    expect(store.getState().activeView).toBe('runtime')
    expect(tui.lastFrame()).toMatch(/agent-1\s+\S+\s+main, consolidator, researcher/)
    expect(tui.lastFrame()).toContain('daemon ›')

    await slash(tui, '/settings')
    await tui.waitFor('All settings (secrets redacted)')
    expect(tui.lastFrame()).not.toContain('sk-settings-secret-2')
    await slash(tui, '/json on')
    await tui.waitFor('"settings"')
    expect(tui.lastFrame()).not.toContain('sk-settings-secret-2')
    expect(tui.lastFrame()).not.toContain('ghp-env-secret-3')

    await slash(tui, '/providers')
    await tui.waitFor('"agentUsage"')
    expect(tui.lastFrame()).not.toContain('sk-provider-secret-1')
    await slash(tui, '/json off')
    await tui.waitFor('What each agent uses')

    await slash(tui, '/usage')
    await tui.waitFor(f => f.includes('Daemon: by model') && f.includes('This TUI session'))
    expect(tui.lastFrame()).not.toContain('agent-1: by model')

    await slash(tui, '/network')
    await tui.waitFor(f => f.includes('Agents on the mesh') && f.includes('m mesh on/off'))

    // Sign-in is a Runtime tab too; Enter opens the sign-in dialog.
    await slash(tui, '/runtime sign-in')
    await tui.waitFor('Subscription sign-ins')
    await focusMain()
    await tui.press(KEY.enter)
    await tui.waitFor(f => f.includes('Provider sign-in') && f.includes('signed in as owner@example.test'))
    await tui.press(KEY.esc)

    // Tabs slide at 80 columns so the active one is always visible.
    tui.resize(80, 24)
    await slash(tui, '/runtime events')
    await tui.waitFor(f => f.includes('Events') && f.includes('Umbilical'))
  }, 20000)

  it('switches themes live and edits config through the validated edit flow', async () => {
    const tui = await mount()
    await slash(tui, '/theme adf-light')
    await tui.waitFor('Theme: ADF light')
    expect(theme.name).toBe('adf-light')
    expect(theme.mono).toBe(false)
    await slash(tui, '/theme mono')
    await tui.waitFor('Theme: Mono')
    expect(theme.mono).toBe(true)
    await slash(tui, '/theme')
    await tui.waitFor('Color theme')
    await tui.press(KEY.esc)

    // First edit is broken JSON (asks to edit again), second changes the instructions.
    const edits = ['{ broken', JSON.stringify({ ...validConfig(AGENT_1_ID, 'agent-1'), instructions: 'Tidy notes daily.' })]
    const off = answerConfirms([true, true])
    const outcome = await editConfigFlow(AGENT_1_ID, 'agent-1', store.actions, async cb => { await cb() }, async text => {
      const next = edits.shift() ?? text
      return { text: next, changed: next !== text, editor: 'test-editor' }
    })
    off()
    expect(outcome).toBe('saved')
    expect(fixture.configPuts).toHaveLength(1)
    expect(fixture.configPuts[0].body.instructions).toBe('Tidy notes daily.')
    await tui.waitFor('saved (instructions)')
  }, 15000)
})

void React
