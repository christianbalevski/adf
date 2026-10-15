import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { MockLLMProvider } from '../../src/main/runtime/headless'
import { assembleAgent, type AssembledAgent } from '../../src/main/runtime/assemble-agent'
import type { AgentProfileName } from '../../src/main/runtime/agent-capability-profiles'
import { ToolRegistry } from '../../src/main/tools/tool-registry'

/**
 * A startup dispatch that runs after the agent was stopped or disposed
 * (embedded AGENT_START schedules it on process.nextTick; AGENT_STOP or
 * EMERGENCY_STOP can tear the agent down first). Parity allowlist entries
 * e3:stop-startup-dispatch-error and e3:emergency-stop-startup-dispatch-error.
 */

const agents: Array<AssembledAgent<AgentProfileName>> = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const agent of agents.splice(0).reverse()) await agent.disposeAsync({ mode: 'immediate' })
  for (const dir of tempDirs.splice(0).reverse()) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeAgent(startInState: 'active' | 'idle') {
  const dir = mkdtempSync(join(tmpdir(), 'adf-startup-after-stop-'))
  tempDirs.push(dir)
  const workspace = AdfWorkspace.create(join(dir, 'agent-1.adf'), {
    name: 'agent-1',
    autonomous: false,
    start_in_state: startInState,
  })
  const agent = assembleAgent({
    profile: 'headlessLive',
    workspace,
    config: workspace.getAgentConfig(),
    provider: new MockLLMProvider({ tokensPerResponse: 4 }),
    registry: new ToolRegistry(),
  })
  agents.push(agent as AssembledAgent<AgentProfileName>)
  return agent
}

describe('startup dispatch after the agent was torn down', () => {
  for (const startInState of ['idle', 'active'] as const) {
    it(`rejects after stop (start_in_state ${startInState})`, async () => {
      const agent = makeAgent(startInState)
      await agent.start()
      await agent.stop({ mode: 'graceful' })
      await expect(agent.dispatchStartup()).rejects.toThrow('Cannot dispatch startup while agent lifecycle is stopped')
    })

    it(`rejects after dispose (start_in_state ${startInState})`, async () => {
      const agent = makeAgent(startInState)
      await agent.start()
      await agent.disposeAsync({ mode: 'graceful' })
      await expect(agent.dispatchStartup()).rejects.toThrow('Cannot dispatch startup while agent lifecycle is disposed')
    })
  }

  it('rejects before start', async () => {
    const agent = makeAgent('idle')
    await expect(agent.dispatchStartup()).rejects.toThrow('Cannot dispatch startup while agent lifecycle is created')
  })
})
