/**
 * Daemon-mode registration against the channel map (design D2, §12 item 1):
 * every channel the map gives a daemon-mode handler has one, every push
 * channel has a bridge mapping, and every handler not written yet fails
 * visibly with the workstream that writes it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub, helpLabels } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { CHANNEL_MAP, type ChannelEntry, type MappedChannel } from '../../src/main/backend/channel-map'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { REGISTERED_OUTSIDE, registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { DAEMON_MODE_HANDLERS } from '../../src/main/backend/daemon-mode/handlers'
import { FRAME_CHANNELS, PUSH_TOPICS } from '../../src/main/backend/daemon-mode/event-bridge'
import { DAEMON_MODE_UNAVAILABLE } from '../../src/main/backend/daemon-mode/errors'
import { channelKey, pendingWorkstream } from '../../src/main/backend/daemon-mode/pending'

const entries = Object.entries(CHANNEL_MAP) as Array<[MappedChannel, ChannelEntry]>
const BASE = 'http://127.0.0.1:47385'
const TOKEN = 'a'.repeat(43)

let dir: string
let handle: DaemonModeHandle
const daemon = createFakeDaemon(BASE)
const session = createFakeClientSession()
const logs: string[] = []
// Boot records Studio as a lease-registry client (not a runtime host), so `adf daemon start` does not refuse it.
const clientRegistrations: unknown[][] = []
const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-'))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect: async () => ({ baseUrl: BASE, logFile: join(dir, 'logs', 'adf-daemon.log'), description: 'the fake daemon', source: { token: () => TOKEN } }),
    leases: { registerClient: async (...args) => { clientRegistrations.push(args) } },
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

describe('daemon-mode boot', () => {
  it('registers Studio as a local lease-registry client, not a runtime host', () => {
    expect(clientRegistrations).toEqual([['local', expect.objectContaining({ settingsPath: join(dir, 'adf-settings.json') })]])
  })
})

describe('daemon-mode handler registration (D2)', () => {
  it('registers every invoke and send channel except those registered outside the backend', () => {
    const missing: string[] = []
    for (const [channel, entry] of entries) {
      const outside = REGISTERED_OUTSIDE.includes(channel)
      if (entry.kind === 'invoke') {
        if (outside) expect(electronStub.handlers.has(channel), `${channel} is registered in main/index.ts`).toBe(false)
        else if (!electronStub.handlers.has(channel)) missing.push(channel)
      }
      if (entry.kind === 'send' && !electronStub.listeners.has(channel)) missing.push(channel)
    }
    expect(missing).toEqual([])
    // Every proxied and remote-variant channel in particular.
    for (const [channel, entry] of entries) {
      if ((entry.class === 'proxied' || entry.class === 'remote-variant' || entry.class === 'remote-unsupported') && entry.kind === 'invoke') {
        expect(electronStub.handlers.has(channel), channel).toBe(true)
      }
    }
  })

  it('every REGISTERED_OUTSIDE channel is a local invoke channel', () => {
    for (const channel of REGISTERED_OUTSIDE) {
      expect(CHANNEL_MAP[channel].class).toBe('local')
      expect(CHANNEL_MAP[channel].kind).toBe('invoke')
    }
  })

  it('splits registered channels into implemented and pending, each pending one naming its workstream', () => {
    const pending = new Set(handle.pending.map((p) => p.channel))
    for (const channel of handle.registered) {
      const implemented = !!DAEMON_MODE_HANDLERS[channel]
      expect(implemented !== pending.has(channel), channel).toBe(true)
    }
    for (const { workstream } of handle.pending) expect(workstream).toMatch(/^W[1-4]-[A-E]$/)
    // Implemented handlers are only for channels the map routes through daemon-mode registration.
    for (const channel of Object.keys(DAEMON_MODE_HANDLERS) as MappedChannel[]) {
      expect(CHANNEL_MAP[channel].kind, channel).toBe('invoke')
      expect(REGISTERED_OUTSIDE.includes(channel), channel).toBe(false)
    }
  })

  it('a pending handler throws a visible error naming its workstream, and never reads embedded state', async () => {
    // Any pending channel will do; the W3 workstreams shrink the list.
    const pending = handle.pending.find((p) => p.channel !== IPC.BACKGROUND_AGENT_STATUS)!
    expect(pending.workstream).toBe(pendingWorkstream(pending.channel))
    const fn = electronStub.handlers.get(pending.channel)!
    await expect(Promise.resolve().then(() => fn({}))).rejects.toMatchObject({
      code: DAEMON_MODE_UNAVAILABLE,
      message: `${channelKey(pending.channel)} is not available in daemon mode yet: ${pending.workstream}`,
    })
  })

  it('every push channel the map feeds from the client stream has a bridge mapping', () => {
    const topicChannels = new Map(Object.entries(PUSH_TOPICS).map(([topic, route]) => [`push:${topic}`, route.channel]))
    for (const [channel, entry] of entries) {
      if (entry.kind !== 'push' || entry.class === 'local') continue
      expect(entry.frame, channel).toBeTruthy()
      if (entry.frame === 'executor' || entry.frame === 'host') {
        expect((FRAME_CHANNELS as readonly string[]).includes(channel), channel).toBe(true)
      } else {
        expect(topicChannels.get(entry.frame!), `${channel} ← ${entry.frame}`).toBe(channel)
      }
    }
    // And every topic route names a push channel of the map with that frame.
    for (const [topic, route] of Object.entries(PUSH_TOPICS)) {
      if (route.focusedAgentEvent) continue
      // Topics with no Studio push run an action or name why there is none.
      if (route.channel === null) {
        expect(route.action ?? route.none, topic).toBeTruthy()
        continue
      }
      const entry = CHANNEL_MAP[route.channel as MappedChannel]
      expect(entry.kind, topic).toBe('push')
      expect(entry.frame, topic).toBe(`push:${topic}`)
    }
  })

  it('adds "Open Daemon Log" to the Help menu', () => {
    expect(helpLabels(electronStub)).toEqual(['ADF Studio Documentation', '<separator>', 'Open Daemon Log'])
  })

  it('local handlers answer without the daemon, as embedded does', async () => {
    expect(electronStub.handlers.get(IPC.APP_GET_VERSION)!({})).toBe('9.9.9')
    electronStub.handlers.get(IPC.APP_SET_BADGE_COUNT)!({}, -2)
    expect(electronStub.calls.at(-1)).toEqual({ api: 'app.setBadgeCount', args: [0] })
    expect(await electronStub.handlers.get(IPC.DOC_SET_CHAT)!({})).toEqual({ success: true })
    expect(await electronStub.handlers.get(IPC.IDENTITY_PASSWORD_SET)!({})).toMatchObject({ success: false })
  })

  it('sends the daemon token in requests and never logs it', async () => {
    await electronStub.handlers.get(IPC.APPROVALS_LIST)!({})
    const approvals = daemon.requests.filter((r) => r.path === '/approvals')
    expect(approvals.length).toBeGreaterThan(0)
    expect(approvals.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('SETTINGS_SET splits the patch: backend keys to PATCH /settings, client keys to studio-client-settings.json', async () => {
    daemon.routes.set('PATCH /settings', ({ body }) => ({ settings: body }))
    daemon.routes.set('GET /settings', () => ({ filePath: 'x', settings: { meshEnabled: true, theme: 'light', providers: [] } }))
    expect(await electronStub.handlers.get(IPC.SETTINGS_SET)!({}, { theme: 'dark', meshEnabled: true })).toEqual({ success: true })
    const patch = daemon.requests.filter((r) => r.method === 'PATCH' && r.path === '/settings').at(-1)
    expect(patch?.body).toEqual({ meshEnabled: true })
    await handle.clientSettings.flush()
    const view = await electronStub.handlers.get(IPC.SETTINGS_GET)!({}) as Record<string, unknown>
    expect(view.theme).toBe('dark')
    expect(view.meshEnabled).toBe(true)
  })

  it('TOOLS_DESCRIPTIONS folds the tools of the open agent into the daemon catalog', async () => {
    const AGENT = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'
    daemon.routes.set('GET /agents', () => [{ id: AGENT, filePath: join(dir, 'agent-1.adf'), name: 'agent-1', autostart: false }])
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => ({ id: AGENT, filePath: join(dir, 'agent-1.adf'), name: 'agent-1', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set('GET /files/agent', () => ({ filePath: join(dir, 'agent-1.adf'), agentId: AGENT, loaded: true, tracked: false }))
    daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: false, unlocked: false }))
    daemon.routes.set('GET /runtime/tools/descriptions', () => ({ fs_read: { name: 'fs_read', description: 'built-in', input_schema: {} } }))
    daemon.routes.set(`GET /agents/${AGENT}/tools`, () => ({ agentId: AGENT, tools: [
      { name: 'fs_read', description: 'agent copy', schema: { type: 'object' } },
      { name: 'mcp_acme_search', description: 'Search', schema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'declared_only', description: '', schema: {} },
    ] }))
    expect(await electronStub.handlers.get(IPC.FILE_OPEN)!({}, { filePath: join(dir, 'agent-1.adf') })).toEqual({ success: true, filePath: join(dir, 'agent-1.adf'), agentWasRunning: true })
    expect(await electronStub.handlers.get(IPC.TOOLS_DESCRIPTIONS)!({})).toEqual({
      fs_read: { name: 'fs_read', description: 'built-in', input_schema: {} },
      mcp_acme_search: { name: 'mcp_acme_search', description: 'Search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
    })
    await electronStub.handlers.get(IPC.FILE_CLOSE)!({})
  })
})

describe('daemon-mode handlers: review fixes', () => {
  const AGENT = '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01'

  it('AGENT_INVOKE ends with a visible error when the daemon does not come back', async () => {
    daemon.routes.set('GET /files/agent', () => ({ filePath: join(dir, 'agent-1.adf'), agentId: AGENT, loaded: true, tracked: false }))
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => ({ id: AGENT, filePath: join(dir, 'agent-1.adf'), name: 'agent-1', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: false, unlocked: false }))
    daemon.routes.set(`POST /agents/${AGENT}/chat`, () => ({ status: 202, body: { accepted: true, turnId: 'turn_lost' } }))
    await electronStub.handlers.get(IPC.FILE_OPEN)!({}, { filePath: join(dir, 'agent-1.adf') })
    const result = Promise.resolve(electronStub.handlers.get(IPC.AGENT_INVOKE)!({}, { userMessage: 'hi' }))
    await new Promise((r) => setTimeout(r, 20))
    handle.bridge.failTurns('disconnected')
    expect(await result).toEqual({ success: false, error: expect.stringContaining('connection to the ADF daemon was lost') })
    await electronStub.handlers.get(IPC.FILE_CLOSE)!({})
  })

  it('W2-A routes: DOC_GET_BATCH and DOC_GET_HEADER in the embedded shape; AGENT_INVOKE sends content blocks as they are', async () => {
    daemon.routes.set('GET /files/agent', () => ({ filePath: join(dir, 'agent-1.adf'), agentId: AGENT, loaded: true, tracked: false }))
    daemon.routes.set(`GET /agents/${AGENT}/status`, () => ({ id: AGENT, filePath: join(dir, 'agent-1.adf'), name: 'agent-1', autostart: false, runtimeState: 'idle', targetState: null, loopCount: 0 }))
    daemon.routes.set(`GET /agents/${AGENT}/identity/password`, () => ({ agentId: AGENT, needsPassword: false, unlocked: false }))
    const header = { agentId: AGENT, document: '# doc', agentConfig: { id: AGENT, name: 'agent-1' }, statusText: 'busy' }
    daemon.routes.set(`GET /agents/${AGENT}/header`, () => header)
    daemon.routes.set(`GET /agents/${AGENT}/batch`, () => ({ ...header, lastTokens: { input: 5 }, contextBaseline: 42, chat: { version: 1, uiLog: [{ role: 'user' }], llmMessages: [], earlierCount: 3, total: 4 } }))
    daemon.routes.set(`POST /agents/${AGENT}/chat`, () => ({ status: 202, body: { accepted: true, turnId: 'turn_blocks' } }))
    await electronStub.handlers.get(IPC.FILE_OPEN)!({}, { filePath: join(dir, 'agent-1.adf') })
    expect(await electronStub.handlers.get(IPC.DOC_GET_HEADER)!({})).toEqual({ document: '# doc', agentConfig: header.agentConfig, statusText: 'busy' })
    expect(await electronStub.handlers.get(IPC.DOC_GET_BATCH)!({})).toEqual({
      document: '# doc', agentConfig: header.agentConfig, lastTokens: { input: 5 }, contextBaseline: 42, statusText: 'busy',
      chat: { version: 1, uiLog: [{ role: 'user' }], llmMessages: [], earlierCount: 3 },
    })
    const content = [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]
    const result = Promise.resolve(electronStub.handlers.get(IPC.AGENT_INVOKE)!({}, { content, userMessage: 'ignored' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(daemon.requests.filter((r) => r.path === `/agents/${AGENT}/chat` && r.method === 'POST').at(-1)?.body).toEqual({ content })
    handle.bridge.failTurns('disconnected')
    await result
    await electronStub.handlers.get(IPC.FILE_CLOSE)!({})
  })

  it('a pending channel warns once, and BACKGROUND_AGENT_STATUS announces the running agents', async () => {
    logs.length = 0
    // Not the channel the test above already called (it warned then).
    const called = handle.pending.find((p) => p.channel !== IPC.BACKGROUND_AGENT_STATUS)!.channel
    const channel = handle.pending.find((p) => p.channel !== IPC.BACKGROUND_AGENT_STATUS && p.channel !== called)!.channel
    const fn = electronStub.handlers.get(channel)!
    for (let i = 0; i < 3; i++) await expect(Promise.resolve().then(() => fn({}))).rejects.toThrow('not available in daemon mode yet')
    expect(logs.filter((l) => l.includes(`${channelKey(channel)} was called`))).toHaveLength(1)
    handle.bridge.seed([{ id: 'id-9', filePath: join(dir, 'agent-9.adf'), handle: 'agent-9', runtimeState: 'idle' as never }])
    electronStub.pushes.length = 0
    await expect(Promise.resolve().then(() => electronStub.handlers.get(IPC.BACKGROUND_AGENT_STATUS)!({}))).rejects.toThrow('W3-A')
    await new Promise((r) => setTimeout(r, 10))
    const batch = electronStub.pushes.find((p) => p.channel === IPC.BACKGROUND_AGENT_EVENT_BATCH)
    expect(batch?.args[0]).toEqual([{ type: 'agent_started', payload: { filePath: join(dir, 'agent-9.adf'), state: 'idle', handle: 'agent-9' }, timestamp: expect.any(Number) }])
  })
})
