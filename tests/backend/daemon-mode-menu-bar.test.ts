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
