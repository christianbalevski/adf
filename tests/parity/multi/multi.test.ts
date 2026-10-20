import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import { multiDaemonBackend, type BootedMultiBackend, type MultiDaemonOptions, type MultiParityBackend } from '../harness/multi-daemon-backend'
import { diffRendered, renderRecording } from '../harness/format'
import { toGoldenForm } from '../harness/normalize'
import { runScenario, type ParityScenario, type ScenarioContext } from '../harness/scenario'
import type { PushRecord } from '../harness/electron-fake'
import type { LlmRequestView } from '../harness/mock-llm'
import { chatToolCallScenario } from '../scenarios/core'

/**
 * Multi-runtime parity (docs/design/multi-runtime.md §9.1): Studio in local
 * mode with This computer and one saved connection, each a built daemon in
 * its own fenced child process (harness/multi-daemon-backend.ts). Every run
 * goes through runScenario: the fences, the real-state check, the quiet
 * window and the leak checks apply.
 *
 * Needs out/main/daemon.js; skipped without it, a failure with
 * PARITY_REQUIRE_DAEMON=1 (daemon.test.ts checks the bundle is current).
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))
const BUNDLE = existsSync(DAEMON_BUNDLE)
const REMOTE = 'remote:host-1'
const TAG = { $runtime: REMOTE }
const TURN_MS = 60_000

type AgentEvent = { type?: string; payload?: { state?: string } }
const isTagged = (p: PushRecord) => (p.args[0] as { $runtime?: unknown } | undefined)?.$runtime === REMOTE
/** A push of This computer (untagged) or of the remote (tagged), and its payload. */
const payloadOf = (p: PushRecord): unknown => (isTagged(p) ? p.args[1] : p.args[0])

/** A backend whose booted form the scenario can reach. */
function capture(options: MultiDaemonOptions = {}): { backend: MultiParityBackend; booted(): BootedMultiBackend } {
  const inner = multiDaemonBackend(options)
  let booted: BootedMultiBackend | null = null
  return {
    backend: { name: inner.name, boot: async (env, electron): Promise<BootedMultiBackend> => { const b = await inner.boot(env, electron); booted = b; return b } },
    booted: () => {
      if (!booted) throw new Error('parity harness: the multi backend has not booted')
      return booted
    },
  }
}

/** Wait for a push of one runtime (`remote`: tagged with it) whose payload matches, after `from`. */
async function waitPush(b: BootedMultiBackend, channel: string, remote: boolean, match: (payload: unknown) => boolean, from = 0, what = channel): Promise<number> {
  let found = -1
  await b.until(() => {
    const i = b.electron.pushes.findIndex((p, k) => k >= from && p.channel === channel && isTagged(p) === remote && match(payloadOf(p)))
    found = i
    return i >= 0
  }, what, TURN_MS)
  return found
}

/** useAdfFile.openFile and a chat turn, on This computer (no tag) or the remote (tagged). */
async function chat(ctx: ScenarioContext, b: BootedMultiBackend, remote: boolean, filePath: string, message: string): Promise<void> {
  const tag = remote ? [TAG] : []
  const from = b.electron.pushes.length
  await ctx.invoke(IPC.FILE_OPEN, ...tag, { filePath })
  await ctx.invoke(IPC.AGENT_START, ...tag, { filePath, hasUserMessage: true })
  await ctx.invoke(IPC.AGENT_INVOKE, ...tag, { userMessage: message, filePath })
  await waitPush(b, IPC.AGENT_EVENT, remote, (p) => (p as AgentEvent)?.type === 'turn_complete', from, `${remote ? 'remote' : 'local'} turn complete`)
}

/** The model answers each runtime's chat with its own sentence. */
const echo = (req: LlmRequestView) => (req.isPreflight ? { text: 'ok' } : { text: localOnly(req) ? 'Reply to This computer.' : 'Reply to host-1.' })
const localOnly = (req: LlmRequestView) => req.messages.some((m) => m.role === 'user' && m.text.includes('local'))

describe('parity: multi-daemon availability', () => {
  it.runIf(process.env.PARITY_REQUIRE_DAEMON === '1')('the daemon bundle exists (PARITY_REQUIRE_DAEMON=1)', () => {
    expect(BUNDLE, `${DAEMON_BUNDLE} is missing; run npx electron-vite build`).toBe(true)
  })
})

