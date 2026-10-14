import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { DAEMON_BUNDLE, daemonBackend } from './harness/daemon-backend'
import { createFakeElectron, type FakeElectron } from './harness/electron-fake'
import { createParityEnv, writeSettingsFile } from './harness/env'
import { baseSettings, createFixtureAgents } from './harness/fixtures'
import { defaultScript, startMockLlm } from './harness/mock-llm'

/**
 * Daemon mode only (tracker W2-C): the daemon dies under a connected Studio
 * (a crash, a Defender kill), Studio shows that the backend is not
 * connected, calls fail visibly, and when a daemon answers again Studio
 * reconnects by itself, says so, and resyncs (D6: the new daemon run is a
 * new epoch, so the client stream reports `stream.gap`).
 *
 * The daemon child is killed with taskkill, never stopped gracefully.
 */

async function waitFor(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function helpLabels(electron: FakeElectron): string[] {
  const last = [...electron.localCalls].reverse().find((c) => c.api === 'Menu.setApplicationMenu')
  const items = (last?.args[0] ?? []) as Array<{ role?: string; submenu?: Array<{ label?: string }> }>
  return (items.find((i) => i.role === 'help')?.submenu ?? []).map((i) => i.label ?? '-')
}

describe.skipIf(!existsSync(DAEMON_BUNDLE))('daemon mode: backend not connected, reconnect, resync', () => {
  it('shows the disconnected state, fails calls visibly, reconnects to a restarted daemon and resyncs', async () => {
    const env = await createParityEnv('daemon-reconnect')
    const llm = await startMockLlm(defaultScript, { now: () => Date.now() - env.startedAt })
    env.allowPort(Number(new URL(llm.baseUrl).port))
    const electron = createFakeElectron(env)
    const agents = createFixtureAgents(env, [{ name: 'agent-1' }])
    writeSettingsFile(env, baseSettings(env, llm, agents, { trackedDirectories: [env.agentsDir] }))
    // "Dismiss" on the disconnected dialog.
    electron.dialogs = { showMessageBox: (options) => ({ response: ((options as { buttons?: string[] }).buttons?.length ?? 1) - 1 }) }
    const booted = await daemonBackend().boot(env, electron)
    try {
      const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electron.handlers.get(channel)!(electron.ipcEvent(), ...args))
      expect(await invoke(IPC.FILE_OPEN, { filePath: agents['agent-1'].filePath })).toMatchObject({ success: true })
      expect(booted.handle.connection.state.state).toBe('connected')
      expect(helpLabels(electron)).toEqual(['ADF Studio Documentation', '-', 'Open Daemon Log'])

      await booted.killDaemon()
      await waitFor('the Help menu status line', () => helpLabels(electron).includes('Reconnect to the ADF Daemon'))
      expect(helpLabels(electron).find((l) => l.startsWith('ADF daemon: not connected'))).toBeTruthy()
      await waitFor('the disconnected dialog', () => electron.localCalls.some((c) =>
        c.api === 'dialog.showMessageBox' && (c.args[0] as { message?: string }).message === 'Studio lost its connection to the ADF daemon.'), 15_000)
      await expect(invoke(IPC.SETTINGS_GET)).rejects.toThrow(/Cannot reach daemon/)

      const pushesBefore = electron.pushes.length
      await booted.restartDaemon()
      await waitFor('the reconnect', () => booted.handle.connection.state.state === 'connected', 30_000)
      await waitFor('the resync pushes', () => {
        const after = electron.pushes.slice(pushesBefore).map((p) => p.channel)
        return after.includes(IPC.APPROVALS_CHANGED) && after.includes(IPC.TRACKED_DIRS_CHANGED)
      })
      const resync = electron.pushes.slice(pushesBefore)
      expect(resync.find((p) => p.channel === IPC.TRACKED_DIRS_CHANGED)?.args[0]).toEqual({ dirPath: env.agentsDir })
      expect(resync.find((p) => p.channel === IPC.APPROVALS_CHANGED)?.args[0]).toEqual({ pending: [], history: [] })
      expect(electron.localCalls.filter((c) => c.api === 'Notification.show').map((c) => (c.args[0] as { body?: string }).body))
        .toContain('Reconnected to the ADF daemon.')
      expect(helpLabels(electron)).toEqual(['ADF Studio Documentation', '-', 'Open Daemon Log'])
      expect(await invoke(IPC.AGENT_STATUS)).toEqual({ running: false, state: 'stopped' })
    } finally {
      await booted.shutdown()
      await llm.close()
      try {
        env.assertRealStateUntouched()
      } finally {
        env.dispose()
      }
    }
    expect(booted.leaks()).toEqual([])
  }, 180_000)
})
