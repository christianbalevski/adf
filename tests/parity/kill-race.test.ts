import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { embeddedBackend, type ParityBackend } from './harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from './harness/daemon-backend'
import { runScenario, type ParityScenario } from './harness/scenario'

/**
 * Kill is guaranteed: what the owner does while a Kill runs cannot bring an
 * agent back. Both races run against embedded Studio and Studio on the
 * daemon (when out/main/daemon.js is built). No recording: the assertions
 * are on what the runtime answers once the Kill is done.
 */

type Status = { running?: boolean }
type Background = { agents?: unknown[] }
type Start = { success?: boolean; code?: string }

/**
 * The reported bug: Kill, then (while it tears down) open a background agent;
 * the renderer re-attaches it. It must not survive the Kill.
 */
function foregroundDuringKill(seen: { status?: Status; background?: Background; reattach?: Start | null }): ParityScenario {
  return {
    name: 'kill-race-foreground-background-agent',
    description: 'agent-2 runs in the background; Kill, and open agent-2 while the Kill runs.',
    fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
    quietMs: 500,
    llm: () => ({ text: 'ok' }),
    async run(ctx) {
      const one = ctx.agent('agent-1')
      const two = ctx.agent('agent-2')
      await ctx.invoke(IPC.FILE_OPEN, { filePath: one.filePath })
      await ctx.invoke(IPC.AGENT_START, { filePath: one.filePath, hasUserMessage: false })
      expect(await ctx.invoke<Start>(IPC.BACKGROUND_AGENT_START, { filePath: two.filePath })).toMatchObject({ success: true })

      const killed = ctx.invoke(IPC.EMERGENCY_STOP)
      // useAdfFile.openFile: FILE_OPEN, then the re-attach when it ran.
      const opened = await ctx.invoke<{ agentWasRunning?: boolean }>(IPC.FILE_OPEN, { filePath: two.filePath })
      seen.reattach = opened.agentWasRunning ? await ctx.invoke<Start>(IPC.AGENT_START, { reattachOnly: true }) : null
      await killed

      seen.status = await ctx.invoke<Status>(IPC.AGENT_STATUS)
      seen.background = await ctx.invoke<Background>(IPC.BACKGROUND_AGENT_STATUS)
    },
  }
}

/** A Start already building the agent when the Kill begins is not installed after it. */
function startDuringKill(seen: { start?: Start; status?: Status }): ParityScenario {
  return {
    name: 'kill-race-start-in-flight',
    description: 'Start agent-1 and Kill while the start builds it.',
    fixtures: [{ name: 'agent-1' }],
    quietMs: 500,
    llm: () => ({ text: 'ok' }),
    async run(ctx) {
      const one = ctx.agent('agent-1')
      await ctx.invoke(IPC.FILE_OPEN, { filePath: one.filePath })
      const starting = ctx.invoke<Start>(IPC.AGENT_START, { filePath: one.filePath, hasUserMessage: false })
      await ctx.invoke(IPC.EMERGENCY_STOP)
      seen.start = await starting
      seen.status = await ctx.invoke<Status>(IPC.AGENT_STATUS)
    },
  }
}

const backends: Array<[string, ParityBackend, boolean]> = [
  ['embedded', embeddedBackend, true],
  ['daemon', daemonBackend(), existsSync(DAEMON_BUNDLE)],
  // The reported case: Studio on a remote runtime.
  ['remote', daemonBackend({ remote: true }), existsSync(DAEMON_BUNDLE)],
]

for (const [name, backend, available] of backends) {
  describe.skipIf(!available)(`Kill races: ${name}`, () => {
    it('a background agent opened while the Kill runs does not survive it', async () => {
      const seen: { status?: Status; background?: Background; reattach?: Start | null } = {}
      await runScenario(foregroundDuringKill(seen), backend, { tolerant: true })
      expect(seen.status?.running).toBe(false)
      expect(seen.background?.agents).toEqual([])
      if (seen.reattach) expect(seen.reattach.success).toBe(false)
    }, 120_000)

    it('a start in flight when the Kill begins leaves no agent running', async () => {
      const seen: { start?: Start; status?: Status } = {}
      await runScenario(startDuringKill(seen), backend, { tolerant: true })
      expect(seen.status?.running).toBe(false)
    }, 120_000)
  })
}
