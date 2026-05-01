import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { MeshManager } from '../src/main/runtime/mesh-manager'

describe('daemon mesh serving', () => {
  it('registers a headless runtime agent as servable by handle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mesh-serving-'))
    const filePath = join(dir, 'agent-1.adf')
    const agent = createHeadlessAgent({
      filePath,
      name: 'agent-1',
      provider: new MockLLMProvider(),
      createOptions: { handle: 'agent-1' },
    })
    const meshManager = new MeshManager([dir])
    meshManager.enableMesh()

    try {
      meshManager.registerServableAgent(
        filePath,
        agent.workspace.getAgentConfig(),
        agent.registry,
        agent.workspace,
        agent.session,
        agent.executor,
      )

      const servable = meshManager.getServableAgent('agent-1')
      expect(servable).toEqual(expect.objectContaining({
        handle: 'agent-1',
        filePath,
        workspace: agent.workspace,
      }))
      expect(agent.registry.get('msg_send')).toBeTruthy()
      expect(agent.registry.get('agent_discover')).toBeTruthy()
      expect(agent.workspace.getAgentConfig().tools.map(t => t.name)).toEqual(expect.arrayContaining([
        'msg_send',
        'agent_discover',
      ]))
      expect(meshManager.getServableAgents()).toHaveLength(1)
    } finally {
      meshManager.unregisterAgent(filePath)
      agent.dispose()
    }
  })
})
