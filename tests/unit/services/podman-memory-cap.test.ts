import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// No real podman: exec0 is replaced by the fake, and these catch anything else.
const spawnMock = vi.hoisted(() => vi.fn())
const execFileMock = vi.hoisted(() => vi.fn())
const availabilityMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return { ...real, execFile: execFileMock, spawn: spawnMock }
})
vi.mock('../../../src/main/services/podman-bootstrap', async (orig) => {
  const real = await orig<typeof import('../../../src/main/services/podman-bootstrap')>()
  return { ...real, checkPodmanAvailability: availabilityMock }
})

import {
  PodmanService,
  containerMemoryArgs,
  containerMemoryUpdateArgs,
} from '../../../src/main/services/podman.service'
import type { ComputeUsers } from '../../../src/main/services/compute-users'
import { DEFAULT_COMPUTE_SETTINGS, readComputeSettings } from '../../../src/shared/constants/compute-defaults'
import { FakePodman, installFakePodman } from './fake-podman'

const MIB = 1024 * 1024
const SHARED = 'adf-mcp'
const CAP_ARGS = ['--memory', '4096m', '--memory-swap', '4096m']
const LIFT_ARGS = ['--memory', '4611686018427387904', '--memory-swap', '9223372036854771712']

const computeUsers = {
  claim: async () => {},
  release: async () => {},
  others: async () => ({ claims: new Map(), unreadable: [] }),
} as unknown as ComputeUsers

function setup(containerMemoryMb: unknown = 4096, controllers: string[] | null = ['cpu', 'memory', 'pids']) {
  const service = new PodmanService({ computeUsers })
  const fake = installFakePodman(service)
  fake.controllers = controllers ?? undefined
  const settings = { ...DEFAULT_COMPUTE_SETTINGS, containerMemoryMb } as never as Parameters<PodmanService['setSettingsAccessor']>[0] extends () => infer S ? S : never
  service.setSettingsAccessor(() => settings)
  return { service, fake, settings: settings as { containerMemoryMb: unknown } }
}

const calls = (fake: FakePodman, cmd: string) => fake.calls.filter((a) => a[0] === cmd)
const memoryInspects = (fake: FakePodman) => fake.calls.filter((a) => a.join(' ').includes('HostConfig.Memory'))
const updateCalls = (fake: FakePodman) => calls(fake, 'update')

let warnings: string[]
beforeEach(() => {
  warnings = []
  spawnMock.mockReset()
  execFileMock.mockReset()
  availabilityMock.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
})

describe('containerMemoryArgs', () => {
  it('sets memory and an equal memory-swap, so there is no swap on top', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 4096 })).toEqual(CAP_ARGS)
  })

  it('applies no cap for 0', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 0 })).toEqual([])
  })

  it.each([[1, '512m'], [511, '512m'], [512, '512m'], [32768, '32768m'], [32769, '32768m'], [Number.MAX_SAFE_INTEGER, '32768m']])('clamps %s to %s', (value, limit) => {
    expect(containerMemoryArgs({ containerMemoryMb: value })).toEqual(['--memory', limit, '--memory-swap', limit])
  })

  it.each([[-1], [1.5], [NaN], [Infinity], ['abc'], ['0'], ['2048'], [undefined], [null]])('falls back to the default for %s', (value) => {
    expect(containerMemoryArgs({ containerMemoryMb: value as never })).toEqual(CAP_ARGS)
  })
})

