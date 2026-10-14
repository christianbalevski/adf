import { describe, expect, it, vi, beforeEach } from 'vitest'

// No process may be spawned from this file: the fake podman answers every
// call, and anything that slips past it fails here instead of reaching a
// real podman (podman safety rule, incident 2026-10-14).
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  const refuse = () => { throw new Error('test tried to spawn a process') }
  return { ...real, execFile: refuse, spawn: refuse, execFileSync: refuse }
})

const { PodmanService } = await import('../../../src/main/services/podman.service')
const { FakePodman, installFakePodman } = await import('./fake-podman')

function sharedAndAgents(): InstanceType<typeof FakePodman> {
  return new FakePodman()
    .add({ name: 'adf-mcp' })
    .add({ name: 'adf-agent-1-11111111', agentId: '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111', agentName: 'agent-1' })
    .add({ name: 'adf-agent-2-22222222', agentId: '0b6a3c58-2222-4a40-9c55-3f0e0c3d2222', agentName: 'agent-2', running: false })
    .add({ name: 'adf-legacy', kind: 'legacy' })
}

describe('PodmanService shutdown, single runtime (characterization)', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  })

  it('stopAll stops every running managed container and leaves unmanaged ones', async () => {
    const svc = new PodmanService()
    const fake = installFakePodman(svc, sharedAndAgents())
    const statuses: string[] = []
    svc.on('status-changed', (s) => statuses.push(s.status))
    await svc.registerAgent('0b6a3c58-3333-4a40-9c55-3f0e0c3d3333').catch(() => {})

    await svc.stopAll()

    expect(fake.stopped().sort()).toEqual(['adf-agent-1-11111111', 'adf-mcp'])
    expect(fake.running()).toEqual(['adf-legacy'])
    expect(svc.getStatus()).toMatchObject({ status: 'stopped', activeAgents: [] })
    expect(statuses.at(-1)).toBe('stopped')
    expect(logs.some((l) => l.includes('adf-mcp') && l.includes('adf-agent-1-11111111'))).toBe(true)
  })

  it('stopAll marks every stopped container as stopped for the UI', async () => {
    const svc = new PodmanService()
    installFakePodman(svc, sharedAndAgents())
    const phases: Array<[string, string]> = []
    svc.on('container-phase', (e) => phases.push([e.containerName, e.phase]))

    await svc.stopAll()

    expect(phases.filter(([, p]) => p === 'stopped').map(([n]) => n).sort()).toEqual(['adf-agent-1-11111111', 'adf-mcp'])
  })

  it('stopAll with nothing running issues no stop', async () => {
    const svc = new PodmanService()
    const fake = installFakePodman(svc, new FakePodman().add({ name: 'adf-mcp', running: false }))
    await svc.stopAll()
    expect(fake.stopped()).toEqual([])
  })

  it('stopAll without podman is a no-op', async () => {
    const svc = new PodmanService()
    ;(svc as unknown as { findPodman: () => Promise<null> }).findPodman = async () => null
    await expect(svc.stopAll()).resolves.toBeUndefined()
  })

  it('stop() stops the shared container and clears active agents', async () => {
    const svc = new PodmanService()
    const fake = installFakePodman(svc, sharedAndAgents())
    await svc.registerAgent('0b6a3c58-3333-4a40-9c55-3f0e0c3d3333').catch(() => {})

    await svc.stop()

    expect(fake.stopped()).toEqual(['adf-mcp'])
    expect(fake.running()).toEqual(['adf-agent-1-11111111', 'adf-legacy'])
    expect(svc.getStatus()).toMatchObject({ status: 'stopped', activeAgents: [] })
  })
})

// ---------------------------------------------------------------------------
// Two runtimes on one machine (W1-G)
// ---------------------------------------------------------------------------

