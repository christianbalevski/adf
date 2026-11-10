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
import { DEFAULT_COMPUTE_SETTINGS } from '../../../src/shared/constants/compute-defaults'
import { FakePodman, installFakePodman } from './fake-podman'

const MIB = 1024 * 1024
const SHARED = 'adf-mcp'
const VM = { memoryController: true, memoryMb: 16384 }
const CAP_ARGS = ['--memory', '4096m', '--memory-swap', '4096m']
const LIFT_ARGS = ['--memory', '4611686018427387904', '--memory-swap', '9223372036854771712']

const computeUsers = {
  claim: async () => {},
  release: async () => {},
  others: async () => ({ claims: new Map(), unreadable: [] }),
} as unknown as ComputeUsers

function setup(containerMemoryMb: unknown = 4096, hostInfo: FakePodman['hostInfo'] | null = { cgroupControllers: ['cpu', 'memory', 'pids'], memTotal: 16384 * MIB }) {
  const service = new PodmanService({ computeUsers })
  const fake = installFakePodman(service)
  fake.hostInfo = hostInfo ?? undefined
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
    expect(containerMemoryArgs({ containerMemoryMb: 4096 }, VM)).toEqual(CAP_ARGS)
  })

  it('applies no cap for 0', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 0 }, VM)).toEqual([])
    expect(containerMemoryArgs({ containerMemoryMb: '0' as never }, VM)).toEqual([])
  })

  it('applies no cap without the memory controller', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 4096 }, { ...VM, memoryController: false })).toEqual([])
  })

  it('accepts the minimum and the whole of the VM', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 512 }, VM)[1]).toBe('512m')
    expect(containerMemoryArgs({ containerMemoryMb: 16384 }, VM)[1]).toBe('16384m')
  })

  it.each([[511], [-1], [1.5], ['abc'], [undefined], [null], [16385]])('falls back to the default for %s', (value) => {
    expect(containerMemoryArgs({ containerMemoryMb: value as never }, VM)).toEqual(CAP_ARGS)
  })

  it('never exceeds the VM, even with the default', () => {
    const small = { memoryController: true, memoryMb: 2048 }
    expect(containerMemoryArgs({ containerMemoryMb: 4096 }, small)[1]).toBe('2048m')
    expect(containerMemoryArgs({ containerMemoryMb: 99_999 }, small)[1]).toBe('2048m')
  })
})

describe('containerMemoryUpdateArgs', () => {
  it('caps a container with no limit or a different one', () => {
    expect(containerMemoryUpdateArgs(0, { containerMemoryMb: 4096 }, VM)).toEqual(CAP_ARGS)
    expect(containerMemoryUpdateArgs(2048 * MIB, { containerMemoryMb: 4096 }, VM)).toEqual(CAP_ARGS)
  })

  it('leaves a container already at the limit', () => {
    expect(containerMemoryUpdateArgs(4096 * MIB, { containerMemoryMb: 4096 }, VM)).toBeNull()
  })

  it('lifts an existing limit for 0 with sizes podman accepts', () => {
    expect(containerMemoryUpdateArgs(4096 * MIB, { containerMemoryMb: 0 }, VM)).toEqual(LIFT_ARGS)
  })

  it('leaves an unlimited or already lifted container alone for 0', () => {
    expect(containerMemoryUpdateArgs(0, { containerMemoryMb: 0 }, VM)).toBeNull()
    expect(containerMemoryUpdateArgs(2 ** 62, { containerMemoryMb: 0 }, VM)).toBeNull()
  })

  it('re-caps a lifted container when the setting comes back', () => {
    expect(containerMemoryUpdateArgs(2 ** 62, { containerMemoryMb: 4096 }, VM)).toEqual(CAP_ARGS)
  })

  it('does nothing without the memory controller', () => {
    expect(containerMemoryUpdateArgs(0, { containerMemoryMb: 4096 }, { ...VM, memoryController: false })).toBeNull()
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

  it('bounds the cap by the memory podman reports, not this host', async () => {
    const { service, fake } = setup(4096, { cgroupControllers: ['memory'], memTotal: 2048 * MIB })
    await service.ensureRunning()
    expect(calls(fake, 'run')[0]).toContain('2048m')
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

  it('a throwing update does not block startup either', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED })
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'update') throw new Error('boom')
      return answer(bin, args)
    }
    await expect(service.ensureRunning()).resolves.toBeUndefined()
    expect(service.getStatus().status).toBe('running')
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
})

describe('memory controller check', () => {
  const noMemory = { cgroupControllers: ['cpu', 'pids'], memTotal: 16384 * MIB }

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

  it('probes once per session and warns once', async () => {
    const { service, fake } = setup(4096, noMemory)
    fake.add({ name: 'adf-agent-1', running: false }).add({ name: 'adf-agent-2', running: false })
    await service.startContainer('adf-agent-1')
    await service.startContainer('adf-agent-2')
    expect(calls(fake, 'info').filter((a) => a.includes('json'))).toHaveLength(1)
    expect(warnings.filter((w) => w.includes('memory controller'))).toHaveLength(1)
  })

  it('does not parse or retry on run errors, and treats a failed probe as no cap', async () => {
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
    fake.hostInfo = { cgroupControllers: ['memory'], memTotal: 16384 * MIB }
    await service.startContainer('adf-agent-1')
    expect(updateCalls(fake)).toEqual([['update', ...CAP_ARGS, 'adf-agent-1']])
  })

  it('probes again after the setup wizard changes the machine', async () => {
    const { service, fake } = setup(4096, { cgroupControllers: ['memory'], memTotal: 2048 * MIB })
    availabilityMock.mockResolvedValue({ available: true, binPath: '/fake/podman', prerequisites: [], installMethods: [] })
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, o: string, s: string) => void) => cb(null, '', ''))
    fake.add({ name: 'adf-agent-1', running: false })
    await service.startContainer('adf-agent-1')
    expect(fake.containers.get('adf-agent-1')?.memoryBytes).toBe(2048 * MIB)
    await service.setup('machine_init')
    fake.hostInfo = { cgroupControllers: ['memory'], memTotal: 8192 * MIB }
    await service.startContainer('adf-agent-1')
    expect(fake.containers.get('adf-agent-1')?.memoryBytes).toBe(4096 * MIB)
  })
})