describe.skipIf(!BUNDLE)('parity: two runtimes (multi-runtime.md §9.1)', () => {
  it('open and chat on each runtime at once; each turn reaches its own daemon and its own window traffic', async () => {
    for (let run = 0; run < RUNS; run++) {
      const t = capture()
      const scenario: ParityScenario = {
        name: 'multi-chat',
        description: 'Chat with agent-1 on This computer and agent-2 on host-1 at the same time.',
        fixtures: [{ name: 'agent-1' }],
        quietMs: 1000,
        llm: echo,
        shownStream: localOnly,
        async run(ctx) {
          const b = t.booted()
          await Promise.all([
            chat(ctx, b, false, ctx.agent('agent-1').filePath, 'Hello from local.'),
            chat(ctx, b, true, b.remoteAgents['agent-2'].filePath, 'Hello from remote.'),
          ])
          const local = await ctx.invoke<{ messages?: unknown[] }>(IPC.DOC_GET_CHAT, {})
          const remote = await ctx.invoke<{ messages?: unknown[] }>(IPC.DOC_GET_CHAT, TAG, {})
          expect(JSON.stringify(local)).toContain('Reply to This computer.')
          expect(JSON.stringify(local)).not.toContain('host-1')
          expect(JSON.stringify(remote)).toContain('Reply to host-1.')
          expect(JSON.stringify(remote)).not.toContain('This computer')
          // Each runtime's events: This computer's untagged, the remote's tagged; no untagged event names the remote agent.
          const pushes = b.electron.pushes
          expect(pushes.some((p) => p.channel === IPC.AGENT_EVENT && isTagged(p))).toBe(true)
          expect(pushes.filter((p) => !isTagged(p)).some((p) => JSON.stringify(p.args).includes(b.remoteAgents['agent-2'].filePath))).toBe(false)
          for (const id of ['local', REMOTE]) await ctx.invoke(IPC.AGENT_STOP, ...(id === 'local' ? [] : [TAG]))
        },
      }
      await runScenario(scenario, t.backend)
    }
  }, RUNS * 180_000)

  it('approvals from both runtimes arrive in one list and are answered from it, each on its own runtime', async () => {
    for (let run = 0; run < RUNS; run++) {
      const t = capture({ restrictTools: ['fs_write'] })
      type Entry = { id: string; filePath: string; toolName?: string; runtimeId?: string }
      const scenario: ParityScenario = {
        name: 'multi-approvals',
        description: 'agent-1 on This computer and agent-2 on host-1 each call a restricted fs_write; both requests are answered from the merged list.',
        fixtures: [{ name: 'agent-1' }],
        quietMs: 1000,
        shownStream: localOnly,
        llm: (req) => {
          if (req.isPreflight) return { text: 'ok' }
          if (req.last?.role === 'tool') return { text: 'Wrote note.md.' }
          return { toolCalls: [{ name: 'fs_write', arguments: { mode: 'write', path: 'note.md', content: localOnly(req) ? 'from This computer' : 'from host-1' } }] }
        },
        async run(ctx) {
          const b = t.booted()
          const local = ctx.agent('agent-1').filePath
          const remote = b.remoteAgents['agent-2'].filePath
          await ctx.invoke(IPC.FILE_OPEN, { filePath: local })
          await ctx.invoke(IPC.AGENT_START, { filePath: local, hasUserMessage: true })
          await ctx.invoke(IPC.FILE_OPEN, TAG, { filePath: remote })
          await ctx.invoke(IPC.AGENT_START, TAG, { filePath: remote, hasUserMessage: true })
          const turns = [
            ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Write a local note.', filePath: local }),
            ctx.invoke(IPC.AGENT_INVOKE, TAG, { userMessage: 'Write a remote note.', filePath: remote }),
          ]
          // One merged, untagged list: the remote's entry names its runtime, This computer's names none.
          const both = (p: unknown) => {
            const pending = ((p as { pending?: Entry[] })?.pending ?? []).filter((e) => e.toolName === 'fs_write')
            return pending.some((e) => e.runtimeId === REMOTE && e.filePath === remote) && pending.some((e) => e.runtimeId === undefined && e.filePath === local)
          }
          const snapshot = (await ctx.waitForPush(IPC.APPROVALS_CHANGED, 'both requests pending', both, TURN_MS)) as { pending: Entry[] }
          expect(b.electron.pushes.filter((p) => p.channel === IPC.APPROVALS_CHANGED).every((p) => !isTagged(p))).toBe(true)
          for (const entry of snapshot.pending.filter((e) => e.toolName === 'fs_write')) {
            const result = await ctx.invoke<{ success?: boolean }>(IPC.APPROVALS_RESOLVE, ...(entry.runtimeId ? [{ $runtime: entry.runtimeId }] : []), { filePath: entry.filePath, approvalId: entry.id, approved: true })
            expect(result?.success).not.toBe(false)
          }
          await Promise.all(turns)
          await ctx.waitForPush(IPC.APPROVALS_CHANGED, 'both answered', (p) => !((p as { pending?: Entry[] })?.pending ?? []).some((e) => e.toolName === 'fs_write'), TURN_MS)
          const localNote = await ctx.invoke<{ content?: string }>(IPC.DOC_READ_INTERNAL_FILE, { path: 'note.md', binaryContent: false })
          const remoteNote = await ctx.invoke<{ content?: string }>(IPC.DOC_READ_INTERNAL_FILE, TAG, { path: 'note.md', binaryContent: false })
          expect(JSON.stringify(localNote)).toContain('from This computer')
          expect(JSON.stringify(remoteNote)).toContain('from host-1')
          await ctx.invoke(IPC.AGENT_STOP)
          await ctx.invoke(IPC.AGENT_STOP, TAG)
        },
      }
      await runScenario(scenario, t.backend)
    }
  }, RUNS * 180_000)

  it('the remote daemon killed mid-run: This computer\'s turn completes and its recording equals the single-runtime one', async () => {
    const single = await runScenario(chatToolCallScenario, daemonBackend())
    for (let run = 0; run < RUNS; run++) {
      const t = capture({ thisComputerOnly: true })
      const scenario: ParityScenario = {
        ...chatToolCallScenario,
        async run(ctx) {
          const b = t.booted()
          const killed = b.killRemote()
          await chatToolCallScenario.run(ctx)
          await killed
          await b.until(() => b.handle.runtimes.get(REMOTE)?.connection.state.state !== 'connected', 'the remote seen as down')
        },
      }
      const multi = await runScenario(scenario, t.backend)
      expect(multi.raw.pushes.some(isTagged)).toBe(false)
      // The application menu is rebuilt when the remote's state changes (Help names it while it is down),
      // and the remote's notices name it: both are the remote's, not This computer's.
      const thisComputer = (r: typeof multi) => {
        const calls = r.normalized.local.filter((c) => !JSON.stringify(c.args).includes('host-1'))
        const kept = calls.filter((c, i) => c.api !== 'Menu.setApplicationMenu' || JSON.stringify(c) !== JSON.stringify(calls.slice(0, i).filter((x) => x.api === c.api).at(-1)))
        return { ...r.normalized, local: kept }
      }
      expect(diffRendered(renderRecording(toGoldenForm(thisComputer(single))), renderRecording(toGoldenForm(thisComputer(multi))), { expected: 'daemon (one runtime)', actual: 'multi (This computer)' })).toBe('')
    }
  }, (RUNS + 1) * 180_000)

  it('a 401 from the remote fails that runtime only, with the refused-token sentence and no dialog', async () => {
    const { refusedTokenSentence } = await import('../../../src/main/backend/daemon-mode/remote/connector')
    const t = capture()
    const scenario: ParityScenario = {
      name: 'multi-401',
      description: 'host-1 stops accepting the token Studio holds (revoked there); This computer keeps working.',
      fixtures: [{ name: 'agent-1' }],
      quietMs: 1000,
      async run(ctx) {
        const b = t.booted()
        const rt = b.handle.runtimes.get(REMOTE)!
        b.proxy.refuse = true
        await ctx.invoke(IPC.FILE_OPEN, TAG, { filePath: b.remoteAgents['agent-2'].filePath }).catch(() => null)
        await b.until(() => rt.connection.state.state === 'failed', 'the remote failed')
        expect(rt.connection.state).toEqual({ state: 'failed', message: refusedTokenSentence(`http://127.0.0.1:${b.proxy.port}`) })
        expect(b.handle.connection.state.state).toBe('connected')
        expect(b.electron.localCalls.filter((c) => c.api === 'dialog.showMessageBox')).toEqual([])
        expect(b.electron.localCalls.some((c) => c.api.startsWith('Notification') && JSON.stringify(c.args).includes('host-1: Not connected'))).toBe(true)
        // This computer answers as before.
        await ctx.invoke(IPC.FILE_OPEN, { filePath: ctx.agent('agent-1').filePath })
        expect(await ctx.invoke<{ filePath: string | null }>(IPC.FILE_GET_CURRENT)).toMatchObject({ filePath: ctx.agent('agent-1').filePath })
      },
    }
    await runScenario(scenario, t.backend)
  }, 180_000)

  it('another computer at the remote\'s address: that runtime fails with the pin sentence and its token is never sent there', async () => {
    const { pinMismatchSentence } = await import('../../../src/main/backend/connections')
    const t = capture()
    const scenario: ParityScenario = {
      name: 'multi-pin-mismatch',
      description: 'The daemon of host-1 is replaced by a daemon with another fingerprint at the same address.',
      fixtures: [{ name: 'agent-1' }],
      quietMs: 1000,
      async run() {
        const b = t.booted()
        const rt = b.handle.runtimes.get(REMOTE)!
        const pinned = b.proxy.hello!.fingerprint
        await b.replaceRemoteWithImpostor()
        const impostor = b.proxy.upstream
        await b.until(() => rt.connection.state.state === 'failed', 'the remote failed', 60_000)
        const url = `http://127.0.0.1:${b.proxy.port}`
        expect(rt.connection.state).toEqual({ state: 'failed', message: pinMismatchSentence('host-1', url, b.proxy.hello!.fingerprint, pinned) })
        expect(b.proxy.authorized.filter((r) => r.startsWith(`${impostor} `))).toEqual([])
        expect(b.handle.connection.state.state).toBe('connected')
        expect(b.electron.localCalls.filter((c) => c.api === 'dialog.showMessageBox')).toEqual([])
      },
    }
    await runScenario(scenario, t.backend)
  }, 240_000)

  it('a connection saved in cli-remotes.json while Studio runs connects; forgotten, it disconnects', async () => {
    const t = capture({ savedAtBoot: false })
    const scenario: ParityScenario = {
      name: 'multi-save-forget',
      description: 'adf pair saves host-1 while Studio runs, then adf remotes forget removes it.',
      fixtures: [{ name: 'agent-1' }],
      quietMs: 1000,
      async run(ctx) {
        const b = t.booted()
        expect(b.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local'])
        await b.saveRemote()
        await b.until(() => b.handle.runtimes.get(REMOTE) !== null, 'the saved connection joins the set')
        expect(await b.handle.runtimes.get(REMOTE)!.ready).toBe(true)
        await b.until(() => b.connectedRuntimes.includes(REMOTE), 'runtimeConnected for the saved connection')
        expect(await ctx.invoke<{ filePath: string | null }>(IPC.FILE_GET_CURRENT, TAG)).toMatchObject({ filePath: null })
        await b.forgetRemote()
        await b.until(() => b.handle.runtimes.get(REMOTE) === null, 'the forgotten connection leaves the set')
        expect(b.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local'])
        const getCurrent = b.electron.handlers.get(IPC.FILE_GET_CURRENT)!
        expect(() => getCurrent(b.electron.ipcEvent(), TAG)).toThrow(`${REMOTE} is not connected.`)
      },
    }
    await runScenario(scenario, t.backend)
  }, 180_000)

  it('Remove with an agent window open on the remote: the window closes and its session ends', async () => {
    const t = capture()
    const scenario: ParityScenario = {
      name: 'multi-remove-window',
      description: 'An agent window shows agent-2 on host-1; host-1 is removed.',
      fixtures: [{ name: 'agent-1' }],
      quietMs: 1000,
      async run() {
        const b = t.booted()
        const win = b.openAgentWindow()
        const open = b.electron.handlers.get(IPC.FILE_OPEN)!
        await open({ sender: { id: win.id } }, { filePath: b.remoteAgents['agent-2'].filePath })
        expect(b.handle.windows.current(win.id)).toMatchObject({ filePath: b.remoteAgents['agent-2'].filePath })
        const ends = () => b.proxy.authorized.filter((r) => / DELETE \/client\/sessions\//.test(r)).length
        await b.forgetRemote()
        await b.until(() => b.handle.runtimes.get(REMOTE) === null, 'host-1 leaves the set')
        expect(b.closedAgentWindows).toEqual([{ id: win.id, keep: false }])
        // Its session and the main window's on host-1 ended there.
        expect(ends()).toBeGreaterThanOrEqual(2)
        expect(() => b.handle.runtimes.contextFor(win.id, null)).toThrow('This agent window is closed.')
      },
    }
    await runScenario(scenario, t.backend)
  }, 180_000)

  it('quit with the remote unreachable stays within the session-end budget', async () => {
    const { AGENT_SESSION_END_TIMEOUT_MS } = await import('../../../src/main/backend/daemon-mode/index')
    const t = capture({ keepDaemonRunning: true })
    const scenario: ParityScenario = {
      name: 'multi-quit-unreachable',
      description: 'host-1 stops answering without closing its connections; Studio quits.',
      fixtures: [{ name: 'agent-1' }],
      quietMs: 1000,
      async run() {
        const b = t.booted()
        b.openAgentWindow()
        b.proxy.blackhole = true
        const started = Date.now()
        await b.handle.shutdown()
        expect(Date.now() - started).toBeLessThan(AGENT_SESSION_END_TIMEOUT_MS * 2 + 2_000)
      },
    }
    await runScenario(scenario, t.backend)
  }, 180_000)
})