const { mkdtempSync, mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync, utimesSync, statSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { ComputeUserRegistry, markerLiveness } = await import('../../../src/main/services/compute-users')
const { isolatedContainerName, planContainerShutdown } = await import('../../../src/main/services/podman.service')

const ID_1 = '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111'
const ID_2 = '0b6a3c58-2222-4a40-9c55-3f0e0c3d2222'
const BOX_1 = isolatedContainerName('agent-1', ID_1)
const BOX_2 = isolatedContainerName('agent-2', ID_2)
const PID_A = 41_001
const PID_B = 41_002

/** The containers each runtime's host record (`<dir>/hosts/<pid>.json`) claims. */
function claimsOnDisk(dir: string): Record<string, string[]> {
  const hosts = join(dir, 'hosts')
  if (!existsSync(hosts)) return {}
  return Object.fromEntries(readdirSync(hosts).filter((n) => /^\d+\.json$/.test(n)).map((n) => [
    n.replace('.json', ''), (JSON.parse(readFileSync(join(hosts, n), 'utf-8')) as { containers?: string[] }).containers ?? [],
  ]))
}

interface Runtime {
  svc: InstanceType<typeof PodmanService>
  users: InstanceType<typeof ComputeUserRegistry>
}

function machine() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-compute-'))
  const alive = new Set<number>([PID_A, PID_B])
  // One podman, one container table, shared by every runtime on the machine.
  const podman = new FakePodman()
  const runtime = (pid: number, kind: 'studio-embedded' | 'daemon'): Runtime => {
    const users = new ComputeUserRegistry({ dir, pid, kind, host: 'test-host', liveness: markerLiveness({ isAlive: async (p) => alive.has(p) }), recheckMs: 10, exitHook: false })
    const svc = new PodmanService({ computeUsers: users })
    installFakePodman(svc, podman)
    // Provisioning is out of scope here: "create" just means running.
    ;(svc as unknown as { ensureContainerRunning: (b: string, name: string) => Promise<void> }).ensureContainerRunning =
      async (_b, name) => { if (!podman.containers.has(name)) podman.add({ name }); podman.containers.get(name)!.running = true }
    return { svc, users }
  }
  return { dir, alive, podman, a: runtime(PID_A, 'studio-embedded'), b: runtime(PID_B, 'daemon') }
}

