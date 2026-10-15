/**
 * Remote mode (tracker W3-B review): stored values never come from a remote
 * daemon. IDENTITY_GET, IDENTITY_REVEAL and PROVIDER_CREDENTIAL_GET are
 * `remote-unsupported` in the channel map: each says so in a sentence the
 * renderer shows, asks the daemon nothing, and Studio sends no local proof.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { CHANNEL_MAP } from '../../src/main/backend/channel-map'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { REMOTE_VALUES_UNSUPPORTED } from '../../src/main/backend/daemon-mode/handlers/providers'

const BASE = 'http://10.0.0.5:7385'
const AGENT = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'
const FILE = join(tmpdir(), 'agents', 'agent-1.adf')

let dir: string
let handle: DaemonModeHandle
const daemon = createFakeDaemon(BASE)
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electronStub.handlers.get(channel)!({}, ...args))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-remote-'))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  handle = registerDaemonModeHandlers({
    mode: 'remote',
    userDataDir: dir,
    connect: async () => ({ baseUrl: BASE, logFile: null, description: 'a remote fake daemon', source: { token: () => 'c'.repeat(43) } }),
    leases: { registerClient: async () => {} },
    fetch: daemon.fetch,
    createSession: () => createFakeClientSession(),
    log: quiet,
  })
  expect(await handle.ready).toBe(true)
})

afterAll(async () => {
  await handle.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('stored values with a remote daemon', () => {
  it('the channel map classes them remote-unsupported', () => {
    for (const channel of [IPC.IDENTITY_GET, IPC.IDENTITY_REVEAL, IPC.PROVIDER_CREDENTIAL_GET]) {
      expect(CHANNEL_MAP[channel].class, channel).toBe('remote-unsupported')
    }
  })

  it('each answers without a value and never asks for one', async () => {
    await handle.session.openFile(FILE, async () => AGENT)
    daemon.requests.length = 0
    daemon.routes.set(`GET /agents/${AGENT}/identity`, ({ query }) => ({ purposes: query.prefix === 'app:token' ? ['app:token'] : [] }))
    expect(await invoke(IPC.IDENTITY_REVEAL, { purpose: 'app:token' })).toEqual({ value: null, reason: REMOTE_VALUES_UNSUPPORTED })
    // IDENTITY_GET: the placeholder for a stored value, null for none (W4-B review: a form that saves what it read keeps the value).
    expect(await invoke(IPC.IDENTITY_GET, { purpose: 'app:token' })).toBe('__redacted__')
    expect(await invoke(IPC.IDENTITY_GET, { purpose: 'app:other' })).toBeNull()
    expect(await invoke(IPC.PROVIDER_CREDENTIAL_GET, { filePath: FILE, providerId: 'p1' })).toEqual({ credentials: {}, error: REMOTE_VALUES_UNSUPPORTED })
    expect(daemon.requests.map((r) => r.path)).toEqual([`/agents/${AGENT}/identity`, `/agents/${AGENT}/identity`])
  })

  it('SETTINGS_GET keeps the app provider key as the placeholder and never asks for it (W5-D3: only local mode reveals it)', async () => {
    daemon.routes.set('GET /settings', () => ({ settings: { providers: [{ id: 'p1', type: 'openai', name: 'OpenAI', baseUrl: '', apiKey: '__redacted__' }] } }))
    daemon.requests.length = 0
    const settings = await invoke(IPC.SETTINGS_GET) as { providers: Array<{ apiKey?: string }> }
    expect(settings.providers[0].apiKey).toBe('__redacted__')
    expect(daemon.requests.map((r) => r.path)).toEqual(['/settings'])
  })

  it('IDENTITY_SET keeps the stored value for the untouched placeholder and refuses an edited one', async () => {
    await handle.session.openFile(FILE, async () => AGENT)
    daemon.requests.length = 0
    expect(await invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: '__redacted__' })).toBeUndefined()
    await expect(invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: '__redacted_' })).rejects.toThrow(/shown as a placeholder/)
    expect(daemon.requests).toEqual([])
  })

  it('a remote request never carries a local proof; owner import does not even send the phrase (W4-B)', async () => {
    daemon.routes.set('POST /identity/import', () => ({ status: 403, body: { error: 'refused', code: 'loopback_only' } }))
    const answer = await invoke(IPC.IDENTITY_OWNER_IMPORT, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about') as { success: boolean; error: string }
    expect(answer.success).toBe(false)
    expect(answer.error).toMatch(/changed on its machine: run `adf identity restore`/)
    expect(daemon.requests.find((r) => r.path === '/identity/import')).toBeUndefined()
    // Every request this remote session made carries no proof (tests/backend/remote-connector.test.ts covers the local-only routes).
    for (const request of daemon.requests) expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain('x-adf-local-proof')
  })
})
