// The machine id in lease and host records (W5-G, CI run 38749217035: a
// Windows host record carried `machineId: null`). reg.exe answered after its
// 3 s timeout on a loaded runner (2-4 s measured locally under CPU load), and
// the failed lookup was cached for the whole process. A record without a
// machine id is judged by the reader's own pids, so a runtime on another
// machine sharing the lease folder could take a live agent. The lookup now
// retries with a longer timeout, a failure is remembered only briefly, and a
// registry that wrote its records without the id (the first write waits at
// most 3 s, as before) rewrites them once it is read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), on: () => {}, getName: () => 'adf-lease-test', getVersion: () => '0.0.0-test' },
}))

import { __setMachineIdReaderForTests, AgentLeaseRegistry, fromOtherMachine, machineId, type AgentLeaseRecord } from '../../src/main/runtime/agent-lease'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  __setMachineIdReaderForTests()
  vi.restoreAllMocks()
})

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-lease-machine-id-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function registry(dir: string, opts: ConstructorParameters<typeof AgentLeaseRegistry>[0] = {}): AgentLeaseRegistry {
  const reg = new AgentLeaseRegistry({ dir: join(dir, 'leases'), kind: 'daemon', settingsPath: join(dir, 'adf-settings.json'), sweepDeadEntries: false, ...opts })
  cleanups.push(() => reg.close())
  return reg
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf-8')) as T

describe('machine id lookup', () => {
  it('a lookup that times out once is retried with a longer timeout: the host record carries the id', async () => {
    const timeouts: number[] = []
    __setMachineIdReaderForTests(async (timeoutMs) => {
      timeouts.push(timeoutMs)
      if (timeouts.length === 1) throw new Error('spawn reg.exe ETIMEDOUT')
      return 'B5C7E1A2-0000-4000-8000-0123456789AB'
    })
    const dir = tempDir()
    const reg = registry(dir)
    await reg.configure({ kind: 'daemon' })
    expect(timeouts).toEqual([3_000, 10_000])
    expect(readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId).toBe('b5c7e1a2-0000-4000-8000-0123456789ab')
  })

  it('a failed lookup is not cached for the process: the next one after the retry interval reads the id', async () => {
    let answer: string | null = null
    __setMachineIdReaderForTests(async () => {
      if (!answer) throw new Error('spawn reg.exe ETIMEDOUT')
      return answer
    }, { retryMs: 40 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await machineId()).toBeNull()
    answer = 'machine-1'
    // Within the interval the failure stands (no reg.exe per liveness check).
    expect(await machineId()).toBeNull()
    await new Promise((r) => setTimeout(r, 60))
    expect(await machineId()).toBe('machine-1')
  })

  it('records written while the id was unreadable get it once it is read: the host record and every held lease', async () => {
    let answer: string | null = null
    __setMachineIdReaderForTests(async () => {
      if (!answer) throw new Error('spawn reg.exe ETIMEDOUT')
      return answer
    }, { retryMs: 40 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = tempDir()
    const agent = join(dir, 'agent-1.adf')
    writeFileSync(agent, '')
    const reg = registry(dir)
    await reg.configure({ kind: 'daemon' })
    const lease = await reg.acquire(agent)
    expect(lease.ok).toBe(true)
    const leaseFile = (lease as { leaseFile: string }).leaseFile
    expect(readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId).toBeNull()
    expect(readJson<AgentLeaseRecord>(leaseFile).holder.machineId).toBeNull()

    answer = 'machine-1'
    await expect.poll(() => readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId, { timeout: 5_000 }).toBe('machine-1')
    await expect.poll(() => readJson<AgentLeaseRecord>(leaseFile).holder.machineId, { timeout: 5_000 }).toBe('machine-1')
    // New leases and the registry's own view carry it as well.
    expect(reg.holder().machineId).toBe('machine-1')
    const agent2 = join(dir, 'agent-2.adf')
    writeFileSync(agent2, '')
    const second = await reg.acquire(agent2)
    expect(readJson<AgentLeaseRecord>((second as { leaseFile: string }).leaseFile).holder.machineId).toBe('machine-1')
  })

  it('a lookup slower than the wait of the first write goes on: the records written meanwhile get the id when it answers', async () => {
    let answer!: (id: string) => void
    const slow = new Promise<string>((resolve) => { answer = resolve })
    __setMachineIdReaderForTests(() => slow, { waitMs: 30 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = tempDir()
    const agent = join(dir, 'agent-1.adf')
    writeFileSync(agent, '')
    const reg = registry(dir)
    const lease = await reg.acquire(agent)
    const leaseFile = (lease as { leaseFile: string }).leaseFile
    // The start did not wait for the lookup.
    expect(readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId).toBeNull()
    expect(readJson<AgentLeaseRecord>(leaseFile).holder.machineId).toBeNull()
    answer('machine-1')
    await expect.poll(() => readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId, { timeout: 5_000 }).toBe('machine-1')
    await expect.poll(() => readJson<AgentLeaseRecord>(leaseFile).holder.machineId, { timeout: 5_000 }).toBe('machine-1')
  })

  it('a platform with no machine id (empty /etc/machine-id, a container) is cached for the process and said once, never asked again', async () => {
    let reads = 0
    __setMachineIdReaderForTests(async () => { reads++; return '  ' + String.fromCharCode(10) }, { retryMs: 20 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = tempDir()
    const reg = registry(dir)
    await reg.configure({ kind: 'daemon' })
    expect(await machineId()).toBeNull()
    await new Promise((r) => setTimeout(r, 120))
    expect(await machineId()).toBeNull()
    expect(reads).toBe(1)
    expect(warn.mock.calls.filter(([m]) => String(m).includes('This machine has no machine id')).length).toBe(1)
    expect(readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId).toBeNull()
  })

  it('a liveness check waits at most the old 3 s for the machine id of this machine; the lookup goes on', async () => {
    let answer!: (id: string) => void
    const slow = new Promise<string>((resolve) => { answer = resolve })
    __setMachineIdReaderForTests(() => slow, { waitMs: 30 })
    const t0 = Date.now()
    // Unknown yet: judged as this machine's record (by pids), not waited for.
    expect(await fromOtherMachine({ machineId: 'machine-2' })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2_000)
    answer('machine-1')
    expect(await machineId()).toBe('machine-1')
    expect(await fromOtherMachine({ machineId: 'machine-2' })).toBe(true)
  })

  it('an acquire under way (in a takeover) when the id arrives writes its lease with the id', async () => {
    let answer!: (id: string) => void
    const slow = new Promise<string>((resolve) => { answer = resolve })
    __setMachineIdReaderForTests(() => slow, { waitMs: 30 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = tempDir()
    const agent = join(dir, 'agent-1.adf')
    writeFileSync(agent, '')
    let reg!: AgentLeaseRegistry
    reg = registry(dir, {
      // Under the takeover lock, before the lease is replaced: the id arrives
      // and the host record is rewritten with it while this acquire waits.
      beforeTakeoverReplace: async () => {
        answer('machine-1')
        const deadline = Date.now() + 5_000
        while (readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId !== 'machine-1' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10))
        }
      },
    })
    await reg.configure({ kind: 'daemon' })
    // A lease file left half-written by a crash long ago: replaced through a takeover.
    const leaseFile = join(dir, 'leases', `${(await import('../../src/main/runtime/agent-lease')).leaseKeyForCanonicalPath(realpathSync.native(agent))}.json`)
    writeFileSync(leaseFile, '{"v":1,')
    utimesSync(leaseFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const lease = await reg.acquire(agent)
    expect(lease.ok).toBe(true)
    expect(readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId).toBe('machine-1')
    expect(readJson<AgentLeaseRecord>(leaseFile).holder.machineId).toBe('machine-1')
  })

  it('the late id never rewrites a lease another runtime took over meanwhile', async () => {
    let answer!: (id: string) => void
    const slow = new Promise<string>((resolve) => { answer = resolve })
    __setMachineIdReaderForTests(() => slow, { waitMs: 30 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = tempDir()
    const agent = join(dir, 'agent-1.adf')
    writeFileSync(agent, '')
    const reg = registry(dir)
    const lease = await reg.acquire(agent)
    const leaseFile = (lease as { leaseFile: string }).leaseFile
    const taken = readJson<AgentLeaseRecord>(leaseFile)
    const other: AgentLeaseRecord = { ...taken, holder: { ...taken.holder, runtimeId: 'another-runtime', pid: 4242, machineId: null } }
    writeFileSync(leaseFile, JSON.stringify(other, null, 2))
    answer('machine-1')
    await expect.poll(() => readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId, { timeout: 5_000 }).toBe('machine-1')
    await new Promise((r) => setTimeout(r, 50))
    expect(readJson<AgentLeaseRecord>(leaseFile).holder).toEqual(other.holder)
  })

  it('the late id waits for a taker in its critical section (the lease takeover lock) before it rewrites the lease', async () => {
    let answer!: (id: string) => void
    const slow = new Promise<string>((resolve) => { answer = resolve })
    __setMachineIdReaderForTests(() => slow, { waitMs: 30 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = tempDir()
    const agent = join(dir, 'agent-1.adf')
    writeFileSync(agent, '')
    const reg = registry(dir)
    const lease = await reg.acquire(agent)
    const leaseFile = (lease as { leaseFile: string }).leaseFile
    const before = readFileSync(leaseFile, 'utf-8')
    // A live taker (this process's pid, no endpoint) holds the lock: it has read the lease bytes it judges.
    const lock = `${leaseFile}.takeover`
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runtimeId: 'taker', endpoint: null, at: Date.now() }))
    answer('machine-1')
    await expect.poll(() => readJson<{ machineId: string | null }>(reg.hostEntryFile).machineId, { timeout: 5_000 }).toBe('machine-1')
    await new Promise((r) => setTimeout(r, 300))
    // Not rewritten under the taker: the bytes it judged are still there.
    expect(readFileSync(leaseFile, 'utf-8')).toBe(before)
    rmSync(lock)
    await expect.poll(() => readJson<AgentLeaseRecord>(leaseFile).holder.machineId, { timeout: 5_000 }).toBe('machine-1')
  })
})