describe('PodmanService shutdown with two runtimes', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  })

  it("runtime A's shutdown leaves runtime B's containers running", async () => {
    const { podman, a, b } = machine()
    await a.svc.ensureIsolatedRunning('agent-1', ID_1)
    await b.svc.ensureIsolatedRunning('agent-2', ID_2)

    await a.svc.stopAll()

    expect(podman.stopped()).toEqual([BOX_1])
    expect(podman.running()).toEqual([BOX_2])
  })

  it('the shared container stops only when no other live runtime uses it', async () => {
    const { podman, a, b } = machine()
    await a.svc.ensureRunning()
    await b.svc.ensureRunning()

    await a.svc.stopAll()
    expect(podman.running()).toEqual(['adf-mcp'])

    await b.svc.stopAll()
    expect(podman.stopped()).toEqual(['adf-mcp'])
    expect(podman.running()).toEqual([])
  })

  it('stop() (BackgroundAgentManager.stopAll, Settings → Stop) leaves the shared container to the other runtime', async () => {
    const { podman, a, b } = machine()
    await a.svc.ensureRunning()
    await b.svc.ensureRunning()

    await a.svc.stop()

    expect(podman.running()).toEqual(['adf-mcp'])
    expect(logs).toContain(`[Compute] Leaving adf-mcp running (used by daemon pid ${PID_B})`)
    expect(a.svc.getStatus()).toMatchObject({
      status: 'stopped',
      leftRunning: [{ name: 'adf-mcp', holders: [`daemon pid ${PID_B}`], reason: `used by daemon pid ${PID_B}` }],
    })

    // The next start clears it.
    await a.svc.ensureRunning()
    expect(a.svc.getStatus().leftRunning).toBeUndefined()
  })

  it('leftRunning clears on an agent container start and on a stop that finds nothing running', async () => {
    const { podman, a, b } = machine()
    await a.svc.ensureRunning()
    await b.svc.ensureRunning()
    const leftAfterStop = async () => { await a.svc.stop(); return a.svc.getStatus().leftRunning?.map((l) => l.name) }

    expect(await leftAfterStop()).toEqual(['adf-mcp'])
    await a.svc.ensureIsolatedRunning('agent-1', ID_1)
    expect(a.svc.getStatus().leftRunning).toBeUndefined()

    expect(await leftAfterStop()).toEqual(['adf-mcp'])
    podman.add({ name: BOX_1, agentId: ID_1, agentName: 'agent-1', running: false })
    await a.svc.startContainer(BOX_1)
    expect(a.svc.getStatus().leftRunning).toBeUndefined()

    expect(await leftAfterStop()).toEqual(['adf-mcp'])
    await b.svc.stopAll() // B stops adf-mcp (and A's BOX_1, which A no longer claims)
    await a.svc.stopAll() // nothing running any more
    expect(a.svc.getStatus().leftRunning).toBeUndefined()
  })

  it('concurrent shutdowns of both runtimes stop the shared container', async () => {
    const { podman, a, b } = machine()
    await a.svc.ensureRunning()
    await b.svc.ensureRunning()

    await Promise.all([a.svc.stopAll(), b.svc.stopAll()])

    expect(podman.running()).toEqual([])
  })

  it('concurrent stop() calls of both runtimes stop the shared container', async () => {
    const { podman, a, b } = machine()
    await a.svc.ensureRunning()
    await b.svc.ensureRunning()

    await Promise.all([a.svc.stop(), b.svc.stop()])

    expect(podman.running()).toEqual([])
  })

  it('first run after the upgrade: containers running, no markers, everything stops', async () => {
    const { dir, a } = machine()
    const podman = installFakePodman(a.svc, sharedAndAgents())

    await a.svc.stopAll()

    expect(claimsOnDisk(dir)).toEqual({})
    expect(podman.stopped().sort()).toEqual(['adf-agent-1-11111111', 'adf-mcp'])
  })

  it('a reused pid without a heartbeat pins nothing', async () => {
    const { dir, podman, a, b } = machine()
    await b.svc.ensureRunning()
    await b.svc.ensureIsolatedRunning('agent-2', ID_2)
    // B was killed; its pid now belongs to another process (still "alive"),
    // and its marker has not been touched for 10 minutes.
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(b.users.file, old, old)

    await a.svc.stopAll()

    expect(podman.running()).toEqual([])
    // B's record is swept; A never claimed anything, so wrote none.
    expect(claimsOnDisk(dir)).toEqual({})
    expect(logs).toContain(`[Compute] Ignoring container claims of pid ${PID_B}: no heartbeat for 600s (pid reused)`)
  })

  it('destroy() warns about the runtimes it takes the shared container from', async () => {
    const { a, b } = machine()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await b.svc.ensureRunning()
    ;(a.svc as unknown as { exec0: unknown }).exec0 = async () => ({ code: 0, stdout: '', stderr: '' })

    expect(await a.svc.containerUsers()).toEqual([`daemon pid ${PID_B}`])
    await a.svc.destroy()

    expect(warn).toHaveBeenCalledWith(`[Compute] Removing adf-mcp although daemon pid ${PID_B} uses it (explicit reset); it is recreated on its next use`)
  })

  it('logs one line naming what was stopped and what was left, with the reason', async () => {
    const { a, b } = machine()
    await a.svc.ensureRunning()
    await a.svc.ensureIsolatedRunning('agent-1', ID_1)
    await b.svc.ensureRunning()
    await b.svc.ensureIsolatedRunning('agent-2', ID_2)

    await a.svc.stopAll()

    const lines = logs.filter((l) => l.startsWith('[Compute] Stopping'))
    expect(lines).toEqual([
      `[Compute] Stopping 1 container(s): ${BOX_1}; leaving 2 running: adf-mcp (used by daemon pid ${PID_B}), ${BOX_2} (used by daemon pid ${PID_B})`,
    ])
  })

  it('a crashed runtime pins nothing: the next shutdown stops its orphans and sweeps its marker', async () => {
    const { dir, alive, podman, a, b } = machine()
    await a.svc.ensureRunning()
    await b.svc.ensureRunning()
    await b.svc.ensureIsolatedRunning('agent-2', ID_2)
    alive.delete(PID_B) // B crashed: no graceful stop, its marker stays behind

    await a.svc.stopAll()

    expect(podman.running()).toEqual([])
    expect(claimsOnDisk(dir)).toEqual({ [PID_A]: [] })
  })

  it("a dead runtime's marker never protects or exposes a live runtime's containers", async () => {
    const { dir, alive, podman, a, b } = machine()
    await b.svc.ensureIsolatedRunning('agent-2', ID_2)
    const dead = new ComputeUserRegistry({ dir, pid: 41_003, host: 'test-host', exitHook: false })
    await dead.claim(BOX_1)
    podman.add({ name: BOX_1, agentId: ID_1, agentName: 'agent-1' })
    alive.delete(41_003)

    await a.svc.stopAll()

    expect(podman.running()).toEqual([BOX_2])
    expect(podman.stopped()).toEqual([BOX_1])
  })

  it("stops only its own containers when a live runtime's claims are unreadable", async () => {
    const { dir, podman, a } = machine()
    podman.add({ name: BOX_2, agentId: ID_2, agentName: 'agent-2' }) // started by B, marker unreadable
    await a.svc.ensureIsolatedRunning('agent-1', ID_1)
    mkdirSync(join(dir, 'hosts'), { recursive: true })
    writeFileSync(join(dir, 'hosts', `${PID_B}.json`), '{not json')

    await a.svc.stopAll()

    expect(podman.running()).toEqual([BOX_2])
    expect(logs.some((l) => l.includes(`${BOX_2} (owner unknown: unreadable container claims of pid ${PID_B})`))).toBe(true)
  })

  it('ignores markers from another machine (shared network home)', async () => {
    const { dir, podman, a } = machine()
    const elsewhere = new ComputeUserRegistry({ dir, pid: PID_B, host: 'other-host', machineId: 'other-machine', liveness: async () => ({ alive: true, reason: 'test' }), exitHook: false })
    podman.add({ name: BOX_2, agentId: ID_2, agentName: 'agent-2' })
    await elsewhere.claim(BOX_2)

    await a.svc.stopAll()

    expect(podman.running()).toEqual([])
    expect(claimsOnDisk(dir)[PID_B]).toEqual([BOX_2]) // never removed from here
  })

  it('its host record claims nothing once it has stopped its containers', async () => {
    const { dir, a } = machine()
    await a.svc.ensureIsolatedRunning('agent-1', ID_1)
    expect(claimsOnDisk(dir)).toEqual({ [PID_A]: [BOX_1] })

    await a.svc.stopAll()

    expect(claimsOnDisk(dir)).toEqual({ [PID_A]: [] })
  })

  it('stopping an agent container releases the claim; starting one claims it', async () => {
    const { a, b, podman } = machine()
    podman.add({ name: BOX_1, agentId: ID_1, agentName: 'agent-1', running: false })
    await a.svc.ensureIsolatedRunning('agent-1', ID_1)
    await a.svc.stopIsolated('agent-1', ID_1)
    expect([...a.users.own()]).toEqual([])

    await a.svc.startContainer(BOX_1)
    expect([...a.users.own()]).toEqual([BOX_1])
    await b.svc.stopAll()
    expect(podman.running()).toEqual([BOX_1])
  })
})

