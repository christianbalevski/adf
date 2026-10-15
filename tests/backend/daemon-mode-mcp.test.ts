/**
 * W3-C daemon-mode handlers (MCP, adapters, sandbox packages, skills,
 * registries) against a scripted daemon: answers in the embedded handlers'
 * shapes, installs as jobs with their progress pushes, credential values
 * kept in the daemon, the connect test's interactive steps, and the
 * mcp_oauth_authorize opener.
 *
 * The install progress pushes come from the client stream's install
 * topics, as the daemon publishes them (the tests play the daemon's frames
 * while its job runs); the relay (mcp/install-progress.ts) only sends an end
 * the stream lost, with its own unit tests below.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { InstallProgressRelay } from '../../src/main/backend/daemon-mode/mcp/install-progress'
import { McpOAuthAuthorizeOpener } from '../../src/main/backend/daemon-mode/mcp/oauth-authorize'
import { awaitDaemonJob } from '../../src/main/backend/daemon-mode/mcp/jobs'
import { DaemonClient } from '../../src/shared/daemon-client'
import { IPC } from '../../src/shared/constants/ipc-channels'
import type { PendingNotification } from '../../src/shared/types/ipc.types'

const BASE = 'http://127.0.0.1:47385'
const TOKEN = 'a'.repeat(43)
const FILE = 'C:/agents/agent-2.adf'

let dir: string
let handle: DaemonModeHandle
const daemon = createFakeDaemon(BASE)
const session = createFakeClientSession()
const logs: string[] = []
const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } }
const openExternal = vi.fn(async (_url: string) => {})

function invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = electronStub.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn({}, ...args)) as Promise<T>
}

/**
 * A job route: answers 202, then `views` one poll at a time (the last one
 * repeats). `frames[i]` are the install pushes the daemon publishes on the
 * client stream before poll i answers.
 */
function scriptJob(startRoute: string, jobId: string, views: Array<Record<string, unknown>>, frames: Array<Array<{ topic: string; payload: unknown }>> = []): Array<unknown> {
  const bodies: unknown[] = []
  daemon.routes.set(startRoute, ({ body }) => { bodies.push(body); return { status: 202, body: { jobId, job: { id: jobId, kind: 'k', state: 'running', createdAt: 1 } } } })
  let i = 0
  daemon.routes.set(`GET /jobs/${jobId}`, () => {
    for (const f of frames[i] ?? []) session.listener!.onFrame({ kind: 'push', topic: f.topic as never, agentId: null, filePath: null, payload: f.payload })
    return { id: jobId, kind: 'k', createdAt: 1, ...views[Math.min(i++, views.length - 1)] }
  })
  return bodies
}

const pushesOf = (channel: string) => electronStub.pushes.filter((p) => p.channel === channel).map((p) => p.args[0])

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-mcp-'))
  ;(electronStub.module.shell as { openExternal: unknown }).openExternal = openExternal
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect: async () => ({ baseUrl: BASE, logFile: join(dir, 'adf-daemon.log'), description: 'the fake daemon', source: { token: () => TOKEN } }),
    leases: { registerClient: async () => {} },
    fetch: daemon.fetch,
    createSession: () => session,
    log,
  })
  expect(await handle.ready).toBe(true)
})

afterAll(async () => {
  await handle.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  electronStub.pushes.length = 0
  electronStub.calls.length = 0
  daemon.requests.length = 0
  openExternal.mockClear()
})