describe('containerMemoryUpdateArgs', () => {
  it('caps a container with no limit or a different one', () => {
    expect(containerMemoryUpdateArgs(0, { containerMemoryMb: 4096 })).toEqual(CAP_ARGS)
    expect(containerMemoryUpdateArgs(2048 * MIB, { containerMemoryMb: 4096 })).toEqual(CAP_ARGS)
  })

  it('leaves a container already at the limit', () => {
    expect(containerMemoryUpdateArgs(4096 * MIB, { containerMemoryMb: 4096 })).toBeNull()
  })

  it('compares with the clamped value', () => {
    expect(containerMemoryUpdateArgs(32768 * MIB, { containerMemoryMb: 40000 })).toBeNull()
  })

  it('lifts an existing limit for 0 with sizes podman accepts', () => {
    expect(containerMemoryUpdateArgs(4096 * MIB, { containerMemoryMb: 0 })).toEqual(LIFT_ARGS)
  })

  it('leaves an unlimited or already lifted container alone for 0', () => {
    expect(containerMemoryUpdateArgs(0, { containerMemoryMb: 0 })).toBeNull()
    expect(containerMemoryUpdateArgs(2 ** 62, { containerMemoryMb: 0 })).toBeNull()
  })

  it('re-caps a lifted container when the setting comes back', () => {
    expect(containerMemoryUpdateArgs(2 ** 62, { containerMemoryMb: 4096 })).toEqual(CAP_ARGS)
  })
})

describe('new containers', () => {
  const expectCapBeforeImage = (run: string[]) => {
    const at = run.indexOf('--memory')
    expect(at).toBeGreaterThan(-1)
    expect(run.slice(at, at + 4)).toEqual(CAP_ARGS)
    expect(at).toBeLessThan(run.indexOf(DEFAULT_COMPUTE_SETTINGS.containerImage))
  }

  it('caps the shared container', async () => {
    const { service, fake } = setup()
    await service.ensureRunning()
    expectCapBeforeImage(calls(fake, 'run')[0])
    expect(updateCalls(fake)).toEqual([])
  })

  it('caps a per-agent container', async () => {
    const { service, fake } = setup()
    await service.ensureIsolatedRunning('agent', '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111', [], undefined, false)
    expectCapBeforeImage(calls(fake, 'run')[0])
  })

  it('caps a one-shot image process', async () => {
    const { service, fake } = setup()
    await service.spawnImageProcess('img:1', 'node', ['x.js'])
    const args = spawnMock.mock.calls[0][1] as string[]
    const at = args.indexOf('--memory')
    expect(args.slice(at, at + 4)).toEqual(CAP_ARGS)
    expect(at).toBeLessThan(args.indexOf('img:1'))
    expect(fake.containers.size).toBe(0)
  })

  it('adds no args for 0', async () => {
    const { service, fake } = setup(0)
    await service.ensureRunning()
    expect(calls(fake, 'run')[0]).not.toContain('--memory')
    expect(calls(fake, 'run')[0]).not.toContain('--memory-swap')
  })

  it.each([[16385, '16385m'], [40000, '32768m'], [100, '512m']])('runs with a setting of %s as %s, never the default', async (value, limit) => {
    const { service, fake } = setup(value)
    await service.ensureRunning()
    expect(calls(fake, 'run')[0]).toContain(limit)
  })
})

