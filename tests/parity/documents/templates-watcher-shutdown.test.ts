import { describe, expect, it } from 'vitest'
import { embeddedBackend } from '../harness/backend'
import { runScenario, type ParityScenario } from '../harness/scenario'

/**
 * E3 (tracker §6, W0-F row): embedded Studio's quit path,
 * `cleanupAllProcesses`, stops the templates-folder watcher that
 * `registerAllIpcHandlers` starts (AgentTemplatesService.startWatcher).
 * Before the fix it never called `stopWatcher`, and the harness exempted
 * that one watcher from its leak check; now every watcher still open after
 * shutdown fails the run (harness/backend.ts releaseRunResources).
 */
const bootAndQuit: ParityScenario = {
  name: 'boot-and-quit',
  description: 'Studio boots and quits with nothing opened.',
  fixtures: [],
  quietMs: 50,
  async run() { /* nothing: boot, then quit */ },
}

describe('E3: embedded quit stops the templates-folder watcher', () => {
  it('leaves no file watcher open after cleanupAllProcesses', async () => {
    const result = await runScenario(bootAndQuit, embeddedBackend)
    expect(result.raw.scenario).toBe('boot-and-quit')
  }, 60_000)
})