describe('installs run as daemon jobs, with embedded progress pushes', () => {
  it('MCP_INSTALL_PACKAGE: invalid arguments answer as embedded, no request, no push', async () => {
    expect(await invoke(IPC.MCP_INSTALL_PACKAGE, { package: '' })).toEqual({ success: false, error: 'Invalid arguments: String must contain at least 1 character(s), Required' })
    expect(daemon.requests).toEqual([])
    expect(electronStub.pushes).toEqual([])
  })

  it('MCP_INSTALL_PACKAGE: progress lines, then installed, then the answer', async () => {
    const installed = { package: '@acme/server', version: '1.0.0', command: '/x', installPath: '/x', installedAt: 1 }
    const bodies = scriptJob('POST /admin/mcp/packages/npm/jobs', 'job-npm', [
      { state: 'running' },
      { state: 'succeeded', result: { success: true, installed } },
    ], [
      [{ topic: 'mcp_install', payload: { package: '@acme/server', status: 'installing', progress: 'Installing @acme/server...' } }],
      [
        { topic: 'mcp_install', payload: { package: '@acme/server', status: 'installing', progress: 'Installed @acme/server@1.0.0' } },
        { topic: 'mcp_install', payload: { package: '@acme/server', status: 'installed' } },
      ],
    ])
    expect(await invoke(IPC.MCP_INSTALL_PACKAGE, { package: '@acme/server', name: 'acme' })).toEqual({ success: true, installed })
    expect(bodies).toEqual([{ package: '@acme/server' }])
    expect(pushesOf(IPC.MCP_INSTALL_PROGRESS)).toEqual([
      { package: '@acme/server', status: 'installing', progress: 'Installing @acme/server...' },
      { package: '@acme/server', status: 'installing', progress: 'Installed @acme/server@1.0.0' },
      { package: '@acme/server', status: 'installed' },
    ])
  })

  it('a failed install answers String(error) and pushes the error', async () => {
    scriptJob('POST /admin/adapters/packages/jobs', 'job-adapter', [{ state: 'succeeded', result: { success: false, error: 'Error: Invalid npm package name: x y' } }],
      [[{ topic: 'adapter_install', payload: { package: 'x y', status: 'error', error: 'Error: Invalid npm package name: x y' } }]])
    expect(await invoke(IPC.ADAPTER_INSTALL_PACKAGE, { package: 'x y' })).toEqual({ success: false, error: 'Error: Invalid npm package name: x y' })
    expect(pushesOf(IPC.ADAPTER_INSTALL_PROGRESS)).toEqual([{ package: 'x y', status: 'error', error: 'Error: Invalid npm package name: x y' }])
  })

  it('a daemon that cannot start the install: the error answer and its push', async () => {
    daemon.routes.set('POST /admin/mcp/packages/python/jobs', () => ({ status: 503, body: { error: 'MCP Python package service is not configured.', code: 'unavailable' } }))
    expect(await invoke(IPC.MCP_INSTALL_PYTHON_PACKAGE, { package: 'mcp-x', name: 'x' })).toEqual({ success: false, error: 'Error: MCP Python package service is not configured.' })
    expect(pushesOf(IPC.MCP_INSTALL_PROGRESS)).toEqual([{ package: 'mcp-x', status: 'error', error: 'Error: MCP Python package service is not configured.' }])
  })

  it('SANDBOX_INSTALL_PACKAGES: one end push per package, in order', async () => {
    const results = { 'left-pad': { success: true, version: '1.3.0' }, 'bad!': { success: false, error: 'Error: Invalid npm package name: bad!' } }
    const bodies = scriptJob('POST /admin/sandbox/packages/jobs', 'job-sandbox', [{ state: 'succeeded', result: { success: true, results } }], [[
      { topic: 'sandbox_install', payload: { package: 'left-pad', status: 'installed' } },
      { topic: 'sandbox_install', payload: { package: 'bad!', status: 'error', error: 'Error: Invalid npm package name: bad!' } },
    ]])
    const packages = [{ name: 'left-pad', version: '1.3.0' }, { name: 'bad!', version: '1.0.0' }]
    expect(await invoke(IPC.SANDBOX_INSTALL_PACKAGES, packages)).toEqual({ success: true, results })
    expect(bodies).toEqual([{ packages }])
    expect(pushesOf(IPC.SANDBOX_INSTALL_PROGRESS)).toEqual([
      { package: 'left-pad', status: 'installed' },
      { package: 'bad!', status: 'error', error: 'Error: Invalid npm package name: bad!' },
    ])
  })

  it('MCP_ENSURE_PYTHON_RUNTIME answers the job result', async () => {
    const result = { success: true, uvAvailable: true, uvVersion: '0.5.1', pythonAvailable: true, uvPath: '/bin/uv' }
    scriptJob('POST /admin/mcp/python-runtime', 'job-uv', [{ state: 'running' }, { state: 'succeeded', result }])
    expect(await invoke(IPC.MCP_ENSURE_PYTHON_RUNTIME)).toEqual(result)
  })
})

