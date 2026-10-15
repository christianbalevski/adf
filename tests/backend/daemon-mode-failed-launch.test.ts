/**
 * A launch whose connector failed (no daemon, port in use, refused attach):
 * Help offers Reconnect (Studio restarts and runs the connector again) and
 * "Use Embedded for This Session" (embedded for this launch only, the saved
 * mode stays), and so does the failure dialog. While the stream is merely
 * disconnected, Reconnect reconnects the stream and the embedded escape is
 * not offered.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub, helpLabels } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { registerDaemonModeHandlers } from '../../src/main/backend/daemon-mode'

const BASE = 'http://127.0.0.1:47386'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

type MenuItem = { label?: string; click?: () => void; role?: string; submenu?: MenuItem[] }
function helpItem(label: string): MenuItem | undefined {
  const last = [...electronStub.calls].reverse().find((c) => c.api === 'Menu.setApplicationMenu')
  const help = ((last?.args[0] ?? []) as MenuItem[]).find((i) => i.role === 'help')
  return help?.submenu?.find((i) => i.label === label)
}

function boot(connect: () => Promise<never> | Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-failed-'))
  dirs.push(dir)
  const daemon = createFakeDaemon(BASE)
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const session = createFakeClientSession()
  const relaunches: string[] = []
  const handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect: Object.assign(connect as never, { logFile: join(dir, 'adf-daemon.log') }),
    leases: { registerClient: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} } as never,
    fetch: daemon.fetch,
    createSession: () => session,
    relaunch: { reconnect: (reason) => { relaunches.push(`reconnect: ${reason}`) }, embeddedForSession: (reason) => { relaunches.push(`embedded: ${reason}`) } },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  })
  return { handle, session, relaunches }
}

describe('after a failed launch', () => {
  it('Help offers Reconnect and Use Embedded for This Session; each restarts Studio its way', async () => {
    electronStub.calls.length = 0
    electronStub.dialogResponse = 99 // dismiss the failure dialog
    const { handle, relaunches } = boot(async () => { throw new Error('The ADF daemon exited during startup (code 1). Its log says: "Failed to start: port 7385 on 127.0.0.1 is already in use".') })
    expect(await handle.ready).toBe(false)
    expect(handle.connection.state.state).toBe('failed')
    expect(helpLabels(electronStub)).toEqual(['ADF Studio Documentation', '<separator>', 'Open Daemon Log', 'ADF daemon: not connected', 'Reconnect to the ADF Daemon', 'Use Embedded for This Session'])
    helpItem('Reconnect to the ADF Daemon')!.click!()
    helpItem('Use Embedded for This Session')!.click!()
    expect(relaunches).toEqual([
      'reconnect: Reconnect after a failed connection to the ADF daemon',
      'embedded: no ADF daemon could be reached at launch',
    ])
    // The failure dialog offers the same two, with the daemon's reason.
    const dialog = electronStub.calls.find((c) => c.api === 'dialog.showMessageBox')?.args[0] as { buttons: string[]; detail: string }
    expect(dialog.buttons).toEqual(['Reconnect', 'Use Embedded for This Session', 'Open Daemon Log', 'OK'])
    expect(dialog.detail).toContain('port 7385 on 127.0.0.1 is already in use')
  })

  it('the failure dialog\'s buttons do what they say', async () => {
    electronStub.calls.length = 0
    electronStub.dialogResponse = 1 // "Use Embedded for This Session"
    const { handle, relaunches } = boot(async () => { throw new Error('No ADF daemon answers.') })
    expect(await handle.ready).toBe(false)
    await vi.waitFor(() => expect(relaunches).toEqual(['embedded: no ADF daemon could be reached at launch']))
  })

  it('while the stream is only disconnected, Reconnect reconnects it and the embedded escape is not offered', async () => {
    electronStub.calls.length = 0
    const { handle, session, relaunches } = boot(async () => ({ baseUrl: BASE, logFile: null, description: 'the fake daemon', source: { token: () => 't' } }))
    expect(await handle.ready).toBe(true)
    handle.connection.markDisconnected('stream ended')
    expect(helpLabels(electronStub)).toEqual(['ADF Studio Documentation', '<separator>', 'Open Daemon Log', `ADF daemon: not connected (${BASE}), retrying`, 'Reconnect to the ADF Daemon'])
    helpItem('Reconnect to the ADF Daemon')!.click!()
    expect(session.reconnects).toBe(1)
    expect(relaunches).toEqual([])
    await handle.shutdown()
  })
})
