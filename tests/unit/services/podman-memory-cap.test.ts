import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  isolatedContainerName,
} from '../../../src/main/services/podman.service'
import type { ComputeUsers } from '../../../src/main/services/compute-users'
import { DEFAULT_COMPUTE_SETTINGS, effectiveContainerMemoryMb, readComputeSettings } from '../../../src/shared/constants/compute-defaults'
import { FakePodman, installFakePodman } from './fake-podman'

const MIB = 1024 * 1024
const SHARED = 'adf-mcp'
const AGENT_ID = '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111'
const AGENT = isolatedContainerName('agent', AGENT_ID)
const CAP_ARGS = ['--memory', '4096m', '--memory-swap', '4096m']
const LIFT_ARGS = ['--memory', '4611686018427387904', '--memory-swap', '9223372036854771712']

const computeUsers = {
  claim: async () => {},
  release: async () => {},
  own: () => [],
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
afterEach(() => { vi.useRealTimers() })

/** Move the clock past the retry interval after a failed apply (only Date is faked). */
const later = () => {
  const now = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now + 60_000)
}

describe('effectiveContainerMemoryMb', () => {
  it.each([[0, 0], ['0', 0], [512, 512], [32768, 32768], [4096, 4096], ['8192', 8192]])('%j is %j MB', (value, mb) => {
    expect(effectiveContainerMemoryMb(value)).toBe(mb)
  })

  it.each([[1], [4], [100], [511], [32769], [2 ** 43], [-5], [1024.5], [''], ['abc'], [null], [undefined], [true], [NaN]])('%j is invalid', (value) => {
    expect(effectiveContainerMemoryMb(value)).toBeNull()
  })
})

