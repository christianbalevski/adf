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
    const exec0 = vi.fn().mockResolvedValue({
      code: 0,
      stderr: '',
      // Shape of a real `podman ps --format json` row: labels are an object,
      // names an array, and the agent name may contain spaces.
      stdout: JSON.stringify([{
        Id: 'abc123def4567890',
        Names: ['adf-research-12345678'],
        State: 'running',
        Status: 'Up 2 hours',
        Image: 'node:20-slim',
        Created: 1_753_084_800,
        CreatedAt: '2 days ago',
        Labels: {
          'io.adf.managed': 'true',
          'io.adf.kind': 'agent',
          'io.adf.agent-id': 'agent-1',
          'io.adf.agent-name': 'Research Desk',
        },
      }]),
    })
    ;(service as any).exec0 = exec0

    await expect(service.listContainers()).resolves.toEqual([expect.objectContaining({
      id: 'abc123def456',
      name: 'adf-research-12345678',
      running: true,
      image: 'node:20-slim',
      createdAt: new Date(1_753_084_800_000).toISOString(),
      managed: true,
      scope: 'dedicated',
      agentId: 'agent-1',
      agentName: 'Research Desk',
    })])
    expect(exec0.mock.calls[0][1]).toEqual(['ps', '-a', '--filter', 'name=adf-', '--format', 'json'])
  })

  it('marks containers created before the managed labels as legacy', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).exec0 = vi.fn().mockResolvedValue({
      code: 0,
      stderr: '',
      stdout: JSON.stringify([{
        Id: 'b7ed5ade8c92aaaa',
        Names: ['adf-mcp'],
        State: 'exited',
        Status: 'Exited (137) 4 weeks ago',
        Image: 'node:20-slim',
        Labels: {},
      }]),
    })

    await expect(service.listContainers()).resolves.toEqual([expect.objectContaining({
      name: 'adf-mcp',
      running: false,
      managed: false,
      scope: 'legacy',
    })])
  })

  it('removes an unlabeled container so it can be recreated as managed', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0

    await expect(service.destroyContainer('adf-legacy-agent')).resolves.toBe(true)
    expect(exec0.mock.calls.map((call) => call[1][0])).toEqual(['inspect', 'rm'])
  })

  it('refuses to remove a container outside the ADF namespace', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    ;(service as any).exec0 = exec0

    await expect(service.destroyContainer('other-container')).rejects.toThrow('outside the ADF namespace')
    expect(exec0).not.toHaveBeenCalled()
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

  it('gives stop calls headroom over the container stop grace period', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'inspect') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    ;(service as any).exec0 = exec0

    await service.stopContainer('adf-agent-12345678')
    // `stop -t 5` gives the container 5s of its own grace — the exec timeout
    // must exceed that comfortably.
    expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', ['stop', '-t', '5', 'adf-agent-12345678'], 12_000)
  })

  it('flags exec timeouts distinctly from real failures', async () => {
    const service = new PodmanService()
    const timedOut = await (service as any).exec0(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 500)
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.code).toBe(1)

    const failed = await (service as any).exec0(process.execPath, ['-e', 'process.exit(3)'], 15_000)
    expect(failed.code).toBe(1)
    expect(failed.timedOut).toBe(false)

    const ok = await (service as any).exec0(process.execPath, ['-e', ''], 15_000)
    expect(ok.code).toBe(0)
    expect(ok.timedOut).toBe(false)
  })

  it('retries a timed-out container inspect with a long timeout instead of recreating', async () => {
    const service = new PodmanService()
    const exec0 = vi.fn(async (_bin: string, args: string[], timeout?: number) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (timeout === 7_000) return { code: 1, stdout: '', stderr: '', timedOut: true }
        return { code: 0, stdout: 'true', stderr: '', timedOut: false }
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({})
    ;(service as any).ensureBrowserCompatibility = vi.fn().mockResolvedValue(undefined)

    await (service as any).ensureContainerRunning('/usr/bin/podman', 'adf-mcp', { kind: 'shared' })

    // The long-timeout retry saw the running container — no create attempted.
    expect(exec0.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false)
    const retry = exec0.mock.calls.find(([, args, timeout]) => args[1] === 'inspect' && timeout === 30_000)
    expect(retry).toBeTruthy()
  })

  it('treats "name already in use" on create as an existing container', async () => {
    const service = new PodmanService()
    let created = false
    const exec0 = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!created) return { code: 1, stdout: '', stderr: 'no such container', timedOut: false }
        return { code: 0, stdout: 'true', stderr: '', timedOut: false }
      }
      if (args[0] === 'run') {
        created = true
        return { code: 1, stdout: '', stderr: 'Error: creating container storage: the container name "adf-mcp" is already in use', timedOut: false }
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    ;(service as any).exec0 = exec0
    ;(service as any).getBrowserRuntimeCompatibility = vi.fn().mockResolvedValue({})
    ;(service as any).ensureBrowserCompatibility = vi.fn().mockResolvedValue(undefined)

    await expect(
      (service as any).ensureContainerRunning('/usr/bin/podman', 'adf-mcp', { kind: 'shared' })
    ).resolves.toBeUndefined()
  })

  it('does not clear a pending ensureRunning memo on dead-container signals', async () => {
    const service = new PodmanService()
    vi.spyOn(service, 'findPodman').mockResolvedValue('/usr/bin/podman')
    ;(service as any).ensureMachine = vi.fn().mockResolvedValue(undefined)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ensureContainerRunning = vi.fn().mockImplementation(() => gate)
    ;(service as any).ensureContainerRunning = ensureContainerRunning

    const first = service.ensureRunning()
    await new Promise((resolve) => setImmediate(resolve))
    // A stale exec against the old run reports the container dead while the
    // bring-up is still in flight — this must NOT clear the pending memo.
    ;(service as any).noteContainerExec('adf-mcp', { code: 1, stderr: 'Error: container adf-mcp is not running' })
    expect(service.ensureRunning()).toBe(first)
    release()
    await first
    expect(ensureContainerRunning).toHaveBeenCalledTimes(1)

    // Once settled, the same signal invalidates the memo as before.
    ;(service as any).noteContainerExec('adf-mcp', { code: 1, stderr: 'Error: container adf-mcp is not running' })
    await service.ensureRunning()
    expect(ensureContainerRunning).toHaveBeenCalledTimes(2)
  })

  it('rejects ensure calls fast after beginShutdown and still resolves pendingStarts', async () => {
    const service = new PodmanService()
    service.beginShutdown()
    await expect(service.ensureRunning()).rejects.toThrow('shutting down')
    await expect(
      service.ensureIsolatedRunning('agent-1', '11111111-1111-1111-1111-111111111111')
    ).rejects.toThrow('shutting down')
    await expect(service.pendingStarts()).resolves.toBeUndefined()
  })

  it('does not cache a workspace ensured against a previous container run', async () => {
    const service = new PodmanService()
    ;(service as any).requirePodman = vi.fn().mockResolvedValue('/usr/bin/podman')
    let calls = 0
    const exec0 = vi.fn().mockImplementation(async () => {
      calls++
      // Simulate the container restarting while mkdir was in flight.
      if (calls === 1) (service as any).invalidateContainer('adf-mcp')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    ;(service as any).exec0 = exec0

    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    // The success belonged to the old run — must not be cached for the new one.
    await service.ensureWorkspace('adf-mcp', '/workspace/agent-1')
    expect(exec0).toHaveBeenCalledTimes(2)
  })

  it('gives the first machine list of a session a long timeout', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const service = new PodmanService()
      const exec0 = vi.fn().mockResolvedValue({ code: 0, stdout: 'true', stderr: '', timedOut: false })
      ;(service as any).exec0 = exec0

      await (service as any).ensureMachine('/usr/bin/podman')
      expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', ['machine', 'list', '--format', '{{.Running}}', '--noheading'], 30_000)

      exec0.mockClear()
      await (service as any).ensureMachine('/usr/bin/podman')
      expect(exec0).toHaveBeenCalledWith('/usr/bin/podman', ['machine', 'list', '--format', '{{.Running}}', '--noheading'], 7_000)
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
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
