// Agent websites: the mesh web server's link per serving agent (Fleet row /
// details, Inspect › Status, the chat info line), w opens it in the browser,
// W copies it, a stopped server says so and starts on w; the header badge,
// /web on|off and the palette toggle the server (stopping asks).

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { setAuthFlowSeams } from '../../src/main/tui/auth/flow'
import { setClipboardWriter } from '../../src/main/tui/views/chat/model'
import { linkHost, parseLan, parseMeshAgents, parseServer, servedText, siteOf } from '../../src/main/tui/web/model'
import { AGENT_1_ID, AGENT_2_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', tab: '\t' }

let mock: MockDaemon
let store: TuiStore
let ui: RenderedTui | null = null
let opened: string[] = []
let copied: string[] = []

async function setup(web?: Parameters<typeof startMockDaemon>[0]['web']) {
  mock = await startMockDaemon({ stepMs: 5, web })
}

beforeEach(() => {
  opened = []
  copied = []
  setAuthFlowSeams({ openBrowser: url => { opened.push(url) } })
  setClipboardWriter(async text => { copied.push(text); return true })
})

afterEach(async () => {
  ui?.unmount()
  ui = null
  store?.stop()
  await mock?.close()
  setAuthFlowSeams(null)
  setClipboardWriter(null)
})

async function mount(view = 'fleet', size: { columns?: number; rows?: number } = { columns: 130, rows: 34 }) {
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), initialView: view })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, size)
  await store.start()
  await ui.waitFor(f => f.includes('agent-1') && f.includes('live'))
  store.actions.selectAgent(AGENT_1_ID)
  store.actions.setFocus('main')
  return ui
}

describe('web model', () => {
  it('parses the daemon answers and derives the site link', () => {
    expect(parseServer({ running: true, port: 7301, host: '0.0.0.0' })).toEqual({ running: true, port: 7301, host: '0.0.0.0' })
    expect(parseServer({ error: 'nope' })).toBeNull()
    expect(parseLan({ addresses: { hostname: 'h', addresses: [{ address: '10.0.0.5', family: 'IPv4' }, { address: 'fe80::1', family: 'IPv6' }] } })).toEqual(['10.0.0.5'])
    expect(parseMeshAgents([{ agentId: 'a', handle: 'agent-1', publicEnabled: true, apiRouteCount: 2, sharedCount: 0, status: ' busy ' }]))
      .toEqual({ a: { handle: 'agent-1', publicEnabled: true, apiRoutes: 2, sharedCount: 0, status: 'busy' } })
    // A wildcard bind is reached at loopback locally, at the daemon's host remotely.
    expect(linkHost('0.0.0.0', 'http://127.0.0.1:7385')).toBe('127.0.0.1')
    expect(linkHost('0.0.0.0', 'http://box.lan:7385')).toBe('box.lan')
    expect(linkHost('127.0.0.1', 'http://box.lan:7385')).toBe('127.0.0.1')
  })

  it('uses the actual bound port, adds LAN links on a 0.0.0.0 bind, and shows nothing for an agent that serves nothing', () => {
    const agents = {
      [AGENT_1_ID]: { summary: { id: AGENT_1_ID, handle: 'agent-1', name: 'agent-1' }, config: { serving: { public: { enabled: true }, api: [{ method: 'WS', path: '/live', lambda: 'x' }] } } },
      [AGENT_2_ID]: { summary: { id: AGENT_2_ID, handle: 'agent-2', name: 'agent-2' }, config: { serving: { public: { enabled: false }, api: [] } } },
    } as never
    const state = { agents, daemonUrl: 'http://127.0.0.1:7385', web: { server: { running: true, port: 7302, host: '0.0.0.0' }, lan: ['192.168.1.20'], agents: {}, at: 0 } }
    const site = siteOf(state, AGENT_1_ID)!
    expect(site.url).toBe('http://127.0.0.1:7302/agents/agent-1/')
    expect(site.lanUrls).toEqual(['http://192.168.1.20:7302/agents/agent-1/'])
    expect(servedText(site)).toBe('public/ (index.html) · 1 API route incl. 1 WS')
    expect(siteOf(state, AGENT_2_ID)).toBeNull()
    const stopped = siteOf({ ...state, web: { ...state.web, server: { running: false, port: 7302, host: '127.0.0.1' } } }, AGENT_1_ID)!
    expect(stopped.url).toBeNull()
  })
})