describe('credential values: local mode reads them, a remote daemon never sends them', () => {
  it('local MCP_CREDENTIAL_GET: the values through the reveal route, as embedded reads them', async () => {
    daemon.routes.set('POST /files/agent/identity/reveal', ({ query, body }) => {
      expect(query).toEqual({ path: FILE })
      expect(body).toEqual({ prefix: 'mcp:@acme/server:' })
      return { values: { 'mcp:@acme/server:API_KEY': 'k-1', 'mcp:@acme/server:EMPTY': '' } }
    })
    expect(await invoke(IPC.MCP_CREDENTIAL_GET, { filePath: FILE, npmPackage: '@acme/server' })).toEqual({ credentials: { API_KEY: 'k-1', EMPTY: '' } })
    expect(await invoke(IPC.MCP_CREDENTIAL_GET, { filePath: FILE })).toEqual({ credentials: {} })
    daemon.routes.set('POST /files/agent/identity/reveal', () => ({ status: 403, body: { error: 'this request lacks the local proof', code: 'forbidden' } }))
    expect(await invoke(IPC.MCP_CREDENTIAL_GET, { filePath: FILE, npmPackage: '@acme/server' })).toEqual({ credentials: {}, error: 'Error: this request lacks the local proof' })
  })

  it('local MCP_CREDENTIAL_SET writes what it is given, a literal placeholder too (as embedded); a refusal reads without a prefix', async () => {
    const bodies: unknown[] = []
    daemon.routes.set('PUT /files/agent/mcp/credentials', ({ body }) => { bodies.push(body); return { success: true } })
    expect(await invoke(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: 'k-1' })).toEqual({ success: true })
    expect(await invoke(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: '__redacted__' })).toEqual({ success: true })
    expect(bodies).toEqual([
      { npmPackage: '@acme/server', envKey: 'API_KEY', value: 'k-1' },
      { npmPackage: '@acme/server', envKey: 'API_KEY', value: '__redacted__' },
    ])
    daemon.routes.set('PUT /files/agent/mcp/credentials', () => ({ status: 409, body: { error: 'The credentials envelope of this agent is locked on this daemon.', code: 'credentials_locked' } }))
    expect(await invoke(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: 'k-1' }))
      .toEqual({ success: false, error: 'The credentials envelope of this agent is locked on this daemon.' })
  })

  it('local ADAPTER_CREDENTIAL_GET: the readable values, and every stored key', async () => {
    daemon.routes.set('GET /files/agent/adapters/credentials', () => ({ credentials: { BOT_TOKEN: { present: true, locked: false }, OLD: { present: true, locked: true } } }))
    daemon.routes.set('POST /files/agent/identity/reveal', ({ body }) => {
      expect(body).toEqual({ prefix: 'adapter:telegram:' })
      return { values: { 'adapter:telegram:BOT_TOKEN': '123:abc' } }
    })
    expect(await invoke(IPC.ADAPTER_CREDENTIAL_GET, { filePath: FILE, adapterType: 'telegram' })).toEqual({ credentials: { BOT_TOKEN: '123:abc' }, storedKeys: ['BOT_TOKEN', 'OLD'] })
    await expect(invoke(IPC.ADAPTER_CREDENTIAL_GET, { filePath: FILE })).rejects.toThrow()
  })

  describe('remote mode', () => {
    /** The W3-C handlers with a remote-mode context on the scripted daemon (no second registration). */
    const remote = async (handler: string, args: unknown) => {
      const { MCP_HANDLERS } = await import('../../src/main/backend/daemon-mode/handlers/mcp')
      const { ADAPTER_HANDLERS } = await import('../../src/main/backend/daemon-mode/handlers/adapters')
      const client = new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch })
      const ctx = { mode: 'remote', ready: async () => client, log } as unknown as Parameters<NonNullable<typeof MCP_HANDLERS[typeof IPC.MCP_CREDENTIAL_GET]>>[0]
      const fn = (MCP_HANDLERS as Record<string, unknown>)[handler] ?? (ADAPTER_HANDLERS as Record<string, unknown>)[handler]
      return (fn as (c: unknown, e: unknown, a: unknown) => Promise<unknown>)(ctx, {}, args)
    }
    const stored = () => daemon.routes.set('GET /files/agent/mcp/credentials', () => ({ credentials: { API_KEY: { present: true, locked: false }, SEALED: { present: true, locked: true } } }))

    it('MCP_CREDENTIAL_GET answers __redacted__ for each readable value and never asks for values', async () => {
      stored()
      expect(await remote(IPC.MCP_CREDENTIAL_GET, { filePath: FILE, npmPackage: '@acme/server' })).toEqual({ credentials: { API_KEY: '__redacted__' } })
      expect(daemon.requests.some((r) => r.path === '/files/agent/identity/reveal')).toBe(false)
    })

    it('MCP_CREDENTIAL_SET: the untouched placeholder of a stored key keeps it; an edited one, or one under an unstored (renamed) key, is refused', async () => {
      stored()
      const bodies: unknown[] = []
      daemon.routes.set('PUT /files/agent/mcp/credentials', ({ body }) => { bodies.push(body); return { success: true } })
      expect(await remote(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: '__redacted__' })).toEqual({ success: true })
      expect(await remote(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: '__redacted__abc' })).toEqual({
        success: false,
        error: 'The value of API_KEY was shown as a placeholder (a remote ADF daemon never sends stored values), so an edit of it cannot be saved. Clear the field and type the whole value.',
      })
      expect(await remote(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'RENAMED_KEY', value: '__redacted__' })).toEqual({
        success: false,
        error: 'RENAMED_KEY has no stored value to keep: a remote ADF daemon never sends stored values, so its field showed a placeholder. Type the value for RENAMED_KEY.',
      })
      // Exact placeholder only (W4-B): a backspaced or mid-edited placeholder is refused too, never saved as the secret.
      for (const edited of ['__redacted_', '__redac', '__redaXcted__', '__redcted__', 'x__redacted__']) {
        expect(await remote(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: edited }), edited).toMatchObject({ success: false, error: expect.stringMatching(/shown as a placeholder/) })
      }
      expect(await remote(IPC.MCP_CREDENTIAL_SET, { filePath: FILE, npmPackage: '@acme/server', envKey: 'API_KEY', value: 'k-2' })).toEqual({ success: true })
      expect(bodies).toEqual([{ npmPackage: '@acme/server', envKey: 'API_KEY', value: 'k-2' }])
    })

    it('ADAPTER_CREDENTIAL_GET names the stored keys and sends no values', async () => {
      daemon.routes.set('GET /files/agent/adapters/credentials', () => ({ credentials: { BOT_TOKEN: { present: true, locked: false } } }))
      expect(await remote(IPC.ADAPTER_CREDENTIAL_GET, { filePath: FILE, adapterType: 'telegram' })).toEqual({ credentials: {}, storedKeys: ['BOT_TOKEN'] })
      expect(daemon.requests.some((r) => r.path === '/files/agent/identity/reveal')).toBe(false)
    })
  })
})

