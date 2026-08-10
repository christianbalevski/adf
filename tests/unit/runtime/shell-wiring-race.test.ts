/**
 * Singleton-shell wiring across assembly lifecycles.
 *
 * assembleAgent reuses a ShellTool already present in the registry
 * (registry.get('adf_shell')) and re-points its callbacks at the new
 * executor; cleanupWiring on teardown sets them to undefined. When two
 * lifecycles share one registry (reassemble/config-change/restart race —
 * same class as the MCP config-clobber), a LATE teardown of the old
 * lifecycle must not strip the callbacks the new lifecycle just wired:
 * that would leave a live agent with no protection-HIL path (denials
 * become flat errors with no human override, or worse if a future
 * refactor keys any bypass off the callback's absence).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { assembleAgent } from '../../../src/main/runtime/assemble-agent'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import type { ShellTool } from '../../../src/main/tools/shell/shell.tool'

const tempDirs: string[] = []
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function makeWorkspace(name: string): AdfWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'adf-wiring-race-'))
  tempDirs.push(dir)
  return AdfWorkspace.create(join(dir, 'agent.adf'), { name, autonomous: false })
}

describe('shell singleton wiring across lifecycles', () => {
  it('late teardown of an old lifecycle must not strip the new lifecycle\'s protection wiring', async () => {
    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    const ws1 = makeWorkspace('lifecycle-one')
    const agent1 = assembleAgent({
      profile: 'headlessLive',
      workspace: ws1,
      config: ws1.getAgentConfig(),
      provider: new MockLLMProvider(),
      registry,
      ownsWorkspace: true,
    })
    await agent1.start()

    const shell = registry.get('adf_shell') as ShellTool
    expect(shell.onProtectionBlocked).toBeDefined()

    // Second lifecycle adopts the same registry (and thus the same ShellTool)
    // and re-wires it to its own executor.
    const ws2 = makeWorkspace('lifecycle-two')
    const agent2 = assembleAgent({
      profile: 'headlessLive',
      workspace: ws2,
      config: ws2.getAgentConfig(),
      provider: new MockLLMProvider(),
      registry,
      ownsWorkspace: true,
    })
    await agent2.start()
    expect(shell.onProtectionBlocked).toBeDefined()

    // The OLD lifecycle tears down AFTER the new one wired the shared shell.
    await agent1.disposeAsync({ mode: 'immediate' })

    // The live agent (agent2) must still have its protection-HIL callback.
    expect(shell.onProtectionBlocked, 'old teardown clobbered the live agent\'s protection wiring').toBeDefined()
    expect(shell.onApprovalRequired, 'old teardown clobbered the live agent\'s approval wiring').toBeDefined()
    expect(shell.onToolCallIntercepted, 'old teardown clobbered the live agent\'s interception wiring').toBeDefined()

    await agent2.disposeAsync({ mode: 'immediate' })
    // Once the owning (last-wired) lifecycle is gone, the callbacks are cleared.
    expect(shell.onProtectionBlocked).toBeUndefined()
  })
})
