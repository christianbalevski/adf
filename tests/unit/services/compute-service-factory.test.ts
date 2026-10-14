import { describe, expect, it, vi, beforeEach } from 'vitest'

// The fake compute service must never start a process.
const spawned: string[] = []
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  const refuse = (cmd: string) => { spawned.push(cmd); throw new Error(`test tried to spawn ${cmd}`) }
  return { ...real, execFile: refuse, spawn: refuse, execFileSync: refuse }
})

const { createComputeService, FakeComputeService, isPackagedRuntime } = await import('../../../src/main/services/compute-service-factory')
const { PodmanService } = await import('../../../src/main/services/podman.service')

describe('createComputeService (ADF_COMPUTE=fake seam)', () => {
  let warnings: string[]
  beforeEach(() => {
    warnings = []
    spawned.length = 0
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('builds the real service by default', () => {
    const svc = createComputeService({ env: {} })
    expect(svc).toBeInstanceOf(PodmanService)
    expect(svc).not.toBeInstanceOf(FakeComputeService)
  })

  it('builds the fake with ADF_COMPUTE=fake and ADF_TEST_SEAMS=1 in an unpackaged process', () => {
    expect(createComputeService({ env: { ADF_COMPUTE: 'fake', ADF_TEST_SEAMS: '1' }, packaged: false })).toBeInstanceOf(FakeComputeService)
  })

  it('ignores ADF_COMPUTE=fake without ADF_TEST_SEAMS=1', () => {
    expect(createComputeService({ env: { ADF_COMPUTE: 'fake' }, packaged: false })).not.toBeInstanceOf(FakeComputeService)
    expect(warnings).toEqual(['[Compute] Ignoring ADF_COMPUTE=fake: ADF_TEST_SEAMS=1 is not set; using Podman'])
  })

  it('ignores ADF_COMPUTE=fake in a packaged app', () => {
    expect(createComputeService({ env: { ADF_COMPUTE: 'fake', ADF_TEST_SEAMS: '1' }, packaged: true })).not.toBeInstanceOf(FakeComputeService)
    expect(warnings).toEqual(['[Compute] Ignoring ADF_COMPUTE=fake: this is a packaged app; using Podman'])
  })

  it('warns about an unknown ADF_COMPUTE value', () => {
    expect(createComputeService({ env: { ADF_COMPUTE: 'mock', ADF_TEST_SEAMS: '1' }, packaged: false })).not.toBeInstanceOf(FakeComputeService)
    expect(warnings[0]).toContain('ADF_COMPUTE=mock')
  })
})

describe('FakeComputeService', () => {
  it('never runs podman or wsl, on any lifecycle path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new FakeComputeService()
    expect(await svc.findPodman()).toBeNull()
    await expect(svc.ensureRunning()).rejects.toThrow(/not installed/)
    await expect(svc.ensureIsolatedRunning('agent-1', '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111')).rejects.toThrow()
    expect(await svc.listContainers()).toEqual([])
    expect(await svc.setup('check')).toMatchObject({ success: false })
    expect(await svc.setup('machine_start')).toMatchObject({ success: false })
    await svc.stop()
    await svc.stopAll()
    await svc.destroy()
    expect(await svc.stopContainer('adf-mcp')).toBe(false)
    expect(spawned).toEqual([])
    expect(svc.getStatus().status).toBe('not_installed')
  })
})

describe('isPackagedRuntime', () => {
  it.each([
    ['C:\\Program Files\\ADF Studio\\ADF Studio.exe', 'C:\\Program Files\\ADF Studio\\resources\\app.asar\\out\\main\\daemon.js', true],
    ['/Applications/ADF Studio.app/Contents/MacOS/ADF Studio', '/Applications/ADF Studio.app/Contents/Resources/app.asar/out/main/daemon.js', true],
    ['C:\\tools\\electron.exe', 'C:\\x\\resources\\app.asar\\out\\main\\daemon.js', true],
    ['C:\\repo\\node_modules\\electron\\dist\\electron.exe', 'C:\\repo\\out\\main\\daemon.js', false],
    ['/usr/local/bin/node', '/repo/out/main/daemon.js', false],
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\adf\\dist\\cli.js', false],
  ])('%s %s → %s', (execPath, entry, expected) => {
    expect(isPackagedRuntime(execPath, entry)).toBe(expected)
  })
})