describe('attach and detach on agent files', () => {
  it('MCP_ATTACH_SERVER sends the entry embedded builds; MCP_DETACH_SERVER the namespace', async () => {
    const bodies: unknown[] = []
    daemon.routes.set('POST /files/agent/mcp/servers', ({ body, query }) => { bodies.push({ body, query }); return { success: true, alreadyAttached: false } })
    expect(await invoke(IPC.MCP_ATTACH_SERVER, { filePath: FILE, serverConfig: { name: 'acme', type: 'npm', npmPackage: '@acme/server', envKeys: ['API_KEY'] } }))
      .toEqual({ success: true, alreadyAttached: false })
    expect(bodies).toEqual([{ query: { path: FILE }, body: { server: expect.objectContaining({ name: 'acme', transport: 'stdio', npm_package: '@acme/server', source: 'npm:@acme/server' }) } }])
    daemon.routes.set('DELETE /files/agent/mcp/servers/acme', ({ query }) => { expect(query).toEqual({ path: FILE, credentialNamespace: '@acme/server' }); return { success: true } })
    expect(await invoke(IPC.MCP_DETACH_SERVER, { filePath: FILE, serverName: 'acme', credentialNamespace: '@acme/server' })).toEqual({ success: true })
  })

  it('ADAPTER_ATTACH: on stays as it is, off is turned on with its policy, new gets the config', async () => {
    const posted: unknown[] = []
    let adapters: Record<string, unknown> = {}
    daemon.routes.set('GET /files/agent/config', () => ({ filePath: FILE, agentId: 'a2', loaded: false, config: { id: 'a2', adapters } }))
    daemon.routes.set('POST /files/agent/adapters', ({ body }) => { posted.push(body); return { success: true, alreadyAttached: false } })
    const config = { enabled: true, policy: { dm: 'all' } }
    adapters = { telegram: { enabled: true, policy: { dm: 'allowlist' } } }
    expect(await invoke(IPC.ADAPTER_ATTACH, { filePath: FILE, adapterType: 'telegram', config })).toEqual({ success: true, alreadyAttached: true, enabled: true })
    expect(posted).toEqual([])
    adapters = { telegram: { enabled: false, policy: { dm: 'allowlist', allow_from: ['42'] } } }
    expect(await invoke(IPC.ADAPTER_ATTACH, { filePath: FILE, adapterType: 'telegram', config })).toEqual({ success: true, alreadyAttached: true, enabled: true })
    expect(posted.at(-1)).toEqual({ adapterType: 'telegram', config: { enabled: true, policy: { dm: 'allowlist', allow_from: ['42'] } } })
    adapters = {}
    expect(await invoke(IPC.ADAPTER_ATTACH, { filePath: FILE, adapterType: 'telegram', config: { enabled: false } })).toEqual({ success: true, enabled: false })
    expect(posted.at(-1)).toEqual({ adapterType: 'telegram', config: { enabled: false } })
  })

  it('ADAPTER_UNINSTALL_PACKAGE removes the registration from settings.adapters', async () => {
    daemon.routes.set('DELETE /admin/adapters/packages', () => ({ success: true }))
    daemon.routes.set('GET /settings', () => ({ settings: { adapters: [{ type: 'slack', npmPackage: '@adf/slack' }, { type: 'x', npmPackage: '@adf/x' }] } }))
    const patches: unknown[] = []
    daemon.routes.set('PATCH /settings', ({ body }) => { patches.push(body); return { success: true } })
    expect(await invoke(IPC.ADAPTER_UNINSTALL_PACKAGE, { package: '@adf/slack' })).toEqual({ success: true })
    expect(patches).toEqual([{ adapters: [{ type: 'x', npmPackage: '@adf/x' }] }])
  })

  it('ADAPTER_RESTART without a path and no running open agent says no agent is open', async () => {
    daemon.routes.set('POST /fleet/adapters/restart', () => ({ success: false, error: 'No agent is open, so there is no channel to restart.' }))
    expect(await invoke(IPC.ADAPTER_RESTART, { type: 'telegram' })).toEqual({ success: false, error: 'No agent is open, so there is no channel to restart.' })
  })
})

