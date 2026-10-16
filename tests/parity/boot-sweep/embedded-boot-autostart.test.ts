import { describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend } from '../harness/backend'
import { runScenario, type ParityScenario } from '../harness/scenario'

/**
 * Characterization (before the W5-I E3 change): embedded Studio's boot
 * autostart starts an agent set to autostart in a tracked folder, once the
 * mesh boot finished.
 */

type Status = { agents: Array<{ filePath: string }>; starting: string[] }

/** Boot with agent-1 (autostart) in the tracked agents folder; record what runs after `waitMs`. */
export function bootAutostartScenario(seen: Status[], waitMs: number): ParityScenario {
  return {
    name: 'w5i-embedded-boot-autostart',
    description: 'Boot embedded Studio with agent-1 set to autostart in the tracked agents folder.',
    fixtures: [{ name: 'agent-1', autostart: true }],
    settings: (env) => ({ trackedDirectories: [env.agentsDir] }),
    quietMs: 500,
    async run(ctx) {
      const deadline = Date.now() + waitMs
      let status = await ctx.invoke<Status>(IPC.BACKGROUND_AGENT_STATUS)
      while (Date.now() < deadline && !status.agents.some((a) => a.filePath.endsWith('agent-1.adf'))) {
        await new Promise((r) => setTimeout(r, 100))
        status = await ctx.invoke<Status>(IPC.BACKGROUND_AGENT_STATUS)
      }
      seen.push(status)
      // Stop it, so the run ends quiet.
      if (status.agents.length > 0) await ctx.invoke(IPC.BACKGROUND_AGENT_STOP, { filePath: ctx.agent('agent-1').filePath })
    },
  }
}

describe('embedded boot autostart (characterization)', () => {
  it('starts the agent set to autostart in a tracked folder', async () => {
    const seen: Status[] = []
    await runScenario(bootAutostartScenario(seen, 15_000), embeddedBackend)
    expect(seen[0].agents.map((a) => a.filePath)).toEqual([expect.stringMatching(/agent-1\.adf$/)])
  }, 60_000)
})
