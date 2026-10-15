// The machine id in lease and host records (W5-G, CI run 38749217035: a
// Windows host record carried `machineId: null`). reg.exe answered after its
// 3 s timeout on a loaded runner, and the failed lookup was cached for the
// whole process. A record without a machine id is judged by the reader's own
// pids, so a runtime on another machine sharing the lease folder could take a
// live agent. The lookup now retries with a longer timeout, a failure is
// remembered only briefly, and a registry that wrote its records without the
// id rewrites them once it is read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), on: () => {}, getName: () => 'adf-lease-test', getVersion: () => '0.0.0-test' },
}))

import { __setMachineIdReaderForTests, AgentLeaseRegistry, machineId, type AgentLeaseRecord } from '../../src/main/runtime/agent-lease'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  __setMachineIdReaderForTests()
})

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-lease-machine-id-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function registry(dir: string): AgentLeaseRegistry {
  const reg = new AgentLeaseRegistry({ dir: join(dir, 'leases'), kind: 'daemon', settingsPath: join(dir, 'adf-settings.json'), sweepDeadEntries: false })
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
    }, 40)
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
    }, 40)
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
})
