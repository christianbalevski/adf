import { describe, expect, it, vi } from 'vitest'
import { ComputeExecTool, describeNotReady } from '../../../src/main/tools/built-in/compute-exec.tool'
import type { PodmanService } from '../../../src/main/services/podman.service'

function tool(podman: Partial<PodmanService>) {
  return new ComputeExecTool(podman as PodmanService, {
    hasIsolated: true,
    hasShared: false,
    hasHost: false,
    allowedTargets: ['isolated'],
    defaultTarget: 'isolated',
    isolatedContainerName: 'adf-agent-12345678',
    agentName: 'Agent',
    agentId: 'agent-1',
    pipPackages: ['requests'],
    browserDisplay: true,
  })
}

describe('compute_exec isolated container phases', () => {
  it('tells the agent to wait while the container is provisioning instead of running podman', async () => {
    const execInContainer = vi.fn()
    const result = await tool({
      containerPhase: vi.fn().mockResolvedValue({ phase: 'provisioning', detail: 'Installing packages (a minute or two)' }),
      execInContainer,
    }).execute({ command: 'ls' }, {} as any)

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/still being set up \(installing packages/)
    expect(execInContainer).not.toHaveBeenCalled()
  })

  it('names the failure and the owner action when setup failed', async () => {
    const result = await tool({
      containerPhase: vi.fn().mockResolvedValue({ phase: 'failed', detail: 'Package installation failed in adf-agent-12345678: E: not valid yet' }),
      execInContainer: vi.fn(),
    }).execute({ command: 'ls' }, {} as any)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('could not be set up: Package installation failed')
    expect(result.content).toContain('Settings → Compute')
  })

  it('brings an absent container back with the agent identity, then runs the command', async () => {
    const ensureIsolatedRunning = vi.fn().mockResolvedValue(undefined)
    const execInContainer = vi.fn().mockResolvedValue({ stdout: 'hi', stderr: '', code: 0 })
    const result = await tool({
      containerPhase: vi.fn().mockResolvedValue({ phase: 'absent' }),
      ensureIsolatedRunning,
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      execInContainer,
    }).execute({ command: 'echo hi' }, {} as any)

    expect(ensureIsolatedRunning).toHaveBeenCalledWith('Agent', 'agent-1', ['requests'], undefined, true)
    expect(execInContainer).toHaveBeenCalled()
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ exit_code: 0, stdout: 'hi' })
  })

  it('reports the phase instead of raw podman stderr when the container dies mid-session', async () => {
    const phases = [{ phase: 'ready' }, { phase: 'stopped' }]
    const result = await tool({
      containerPhase: vi.fn().mockImplementation(async () => phases.shift()),
      ensureWorkspace: vi.fn().mockResolvedValue(undefined),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: 'Error: can only create exec sessions on running containers: container state improper', code: 1 }),
    }).execute({ command: 'ls' }, {} as any)

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/^Your isolated container is stopped/)
  })

  it('has wording for every non-ready phase', () => {
    for (const phase of ['provisioning', 'starting', 'failed', 'stopped', 'absent'] as const) {
      expect(describeNotReady(phase)).toEqual(expect.any(String))
    }
    expect(describeNotReady('ready')).toBeNull()
  })
})
