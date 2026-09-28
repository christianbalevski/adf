// /model (argument or picker; main → agent config, inner loop → its override
// or inherit), /config (Inspect › Config, `edit` → $EDITOR), and the chat info
// line (host access, status line, schedule without timer ids, priorities).

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { modelIds, parseModelArg, providerChoices } from '../../src/main/tui/views/inspect/model-picker'
import { fitInfoSegments, formatNextFire, wakesText } from '../../src/main/tui/views/chat/model'
import { readInspectState } from '../../src/main/tui/views/inspect/state'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', down: '\u001b[B' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null

beforeEach(async () => {
  mock = await startMockDaemon({ stepMs: 5 })
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: 'chat' })
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
  await ui.waitFor(f => f.includes('agent-1') && f.includes('live'))
  store.actions.selectAgent(AGENT_1_ID)
  await ui.waitFor('Message agent-1')
  return ui
}

async function slash(tui: RenderedTui, text: string) {
  store.actions.setFocus('input')
  await tui.type(text)
  await tui.press(KEY.enter)
}

describe('model helpers', () => {
  it('reads providers with their access, model lists and [provider/]model arguments', () => {
    const providers = providerChoices([
      { id: 'or', name: 'OpenRouter', type: 'openai-compatible', hasApiKey: true },
      { id: 'sub', name: 'ChatGPT', type: 'chatgpt-subscription', hasApiKey: false },
      { id: 'nokey', name: 'Nokey', type: 'anthropic', hasApiKey: false, baseUrl: 'https://api.example' },
    ], { chatgpt: { authenticated: false } } as never)
    expect(providers.map(p => [p.id, p.access, p.ready])).toEqual([['or', 'key set', true], ['sub', 'not signed in (/login)', false], ['nokey', 'no key', false]])
    expect(modelIds(['a', { id: 'b' }, { name: 'c' }, 7])).toEqual(['a', 'b', 'c'])
    // Model ids contain '/' too: the prefix is a provider only when it names one.
    expect(parseModelArg('or/z-ai/glm-5', providers)).toEqual({ provider: 'or', model: 'z-ai/glm-5' })
    expect(parseModelArg('z-ai/glm-5', providers)).toEqual({ model: 'z-ai/glm-5' })
  })
})

describe('/model', () => {
  it('with an argument changes main’s model in the agent config; the status bar shows it at once', async () => {
    const tui = await mount()
    await slash(tui, '/model mock/mock-large')
    await tui.waitFor('agent-1 now runs mock/mock-large')
    expect(mock.agents.get(AGENT_1_ID)!.model).toBe('mock-large')
    // Only the model moved: the rest of the config (serving) is intact.
    expect(mock.agents.get(AGENT_1_ID)!.serving?.public?.enabled).toBe(true)
    await tui.waitFor(f => f.split('\n').at(-1)!.includes('mock-large'))
  })

  it('no argument opens the picker: provider (access shown, current marked), then model with type-to-filter', async () => {
    const tui = await mount()
    await slash(tui, '/model')
    let frame = await tui.waitFor(f => f.includes('pick a provider') && /Mock\s+key set\s+\(current\)/.test(f))
    expect(frame).toContain('Mock Subscription')
    await tui.press(KEY.enter)
    frame = await tui.waitFor('3 of 3')
    expect(frame).toMatch(/mock-model\s+\(current\)/)
    await tui.type('mini')
    frame = await tui.waitFor('1 of 3')
    expect(frame).not.toContain('mock-large')
    await tui.press(KEY.enter)
    await tui.waitFor('agent-1 now runs mock/mock-mini')
    expect(mock.agents.get(AGENT_1_ID)!.model).toBe('mock-mini')
  })

  it('on an inner loop sets its override, and inherit clears it', async () => {
    const tui = await mount()
    store.actions.selectLoop(AGENT_1_ID, 'researcher')
    await tui.waitFor('Message agent-1 › researcher')
    await slash(tui, '/model mock/mock-large')
    await tui.waitFor('agent-1 › researcher now runs mock/mock-large')
    expect(mock.agents.get(AGENT_1_ID)!.loops.find(l => l.name === 'researcher')!.model?.model_id).toBe('mock-large')
    expect(mock.agents.get(AGENT_1_ID)!.model).toBe('mock-model')
    await slash(tui, '/model inherit')
    await tui.waitFor('inherits the agent’s model again')
    expect(mock.agents.get(AGENT_1_ID)!.loops.find(l => l.name === 'researcher')!.model).toBeUndefined()
  })
})

describe('/config', () => {
  it('opens Inspect › Config; /config edit asks the Config tab to open the editor', async () => {
    const tui = await mount()
    await slash(tui, '/config')
    await tui.waitFor('e edit in $EDITOR')
    expect(store.getState().activeView).toBe('inspect')
    expect(readInspectState(store.getState()).tab).toBe('config')
  })
})

describe('chat info line', () => {
  it('keeps the most important pieces when narrow and shows them in a fixed order', () => {
    const segs = [
      { key: 'status', text: 'A long status line the agent wrote about itself', order: 3, priority: 4, flex: true },
      { key: 'host', text: 'host ✓', order: 2, priority: 2 },
      { key: 'wakes', text: 'wakes every 1h · next 14:30', order: 5, priority: 3 },
      { key: 'web', text: 'web 127.0.0.1:7295/agents/agent-1/', order: 6, priority: 6 },
    ]
    expect(fitInfoSegments(segs, 200).map(s => s.key)).toEqual(['host', 'status', 'wakes', 'web'])
    const narrow = fitInfoSegments(segs, 60)
    expect(narrow.map(s => s.key)).toEqual(['host', 'status', 'wakes'])
    expect(narrow.find(s => s.key === 'status')!.text.endsWith('…')).toBe(true)
    expect(fitInfoSegments(segs, 20).map(s => s.key)).toEqual(['host'])
  })

  it('describes a schedule without the timer id', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime()
    const at = new Date(2026, 8, 28, 14, 30).getTime()
    expect(formatNextFire(at, now)).toBe('14:30')
    expect(wakesText([{ id: 9, schedule: { mode: 'interval', every_ms: 3_600_000 }, next_wake_at: at } as never], now)).toBe('wakes every 1h · next 14:30')
  })

  it('in chat: host ✓ and the agent’s status line, no "main loop" boilerplate', async () => {
    const tui = await mount()
    const frame = await tui.waitFor('Merging API notes into mind.md')
    expect(frame).toContain('host ✓')
    expect(frame).not.toContain('inner loops')
    // The status line follows the agent: a meta write refreshes it.
    mock.agents.get(AGENT_1_ID)!.status = 'Waiting for review'
    mock.emit({ event_type: 'tool.completed', agent_id: AGENT_1_ID, payload: { name: 'sys_set_meta', id: 'tu_x', result: { isError: false }, isError: false } })
    await tui.waitFor('Waiting for review')
  })
})
