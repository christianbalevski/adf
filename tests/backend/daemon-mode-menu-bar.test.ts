/**
 * Daemon mode on macOS creates the menu bar icon (ApprovalsUi) while the
 * handlers register, before the event bridge exists; its first refresh
 * must not read the bridge. Run on every platform with process.platform
 * set to darwin around the (synchronous) registration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'

const BASE = 'http://127.0.0.1:47391'
const TOKEN = 'c'.repeat(43)
const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-menu-bar-'))
const daemon = createFakeDaemon(BASE)
const log = { log: () => {}, warn: () => {}, error: () => {} }
let handle: DaemonModeHandle | undefined

afterAll(async () => {
  await handle?.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

it('registers on macOS with the menu bar on: the icon is made and titled before any agent is known', async () => {
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    handle = registerDaemonModeHandlers({
      mode: 'local',
      userDataDir: dir,
      connect: async () => ({ baseUrl: BASE, logFile: null, description: 'the fake daemon', source: { token: () => TOKEN } }),
      leases: { registerClient: async () => {} },
      fetch: daemon.fetch,
      createSession: () => createFakeClientSession(),
      log,
    })
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
  expect(electronStub.calls.map((c) => c.api)).toEqual(expect.arrayContaining(['Tray.new', 'Tray.setTitle']))
  expect(await handle.ready).toBe(true)
})

it('a running agent of another runtime opens on that runtime, never as a path on This computer (A9)', async () => {
  const { ApprovalsUi } = await import('../../src/main/backend/daemon-mode/approvals-ui')
  const { buildMenuBarModel } = await import('../../src/main/tray/menu-bar-model')
  const opened: string[] = []
  const openedOn: Array<[string, string]> = []
  const ui = new ApprovalsUi({
    notificationsEnabled: () => false,
    menuBarEnabled: () => false,
    // The same path on two computers: two agents.
    agents: () => [{ filePath: '/srv/agents/agent-1.adf', state: 'active', runtimeId: 'remote:host-1' }, { filePath: '/srv/agents/agent-1.adf', state: 'active' }],
    foreground: () => null,
    tokensToday: () => ({ input: 0, output: 0 }),
    openFile: (filePath) => { opened.push(filePath) },
    openFileOn: (runtimeId, filePath) => { openedOn.push([runtimeId, filePath]) },
    log,
  })
  const ux = ui as unknown as { menuBarSnapshot(): Parameters<typeof buildMenuBarModel>[0]; onMenuBarAction(action: unknown): void }
  const actions = buildMenuBarModel(ux.menuBarSnapshot()).items.flatMap((i) => (i.kind === 'action' && i.action.type === 'open-agent' ? [i.action] : []))
  expect(actions).toEqual(expect.arrayContaining([{ type: 'open-agent', filePath: '/srv/agents/agent-1.adf', runtimeId: 'remote:host-1' }, { type: 'open-agent', filePath: '/srv/agents/agent-1.adf' }]))
  for (const action of actions) ux.onMenuBarAction(action)
  expect(openedOn).toEqual([['remote:host-1', '/srv/agents/agent-1.adf']])
  expect(opened).toEqual(['/srv/agents/agent-1.adf'])
  ui.dispose()
})