describe('containerMemoryArgs', () => {
  it('sets memory and an equal memory-swap, so there is no swap on top', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 4096 })).toEqual(CAP_ARGS)
  })

  it('applies no cap for 0', () => {
    expect(containerMemoryArgs({ containerMemoryMb: 0 })).toEqual([])
  })

  it.each([[512, '512m'], [32768, '32768m'], ['8192', '8192m']])('passes %j through as %s, with no warning', (value, limit) => {
    expect(containerMemoryArgs({ containerMemoryMb: value })).toEqual(['--memory', limit, '--memory-swap', limit])
    expect(warnings).toEqual([])
  })

  it('applies no cap for "0", with no warning', () => {
    expect(containerMemoryArgs({ containerMemoryMb: '0' })).toEqual([])
    expect(warnings).toEqual([])
  })

  it.each([[1], [4], [100], [511], [32769], [2 ** 43], [-1], [1.5], [1e21], ['abc'], [true], [null]])('gets the default for %j and warns once, naming both values', (value) => {
    expect(containerMemoryArgs({ containerMemoryMb: value })).toEqual(CAP_ARGS)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(JSON.stringify(value))
    expect(warnings[0]).toContain('4096')
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

  it('compares with the value as entered', () => {
    expect(containerMemoryUpdateArgs(32768 * MIB, { containerMemoryMb: 32768 })).toBeNull()
  })

  it('warns once for an unusable value', () => {
    expect(containerMemoryUpdateArgs(0, { containerMemoryMb: 1.5 })).toEqual(CAP_ARGS)
    expect(warnings).toHaveLength(1)
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

  it.each([[16385, '16385m'], [32768, '32768m'], ['8192', '8192m'], [100, '4096m'], [2 ** 43, '4096m']])('runs with a setting of %j as %s', async (value, limit) => {
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
    later()
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
    expect(warnings.find((w) => w.includes('memory limit'))).toContain('its current limit is unreadable')
  })
})

// Each path starts a stopped container; `reported` says the path has told the world it is up.
const BRING_UPS: [string, string, (s: PodmanService) => Promise<unknown>, (s: PodmanService, f: FakePodman, phases: string[]) => boolean][] = [
  ['shared', SHARED, (s) => s.ensureRunning(), (s) => s.getStatus().status === 'running'],
  ['per-agent', AGENT, (s) => s.ensureIsolatedRunning('agent', AGENT_ID, ['x'], undefined, false), (_s, _f, phases) => phases.includes('ready')],
  ['Settings start', 'adf-agent-1', (s) => s.startContainer('adf-agent-1'), (_s, _f, phases) => phases.includes('ready')],
]

describe('order at bring-up', () => {
  it.each(BRING_UPS)('%s: loads the firewall before the memory step', async (_path, name, bringUp) => {
    const { service, fake } = setup()
    fake.add({ name, running: false })
    await bringUp(service)
    const lines = fake.calls.map((a) => a.join(' '))
    const firewall = lines.findIndex((l) => l.startsWith('inspect') && l.includes('io.adf.peer'))
    expect(firewall).toBeGreaterThan(-1)
    expect(lines.findIndex((l) => l.includes('HostConfig.Memory'))).toBeGreaterThan(firewall)
  })

  it.each(BRING_UPS)('%s: applies the limit after the container is reported up', async (_path, name, bringUp, reported) => {
    const { service, fake } = setup()
    fake.add({ name, running: false })
    const phases: string[] = []
    service.on('container-phase', (e: { phase: string }) => phases.push(e.phase))
    let reportedAtUpdate = false
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'update') reportedAtUpdate = reported(service, fake, phases)
      return answer(bin, args)
    }
    await bringUp(service)
    expect(reportedAtUpdate).toBe(true)
  })

  it('applies the limit before pip, so a failed pip install still has it, and still fails the bring-up', async () => {
    const { service, fake } = setup()
    fake.add({ name: AGENT })
    const answer = fake.exec0
    let cappedAtPip: number | undefined
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (!args.includes('pip')) return answer(bin, args)
      cappedAtPip = fake.containers.get(AGENT)?.memoryBytes
      return { stdout: '', stderr: 'pip boom', code: 1 }
    }
    await expect(service.ensureIsolatedRunning('agent', AGENT_ID, ['x'], undefined, false)).rejects.toThrow(/pip boom/)
    expect(cappedAtPip).toBe(4096 * MIB)
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
    later()
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
    later()
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
    later()
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(2048 * MIB)
  })

  it('retries when a later bring-up fails after an earlier one succeeded', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    await service.stop()
    fake.add({ name: SHARED })
    fake.failUpdate = true
    await service.ensureRunning()
    fake.failUpdate = false
    later()
    await service.ensureRunning()
    expect(fake.containers.get(SHARED)?.memoryBytes).toBe(4096 * MIB)
  })

  it('does not retry when the controller is missing, even after the interval', async () => {
    const { service, fake } = setup(4096, ['cpu', 'pids'])
    fake.add({ name: SHARED })
    await service.ensureRunning()
    const before = fake.calls.length
    await service.ensureRunning()
    later()
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
    expect(updateCalls(fake)).toEqual([])
  })

  it.each([[['cpu', 'pids']], [null]])('runs a one-shot uncapped for controllers %j', async (controllers) => {
    const { service } = setup(4096, controllers)
    await service.spawnImageProcess('img:1', 'node', [])
    expect(spawnMock.mock.calls[0][1]).not.toContain('--memory')
  })

  describe('a probe whose spawn throws', () => {
    const throwingProbe = (service: PodmanService, fake: FakePodman) => {
      const answer = fake.exec0
      const realExec0 = (PodmanService.prototype as unknown as { exec0: FakePodman['exec0'] }).exec0
      execFileMock.mockImplementation(() => { throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }) })
      ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) =>
        args[2] === '{{.Host.CgroupControllers}}' ? realExec0.call(service, bin, args) : answer(bin, args)
    }

    it('still creates the container, uncapped', async () => {
      const { service, fake } = setup()
      throwingProbe(service, fake)
      await expect(service.ensureRunning()).resolves.toBeUndefined()
      expect(calls(fake, 'run')[0]).not.toContain('--memory')
    })

    it('still starts a one-shot, uncapped', async () => {
      const { service, fake } = setup()
      throwingProbe(service, fake)
      await service.spawnImageProcess('img:1', 'node', [])
      expect(spawnMock.mock.calls[0][1]).not.toContain('--memory')
    })
  })

  it('does not probe a container already in line', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    expect(calls(fake, 'info').filter((a) => a[2].includes('CgroupControllers'))).toEqual([])
  })

  it('probes once when creating a container', async () => {
    const { service, fake } = setup()
    await service.ensureRunning()
    expect(calls(fake, 'info').filter((a) => a[2].includes('CgroupControllers'))).toHaveLength(1)
  })

  it('remembers a positive probe', async () => {
    const { service, fake } = setup()
    await service.spawnImageProcess('img:1', 'node', [])
    await service.spawnImageProcess('img:1', 'node', [])
    await service.spawnImageProcess('img:1', 'node', [])
    expect(calls(fake, 'info').filter((a) => a[2].includes('CgroupControllers'))).toHaveLength(1)
  })

  it('remembers a probe that finds no memory controller', async () => {
    const { service, fake } = setup(4096, ['cpu', 'pids'])
    await service.spawnImageProcess('img:1', 'node', [])
    await service.spawnImageProcess('img:1', 'node', [])
    await service.ensureRunning()
    expect(calls(fake, 'info').filter((a) => a[2].includes('CgroupControllers'))).toHaveLength(1)
  })

  it('asks again after a failed probe, once the interval has passed', async () => {
    const { service, fake } = setup(4096, null)
    const probes = () => calls(fake, 'info').filter((a) => a[2].includes('CgroupControllers'))
    await service.spawnImageProcess('img:1', 'node', [])
    await service.spawnImageProcess('img:1', 'node', [])
    expect(probes()).toHaveLength(1)
    later()
    await service.spawnImageProcess('img:1', 'node', [])
    expect(probes()).toHaveLength(2)
  })

  it('probes again after the setup wizard changes the machine', async () => {
    const { service, fake } = setup()
    availabilityMock.mockResolvedValue({ available: true, binPath: '/fake/podman', prerequisites: [], installMethods: [] })
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: null, o: string, s: string) => void) => cb(null, '', ''))
    await service.spawnImageProcess('img:1', 'node', [])
    await service.setup('machine_init')
    fake.controllers = ['cpu']
    await service.spawnImageProcess('img:1', 'node', [])
    expect(spawnMock.mock.calls[1][1]).not.toContain('--memory')
  })
})