describe('agent websites', () => {
  beforeEach(async () => { await setup() })

  it('Fleet shows the link and what is served; w opens it in the browser, W copies it', async () => {
    const tui = await mount()
    const frame = await tui.waitFor('web  http://127.0.0.1:7295/agents/agent-1/')
    expect(frame).toContain('public/ (index.html) · 2 API routes incl. 1 WS')
    expect(frame).toContain('● web :7295')
    await tui.press('w')
    await tui.waitFor('Opening http://127.0.0.1:7295/agents/agent-1/')
    expect(opened).toEqual(['http://127.0.0.1:7295/agents/agent-1/'])
    await tui.press('W')
    await tui.waitFor('Copied http://127.0.0.1:7295/agents/agent-1/')
    expect(copied).toEqual(['http://127.0.0.1:7295/agents/agent-1/'])
    // agent-2 serves nothing: no web line, and w says so instead of opening anything.
    store.actions.selectAgent(AGENT_2_ID)
    const other = await tui.waitFor(f => !f.includes('web  http'))
    expect(other).not.toContain('server stopped')
    await tui.press('w')
    await tui.waitFor('agent-2 serves nothing on the web')
    expect(opened).toHaveLength(1)
  })

  it('Inspect › Status leads with the website; the chat info line carries it compactly', async () => {
    const tui = await mount('inspect')
    let frame = await tui.waitFor('Website')
    expect(frame).toMatch(/url\s+http:\/\/127\.0\.0\.1:7295\/agents\/agent-1\//)
    expect(frame).toMatch(/serves\s+public\/ \(index\.html\) · 2 API routes incl\. 1 WS/)
    expect(frame).toContain('running on 127.0.0.1:7295 (this machine only)')
    await tui.press('w')
    await tui.waitFor('Opening http://127.0.0.1:7295/agents/agent-1/')
    store.actions.setView('chat')
    frame = await tui.waitFor('web 127.0.0.1:7295/agents/agent-1/')
    expect(frame).toContain('host ✓')
  })

  it('refreshes when a config change turns serving off, and back on', async () => {
    const tui = await mount()
    await tui.waitFor('web  http://127.0.0.1:7295/agents/agent-1/')
    const agent = mock.agents.get(AGENT_1_ID)!
    const serving = agent.serving
    agent.serving = undefined
    mock.emit({ event_type: 'config.changed', agent_id: AGENT_1_ID, payload: { changed_keys: ['serving'] } })
    await tui.waitFor(f => !f.includes('web  http'), 4000)
    agent.serving = serving
    mock.emit({ event_type: 'config.changed', agent_id: AGENT_1_ID, payload: { changed_keys: ['serving'] } })
    await tui.waitFor('web  http://127.0.0.1:7295/agents/agent-1/', 4000)
  })

  it('the header badge toggles the server: a click stops it after asking, /web on starts it without asking', async () => {
    const tui = await mount()
    const frame = await tui.waitFor('● web :7295')
    const row = frame.split('\n')[0]
    const x = row.indexOf('● web :7295')
    tui.raw(`\u001b[<0;${x + 2};1M`)
    await tui.waitFor('Stop the web server')
    await tui.press('y')
    await tui.waitFor('Web server stopped')
    expect(mock.web.running).toBe(false)
    await tui.waitFor('○ web off')
    await tui.waitFor('web server stopped — start it')
    await tui.press('/')
    await tui.type('web on')
    await tui.press(KEY.enter)
    await tui.waitFor('agent sites are up')
    expect(mock.web.running).toBe(true)
    await tui.waitFor('● web :7295')
  })
})

describe('web server stopped', () => {
  beforeEach(async () => { await setup({ running: false }) })

  it('says so where the link would be; w starts the server (no confirm) and then opens the site', async () => {
    const tui = await mount()
    const frame = await tui.waitFor('web server stopped — start it (w)')
    expect(frame).toContain('○ web off')
    await tui.press('w')
    await tui.waitFor('Opening http://127.0.0.1:7295/agents/agent-1/')
    expect(mock.web.running).toBe(true)
    expect(opened).toEqual(['http://127.0.0.1:7295/agents/agent-1/'])
  })

  it('Runtime › Network lists agent websites and s starts the server', async () => {
    const tui = await mount('runtime')
    store.actions.setViewState('runtime', { tab: 'network' })
    let frame = await tui.waitFor('Agent websites (1)')
    expect(frame).toContain('agent-1')
    expect(frame).toContain('web server stopped — start it')
    await tui.press('s')
    await tui.waitFor('agent sites are up')
    frame = await tui.waitFor('http://127.0.0.1:7295/agents/agent-1/')
    expect(mock.web.running).toBe(true)
  })

  it('binding to every interface adds the LAN link', async () => {
    mock.web.host = '0.0.0.0'
    mock.web.running = true
    const tui = await mount('inspect')
    const frame = await tui.waitFor('lan      http://192.168.1.20:7295/agents/agent-1/')
    expect(frame).toContain('running on all interfaces, port 7295 (LAN too)')
  })
})
