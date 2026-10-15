/**
 * Daemon-mode building blocks: the session (D3), the settings split (§4.2)
 * with the client-key migration, credentials, the visible
 * "backend not connected" state, and adf-file://.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub, helpLabels } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { ClientSettingsStore, clientSettingsDefaults, clientSettingsPath, mergeSettingsViews, splitSettingsPatch } from '../../src/main/backend/daemon-mode/settings'
import { createStudioDaemonClient } from '../../src/main/backend/daemon-mode/credentials'
import { DaemonConnection } from '../../src/main/backend/daemon-mode/connection'
import { ConnectionStatusUi, DISCONNECT_DIALOG_COOLDOWN_MS, connectionProblem } from '../../src/main/backend/daemon-mode/status-ui'
import { createAdfFileHandler } from '../../src/main/backend/daemon-mode/adf-file'
import { initApplicationMenu } from '../../src/main/menu'
import { ApprovalsUi } from '../../src/main/backend/daemon-mode/approvals-ui'
import { IPC } from '../../src/shared/constants/ipc-channels'
import type { PendingNotification } from '../../src/shared/types/ipc.types'

const BASE = 'http://127.0.0.1:47385'
const quiet = { log: () => {}, warn: () => {}, error: () => {} }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('DaemonModeSession (D3)', () => {
  it('holds the open file, releases it on switch, and keeps unlocked files held for their derived key', async () => {
    const ids: Record<string, string> = { 'C:/a/agent-1.adf': 'id-1', 'C:/a/agent-2.adf': 'id-2' }
    const client = createFakeClientSession((p) => ids[p] ?? null)
    client.holdsAvailable = true
    const session = new DaemonModeSession(client, quiet)
    await session.openFile('C:/a/agent-1.adf', async () => null)
    expect(session.agentId).toBe('id-1')
    expect(session.focusAgentId).toBe('id-1')
    session.noteUnlocked('C:/a/agent-1.adf', 'id-1')
    await session.openFile('C:/a/agent-2.adf', async () => null)
    // agent-1 was unlocked in this session: still held, as embedded keeps its key cached.
    expect(client.released).toEqual([])
    await session.openFile('C:/a/agent-1.adf', async () => null)
    expect(client.released).toEqual(['id-2'])
    await session.releaseAll()
    expect(client.released).toEqual(['id-2', 'id-1'])
    expect(session.filePath).toBeNull()
    expect(client.focus.at(-1)).toBeNull()
  })

  it('without client sessions (until W2-B) resolves the running agent and logs the gap once', async () => {
    const warnings: string[] = []
    const session = new DaemonModeSession(createFakeClientSession(), { log: () => {}, warn: (m: string) => { warnings.push(m) } })
    await session.openFile('C:/a/agent-1.adf', async () => 'running-id')
    await session.openFile('C:/a/agent-2.adf', async () => null)
    expect(session.agentId).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not available in daemon mode yet: W2-B')
  })

  it('matches frames by id, or by path before the id is known (case-insensitive on Windows and macOS)', async () => {
    const session = new DaemonModeSession(createFakeClientSession(), quiet)
    await session.openFile('C:/a/agent-1.adf', async () => null)
    expect(session.isFocused('x', 'C:/a/agent-1.adf')).toBe(true)
    if (process.platform === 'win32' || process.platform === 'darwin') expect(session.isFocused('x', 'c:/A/AGENT-1.adf')).toBe(true)
    session.noteAgent('C:/a/agent-1.adf', 'id-1')
    expect(session.isFocused('id-1', null)).toBe(true)
    expect(session.isFocused('id-2', 'C:/a/agent-1.adf')).toBe(false)
  })
})

describe('settings split (§4.1, §4.2)', () => {
  it('splits a patch by key class; unclassified keys go to the daemon', () => {
    expect(splitSettingsPatch({ theme: 'dark', providers: [], recentFiles: ['x'], somethingNew: 1 })).toEqual({
      client: { theme: 'dark', recentFiles: ['x'] },
      backend: { providers: [], somethingNew: 1 },
      unclassified: ['somethingNew'],
    })
  })

  it('SETTINGS_GET view: backend keys from the daemon, client keys from Studio only', () => {
    const store = new ClientSettingsStore(clientSettingsPath(dir), quiet)
    store.set('theme', 'dark')
    const view = mergeSettingsViews({ theme: 'light', uiScale: 2, providers: [{ id: 'p' }] }, store)
    expect(view.theme).toBe('dark')
    expect(view.providers).toEqual([{ id: 'p' }])
    // The daemon file's copy of a client key never shows through.
    expect(view.uiScale).not.toBe(2)
  })

  it('runs the ui-font migration on studio-client-settings.json and writes only client keys', async () => {
    const path = clientSettingsPath(dir)
    writeFileSync(path, JSON.stringify({ uiFont: 'inter-tight', theme: 'dark' }))
    const store = new ClientSettingsStore(path, quiet)
    await store.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ uiFont: 'system', theme: 'dark', uiFontSystemDefaultApplied: true })
    store.patch({ providers: [], menuBarEnabled: false })
    await store.flush()
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.menuBarEnabled).toBe(false)
    expect('providers' in onDisk).toBe(false)
    // One-shot: an explicit Inter Tight afterwards sticks.
    store.set('uiFont', 'inter-tight')
    await store.flush()
    const again = new ClientSettingsStore(path, quiet)
    expect(again.get('uiFont')).toBe('inter-tight')
  })
})

describe('credentials (W0-B follow-up)', () => {
  it('credentialsFor honours the explicit token and never hands this daemon\'s token to another origin', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const client = createStudioDaemonClient({ baseUrl: BASE, source: { token: () => 'own-token' }, fetch: fetchImpl })
    await client.health()
    await client.withBaseUrl('http://10.0.0.2:7385', 'explicit-token').health()
    await client.withBaseUrl('http://10.0.0.2:7385').health()
    await client.withBaseUrl(`${BASE}/`).health()
    expect(seen.map((s) => s.auth)).toEqual(['Bearer own-token', 'Bearer explicit-token', null, 'Bearer own-token'])
  })
})

describe('backend not connected (visible state, reconnect)', () => {
  it('shows a status line, Reconnect and a dialog while down; a notification when back', async () => {
    vi.useFakeTimers()
    try {
      const connection = new DaemonConnection(async () => ({ baseUrl: BASE, logFile: join(dir, 'adf-daemon.log'), description: 'fake', source: { token: () => 't' } }), quiet)
      await connection.client()
      let reconnects = 0
      const opened: string[] = []
      initApplicationMenu({ get: () => undefined, set: () => {} }, {
        logFile: () => connection.logFile,
        problem: () => (connection.state.state === 'disconnected' ? 'ADF daemon: not connected, retrying' : null),
        canReconnect: () => connection.state.state === 'disconnected',
        openLog: () => { opened.push('log') },
        reconnect: () => { reconnects++ },
      })
      const ui = new ConnectionStatusUi(connection, { reconnect: () => { reconnects++ }, openLog: () => { opened.push('log') }, recoveryHint: 'hint' }, quiet)
      connection.markConnected()
      electronStub.calls.length = 0
      electronStub.dialogResponse = 0 // "Reconnect Now"

      connection.markDisconnected('stream ended')
      expect(helpLabels(electronStub)).toEqual(['ADF Studio Documentation', '<separator>', 'Open Daemon Log', 'ADF daemon: not connected, retrying', 'Reconnect to the ADF Daemon'])
      // A short blip raises no dialog; a lasting one does, once.
      expect(electronStub.calls.some((c) => c.api === 'dialog.showMessageBox')).toBe(false)
      await vi.advanceTimersByTimeAsync(3_100)
      const dialogs = electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox')
      expect(dialogs).toHaveLength(1)
      expect((dialogs[0].args[0] as { message: string }).message).toBe('Studio lost its connection to the ADF daemon.')
      expect(reconnects).toBe(1)

      connection.markConnected()
      expect(helpLabels(electronStub)).toEqual(['ADF Studio Documentation', '<separator>', 'Open Daemon Log'])
      expect(electronStub.calls.filter((c) => c.api === 'Notification.show').map((c) => (c.args[0] as { body: string }).body)).toEqual(['Reconnected to the ADF daemon.'])
      ui.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a connector failure is shown once, with the reason and the recovery override', async () => {
    electronStub.calls.length = 0
    const connection = new DaemonConnection(async () => { throw new Error('The ADF daemon exited during startup (code 1).') }, quiet)
    const ui = new ConnectionStatusUi(connection, { reconnect: () => {}, openLog: () => {}, recoveryHint: 'Start Studio with ADF_STUDIO_BACKEND=embedded.' }, quiet)
    await expect(connection.client()).rejects.toThrow('Studio is not connected to an ADF daemon: The ADF daemon exited during startup (code 1).')
    await Promise.resolve()
    const dialog = electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')
    expect((dialog?.args[0] as { detail: string }).detail).toContain('ADF_STUDIO_BACKEND=embedded')
    ui.dispose()
  })
})

describe('adf-file:// (daemon mode)', () => {
  async function setup() {
    const daemon = createFakeDaemon(BASE)
    const connection = new DaemonConnection(async () => ({ baseUrl: BASE, logFile: null, description: 'fake', source: { token: () => 't' } }), quiet, daemon.fetch)
    await connection.client()
    const session = new DaemonModeSession(createFakeClientSession(), quiet)
    await session.openFile('C:/a/agent-1.adf', async () => 'id-1')
    const handler = createAdfFileHandler({ session, connection, fetch: daemon.fetch, log: quiet })
    return { daemon, handler }
  }

  it('streams the file from GET /agents/:id/files/raw with the embedded header rules', async () => {
    const { daemon, handler } = await setup()
    daemon.routes.set('GET /agents/id-1/files/raw', ({ query }) => ({ status: 200, raw: `bytes of ${query.path}`, headers: { 'Content-Type': 'text/html' } }))
    const res = await handler(new Request('adf-file://files/Chart%20One.png'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('bytes of files/Chart One.png')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(daemon.requests.at(-1)?.auth).toBe('Bearer t')
    const unsafe = await handler(new Request('adf-file://x.svg'))
    expect(unsafe.headers.get('Content-Type')).toBe('text/html')
    daemon.routes.set('GET /agents/id-1/files/raw', () => ({ status: 200, raw: '<svg/>', headers: { 'Content-Type': 'image/svg+xml' } }))
    expect((await handler(new Request('adf-file://x.svg'))).headers.get('Content-Type')).toBe('image/svg+xml')
    daemon.routes.set('GET /agents/id-1/files/raw', () => ({ status: 200, raw: 'x', headers: { 'Content-Type': 'application/x-msdownload' } }))
    expect((await handler(new Request('adf-file://x.exe'))).headers.get('Content-Type')).toBe('application/octet-stream')
    expect((await handler(new Request('adf-file://../etc/passwd'))).status).toBe(400)
  })

  it('answers the daemon\'s 404 as "File not found"', async () => {
    const { daemon, handler } = await setup()
    daemon.routes.set('GET /agents/id-1/files/raw', () => ({ status: 404, body: { error: 'Unknown file "img1.png"' } }))
    const res = await handler(new Request('adf-file://img1.png'))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('File not found')
  })
})

describe('native notifier and approvals reveal fed from the stream', () => {
  const entry = (n: number): PendingNotification => ({
    id: `C:/a/agent-1.adf|main|task_${n}`, kind: 'approval', requestId: `task_${n}`, filePath: 'C:/a/agent-1.adf',
    agentName: 'agent-1', loop: 'main', toolName: 'fs_write', preview: 'note.md', createdAt: 1,
  } as PendingNotification)

  it('adopts the state found at connect without toasts, toasts new requests while Studio is not focused, and reveals on click', () => {
    electronStub.calls.length = 0
    electronStub.pushes.length = 0
    electronStub.toastClicks.length = 0
    let enabled = true
    const ui = new ApprovalsUi({
      notificationsEnabled: () => enabled,
      menuBarEnabled: () => false,
      agents: () => [],
      foreground: () => null,
      tokensToday: () => ({ input: 0, output: 0 }),
      log: quiet,
    })
    electronStub.focused = false
    ui.apply({ pending: [entry(1)], history: [] })
    expect(electronStub.calls.filter((c) => c.api === 'Notification.show')).toEqual([])
    ui.apply({ pending: [entry(1), entry(2)], history: [] })
    expect(electronStub.calls.filter((c) => c.api === 'Notification.show')).toHaveLength(1)
    electronStub.toastClicks[0]()
    expect(electronStub.pushes.at(-1)).toEqual({ channel: IPC.APPROVALS_REVEAL, args: [{ filePath: 'C:/a/agent-1.adf', notificationId: entry(2).id }] })
    // Focused, or switched off: no toast.
    electronStub.focused = true
    ui.apply({ pending: [entry(1), entry(2), entry(3)], history: [] })
    electronStub.focused = false
    enabled = false
    ui.apply({ pending: [entry(1), entry(2), entry(3), entry(4)], history: [] })
    expect(electronStub.calls.filter((c) => c.api === 'Notification.show')).toHaveLength(1)
    expect(ui.takePendingReveal()).toBeNull()
    electronStub.focused = true
    ui.dispose()
  })
})

describe('reattach, defaults (review fixes)', () => {
  it('reattach re-holds the open and the unlocked documents and re-sends the focus', async () => {
    const ids: Record<string, string> = { 'C:/a/agent-1.adf': 'id-1', 'C:/a/agent-2.adf': 'id-2' }
    const client = createFakeClientSession((p) => ids[p] ?? (p.toLowerCase().includes('agent-1') ? 'id-1' : p.toLowerCase().includes('agent-2') ? 'id-2' : null))
    client.holdsAvailable = true
    const session = new DaemonModeSession(client, quiet)
    await session.openFile('C:/a/agent-1.adf', async () => null)
    session.noteUnlocked('C:/a/agent-1.adf', 'id-1')
    await session.openFile('C:/a/agent-2.adf', async () => null)
    client.held.length = 0
    client.focus.length = 0
    await session.reattach()
    expect(client.held.sort()).toEqual(['id-1', 'id-2'])
    expect(client.focus).toEqual(['id-2'])
  })

  it('computes the client defaults once', () => {
    expect(clientSettingsDefaults()).toBe(clientSettingsDefaults())
  })
})

describe('connection dialogs and boot progress (review fixes)', () => {
  it('never shows two disconnect dialogs at once, and not again within the cooldown', async () => {
    vi.useFakeTimers()
    try {
      const connection = new DaemonConnection(async () => ({ baseUrl: BASE, logFile: null, description: 'fake', source: { token: () => 't' } }), quiet)
      await connection.client()
      initApplicationMenu({ get: () => undefined, set: () => {} }, { logFile: () => null, problem: () => null, canReconnect: () => false, openLog: () => {}, reconnect: () => {} })
      const ui = new ConnectionStatusUi(connection, { reconnect: () => {}, openLog: () => {}, recoveryHint: 'hint' }, quiet)
      connection.markConnected()
      electronStub.calls.length = 0
      const dialogs = () => electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox').length
      connection.markDisconnected()
      await vi.advanceTimersByTimeAsync(3_100)
      expect(dialogs()).toBe(1)
      connection.markConnected()
      connection.markDisconnected()
      await vi.advanceTimersByTimeAsync(3_100)
      expect(dialogs()).toBe(1)
      connection.markConnected()
      await vi.advanceTimersByTimeAsync(DISCONNECT_DIALOG_COOLDOWN_MS)
      connection.markDisconnected()
      await vi.advanceTimersByTimeAsync(3_100)
      expect(dialogs()).toBe(2)
      ui.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a status line and an indeterminate taskbar progress while Studio waits for the daemon at boot', async () => {
    vi.useFakeTimers()
    try {
      let release: (() => void) | null = null
      const connection = new DaemonConnection((progress) => new Promise((resolve) => {
        progress('Starting the ADF daemon…')
        release = () => resolve({ baseUrl: BASE, logFile: null, description: 'fake', source: { token: () => 't' } })
      }), quiet)
      initApplicationMenu({ get: () => undefined, set: () => {} }, {
        logFile: () => null, problem: () => connectionProblem(connection.state, null), canReconnect: () => false, openLog: () => {}, reconnect: () => {},
      })
      electronStub.calls.length = 0
      const ui = new ConnectionStatusUi(connection, { reconnect: () => {}, openLog: () => {}, recoveryHint: 'hint' }, quiet)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(electronStub.calls.filter((c) => c.api === 'window.setProgressBar').map((c) => c.args[0])).toEqual([2])
      expect(connectionProblem(connection.state, null)).toBe('ADF daemon: Starting the ADF daemon…')
      release!()
      await connection.client()
      connection.markConnected()
      expect(electronStub.calls.filter((c) => c.api === 'window.setProgressBar').map((c) => c.args[0])).toEqual([2, -1])
      ui.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed start can still open the daemon log (the connector knows it before it runs)', async () => {
    const connector = Object.assign(async () => { throw new Error('exited during startup') }, { logFile: 'C:/data/logs/adf-daemon.log' })
    const connection = new DaemonConnection(connector, quiet)
    await expect(connection.client()).rejects.toThrow()
    expect(connection.logFile).toBe('C:/data/logs/adf-daemon.log')
  })
})