describe('ComputeUserRegistry', () => {
  it('heartbeats its marker while it holds claims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-hb-'))
    const users = new ComputeUserRegistry({ dir, pid: PID_A, host: 'test-host', heartbeatMs: 20, heartbeatTickMs: 10, exitHook: false })
    await users.claim('adf-mcp')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(users.file, old, old)

    await vi.waitFor(() => expect(statSync(users.file).mtimeMs).toBeGreaterThan(Date.now() - 60_000), { timeout: 2000 })
    await users.release(['adf-mcp'])
  })

  it('retries a failed marker write on the next call and on a timer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-retry-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, '') // a file where the registry wants a directory
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const users = new ComputeUserRegistry({ dir: join(blocker, 'compute'), pid: PID_A, host: 'test-host', retryMs: 20, exitHook: false })

    await users.claim('adf-mcp')
    expect(existsSync(users.file)).toBe(false)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('Could not record container use'))).toHaveLength(1)

    rmSync(blocker) // plain file, no links
    await vi.waitFor(() => expect(existsSync(users.file)).toBe(true), { timeout: 2000 })
    expect(claimsOnDisk(join(blocker, 'compute'))).toEqual({ [PID_A]: ['adf-mcp'] })
    await users.release(['adf-mcp'])
    expect(claimsOnDisk(join(blocker, 'compute'))).toEqual({ [PID_A]: [] })
  })

  it('a dirty registry rewrites its marker before reading the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-dirty-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const users = new ComputeUserRegistry({ dir: join(blocker, 'compute'), pid: PID_A, host: 'test-host', retryMs: 60_000, exitHook: false })
    await users.claim('adf-mcp')
    rmSync(blocker)

    await users.others()

    expect(existsSync(users.file)).toBe(true)
    await users.release(['adf-mcp'])
  })
})

