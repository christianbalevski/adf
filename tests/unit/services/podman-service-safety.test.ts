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
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
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
      '--init',
      'adf-npx-cache:/var/cache/adf-npm',
      'npm_config_cache=/var/cache/adf-npm',
      'io.adf.runtime.platform=native',
      'io.adf.runtime.browser-compat=mask-sme',
      'io.adf.runtime.schema=4',
      'PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium',
      'CHROME_BIN=/usr/local/bin/chromium',
      'PLAYWRIGHT_MCP_CDP_ENDPOINT=http://127.0.0.1:9222',
    ]))
    expect(runCall?.[1]).not.toContain('--platform')
    expect((service as any).ensureBrowserCompatibility).toHaveBeenCalled()
    // Browser bring-up is kicked off in the background, not awaited on the
    // container-start path — await the memoized promise to observe it.
    await service.browserReady('adf-agent-12345678')
    expect((service as any).ensureBrowserStack).toHaveBeenCalled()
  })

  it('upgrades a preexisting running container in place', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: 'true', stderr: '' })
    ;(service as any).exec0 = exec0
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
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

describe('PodmanService lifecycle hardening', () => {
  it('memoizes ensureRunning so repeated calls do no extra podman work', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    const ensureMachine = vi.fn().mockResolvedValue(undefined)
    const ensureContainerRunning = vi.fn().mockResolvedValue(undefined)
    ;(service as any).ensureMachine = ensureMachine
    ;(service as any).ensureContainerRunning = ensureContainerRunning

    const first = service.ensureRunning()
    const second = service.ensureRunning()
    expect(second).toBe(first)
    await first
    await service.ensureRunning()
    expect(ensureContainerRunning).toHaveBeenCalledTimes(1)
  })

  it('clears the ensureRunning memo on failure so recovery retries', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).ensureMachine = vi.fn().mockResolvedValue(undefined)
    const ensureContainerRunning = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    ;(service as any).ensureContainerRunning = ensureContainerRunning

    await expect(service.ensureRunning()).rejects.toThrow('boom')
    await expect(service.ensureRunning()).resolves.toBeUndefined()
    expect(ensureContainerRunning).toHaveBeenCalledTimes(2)
  })

  it('clears the ensureRunning memo when the shared container is observed dead', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).ensureMachine = vi.fn().mockResolvedValue(undefined)
    const ensureContainerRunning = vi.fn().mockResolvedValue(undefined)
    ;(service as any).ensureContainerRunning = ensureContainerRunning
    await service.ensureRunning()

    ;(service as any).noteContainerExec('adf-mcp', { code: 1, stderr: 'Error: container adf-mcp is not running' })
    await service.ensureRunning()
    expect(ensureContainerRunning).toHaveBeenCalledTimes(2)
  })

  it('caches ensureWorkspace per container+path until invalidated', async () => {
    const service = new PodmanService()
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0

    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    expect(exec0).toHaveBeenCalledTimes(1)

    await service.ensureWorkspace('adf-mcp', '/workspace/agent-2')
    expect(exec0).toHaveBeenCalledTimes(2)

    ;(service as any).invalidateContainer('adf-mcp')
    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    expect(exec0).toHaveBeenCalledTimes(3)
  })

  it('does not cache a failed ensureWorkspace', async () => {
    const service = new PodmanService()
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn()
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'exec failed' })
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0

    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    expect(exec0).toHaveBeenCalledTimes(2)
  })

  it('pendingStarts resolves only after in-flight starts settle', async () => {
    const service = new PodmanService()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    ;(service as any)._pendingCreates.set('adf-agent-12345678', gate)

    let settled = false
    const waiter = service.pendingStarts().then(() => { settled = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    ;(service as any)._pendingCreates.delete('adf-agent-12345678')
    release()
    await waiter
    expect(settled).toBe(true)
  })

  it('uses short timeouts for stop-class podman calls', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'inspect') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0

    await service.stopContainer('adf-agent-12345678')
    expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', ['stop', '-t', '5', 'adf-agent-12345678'], 7_000)
  })

  it('memoizes browserReady and clears the memo on failure', async () => {
    const service = new PodmanService()
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
    const verify = vi.fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue(undefined)
    ;(service as any).verifyBrowserRuntime = verify
    ;(service as any).ensureBrowserStack = vi.fn().mockResolvedValue(undefined)

    await expect(service.browserReady('adf-agent-12345678')).rejects.toThrow('probe failed')
    await expect(service.browserReady('adf-agent-12345678')).resolves.toBeUndefined()
    // Now memoized — a third call reuses the resolved promise
    await service.browserReady('adf-agent-12345678')
    expect(verify).toHaveBeenCalledTimes(2)
  })
})
