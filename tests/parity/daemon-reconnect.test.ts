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
    electron.dialogs = { showMessageBox: (options) => ({ response: Math.max(0, ((options as { buttons?: string[] }).buttons ?? []).indexOf('Dismiss')) }) }
    const booted = await daemonBackend().boot(env, electron)
    try {
      const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electron.handlers.get(channel)!(electron.ipcEvent(), ...args))
      expect(await invoke(IPC.FILE_OPEN, { filePath: agents['agent-1'].filePath })).toMatchObject({ success: true })
      expect(booted.handle.connection.state.state).toBe('connected')
      expect(helpLabels(electron)).toEqual(['ADF Studio Documentation', '-', 'Open Daemon Log'])

      await booted.killDaemon()
      await waitFor('the Help menu status line', () => helpLabels(electron).includes('Reconnect to the ADF Daemon'))
      expect(helpLabels(electron).find((l) => /^ADF daemon: (not connected|exited)/.test(l))).toBeTruthy()
      // The daemon's pid is gone: an exit, not a lost connection (W5-D2). This harness connector cannot start a daemon, so no Start button.
      await waitFor('the exit dialog', () => electron.localCalls.some((c) =>
        c.api === 'dialog.showMessageBox' && /^The ADF daemon \(pid \d+\) exited; agents are stopped\.$/.test((c.args[0] as { message?: string }).message ?? '')), 15_000)
      expect(helpLabels(electron).find((l) => l.startsWith('ADF daemon: exited (pid '))).toBeTruthy()
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
      // The session kept the open file across the daemon's restart.
      expect(await invoke(IPC.FILE_GET_CURRENT)).toEqual({ filePath: agents['agent-1'].filePath, agentRunning: false })
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

  it('a stream dropped in the middle of a streamed turn resumes it exactly: the chat ends as it would have', async () => {
    const env = await createParityEnv('daemon-reconnect-turn')
    const llm = await startMockLlm((req) => {
      if (req.isPreflight) return { text: 'ok' }
      if (req.last?.role === 'tool') return { text: 'Wrote note.md.' }
      return { toolCalls: [{ name: 'fs_write', arguments: { mode: 'write', path: 'note.md', content: 'hello from agent-1' } }] }
    }, { now: () => Date.now() - env.startedAt })
    env.allowPort(Number(new URL(llm.baseUrl).port))
    const electron = createFakeElectron(env)
    const agents = createFixtureAgents(env, [{ name: 'agent-1' }])
    writeSettingsFile(env, baseSettings(env, llm, agents))
    const booted = await daemonBackend().boot(env, electron)
    try {
      const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electron.handlers.get(channel)!(electron.ipcEvent(), ...args))
      const filePath = agents['agent-1'].filePath
      await invoke(IPC.FILE_OPEN, { filePath })
      expect(await invoke(IPC.AGENT_START, { filePath, hasUserMessage: true })).toMatchObject({ success: true })
      const turn = invoke(IPC.AGENT_INVOKE, { userMessage: 'Write a note.', filePath })
      // The reply streams in slices 200 ms apart: drop the stream once it is under way.
      await waitFor('the turn to start', () => electron.pushes.some((p) => p.channel === IPC.AGENT_EVENT && (p.args[0] as { type?: string })?.type === 'state_changed'))
      booted.handle.reconnect()
      expect(await turn).toEqual({ success: true })
      const chat = await invoke(IPC.DOC_GET_CHAT, {}) as { chatHistory: { uiLog: Array<{ type?: string; content?: unknown }> } }
      expect(JSON.stringify(chat.chatHistory.uiLog)).toContain('Wrote note.md.')
      const read = await invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'note.md', binaryContent: false })
      expect(read).toMatchObject({ content: 'hello from agent-1', binary: false })
    } finally {
      await booted.shutdown()
      await llm.close()
      try {
        env.assertRealStateUntouched()
      } finally {
        env.dispose()
      }
    }
  }, 180_000)

  it('a stream that loses frames mid-turn gets the D6 resync set and ends with the daemon\'s chat', async () => {
    // The tool call's input is over the client stream's 4 Mi-character frame
    // limit: the focused session gets `stream.gap` (oversized) instead of
    // that tool_call_start, in the middle of the turn (W2-B, D5.1).
    const big = 'x'.repeat(4_300_000)
    const env = await createParityEnv('daemon-reconnect-gap')
    const llm = await startMockLlm((req) => {
      if (req.isPreflight) return { text: 'ok' }
      if (req.last?.role === 'tool') return { text: 'Wrote big.md.' }
      return { toolCalls: [{ name: 'fs_write', arguments: { mode: 'write', path: 'big.md', content: big } }] }
    }, { now: () => Date.now() - env.startedAt })
    env.allowPort(Number(new URL(llm.baseUrl).port))
    const electron = createFakeElectron(env)
    const agents = createFixtureAgents(env, [{ name: 'agent-1' }])
    writeSettingsFile(env, baseSettings(env, llm, agents, { trackedDirectories: [env.agentsDir] }))
    const booted = await daemonBackend().boot(env, electron)
    try {
      const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(electron.handlers.get(channel)!(electron.ipcEvent(), ...args))
      const filePath = agents['agent-1'].filePath
      await invoke(IPC.FILE_OPEN, { filePath })
      expect(await invoke(IPC.AGENT_START, { filePath, hasUserMessage: true })).toMatchObject({ success: true })
      const before = electron.pushes.length
      expect(await invoke(IPC.AGENT_INVOKE, { userMessage: 'Write a big note.', filePath })).toEqual({ success: true })
      const events = () => electron.pushes.slice(before).filter((p) => p.channel === IPC.AGENT_EVENT).map((p) => p.args[0] as { type: string; payload: { uiLog?: unknown[] }; loop?: string })
      // The lost tool_call_start never arrived; the resync set did.
      expect(events().some((e) => e.type === 'tool_call_start')).toBe(false)
      await waitFor('the resync set', () => {
        const channels = electron.pushes.slice(before).map((p) => p.channel)
        return channels.includes(IPC.DOC_AGENT_CONFIG_CHANGED) && channels.includes(IPC.TRACKED_DIRS_CHANGED) && channels.includes(IPC.APPROVALS_CHANGED)
      })
      // The turn was still running at the resync: the chat is repainted once it settles, as the daemon has it.
      await waitFor('the chat repaint after the turn', () => events().some((e) => e.type === 'chat_updated' && !e.loop))
      const repaint = events().filter((e) => e.type === 'chat_updated' && !e.loop).at(-1)!
      const chat = await invoke(IPC.DOC_GET_CHAT, {}) as { chatHistory: { uiLog: unknown[] } }
      expect(repaint.payload.uiLog).toEqual(chat.chatHistory.uiLog)
      expect(JSON.stringify(chat.chatHistory.uiLog)).toContain('Wrote big.md.')
      expect(JSON.stringify(chat.chatHistory.uiLog)).toContain('fs_write')
      const read = await invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'big.md', binaryContent: false }) as { content: string }
      expect(read.content.length).toBe(big.length)
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
  }, 240_000)
})
