import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme } from '../../src/main/tui/app/theme'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { mcpSourceRows, parseAddTarget, serverConfigFor, studioOnlyReason, validateMcpForm, credentialNamespace } from '../../src/main/tui/setup/mcp'
import { parseEnvPairs } from '../../src/main/tui/setup/McpDialog'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { createIdentityFetch, type IdentityMockOptions } from './fixtures/identity-daemon'
import { createSetupFetch, type SetupMock, type SetupMockOptions } from './fixtures/setup-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const KEY = { enter: '\r', esc: '\u001b', ctrlS: '\u0013', down: '\u001b[B', space: ' ' }
const SECRET = 'BSA-0123456789abcdefghijklmnop'

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

async function mount(options: { identity?: IdentityMockOptions; setup?: SetupMockOptions } = {}): Promise<{ tui: RenderedTui; setup: SetupMock; store: TuiStore }> {
  mock = await startMockDaemon({ stepMs: 5 })
  const identity = createIdentityFetch(mock, options.identity ?? {})
  const setup = createSetupFetch(options.setup ?? {}, identity.fetch)
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: setup.fetch }) })
  ui = renderTui(<App store={store} theme={createTheme({ mono: true })} />, { columns: 120, rows: 34 })
  await store.start()
  return { tui: ui, setup, store }
}

async function slash(tui: RenderedTui, text: string) {
  store!.actions.prefillPrompt('')
  await tui.waitFor(() => store!.getState().focus === 'input')
  await new Promise(resolve => setTimeout(resolve, 40))
  await tui.type(text)
  await tui.waitFor(text)
  await tui.press(KEY.enter)
}

describe('mcp model', () => {
  it('parses add targets: catalog, npm/python prefixes, URLs', () => {
    expect(parseAddTarget('brave-search').row?.entry?.npmPackage).toBe('@brave/brave-search-mcp-server')
    expect(parseAddTarget('npm:@modelcontextprotocol/server-everything')).toMatchObject({ row: { kind: 'npm' }, value: '@modelcontextprotocol/server-everything' })
    expect(parseAddTarget('python:mcp-server-fetch')).toMatchObject({ row: { kind: 'python' }, value: 'mcp-server-fetch' })
    expect(parseAddTarget('https://example.test/mcp')).toMatchObject({ row: { kind: 'http' }, value: 'https://example.test/mcp' })
    expect(parseAddTarget('https://mcp.notion.com/mcp').row?.entry?.name).toBe('notion-remote')
    expect(mcpSourceRows().slice(0, 3).map(r => r.kind)).toEqual(['npm', 'python', 'http'])
  })

  it('builds Studio-shaped configs with agent-scoped keys and no secret values', () => {
    const brave = parseAddTarget('brave-search').row!
    const cfg = serverConfigFor(brave, { name: 'brave-search', source: '', args: '', runOn: 'container', env: { BRAVE_API_KEY: SECRET } })
    expect(cfg).toMatchObject({ name: 'brave-search', transport: 'stdio', npm_package: '@brave/brave-search-mcp-server', env_keys: ['BRAVE_API_KEY'] })
    expect(cfg.run_location).toBeUndefined()
    expect(JSON.stringify(cfg)).not.toContain(SECRET)
    expect(credentialNamespace(cfg)).toBe('@brave/brave-search-mcp-server')
    const http = serverConfigFor(parseAddTarget('https://example.test/mcp').row!, { name: 'example', source: 'https://example.test/mcp', args: '', runOn: 'container', env: { MCP_TOKEN: 't' } })
    expect(http).toMatchObject({ transport: 'http', url: 'https://example.test/mcp', bearer_token_env_var: 'MCP_TOKEN', env_keys: ['MCP_TOKEN'] })
    const host = serverConfigFor(parseAddTarget('npm:x-server').row!, { name: 'x', source: 'x-server', args: '--port 3', runOn: 'host', env: {} })
    expect(host).toMatchObject({ run_location: 'host', args: ['--port', '3'] })
    expect(studioOnlyReason(parseAddTarget('notion-remote').row!)).toContain('OAuth')
    expect(validateMcpForm(brave, { name: 'brave-search', source: '', args: '', runOn: 'container', env: {} }, ['brave-search'])).toEqual({ name: 'This agent already has a server named brave-search.', 'env:BRAVE_API_KEY': 'BRAVE_API_KEY is required.' })
    expect(parseEnvPairs('A=1 B="two words" bad')).toEqual([['A', '1'], ['B', 'two words']])
    expect(parseEnvPairs("C='x y'")).toEqual([['C', 'x y']])
  })
})