describe('one memory sync rule per container', () => {
  const NAME = 'adf-agent-1'
  const exec = (service: PodmanService, name = NAME) => service.execInContainer(name, '/workspace', 'true')
  const execs = (fake: FakePodman) => calls(fake, 'exec').filter((a) => a[1] === '-w')

  it('retries a failed apply before the next exec, then stops', async () => {
    const { service, fake } = setup()
    fake.add({ name: NAME, running: false })
    fake.failUpdate = true
    await service.startContainer(NAME)
    expect(fake.containers.get(NAME)?.memoryBytes).toBeUndefined()
    fake.failUpdate = false
    later()
    await exec(service)
    await exec(service)
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(4096 * MIB)
    expect(updateCalls(fake)).toHaveLength(2)
    expect(execs(fake)).toHaveLength(2)
  })

  it('applies a settings change on the next exec of a container in line', async () => {
    const { service, fake, settings } = setup()
    fake.add({ name: NAME, running: false })
    await service.startContainer(NAME)
    settings.containerMemoryMb = 2048
    await exec(service)
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(2048 * MIB)
  })

  it('an exec of a container in line makes no other podman call', async () => {
    const { service, fake } = setup()
    fake.add({ name: NAME, running: false })
    await service.startContainer(NAME)
    fake.calls.length = 0
    await exec(service)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0][0]).toBe('exec')
  })

  it('a stop forgets the record, so the next start checks again', async () => {
    const { service, fake } = setup()
    fake.add({ name: NAME, running: false })
    await service.startContainer(NAME)
    await service.stopContainer(NAME)
    fake.containers.get(NAME)!.memoryBytes = undefined
    await service.startContainer(NAME)
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(4096 * MIB)
  })

  it('a Settings start checks again after a stop outside this service', async () => {
    const { service, fake } = setup()
    fake.add({ name: NAME, running: false })
    await service.startContainer(NAME)
    Object.assign(fake.containers.get(NAME)!, { running: false, memoryBytes: undefined })
    await service.startContainer(NAME)
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(4096 * MIB)
  })

  it('a dead-container exec forgets the record', async () => {
    const { service, fake } = setup()
    fake.add({ name: NAME, running: false })
    await service.startContainer(NAME)
    fake.containers.get(NAME)!.running = false
    await exec(service)
    Object.assign(fake.containers.get(NAME)!, { running: true, memoryBytes: undefined })
    await exec(service)
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(4096 * MIB)
  })

  const bringUpAgent = (service: PodmanService) => service.ensureIsolatedRunning('agent', AGENT_ID, [], undefined, false)

  it('a restart in a bring-up checks again', async () => {
    const { service, fake } = setup()
    fake.add({ name: AGENT })
    await bringUpAgent(service)
    Object.assign(fake.containers.get(AGENT)!, { running: false, memoryBytes: undefined })
    await bringUpAgent(service)
    expect(fake.containers.get(AGENT)?.memoryBytes).toBe(4096 * MIB)
  })

  it('a create after the container vanished checks again', async () => {
    const { service, fake } = setup()
    fake.add({ name: AGENT, memoryBytes: 4096 * MIB }) // in line, so nothing has probed yet
    await bringUpAgent(service)
    fake.containers.delete(AGENT)
    fake.controllers = undefined // the create's probe fails, so it runs uncapped
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'run') { fake.controllers = ['memory']; later() } // and the failed probe's interval passes
      return answer(bin, args)
    }
    await bringUpAgent(service)
    expect(fake.containers.get(AGENT)?.memoryBytes).toBe(4096 * MIB)
  })

  it.each([['stopped', true], ['missing', false]])('a failed apply keeps its back-off when the exec finds the container %s', async (_state, exists) => {
    const { service, fake } = setup()
    if (exists) fake.add({ name: NAME, running: false })
    fake.failUpdate = true
    for (let i = 0; i < 5; i++) await exec(service)
    expect(memoryInspects(fake)).toHaveLength(1)
    expect(updateCalls(fake)).toHaveLength(exists ? 1 : 0)
    expect(warnings.filter((w) => w.includes('memory limit'))).toHaveLength(1)
    if (!exists) expect(warnings.find((w) => w.includes('memory limit'))).toContain(`no such container ${NAME}`)
  })

  it.each([
    ['a Settings start', NAME, (s: PodmanService) => s.startContainer(NAME)],
    ['a bring-up restart', AGENT, (s: PodmanService) => bringUpAgent(s)],
  ])('%s retries a failed apply at once', async (_path, name, start) => {
    const { service, fake } = setup()
    fake.add({ name, running: false })
    fake.failUpdate = true
    await exec(service, name)
    fake.failUpdate = false
    await start(service)
    expect(fake.containers.get(name)?.memoryBytes).toBe(4096 * MIB)
  })

  it('a start waits for an apply already running, so the latest setting lands last', async () => {
    const { service, fake, settings } = setup(1024)
    fake.add({ name: NAME })
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'update' && args.includes('1024m')) await gate
      return answer(bin, args)
    }
    const first = exec(service)
    await new Promise((resolve) => setTimeout(resolve, 10))
    settings.containerMemoryMb = 2048
    const started = service.startContainer(NAME)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([first, started])
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(2048 * MIB)
  })

  it('applies run in order, so the latest setting lands last', async () => {
    const { service, fake, settings } = setup(1024)
    fake.add({ name: NAME })
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args[0] === 'update' && args.includes('1024m')) await gate
      return answer(bin, args)
    }
    const first = exec(service)
    await new Promise((resolve) => setTimeout(resolve, 10))
    settings.containerMemoryMb = 2048
    const second = exec(service)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([first, second])
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(2048 * MIB)
  })

  it('overlapping calls after a change share one update', async () => {
    const { service, fake, settings } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    await service.ensureRunning()
    settings.containerMemoryMb = 2048
    await Promise.all([service.ensureRunning(), service.ensureRunning(), exec(service, SHARED), exec(service, SHARED)])
    expect(updateCalls(fake)).toHaveLength(1)
  })

  it('a call during the bring-up waits for it', async () => {
    const { service, fake } = setup()
    fake.add({ name: SHARED, memoryBytes: 4096 * MIB })
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args.join(' ').includes('State.Running')) await gate
      return answer(bin, args)
    }
    const first = service.ensureRunning()
    let secondDone = false
    const second = service.ensureRunning().then(() => { secondDone = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondDone).toBe(false)
    release()
    await Promise.all([first, second])
    expect(secondDone).toBe(true)
  })

  it('a failed apply waits out the interval, with one warning, unless the setting changes', async () => {
    const { service, fake, settings } = setup()
    fake.add({ name: NAME, running: false })
    fake.failUpdate = true
    await service.startContainer(NAME)
    await exec(service)
    await exec(service)
    expect(updateCalls(fake)).toHaveLength(1)
    expect(warnings.filter((w) => w.includes('memory limit'))).toHaveLength(1)
    later()
    await exec(service)
    await exec(service)
    expect(updateCalls(fake)).toHaveLength(2)
    settings.containerMemoryMb = 2048
    await exec(service)
    expect(updateCalls(fake)).toHaveLength(3)
  })

  const gateMemoryInspect = (service: PodmanService, fake: FakePodman) => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const answer = fake.exec0
    ;(service as unknown as { exec0: FakePodman['exec0'] }).exec0 = async (bin, args) => {
      if (args.join(' ').includes('HostConfig.Memory')) await gate
      return answer(bin, args)
    }
    return release
  }

  it('applies the setting it recorded, so A to B and back to A ends at A', async () => {
    const { service, fake, settings } = setup(4096)
    fake.add({ name: NAME })
    const release = gateMemoryInspect(service, fake)
    const first = exec(service)
    await new Promise((resolve) => setTimeout(resolve, 10))
    settings.containerMemoryMb = 2048
    release()
    await first
    settings.containerMemoryMb = 4096
    await exec(service)
    expect(fake.containers.get(NAME)?.memoryBytes).toBe(4096 * MIB)
  })

  it('starts no update once shutdown has begun', async () => {
    const { service, fake } = setup()
    fake.add({ name: NAME })
    const release = gateMemoryInspect(service, fake)
    const pending = exec(service)
    await new Promise((resolve) => setTimeout(resolve, 10))
    service.beginShutdown()
    release()
    await pending
    expect(updateCalls(fake)).toEqual([])
  })
})