describe('ComputeUserRegistry across suspend (fake timers)', () => {
  // Timers and Date are fake; file I/O is real, so pump the event loop
  // (setImmediate stays real) until the I/O a timer started has finished.
  const pump = async (done: () => boolean) => {
    // The reader reads each record before judging it: give loaded runs room.
    for (let i = 0; i < 20000 && !done(); i++) await new Promise((r) => setImmediate(r))
  }
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  const staleMarker = (dir: string, pid: number, containers: string[]) => {
    mkdirSync(join(dir, 'hosts'), { recursive: true })
    const file = join(dir, 'hosts', `${pid}.json`)
    writeFileSync(file, JSON.stringify({ v: 1, pid, runtimeId: `r${pid}`, hostname: 'test-host', kind: 'daemon', mode: 'daemon', startedAt: 1, settingsPath: '', version: null, endpoint: null, containers }))
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(file, old, old)
    return file
  }
  const reader = (dir: string) => new ComputeUserRegistry({
    dir, pid: PID_A, host: 'test-host', exitHook: false,
    liveness: markerLiveness({ isAlive: async () => true }),
  })

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return () => { vi.useRealTimers() }
  })

  it('the holder refreshes its marker within one tick of a wall-clock jump (resume)', async () => {
    fakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-resume-'))
    const holder = new ComputeUserRegistry({ dir, pid: PID_B, host: 'test-host', exitHook: false })
    await holder.claim('adf-mcp')
    const written = statSync(holder.file).mtimeMs

    // Suspended for 10 minutes: the clock jumps, no interval fired meanwhile.
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await pump(() => statSync(holder.file).mtimeMs > written + 60_000)

    expect(statSync(holder.file).mtimeMs).toBeGreaterThan(Date.now() - 10_000)
    await holder.release(['adf-mcp'])
  })

  it('a reader keeps a stale marker whose holder touches it during the re-check wait', async () => {
    fakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-recheck-'))
    const file = staleMarker(dir, PID_B, ['adf-mcp'])

    let result: Awaited<ReturnType<InstanceType<typeof ComputeUserRegistry>['others']>> | undefined
    const reading = reader(dir).others().then((r) => { result = r })
    await pump(() => vi.getTimerCount() > 0)
    expect(vi.getTimerCount()).toBe(1)
    utimesSync(file, new Date(), new Date()) // holder resumed and touched it
    await vi.advanceTimersByTimeAsync(6_000)
    await pump(() => result !== undefined)
    await reading

    expect(result!.claims.get('adf-mcp')).toEqual([`daemon pid ${PID_B}`])
    expect(existsSync(file)).toBe(true)
  })

  it('a reader voids stale markers after one shared wait of about 6 s', async () => {
    fakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'adf-w1g-void-'))
    const files = [staleMarker(dir, PID_B, ['adf-mcp']), staleMarker(dir, 41_003, [BOX_1]), staleMarker(dir, 41_004, [BOX_2])]

    let result: Awaited<ReturnType<InstanceType<typeof ComputeUserRegistry>['others']>> | undefined
    const started = Date.now()
    const reading = reader(dir).others().then((r) => { result = r })
    await pump(() => vi.getTimerCount() > 0)
    expect(vi.getTimerCount()).toBe(1) // one wait for all three markers
    await vi.advanceTimersByTimeAsync(5_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pump(() => result !== undefined)
    await reading

    expect(Date.now() - started).toBe(6_000)
    expect(result!.claims.size).toBe(0)
    expect(files.filter((f) => existsSync(f))).toEqual([])
  })
})

describe('planContainerShutdown', () => {
  const none = { claims: new Map<string, string[]>(), unreadable: [] as string[] }

  it('stops everything when no other runtime claims anything (single-runtime behaviour)', () => {
    expect(planContainerShutdown(['adf-mcp', BOX_1], new Set(), none)).toEqual({ stop: ['adf-mcp', BOX_1], keep: [] })
  })

  it('keeps containers another runtime claims, even ones this runtime also uses', () => {
    const others = { claims: new Map([['adf-mcp', ['daemon pid 7']]]), unreadable: [] }
    expect(planContainerShutdown(['adf-mcp', BOX_1], new Set(['adf-mcp', BOX_1]), others)).toEqual({
      stop: [BOX_1],
      keep: [{ name: 'adf-mcp', holders: ['daemon pid 7'], reason: 'used by daemon pid 7' }],
    })
  })
})