describe('existing containers', () => {
  it('caps a running container with no limit, without recreating it', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED })
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([['update', ...CAP_ARGS, SHARED]])
    expect(calls(fake, 'run')).toEqual([])
    expect(calls(fake, 'rm')).toEqual([])
  })

  it('updates a stopped container only once it has started', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, running: false })
    await service.ensureRunning()
    const order = fake.calls.map((a) => a[0])
    expect(order.indexOf('start')).toBeGreaterThan(-1)
    expect(order.indexOf('update')).toBeGreaterThan(order.indexOf('start'))
  })

  it('changes a different limit', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 2048 * MIB })
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(4096 * MIB)
  })

  it('leaves the same limit alone', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    expect(memoryInspects(fake)).toHaveLength(1)
    expect(updateCalls(fake)).toEqual([])
  })

  it('lifts the limit for 0', async () => {
    const { service, fake } = setup(0)
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([['update', ...LIFT_ARGS, SHARED]])
  })

  it('applies through the Settings start action', async () => {
    const { service, fake } = setup()
    fake.add({ name: 'adf-agent-1', running: false })
    expect(await service.startContainer('adf-agent-1')).toBe(true)
    expect(updateCalls(fake)).toEqual([['update', ...CAP_ARGS, 'adf-agent-1']])
  })

  it('applies when a concurrent creator won the name', async () => {
    const { service, fake } = setup()
    const answer = fake.exec0
    let firstInspect = true
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'container' && args.join(' ').includes('State.Running') && firstInspect) {
        firstInspect = false
        return { stdout: '', stderr: 'no such container', code: 1 }
      }
      if (args[0] === 'run') {
        fake.add({ name: SHARED })
        return { stdout: '', stderr: 'the container name "adf-mcp" is already in use', code: 1 }
      }
      return answer(bin, args)
    }
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([['update', ...CAP_ARGS, SHARED]])
  })

  it('a failed update warns and the container still starts', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, running: false })
    fake.failUpdate = true
    await expect(service.ensureRunning()).resolves.toBeUndefined()
    expect(fake.running()).toEqual([SHARED])
    expect(service.getStatus().status).toBe('running')
    expect(warnings.filter((w) => w.includes('memory limit') && w.includes(SHARED))).toHaveLength(1)
  })

  it('an update whose spawn throws does not block startup, and is retried', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED })
    const answer = fake.exec0
    const realExec0 = (PodmanService.prototype as unknown as { exec0: FakePodman['exec0'] }).exec0
    execFileMock.mockImplementationOnce(() => { throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }) })
    let first = true
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'update' && first) { first = false; return realExec0.call(service, bin, args) }
      return answer(bin, args)
    }
    await expect(service.ensureRunning()).resolves.toBeUndefined()
    expect(service.getStatus().status).toBe('running')
    expect(fake.containers.get(SHARED)?.memoryBytes).toBeUndefined()
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(4096 * MIB)
  })

  it('an unreadable limit is left alone', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED })
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) =>
      args.join(' ').includes('HostConfig.Memory') ? { stdout: '', stderr: '', code: 0 } : answer(bin, args)
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([])
    expect(service.getStatus().status).toBe('running')
  })
})

describe('order at bring-up', () => {
  const firewallThenMemory = (fake: FakePodman) => {
    const lines = fake.calls.map((a) => a.join(' '))
    const firewall = lines.findIndex((l) => l.startsWith('inspect') && l.includes('io.adf.peer'))
    expect(firewall).toBeGreaterThan(-1)
    expect(lines.findIndex((l) => l.includes('HostConfig.Memory'))).toBeGreaterThan(firewall)
  }

  it('loads the firewall before the memory step in the shared bring-up', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED })
    await service.ensureRunning()
    firewallThenMemory(fake)
  })

  it('loads the firewall before the memory step in a per-agent bring-up', async () => {
    const { service, fake } = setup()
    await service.ensureIsolatedRunning('agent', '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111', [], undefined, false)
    firewallThenMemory(fake)
  })

  it('loads the firewall before the memory step in the Settings start action', async () => {
    const { service, fake } = setup()
    fake.add({ name: 'adf-agent-1', running: false })
    await service.startContainer('adf-agent-1')
    firewallThenMemory(fake)
  })
})

describe('shared container already brought up this session', () => {
  it('applies a changed setting on the next use, once', async () => {
    const { service, fake, settings } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    settings.containerMemoryMb = 2048
    await service.ensureRunning()
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([['update', '--memory', '2048m', '--memory-swap', '2048m', SHARED]])
  })

  it('costs no podman call while the setting is unchanged', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    const before = fake.calls.length
    await service.ensureRunning()
    expect(fake.calls.length).toBe(before)
  })

  it('retries on the next use after a failed probe, then stops', async () => {
    const { service, fake } = setup(4096, null)
    fake.add({ name: SHARED })
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([])
    fake.controllers = ['memory']
    await service.ensureRunning()
    await service.ensureRunning()
    expect(updateCalls(fake)).toEqual([['update', ...CAP_ARGS, SHARED]])
  })

  it('retries on the next use after a failed update, then stops', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED })
    fake.failUpdate = true
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBeUndefined()
    fake.failUpdate = false
    await service.ensureRunning()
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(4096 * MIB)
    expect(updateCalls(fake)).toHaveLength(2)
  })

  it('retries a changed setting whose update failed', async () => {
    const { service, fake, settings } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    settings.containerMemoryMb = 2048
    fake.failUpdate = true
    await service.ensureRunning()
    fake.failUpdate = false
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(2048 * MIB)
  })

  it('retries when a later bring-up fails after an earlier one succeeded', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    ;(service as unknown as { _sharedRunning: unknown })._sharedRunning = null
    fake.add({ name: SHARED })
    fake.failUpdate = true
    await service.ensureRunning()
    fake.failUpdate = false
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(4096 * MIB)
  })

  it('does not retry when the controller is missing', async () => {
    const { service, fake } = setup(4096, ['cpu', 'pids'])
    fake.add({ name: SHARED })
    await service.ensureRunning()
    const before = fake.calls.length
    await service.ensureRunning()
    expect(fake.calls.length).toBe(before)
  })
})

