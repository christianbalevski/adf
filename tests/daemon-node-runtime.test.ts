import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'

describe('daemon runtime under plain Node', () => {
  it('autostarts an active agent without an Electron app object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-node-'))
    const filePath = join(dir, 'plain-node.adf')
    const created = createHeadlessAgent({
      filePath,
      name: 'plain-node',
      provider: new MockLLMProvider(),
      createOptions: { autostart: true },
    })
    const agentId = created.workspace.getAgentConfig().id
    created.dispose()

    const provider = new MockLLMProvider({ tokensPerResponse: 120 })
    const runtime = new RuntimeService({
      settings: {
        get: key => key === 'reviewedAgents' ? [agentId] : undefined,
      },
      providerFactory: () => provider,
    })

    const report = await runtime.autostartFromDirectories([dir], { maxDepth: 0 })

    expect(report.failed).toEqual([])
    expect(report.started).toEqual([
      expect.objectContaining({ agentId, startupTriggered: true }),
    ])
    expect(runtime.listAgents()).toEqual([
      expect.objectContaining({ id: agentId, name: 'plain-node' }),
    ])
    expect(provider.getCallCount()).toBe(1)

    await runtime.unloadAgent(agentId)
  })
})
