import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend, embeddedBackendWith } from '../harness/backend'
import { runScenario, type ParityScenario } from '../harness/scenario'

/**
 * Characterization (before the W5-I E3 follow-up): embedded Studio's
 * tracked-folder watcher starts a new `.adf` set to autostart when it
 * appears in a tracked folder.
 *
 * E3 (W5-I): with `IpcHostHooks.skipBootAutostart` (an older ADF daemon
 * runs these settings' agents) the watcher does not start it either.
 */

type Status = { agents: Array<{ filePath: string }>; starting: string[] }

/** Track `<root>/tracked`; once the watcher runs, copy agent-2 (autostart) into it; record what runs after `waitMs`. */
export function watcherAutostartScenario(seen: Status[], waitMs: number): ParityScenario {
  return {
    name: 'w5i-embedded-watcher-autostart',
    description: 'A new agent set to autostart appears in a tracked folder of embedded Studio.',
    fixtures: [{ name: 'agent-2', autostart: true }],
    settings: (env) => {
      const tracked = join(env.root, 'tracked')
      mkdirSync(tracked, { recursive: true })
      return { trackedDirectories: [tracked] }
    },
    quietMs: 500,
    async run(ctx) {
      // The sidebar's first read starts the watcher; let it finish its initial scan, so the copy is a new file.
      await ctx.invoke(IPC.TRACKED_DIRS_GET)
      await new Promise((r) => setTimeout(r, 1500))
      const copy = join(ctx.env.root, 'tracked', 'agent-2.adf')
      copyFileSync(ctx.agent('agent-2').filePath, copy)
      const deadline = Date.now() + waitMs
      let status = await ctx.invoke<Status>(IPC.BACKGROUND_AGENT_STATUS)
      while (Date.now() < deadline && status.agents.length === 0) {
        await new Promise((r) => setTimeout(r, 100))
        status = await ctx.invoke<Status>(IPC.BACKGROUND_AGENT_STATUS)
      }
      seen.push(status)
      for (const agent of status.agents) await ctx.invoke(IPC.BACKGROUND_AGENT_STOP, { filePath: agent.filePath })
    },
  }
}

describe('embedded tracked-folder watcher autostart (characterization)', () => {
  it('starts a new agent set to autostart that appears in a tracked folder', async () => {
    const seen: Status[] = []
    await runScenario(watcherAutostartScenario(seen, 15_000), embeddedBackend)
    expect(seen[0].agents.map((a) => a.filePath)).toEqual([expect.stringMatching(/tracked[\\/]agent-2\.adf$/)])
  }, 60_000)
})

describe('embedded watcher autostart skipped by the host (E3, W5-I)', () => {
  it('does not start the new agent, and says why in the log', async () => {
    const warned: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(String(args[0])) })
    const seen: Status[] = []
    try {
      await runScenario(watcherAutostartScenario(seen, 4_000), embeddedBackendWith({ skipBootAutostart: 'an older ADF daemon runs the agents of these settings' }))
    } finally {
      warn.mockRestore()
    }
    expect(seen[0]).toEqual({ agents: [], starting: [] })
    expect(warned).toContain('[autostart] Watcher autostart skipped for agent-2.adf: an older ADF daemon runs the agents of these settings')
  }, 60_000)
})
