import { describe, expect, it, vi } from 'vitest'
import {
  PodmanService,
  normalizeBrowserHostIdentity,
  selectBrowserRuntimeCompatibility,
} from '../../../src/main/services/podman.service'

describe('browser container platform compatibility', () => {
  it('normalizes host timezone and locale hints without accepting shell input', () => {
    expect(normalizeBrowserHostIdentity('America/New_York', 'en-US')).toEqual({
      timezone: 'America/New_York',
      locale: 'en-US',
    })
    expect(normalizeBrowserHostIdentity('UTC; touch /tmp/nope', 'en-US;bad')).toEqual({
      timezone: 'UTC',
      locale: 'en-US',
    })
  })

  it('masks SME on Apple Silicon VMs that advertise SME without SVE', () => {
    expect(selectBrowserRuntimeCompatibility('darwin', 'arm64', ['fp', 'asimd', 'sme', 'sme2'])).toEqual({
      maskSme: true,
      reason: 'arm64-sme-without-sve',
    })
  })

  it('masks SME conservatively when Apple Silicon VM features cannot be read', () => {
    expect(selectBrowserRuntimeCompatibility('darwin', 'aarch64')).toEqual({
      maskSme: true,
      reason: 'arm64-features-unknown',
    })
  })

  it.each([
    ['darwin', 'amd64', ['sme']],
    ['win32', 'amd64', undefined],
    ['linux', 'amd64', undefined],
    ['darwin', 'arm64', ['fp', 'asimd', 'sme', 'sve']],
  ] as const)('keeps the native runtime on %s/%s when compatible', (host, arch, features) => {
    expect(selectBrowserRuntimeCompatibility(host, arch, features)).toEqual({})
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

  it('creates a native container with the process-local Chromium compatibility wrapper', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'not found' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({
      maskSme: true,
      reason: 'arm64-sme-without-sve',
    })
    ;(service as any).allocateNovncPort = vi.fn().mockResolvedValue(36080)
    ;(service as any).ensureBrowserCompatibility = vi.fn().mockResolvedValue(undefined)
    ;(service as any).verifyBrowserRuntime = vi.fn().mockResolvedValue(undefined)
    ;(service as any).ensureBrowserStack = vi.fn().mockResolvedValue(undefined)

    await (service as any).ensureContainerRunning('/usr/bin/podman', 'adf-agent-12345678', {
      kind: 'agent',
      agentId: 'agent-1',
      agentName: 'Agent',
      browser: true,
    })

    const runCall = exec0.mock.calls.find(([, args]) => args[0] === 'run')
    expect(runCall?.[1]).toEqual(expect.arrayContaining([
      'io.adf.runtime.platform=native',
      'io.adf.runtime.browser-compat=mask-sme',
      'io.adf.runtime.schema=4',
      'PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium',
      'CHROME_BIN=/usr/local/bin/chromium',
      'PLAYWRIGHT_MCP_CDP_ENDPOINT=http://127.0.0.1:9222',
    ]))
    expect(runCall?.[1]).not.toContain('--platform')
    expect((service as any).ensureBrowserCompatibility).toHaveBeenCalled()
    expect((service as any).ensureBrowserStack).toHaveBeenCalled()
  })

  it('upgrades a preexisting running container in place', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: 'true', stderr: '' })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({ maskSme: true })
    ;(service as any).ensureBrowserCompatibility = vi.fn().mockResolvedValue(undefined)
    ;(service as any).verifyBrowserRuntime = vi.fn().mockResolvedValue(undefined)
    ;(service as any).ensureBrowserStack = vi.fn().mockResolvedValue(undefined)

    await (service as any).ensureContainerRunning('/usr/bin/podman', 'adf-agent-12345678', {
      kind: 'agent',
      agentId: 'agent-1',
      agentName: 'Agent',
      browser: true,
    })

    expect(exec0).not.toHaveBeenCalledWith('/usr/bin/podman', expect.arrayContaining(['rename']), expect.anything())
    expect(exec0).not.toHaveBeenCalledWith('/usr/bin/podman', expect.arrayContaining(['run']), expect.anything())
    expect((service as any).ensureBrowserCompatibility).toHaveBeenCalledWith(
      '/usr/bin/podman', 'adf-agent-12345678', { maskSme: true },
    )
  })

  it('runs the renderer probe without inheriting the visible DISPLAY', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0
    await (service as any).verifyBrowserRuntime('/usr/bin/podman', 'adf-agent-12345678')

    const probeCall = exec0.mock.calls.find(([, args]) => args[0] === 'exec' && args[4]?.includes('adf-browser-probe'))
    expect(probeCall?.[1][4]).toContain('env -u DISPLAY chromium')
  })

  it('shares one display readiness gate across concurrent callers', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'getNovncHostPort').mockResolvedValue(36080)
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
    ;(service as any).exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: 'yes', stderr: '' })

    const first = (service as any).ensureBrowserStack('adf-agent-12345678')
    const second = (service as any).ensureBrowserStack('adf-agent-12345678')

    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect((service as any)._stackStarted.has('adf-agent-12345678')).toBe(true)
  })

  it('provides the Chromium wrapper path to container MCP transports', async () => {
    const service = new PodmanService()
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
    ;(service as any).getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({ maskSme: true })

    await expect(service.getBrowserRuntimeEnv()).resolves.toEqual({
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:9222',
      TZ: expect.any(String),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PUPPETEER_EXECUTABLE_PATH: '/usr/local/bin/chromium',
      CHROME_BIN: '/usr/local/bin/chromium',
    })
  })

  it('starts ADF-owned Chromium with a persistent profile and loopback-only CDP', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'exec' && args[2] === 'wget') {
        return { code: 1, stdout: '', stderr: 'not ready' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({})
    ;(service as any).getBrowserHostIdentity = vi.fn().mockReturnValue({ timezone: 'America/New_York', locale: 'en-US' })

    await (service as any).ensureManagedBrowser('/usr/bin/podman', 'adf-agent-12345678')

    const startCall = exec0.mock.calls.find(([, args]) => args[0] === 'exec' && args[1] === '-d')
    const command = startCall?.[1][5] ?? ''
    expect(command).toContain("export TZ='America/New_York'")
    expect(command).toContain("--user-data-dir='/var/lib/adf/browser-profile'")
    expect(command).toContain('--remote-debugging-address=127.0.0.1')
    expect(command).toContain('--remote-debugging-port=9222')
    expect(command).not.toContain('--enable-automation')
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