describe('compute settings reader', () => {
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

  it.each([['abc'], [null]])('leaves judging containerMemoryMb %j to the service, which warns', async (value) => {
    expect(readComputeSettings({ containerMemoryMb: value }).containerMemoryMb).toBe(value)
    const { service, fake } = setup()
    service.setSettingsAccessor(() => readComputeSettings({ containerMemoryMb: value }))
    await service.ensureRunning()
    expect(calls(fake, 'run')[0]).toContain('4096m')
    expect(warnings.filter((w) => w.includes('containerMemoryMb') && w.includes(JSON.stringify(value))).length).toBeGreaterThan(0)
  })

  it('reads numeric machine strings as numbers, and leaves containerMemoryMb to the service', () => {
    expect(readComputeSettings({ machineCpus: '4', machineMemoryMb: '4096', containerMemoryMb: '8192' }))
      .toMatchObject({ machineCpus: 4, machineMemoryMb: 4096, containerMemoryMb: '8192' })
  })

  it('a missing containerMemoryMb gets the default with no warning', () => {
    expect(containerMemoryArgs(readComputeSettings({}))).toEqual(CAP_ARGS)
    expect(warnings).toEqual([])
  })

  it.each([[undefined], [null], ['x'], [{}], [{ containerPackages: 'git', machineCpus: 'four', machineMemoryMb: false, containerImage: 0 }]])('falls back to the defaults for %j', (raw) => {
    const { containerPackages, machineCpus, machineMemoryMb, containerMemoryMb, containerImage } = DEFAULT_COMPUTE_SETTINGS
    expect(readComputeSettings(raw)).toEqual({ containerPackages, machineCpus, machineMemoryMb, containerMemoryMb, containerImage })
  })

  it('drops non-string packages', () => {
    expect(readComputeSettings({ containerPackages: ['git', 1] }).containerPackages).toEqual(['git'])
  })
})
