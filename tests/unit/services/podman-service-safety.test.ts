import { describe, expect, it, vi } from 'vitest'
import {
  PodmanService,
  selectBrowserContainerPlatform,
} from '../../../src/main/services/podman.service'

describe('browser container platform compatibility', () => {
  it('uses amd64 on Apple Silicon VMs that advertise SME without SVE', () => {
    expect(selectBrowserContainerPlatform('darwin', 'arm64', ['fp', 'asimd', 'sme', 'sme2'])).toEqual({
      platform: 'linux/amd64',
      reason: 'arm64-sme-without-sve',
    })
  })

  it('uses amd64 conservatively when Apple Silicon VM features cannot be read', () => {
    expect(selectBrowserContainerPlatform('darwin', 'aarch64')).toEqual({
      platform: 'linux/amd64',
      reason: 'arm64-features-unknown',
    })
  })

  it.each([
    ['darwin', 'amd64', ['sme']],
    ['win32', 'amd64', undefined],
    ['linux', 'amd64', undefined],
    ['darwin', 'arm64', ['fp', 'asimd', 'sme', 'sve']],
  ] as const)('keeps the native runtime on %s/%s when compatible', (host, arch, features) => {
    expect(selectBrowserContainerPlatform(host, arch, features)).toEqual({})
  })
})

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

  it('hides preserved compatibility backups from the normal container list', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).exec0 = vi.fn().mockResolvedValue({
      code: 0,
      stderr: '',
      stdout: 'abc123|adf-internal-compat-backup--abc--adf-research-12345678|exited|Exited|node:20-slim|2026-07-21 08:00:00|io.adf.managed=true,io.adf.kind=agent',
    })

    await expect(service.listContainers()).resolves.toEqual([])
  })

  it('creates Apple Silicon compatibility containers with an explicit amd64 platform', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'not found' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { code: 0, stdout: 'arm64', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserPlatformSelection = vi.fn().mockResolvedValue({
      platform: 'linux/amd64',
      reason: 'arm64-sme-without-sve',
    })
    ;(service as any).allocateNovncPort = vi.fn().mockResolvedValue(36080)
    ;(service as any).verifyBrowserRuntime = vi.fn().mockResolvedValue(undefined)
    ;(service as any).ensureBrowserStack = vi.fn()

    await (service as any).ensureContainerRunning('/usr/bin/podman', 'adf-agent-12345678', {
      kind: 'agent',
      agentId: 'agent-1',
      agentName: 'Agent',
      browser: true,
    })

    expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', [
      'pull', '--platform', 'linux/amd64', 'docker.io/library/node:20-slim',
    ], 120_000)
    const runCall = exec0.mock.calls.find(([, args]) => args[0] === 'run')
    expect(runCall?.[1]).toEqual(expect.arrayContaining([
      '--platform', 'linux/amd64',
      'io.adf.runtime.platform=linux/amd64',
      'io.adf.runtime.schema=2',
    ]))
  })

  it('preserves and restores an existing native container before replacing it', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'container' && args[1] === 'inspect' && args.includes('{{.State.Running}}')) {
        return { code: 0, stdout: 'true', stderr: '' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { code: 0, stdout: 'amd64', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserPlatformSelection = vi.fn().mockResolvedValue({ platform: 'linux/amd64' })
    ;(service as any).getContainerArchitecture = vi.fn().mockResolvedValue('arm64')
    ;(service as any).archiveIncompatibleContainer = vi.fn().mockResolvedValue('adf-agent-12345678-compat-backup-test')
    ;(service as any).restoreWorkspaceFromBackup = vi.fn().mockResolvedValue(undefined)
    ;(service as any).allocateNovncPort = vi.fn().mockResolvedValue(36080)
    ;(service as any).verifyBrowserRuntime = vi.fn().mockResolvedValue(undefined)
    ;(service as any).ensureBrowserStack = vi.fn()

    await (service as any).ensureContainerRunning('/usr/bin/podman', 'adf-agent-12345678', {
      kind: 'agent',
      agentId: 'agent-1',
      agentName: 'Agent',
      browser: true,
    })

    expect((service as any).archiveIncompatibleContainer).toHaveBeenCalledWith(
      '/usr/bin/podman', 'adf-agent-12345678', 'arm64', 'linux/amd64',
    )
    expect((service as any).restoreWorkspaceFromBackup).toHaveBeenCalledWith(
      '/usr/bin/podman', 'adf-agent-12345678-compat-backup-test', 'adf-agent-12345678',
    )
  })

  it('rolls a migration back when the compatibility replacement cannot be created', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { code: 0, stdout: 'true', stderr: '' }
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return { code: 0, stdout: 'amd64', stderr: '' }
      }
      if (args[0] === 'run') {
        return { code: 1, stdout: '', stderr: 'Rosetta unavailable' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserPlatformSelection = vi.fn().mockResolvedValue({ platform: 'linux/amd64' })
    ;(service as any).getContainerArchitecture = vi.fn().mockResolvedValue('arm64')
    ;(service as any).archiveIncompatibleContainer = vi.fn().mockResolvedValue('adf-internal-compat-backup--test--adf-agent-12345678')
    ;(service as any).allocateNovncPort = vi.fn().mockResolvedValue(36080)

    await expect((service as any).ensureContainerRunning('/usr/bin/podman', 'adf-agent-12345678', {
      kind: 'agent',
      agentId: 'agent-1',
      agentName: 'Agent',
      browser: true,
    })).rejects.toThrow('Rosetta unavailable')

    expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', [
      'rename', 'adf-internal-compat-backup--test--adf-agent-12345678', 'adf-agent-12345678',
    ], 30_000)
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