describe('the open agent and registries', () => {
  it('without an open agent: no servers, no manager, cached logs', async () => {
    expect(await invoke(IPC.MCP_GET_SERVER_STATUS)).toEqual({ servers: [] })
    expect(await invoke(IPC.MCP_RESTART_SERVER, { name: 'acme' })).toEqual({ success: false, error: 'No MCP manager active' })
    daemon.routes.set('GET /admin/mcp/logs/acme', ({ query }) => { expect(query).toEqual({}); return { logs: [{ timestamp: 1, stream: 'stderr', message: 'hi' }] } })
    expect(await invoke(IPC.MCP_GET_SERVER_LOGS, { name: 'acme' })).toEqual({ logs: [{ timestamp: 1, stream: 'stderr', message: 'hi' }] })
    expect(await invoke(IPC.MCP_GET_SERVER_LOGS, {})).toEqual({ logs: [] })
  })

  it('AGENT_MODEL_SET_FOR_FILE refuses in embedded order and words', async () => {
    expect(await invoke(IPC.AGENT_MODEL_SET_FOR_FILE, { filePath: 'C:/x/notes.txt', model: { provider: 'p', model_id: 'm' } })).toEqual({ success: false, error: 'No such file' })
    daemon.routes.set('GET /files/agent', ({ query }) => query.path === FILE
      ? { filePath: FILE, agentId: 'a2', loaded: false, tracked: true }
      : { status: 404, body: { error: 'path does not exist', code: 'not_found' } })
    expect(await invoke(IPC.AGENT_MODEL_SET_FOR_FILE, { filePath: 'C:/x/missing.adf', model: { provider: 'p', model_id: 'm' } })).toEqual({ success: false, error: 'No such file' })
    expect(await invoke(IPC.AGENT_MODEL_SET_FOR_FILE, { filePath: FILE })).toEqual({ success: false, error: 'Missing model' })
    daemon.routes.set('PUT /files/agent/model', () => ({ status: 409, body: { error: 'Stop the agent before changing its model', code: 'agent_running' } }))
    expect(await invoke(IPC.AGENT_MODEL_SET_FOR_FILE, { filePath: FILE, model: { provider: 'p', model_id: 'm' } })).toEqual({ success: false, error: 'Stop the agent before changing its model' })
    daemon.routes.set('PUT /files/agent/model', ({ body }) => { expect(body).toEqual({ model: { provider: 'p', model_id: 'm' } }); return { success: true } })
    expect(await invoke(IPC.AGENT_MODEL_SET_FOR_FILE, { filePath: FILE, model: { provider: 'p', model_id: 'm' } })).toEqual({ success: true })
  })

  it('AGENT_REGISTRY_BRING_HOME: missing id refused locally; a copy is a recent file', async () => {
    expect(await invoke(IPC.AGENT_REGISTRY_BRING_HOME, { id: '' })).toEqual({ success: false, error: 'Missing registry id' })
    daemon.routes.set('POST /registry/agents/ash/bring-home', () => ({ success: true, filePath: 'C:/agents/ash.adf' }))
    expect(await invoke(IPC.AGENT_REGISTRY_BRING_HOME, { id: 'ash' })).toEqual({ success: true, filePath: 'C:/agents/ash.adf' })
    expect(electronStub.calls).toContainEqual({ api: 'app.addRecentDocument', args: ['C:/agents/ash.adf'] })
  })

  it('SANDBOX_CHECK_MISSING: a failure answers every package as missing', async () => {
    daemon.routes.set('POST /admin/sandbox/packages/check', () => ({ status: 503, body: { error: 'Sandbox package service is not configured.', code: 'unavailable' } }))
    const packages = [{ name: 'lodash', version: '4.17.21' }]
    expect(await invoke(IPC.SANDBOX_CHECK_MISSING, packages)).toEqual({ success: false, error: 'Error: Sandbox package service is not configured.', missing: packages })
  })
})

