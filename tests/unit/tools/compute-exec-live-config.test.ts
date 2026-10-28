import { describe, expect, it, vi } from 'vitest'
import { ComputeExecTool } from '../../../src/main/tools/built-in/compute-exec.tool'
import { buildComputeCapabilities, liveComputeCapabilities, type ComputeCapabilityInputs } from '../../../src/main/tools/built-in/compute-capabilities'
import type { PodmanService } from '../../../src/main/services/podman.service'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

const AGENT_ID = '3f1c9a2e-7b4d-4e8a-9c6f-1a2b3c4d5e6f'

function makeConfig(compute: AgentConfig['compute']): AgentConfig {
  return { name: 'agent-1', id: AGENT_ID, compute } as AgentConfig
}

function setup(podman: Partial<PodmanService>) {
  let config = makeConfig({ enabled: false })
  const inputs = (): ComputeCapabilityInputs => ({
    podmanService: podman as PodmanService,
    computeSettings: {},
    runtimeHostAllowed: false,
  })
  const caps = liveComputeCapabilities(buildComputeCapabilities(config, inputs()), () => config, inputs, 'C:/agents/agent-1.adf')
  const tool = new ComputeExecTool(podman as PodmanService, caps)
  return { tool, setConfig: (next: AgentConfig) => { config = next } }
}

describe('compute_exec follows config changes made mid-run', () => {
  it('moves from the shared container to the isolated one when the agent enables compute', async () => {
    const execInContainer = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    const ensureIsolatedRunning = vi.fn().mockResolvedValue(undefined)
    const { tool, setConfig } = setup({
      containerPhase: vi.fn().mockResolvedValue({ phase: 'ready' }),
      ensureIsolatedRunning,
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      execInContainer,
    })

    expect(tool.description).toContain('Commands run in shared.')
    const before = await tool.execute({ command: 'hostname' }, {} as any)
    expect(JSON.parse(before.content).target).toBe('shared')
    expect(execInContainer).toHaveBeenLastCalledWith('adf-mcp', `/workspace/${AGENT_ID}`, 'hostname', expect.any(Number))

    setConfig(makeConfig({ enabled: true, allowed_targets: ['isolated'], default_target: 'isolated' }))

    expect(tool.description).toContain('Commands run in isolated.')
    expect(tool.description).toContain('DISPLAY=:99')
    // Enabling brings the container up right away, so the Computer tab can show it.
    await Promise.resolve()
    expect(ensureIsolatedRunning).toHaveBeenCalledWith('agent-1', AGENT_ID, [], 'C:/agents/agent-1.adf', true)

    const after = await tool.execute({ command: 'hostname' }, {} as any)
    expect(JSON.parse(after.content).target).toBe('isolated')
    expect(execInContainer).toHaveBeenLastCalledWith('adf-agent-1-3f1c9a2e', '/workspace', 'hostname', expect.any(Number))
    expect(ensureIsolatedRunning).toHaveBeenCalledTimes(1)
  })

  it('offers a target choice once more than one is allowed', () => {
    const { tool, setConfig } = setup({
      ensureIsolatedRunning: vi.fn().mockResolvedValue(undefined),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
    })
    expect(tool.toProviderFormat().input_schema.properties).not.toHaveProperty('target')
    setConfig(makeConfig({ enabled: true, allowed_targets: ['isolated', 'shared'], default_target: 'isolated' }))
    expect(tool.toProviderFormat().input_schema.properties).toHaveProperty('target')
    expect(tool.description).toContain('Available targets: isolated, shared. Default target: isolated.')
  })
})