describe('memory controller check', () => {
  const noMemory = ['cpu', 'pids']

  it('creates without a cap when the controller is missing', async () => {
    const { service, fake } = setup(4096, noMemory)
    await service.ensureRunning()
    expect(calls(fake, 'run')[0]).not.toContain('--memory')
  })

  it('leaves existing containers alone when the controller is missing', async () => {
    const { service, fake } = setup(4096, noMemory)
    fake.add({ name: SHARED })
    await service.ensureRunning()
    expect(memoryInspects(fake)).toEqual([])
    expect(updateCalls(fake)).toEqual([])
  })

  it('treats a failed probe as no cap', async () => {
    const { service, fake } = setup(4096, null)
    await service.ensureRunning()
    expect(calls(fake, 'run')).toHaveLength(1)
    expect(calls(fake, 'run')[0]).not.toContain('--memory')
  })

  it('tries again after a failed probe', async () => {
    const { service, fake } = setup(4096, null)
    fake.add({ name: 'adf-agent-1', running: false })
    await service.startContainer('adf-agent-1')
    expect(updateCalls(fake)).toEqual([])
    fake.controllers = ['memory']
    await service.startContainer('adf-agent-1')
    expect(updateCalls(fake)).toEqual([['update', ...CAP_ARGS, 'adf-agent-1']])
  })
})

describe('compute settings reader', () => {
  const source = (path: string) => readFileSync(join(__dirname, '../../..', path), 'utf-8')

  it.each([
    ['src/main/ipc/index.ts', "setSettingsAccessor(() => readComputeSettings(settings?.get('compute')))"],
    ['src/main/daemon/index.ts', "setSettingsAccessor(() => readComputeSettings(settings.get('compute')))"],
  ])('%s reads through it', (path, accessor) => {
    expect(source(path)).toContain(accessor)
  })

  it('keeps an explicit 0, end to end to podman run', async () => {
    const { service, fake } = setup()
    service.setSettingsAccessor(() => readComputeSettings({ containerMemoryMb: 0 }))
    await service.ensureRunning()
    expect(calls(fake, 'run')[0]).not.toContain('--memory')
  })

  it('keeps valid values and explicit zeros', () => {
    const saved = { containerPackages: ['git'], machineCpus: 0, machineMemoryMb: 0, containerMemoryMb: 0, containerImage: 'img:1' }
    expect(readComputeSettings(saved)).toEqual(saved)
  })

  it.each([[undefined], [null], ['x'], [{}], [{ containerPackages: 'git', machineCpus: '4', machineMemoryMb: false, containerMemoryMb: '0', containerImage: 0 }]])('falls back to the defaults for %j', (raw) => {
    const { containerPackages, machineCpus, machineMemoryMb, containerMemoryMb, containerImage } = DEFAULT_COMPUTE_SETTINGS
    expect(readComputeSettings(raw)).toEqual({ containerPackages, machineCpus, machineMemoryMb, containerMemoryMb, containerImage })
  })

  it('drops non-string packages', () => {
    expect(readComputeSettings({ containerPackages: ['git', 1] }).containerPackages).toEqual(['git'])
  })
})