describe('MCP_REGISTRATION_TEST interactive steps', () => {
  it('opens the authorization page, shows the Continue dialog, answers both, and resolves with the job result', async () => {
    const result = { success: true, tools: [{ name: 'search' }], location: 'host', authRan: true, oauthRan: false, notes: [] }
    const bodies = scriptJob('POST /admin/mcp/registration-test', 'job-test', [{ state: 'running' }, { state: 'running' }, { state: 'running' }, { state: 'succeeded', result }])
    const interactions = [
      { id: 'i-1', jobId: 'job-test', kind: 'open_url', state: 'pending', serverName: 'gh', url: 'https://auth.example.test/authorize?x=1', message: 'm', createdAt: 1 },
      { id: 'i-2', jobId: 'job-test', kind: 'confirm', state: 'pending', serverName: 'gh', authUrlOpened: true, message: 'm', createdAt: 2 },
    ]
    daemon.routes.set('GET /admin/mcp/interactions', ({ query }) => { expect(query).toEqual({ jobId: 'job-test' }); return { interactions } })
    const answered: string[] = []
    daemon.routes.set('POST /admin/mcp/interactions/i-1/continue', () => { answered.push('i-1'); return { success: true } })
    daemon.routes.set('POST /admin/mcp/interactions/i-2/continue', () => { answered.push('i-2'); interactions.length = 0; return { success: true } })
    const args = { registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', auth: true } }
    expect(await invoke(IPC.MCP_REGISTRATION_TEST, args)).toEqual(result)
    expect(bodies).toEqual([args])
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.test/authorize?x=1')
    expect(answered.sort()).toEqual(['i-1', 'i-2'])
    const box = electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')?.args[0] as Record<string, unknown>
    expect(box).toMatchObject({
      type: 'info',
      title: 'MCP Authorization — gh',
      message: 'Complete authorization in your browser, then click Continue.',
      detail: 'An authorization page has been opened in your browser for "gh". Complete the authorization flow, then click Continue.',
      buttons: ['Continue'],
      defaultId: 0,
    })
  })

  it('a refused start (429, too many jobs) answers a failed result, not a rejection', async () => {
    daemon.routes.set('POST /admin/mcp/registration-test', () => ({ status: 429, body: { error: 'Too many jobs are running on this daemon (128); try again when some have finished.', code: 'too_many_jobs' } }))
    expect(await invoke(IPC.MCP_REGISTRATION_TEST, { registration: { name: 'r', type: 'http', url: 'https://mcp.example.test/mcp' } })).toEqual({
      success: false, tools: [], location: 'remote http', authRan: false, notes: [],
      error: 'Error: Too many jobs are running on this daemon (128); try again when some have finished.',
    })
  })

  it('a daemon that restarted mid-test (404 on the job) answers a failed result saying so', async () => {
    daemon.routes.set('POST /admin/mcp/registration-test', () => ({ status: 202, body: { jobId: 'gone', job: { id: 'gone', state: 'running' } } }))
    daemon.routes.set('GET /jobs/gone', () => ({ status: 404, body: { error: 'No such job', code: 'not_found' } }))
    daemon.routes.set('GET /admin/mcp/interactions', () => ({ interactions: [] }))
    const answer = await invoke(IPC.MCP_REGISTRATION_TEST, { registration: { name: 'r', type: 'http', url: 'https://mcp.example.test/mcp' } })
    expect(answer).toMatchObject({ success: false, tools: [], location: 'remote http', authRan: false, notes: [] })
    expect(answer.error).toMatch(/no longer knows the MCP connect test/)
  })
})

describe('InstallProgressRelay', () => {
  it('sends nothing while the stream delivers; after a gap, the end the stream lost (after the grace)', async () => {
    const sent: unknown[] = []
    const relay = new InstallProgressRelay((_c, p) => { sent.push(p) }, { log: () => {}, warn: () => {} }, 20, 40)
    const quiet = relay.begin(IPC.MCP_INSTALL_PROGRESS, ['a'])
    relay.observe({ kind: 'push', topic: 'mcp_install', payload: { package: 'a', status: 'installed' } })
    await quiet.finish([{ package: 'a', status: 'installed' }])
    expect(sent).toEqual([])

    const lost = relay.begin(IPC.MCP_INSTALL_PROGRESS, ['b'])
    relay.onGap()
    await lost.finish([{ package: 'b', status: 'error', error: 'Error: boom' }])
    expect(sent).toEqual([{ package: 'b', status: 'error', error: 'Error: boom' }])

    sent.length = 0
    const arrived = relay.begin(IPC.SANDBOX_INSTALL_PROGRESS, ['c'])
    relay.onGap()
    relay.observe({ kind: 'push', topic: 'sandbox_install', payload: { package: 'c', status: 'installed' } })
    await arrived.finish([{ package: 'c', status: 'installed' }])
    expect(sent).toEqual([])

    // No gap, no end yet: the end never arrives within the wait, so it comes from the result.
    const silent = relay.begin(IPC.MCP_INSTALL_PROGRESS, ['d'])
    await silent.finish([{ package: 'd', status: 'installed' }])
    expect(sent).toEqual([{ package: 'd', status: 'installed' }])
  })

  it('the answer waits until the stream delivered the install\'s end push (W4-B review: a remote stream lags the job poll)', async () => {
    const relay = new InstallProgressRelay(() => {}, { log: () => {}, warn: () => {} }, 20, 5_000)
    const watch = relay.begin(IPC.SANDBOX_INSTALL_PROGRESS, ['jimp'])
    let answered = false
    const finished = watch.finish([{ package: 'jimp', status: 'installed' }]).then(() => { answered = true })
    await new Promise((r) => setTimeout(r, 50))
    // The job ended; its progress line and end push are still in flight.
    expect(answered).toBe(false)
    relay.observe({ kind: 'push', topic: 'sandbox_install', payload: { package: 'jimp', status: 'installing', message: 'npm install' } })
    expect(answered).toBe(false)
    relay.observe({ kind: 'push', topic: 'sandbox_install', payload: { package: 'jimp', status: 'installed' } })
    await finished
    expect(answered).toBe(true)
  })

  it('a real end that arrives after the fallback end was sent is dropped, once; a progress line first means another install, which passes (W4-B follow-up)', async () => {
    const sent: unknown[] = []
    const logged: string[] = []
    const relay = new InstallProgressRelay((_c, p) => { sent.push(p) }, { log: (m: string) => { logged.push(m) }, warn: () => {} }, 20, 40)
    const push = (pkg: string, status: string) => ({ kind: 'push' as const, topic: 'mcp_install' as const, payload: { package: pkg, status } })
    await relay.begin(IPC.MCP_INSTALL_PROGRESS, ['slow']).finish([{ package: 'slow', status: 'installed' }])
    expect(sent).toEqual([{ package: 'slow', status: 'installed' }])
    // The stream catches up: its end is not sent again.
    expect(relay.observe(push('slow', 'installed'))).toBe(false)
    expect(logged.some((m) => /slow install's own end \(installed\) arrived .* not sent again/.test(m))).toBe(true)
    // Only that one end: the next pushes of the package pass, as do other packages and topics.
    expect(relay.observe(push('slow', 'installed'))).toBe(true)
    expect(relay.observe(push('other', 'installed'))).toBe(true)
    expect(relay.observe({ kind: 'push', topic: 'adapter_install', payload: { package: 'slow', status: 'installed' } })).toBe(true)

    // Another client's install of the package after the relayed end: its progress line ends the drop, so its end reaches the renderer.
    await relay.begin(IPC.MCP_INSTALL_PROGRESS, ['shared']).finish([{ package: 'shared', status: 'installed' }])
    expect(relay.observe(push('shared', 'installing'))).toBe(true)
    expect(relay.observe(push('shared', 'installed'))).toBe(true)
    expect(logged.some((m) => /progress line of shared after its relayed end: another install/.test(m))).toBe(true)
    sent.splice(0)

    // A new install of the package owns its pushes, even if the old late end never came.
    await relay.begin(IPC.MCP_INSTALL_PROGRESS, ['lost']).finish([{ package: 'lost', status: 'installed' }])
    const again = relay.begin(IPC.MCP_INSTALL_PROGRESS, ['lost'])
    expect(relay.observe(push('lost', 'installed'))).toBe(true)
    await again.finish([{ package: 'lost', status: 'installed' }])
    expect(sent).toHaveLength(1)
  })
})

describe('McpOAuthAuthorizeOpener (mcp_oauth_authorize)', () => {
  const entry = (id: string): PendingNotification => ({
    id, kind: 'approval', requestId: id, filePath: FILE, agentName: 'agent-2', loop: 'main', toolName: 'mcp_oauth_authorize', preview: '', requestedAt: 1,
  })

  it('opens each authorization page once, without a click; requests found at connect stay in the panel', async () => {
    const opened: string[] = []
    const inputs: Record<string, unknown> = {
      seed: { server: 'docs', authorize_url: 'https://auth.example.test/a?s=0' },
      r1: { server: 'docs', url: 'https://mcp.example.test/mcp', authorize_url: 'https://auth.example.test/a?s=1' },
      r2: { server: 'docs', authorize_url: 'https://auth.example.test/a?s=1' },
      bad: { server: 'docs', authorize_url: 'file:///etc/passwd' },
    }
    const opener = new McpOAuthAuthorizeOpener({
      mode: 'local',
      fetchInput: async (_f, id) => inputs[id],
      openExternal: (url) => { opened.push(url) },
      log: { log: () => {}, warn: () => {} },
    })
    await opener.apply({ pending: [entry('seed')], history: [] })
    expect(opened).toEqual([])
    await opener.apply({ pending: [entry('seed'), entry('r1'), { ...entry('x'), toolName: 'fs_write' }], history: [] })
    expect(opened).toEqual(['https://auth.example.test/a?s=1'])
    // The runtime re-raises the request after "opened": same page, not opened again; a resync repeats the snapshot.
    await opener.apply({ pending: [entry('r2')], history: [] })
    await opener.apply({ pending: [entry('r2')], history: [] })
    await opener.apply({ pending: [entry('bad')], history: [] })
    expect(opened).toEqual(['https://auth.example.test/a?s=1'])
  })

  it('remote mode opens the page through the callback relay, never directly (W4-B)', async () => {
    const warnings: string[] = []
    const opened: string[] = []
    const relayed: string[] = []
    const opener = new McpOAuthAuthorizeOpener({
      mode: 'remote',
      fetchInput: async () => ({ server: 'docs', authorize_url: 'https://auth.example.test/a' }),
      openExternal: (url) => { opened.push(url) },
      openRemote: async (url) => { relayed.push(url); return { opened: true } },
      log: { log: () => {}, warn: (m) => { warnings.push(m) } },
    })
    await opener.apply({ pending: [], history: [] })
    await opener.apply({ pending: [entry('r')], history: [] })
    expect(opened).toEqual([])
    expect(relayed).toEqual(['https://auth.example.test/a'])
    // Without a relay remote mode opens nothing and says why.
    const bare = new McpOAuthAuthorizeOpener({
      mode: 'remote',
      fetchInput: async () => ({ server: 'docs', authorize_url: 'https://auth.example.test/b' }),
      openExternal: (url) => { opened.push(url) },
      log: { log: () => {}, warn: (m) => { warnings.push(m) } },
    })
    await bare.apply({ pending: [], history: [] })
    await bare.apply({ pending: [entry('r2')], history: [] })
    expect(opened).toEqual([])
    expect(warnings[0]).toMatch(/no relay is set up/)
  })

  it('daemon mode wires it to the approvals snapshots: GET /approvals/input for the URL, shell.openExternal to open it', async () => {
    daemon.routes.set('GET /approvals/input', ({ query }) => {
      expect(query).toEqual({ filePath: FILE, approvalId: 'live' })
      return { input: { server: 'docs', authorize_url: 'https://auth.example.test/live' } }
    })
    handle.bridge.handleFrame({ kind: 'push', topic: 'approvals', payload: { pending: [entry('live')], history: [] } })
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://auth.example.test/live'))
  })
})

describe('awaitDaemonJob', () => {
  it('gives up after the daemon stays unreachable; cancels past the deadline', async () => {
    let t = 0
    const unreachable = new DaemonClient({ baseUrl: BASE, fetch: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch })
    const lost = await awaitDaemonJob(async () => unreachable, 'j', { what: 'the test job', deadlineMs: 1e9, unreachableMs: 1000, sleep: async () => { t += 600 }, now: () => t })
    expect(lost).toEqual({ kind: 'lost', reason: 'The ADF daemon could not be reached for 1 s while the test job ran; it may still finish there.' })

    const cancels: string[] = []
    const fake = createFakeDaemon(BASE)
    fake.routes.set('GET /jobs/slow', () => ({ id: 'slow', state: 'running' }))
    fake.routes.set('POST /jobs/slow/cancel', () => { cancels.push('slow'); return { cancelled: true } })
    t = 0
    const slow = new DaemonClient({ baseUrl: BASE, fetch: fake.fetch })
    const timedOut = await awaitDaemonJob(async () => slow, 'slow', { what: 'the slow job', deadlineMs: 60_000, cancelOnDeadline: true, sleep: async () => { t += 30_000 }, now: () => t })
    expect(timedOut).toEqual({ kind: 'lost', reason: 'The slow job did not finish within 1 minutes; Studio cancelled it.' })
    expect(cancels).toEqual(['slow'])

    // A shared (keyed) job: this waiter's deadline ends its wait only; another client may still wait on the job.
    t = 0
    const mine = await awaitDaemonJob(async () => slow, 'slow', { what: 'the shared install', deadlineMs: 60_000, sleep: async () => { t += 30_000 }, now: () => t })
    expect(mine).toEqual({ kind: 'lost', reason: 'The shared install did not finish within 1 minutes; Studio stopped waiting, and it may still finish in the ADF daemon.' })
    expect(cancels).toEqual(['slow'])
  })
})
