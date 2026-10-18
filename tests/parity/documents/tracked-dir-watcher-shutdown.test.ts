import { describe, expect, it } from 'vitest'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend } from '../harness/backend'
import { runScenario, type ParityScenario } from '../harness/scenario'

/**
 * E3 (found by W3-A's review-accept-foreign scenario): embedded Studio's quit
 * path, `cleanupAllProcesses`, closes the tracked-folder watcher
 * (`startDirWatcher`, chokidar). Before the fix it never called
 * `stopDirWatcher`, so a session that tracked a folder left the watcher open
 * after quit; the harness fails a run on any watcher still open.
 */
const trackAndQuit: ParityScenario = {
  name: 'track-and-quit',
  description: 'Studio tracks the agents folder (TRACKED_DIRS_GET starts the watcher), then quits.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 50,
  async run(ctx) {
    const dir = ctx.env.agentsDir
    ctx.setDialogs({ showOpenDialog: () => ({ canceled: false, filePaths: [dir] }) })
    await ctx.invoke(IPC.TRACKED_DIRS_ADD)
  },
}

describe('E3: embedded quit closes the tracked-folder watcher', () => {
  it('leaves no file watcher open after cleanupAllProcesses', async () => {
    const result = await runScenario(trackAndQuit, embeddedBackend)
    expect(result.raw.scenario).toBe('track-and-quit')
  }, 60_000)
})
