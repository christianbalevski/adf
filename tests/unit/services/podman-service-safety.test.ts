import { describe, expect, it, vi } from 'vitest'
import { PodmanService } from '../../../src/main/services/podman.service'

describe('PodmanService managed container safety', () => {
  it('returns structured ownership and assignment metadata', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).exec0 = vi.fn().mockResolvedValue({
      code: 0,
      stderr: '',
      stdout: 'abc123|adf-research-12345678|running|Up 2 hours|node:20-slim|2026-07-21 08:00:00|io.adf.managed=true,io.adf.kind=agent,io.adf.agent-id=agent-1,io.adf.agent-name=Research',
    })

    await expect(service.listContainers()).resolves.toEqual([expect.objectContaining({
      id: 'abc123',
      name: 'adf-research-12345678',
      running: true,
      image: 'node:20-slim',
      managed: true,
      scope: 'dedicated',
      agentId: 'agent-1',
      agentName: 'Research',
    })])
  })

  it('refuses lifecycle changes for unlabeled containers', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0

    await expect(service.stopContainer('adf-user-container')).rejects.toThrow('not labeled as ADF-managed')
    expect(exec0).toHaveBeenCalledTimes(1)
    expect(exec0.mock.calls[0][1][0]).toBe('inspect')
  })

  it('installs only declared pip packages without shell interpolation', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0

    await (service as any).ensurePipPackages('/usr/bin/podman', 'adf-agent-12345678', ['requests==2.32.4', 'httpx'])

    expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', [
      'exec', 'adf-agent-12345678', 'python3', '-m', 'pip', 'install',
      '--disable-pip-version-check', '--break-system-packages', 'requests==2.32.4', 'httpx',
    ], 300_000)
  })

  it('redacts environment values from inspect output', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'inspect') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify([{ Id: 'abc', Name: '/adf-mcp', State: { Status: 'running' }, Config: { Image: 'node:20', Env: ['TOKEN=secret-value', 'MODE=dev'] } }]),
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

    const detail = await service.getContainerDetail('adf-mcp')
    expect(detail.inspect).toContain('TOKEN=<redacted>')
    expect(detail.inspect).not.toContain('secret-value')
  })
})
