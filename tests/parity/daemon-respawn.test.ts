import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { DAEMON_BUNDLE, daemonBackend } from './harness/daemon-backend'
import { createFakeElectron } from './harness/electron-fake'
import { createParityEnv, writeSettingsFile } from './harness/env'
import { baseSettings, createFixtureAgents } from './harness/fixtures'
import { defaultScript, startMockLlm } from './harness/mock-llm'

/**
 * Daemon mode only (W5-D2): the daemon Studio started dies under a
 * connected Studio (taskkill, as a crash or a Defender kill). Studio tells
 * the exit from a dropped connection by the daemon's pid, says so in one
 * notice, starts the daemon again by itself through its own connector
 * (localDaemonConnector → DaemonProcessController.ensure against the built
 * bundle, fake compute), re-holds the open file, starts the agents that
 * were running again, and says so.
 */

async function waitFor(what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!existsSync(DAEMON_BUNDLE))('daemon mode: the daemon Studio started exits', () => {
  it('is started again once, by Studio, visibly; the open file is re-held and the agents run again', async () => {
    const env = await createParityEnv('daemon-respawn')
    const llm = await startMockLlm(defaultScript, { now: () => Date.now() - env.startedAt })
    env.allowPort(Number(new URL(llm.baseUrl).port))
    const electron = createFakeElectron(env)
    const agents = createFixtureAgents(env, [{ name: 'agent-1' }, { name: 'agent-2' }])
    writeSettingsFile(env, baseSettings(env, llm, agents))
    electron.dialogs = { showMessageBox: (options) => ({ response: Math.max(0, ((options as { buttons?: string[] }).buttons ?? []).indexOf('Dismiss')) }) }
    const booted = await daemonBackend({ revivable: true }).boot(env, electron)
    try {
      const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electron.handlers.get(channel)!(electron.ipcEvent(), ...args))
      const one = agents['agent-1'].filePath
      const two = agents['agent-2'].filePath
      expect(await invoke(IPC.FILE_OPEN, { filePath: one })).toMatchObject({ success: true })
      expect(await invoke(IPC.AGENT_START, { filePath: one })).toMatchObject({ success: true })
      expect(await invoke(IPC.BACKGROUND_AGENT_START, { filePath: two })).toEqual({ success: true })
      await waitFor('both agents in the bridge', () => booted.handle.bridge.runningAgents().length === 2)
      const firstPid = booted.daemonPid()!
      expect(booted.handle.status()).toMatchObject({ connection: 'connected', pid: firstPid, startedBy: 'studio' })

      await booted.killDaemon()
      const notices = () => electron.localCalls.filter((c) => c.api === 'Notification.show').map((c) => (c.args[0] as { body?: string }).body ?? '')
      await waitFor('the exit notice', () => notices().includes(`The ADF daemon (pid ${firstPid}) exited; agents are stopped. Studio is starting it again.`))
      await waitFor('the respawn notice', () => notices().some((n) => n.startsWith('Studio started the ADF daemon again')), 120_000)
      const secondPid = booted.daemonPid()!
      expect(secondPid).not.toBe(firstPid)
      expect(notices().find((n) => n.startsWith('Studio started the ADF daemon again'))).toBe(`Studio started the ADF daemon again (pid ${secondPid}). Agents running again: 2 of 2.`)
      // No dialog: the respawn was Studio's own, announced by notices.
      expect(electron.localCalls.filter((c) => c.api === 'dialog.showMessageBox')).toEqual([])
      expect(booted.handle.status()).toMatchObject({ connection: 'connected', pid: secondPid, startedBy: 'studio', how: 'spawned' })

      // The open file is held again (re-held on the new daemon's session) and its agent runs.
      expect(await invoke(IPC.FILE_GET_CURRENT)).toEqual({ filePath: one, agentRunning: true })
      expect(await invoke(IPC.AGENT_STATUS)).toMatchObject({ running: true })
      const background = await invoke(IPC.BACKGROUND_AGENT_STATUS) as { agents: Array<{ filePath: string }> }
      expect(background.agents.map((a) => a.filePath)).toEqual([two])
      // It answers a chat: the new daemon runs it.
      expect(await invoke(IPC.AGENT_INVOKE, { userMessage: 'Hello again.', filePath: one })).toEqual({ success: true })
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
  }, 300_000)
})