describe('/mcp', () => {
  it('adds an npm server: install, attach, connect, tools — visible step by step', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/mcp add npm:@modelcontextprotocol/server-everything')
    await tui.waitFor(f => f.includes('npm package · agent-1') && f.includes('everything'))
    await tui.press(KEY.ctrlS)
    const frame = await tui.waitFor(f => f.includes('Connecting everything') && f.includes('3 tools'))
    expect(frame).toContain('✓ Installing @modelcontextprotocol/server-everything (npm)')
    expect(frame).toContain('✓ Attaching everything to agent-1')
    expect(setup.installed).toEqual(['npm @modelcontextprotocol/server-everything'])
    expect(setup.calls).toEqual(['POST /admin/mcp/packages/npm', `POST /agents/${AGENT_1_ID}/mcp/servers`, `POST /agents/${AGENT_1_ID}/mcp/servers/everything/restart`])
    expect(setup.mcpServers.get(AGENT_1_ID)?.[0]).toMatchObject({ name: 'everything', transport: 'stdio', npm_package: '@modelcontextprotocol/server-everything' })
  }, 15000)

  it('catalog server with a key: masked, sealed under mcp:<package>:<KEY>, never in the config', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/mcp add brave-search')
    await tui.waitFor('BRAVE_API_KEY')
    await tui.press(KEY.down) // name → runs on
    await tui.press(KEY.down) // → BRAVE_API_KEY (no args field: the entry takes none)
    await tui.type(SECRET)
    await tui.waitFor(`${SECRET.length} chars`)
    await tui.press(KEY.ctrlS)
    await tui.waitFor(f => f.includes('3 tools') && f.includes('Sealing 1 credential'))
    expect(setup.mcpCredentials.get(AGENT_1_ID)?.get('mcp:@brave/brave-search-mcp-server:BRAVE_API_KEY')).toBe(SECRET)
    expect(JSON.stringify(setup.mcpServers.get(AGENT_1_ID))).not.toContain(SECRET)
    expect(setup.mcpServers.get(AGENT_1_ID)?.[0]).toMatchObject({ env_keys: ['BRAVE_API_KEY'] })
    for (const f of tui.frames) expect(f).not.toContain(SECRET)
  }, 15000)

  it('validates, and routes to the identity dialog before sealing credentials', async () => {
    const { tui, setup, store } = await mount({ identity: { status: 'none' } })
    await slash(tui, '/mcp add brave-search')
    await tui.waitFor('BRAVE_API_KEY')
    await tui.press(KEY.ctrlS)
    await tui.waitFor('BRAVE_API_KEY is required.')
    await tui.press(KEY.down)
    await tui.press(KEY.down)
    await tui.type(SECRET)
    await tui.press(KEY.ctrlS)
    await tui.waitFor(() => store.getState().overlays.some(o => o.kind === 'identity'))
    expect(store.getState().overlays.find(o => o.kind === 'identity')?.props).toMatchObject({ then: 'mcp', thenProps: { agentId: AGENT_1_ID, add: 'brave-search' } })
    expect(setup.calls).toEqual([])
  }, 15000)

  it('OAuth-only remote servers point to Studio', async () => {
    const { tui, setup } = await mount()
    await slash(tui, '/mcp add notion-remote')
    await tui.waitFor('signs in with OAuth in the browser')
    expect(setup.calls).toEqual([])
  }, 15000)

  it('lists servers with state; details, logs, tool toggles, restart and remove', async () => {
    const { tui, setup } = await mount({ setup: { mcp: { 'agent-1': [{ name: 'github', transport: 'stdio', npm_package: '@modelcontextprotocol/server-github', env_keys: ['GITHUB_TOKEN'] }, { name: 'broken', transport: 'stdio', command: 'nope' }] } } })
    await slash(tui, '/mcp')
    let frame = await tui.waitFor(f => f.includes('MCP servers · agent-1') && f.includes('github') && f.includes('spawn failed'))
    expect(frame).toMatch(/github\s+● connected\s+3 tools\s+container/)
    await tui.press(KEY.enter)
    frame = await tui.waitFor('npm @modelcontextprotocol/server-github')
    expect(frame).toContain('GITHUB_TOKEN')
    expect(frame).toContain('3 on / 3')
    await tui.press('t')
    await tui.waitFor('[✓] search')
    await tui.press(KEY.space)
    await tui.waitFor('[ ] search')
    expect(setup.mcpTools.get(AGENT_1_ID)?.find(t => t.name === 'mcp_github_search')?.enabled).toBe(false)
    await tui.press(KEY.esc)
    await tui.press('l')
    await tui.waitFor('github listening on stdio')
    await tui.press(KEY.esc)
    await tui.press('d')
    await tui.waitFor('Remove github from agent-1?')
    await tui.press('y')
    await tui.waitFor(f => f.includes('MCP servers · agent-1') && !f.includes('server-github'))
    expect(setup.calls).toContain(`DELETE /agents/${AGENT_1_ID}/mcp/servers/github`)

    // restart a failing one: the error and stderr are shown
    await tui.press('r')
    await tui.waitFor(f => f.includes('spawn failed: command not found') && f.includes('sh: server: not found'))
  }, 20000)

  it('Inspect › MCP: a adds, m manages', async () => {
    const { tui, store } = await mount()
    await slash(tui, '/inspect mcp')
    await tui.waitFor('a add · m manage')
    store.actions.setFocus('main')
    await new Promise(resolve => setTimeout(resolve, 60))
    await tui.press('a')
    await tui.waitFor('Add an MCP server · agent-1')
  }, 15000)
})
