/**
 * Quit budgets vs the stale-marker re-check (tracker W1-G follow-up, W4-A):
 * a quit that is cut off while compute ownership is still being decided
 * never stops another runtime's containers, and leaves only its own
 * containers running, unclaimed, for the next shutdown to stop.
 *
 * - Embedded Studio: cleanupAllProcesses gives teardown 6 s, the same as
 *   STALE_RECHECK_MS. Its claims are released BEFORE it reads the others, so
 *   a cut during the re-check strands nothing it could protect.
 * - Daemon mode: Studio stops nothing itself; the daemon runs its own
 *   bounded shutdown (20 s) after Studio exited, which fits the re-check and
 *   the container stops.
 *
 * No process is spawned: the fake podman answers every call.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  const refuse = () => { throw new Error('test tried to spawn a process') }
  return { ...real, execFile: refuse, spawn: refuse, execFileSync: refuse }
})

const { mkdtempSync, readdirSync, readFileSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { PodmanService, isolatedContainerName } = await import('../../../src/main/services/podman.service')
const { ComputeUserRegistry, STALE_RECHECK_MS } = await import('../../../src/main/services/compute-users')
const { withDeadline } = await import('../../../src/main/utils/concurrency')
const { FakePodman, installFakePodman } = await import('./fake-podman')

const ID_1 = '0b6a3c58-1111-4a40-9c55-3f0e0c3d1111'
const ID_2 = '0b6a3c58-2222-4a40-9c55-3f0e0c3d2222'
const BOX_1 = isolatedContainerName('agent-1', ID_1)
const BOX_2 = isolatedContainerName('agent-2', ID_2)
const STUDIO = 42_001
const DAEMON = 42_002

function claimsOnDisk(dir: string): Record<string, string[]> {
  const hosts = join(dir, 'hosts')
  if (!existsSync(hosts)) return {}
  return Object.fromEntries(readdirSync(hosts).filter((n) => /^\d+\.json$/.test(n)).map((n) => [
    n.replace('.json', ''), (JSON.parse(readFileSync(join(hosts, n), 'utf-8')) as { containers?: string[] }).containers ?? [],
  ]))
}

function machine(opts: { recheckMs: number; staleOnce: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-quit-budget-'))
  const podman = new FakePodman()
  // The daemon's marker reads stale once (a heartbeat missed across a suspend), then fresh.
  let staleReads = opts.staleOnce
  const runtime = (pid: number, kind: 'studio-embedded' | 'daemon') => {
    const users = new ComputeUserRegistry({
      dir, pid, kind, host: 'test-host', exitHook: false, recheckMs: opts.recheckMs,
      liveness: async ({ pid: other }) => {
        if (other === DAEMON && staleReads > 0) { staleReads--; return { alive: false, recheck: true, reason: 'no heartbeat for 130s' } }
        return { alive: true, reason: 'pid running, heartbeat fresh' }
      },
    })
    const svc = new PodmanService({ computeUsers: users })
    installFakePodman(svc, podman)
    ;(svc as unknown as { ensureContainerRunning: (b: string, name: string) => Promise<void> }).ensureContainerRunning =
      async (_b, name) => { if (!podman.containers.has(name)) podman.add({ name }); podman.containers.get(name)!.running = true }
    return svc
  }
  return { dir, podman, studio: runtime(STUDIO, 'studio-embedded'), daemon: runtime(DAEMON, 'daemon') }
}

describe('quit budget vs the stale-marker re-check', () => {
  it('embedded Studio cut off during the re-check stops nothing, and has already given up its claims', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { dir, podman, studio, daemon } = machine({ recheckMs: 400, staleOnce: 1 })
    await studio.ensureIsolatedRunning('agent-1', ID_1)
    await daemon.ensureIsolatedRunning('agent-2', ID_2)
    await studio.ensureRunning()
    await daemon.ensureRunning()

    // Studio's teardown budget expires while stopAll waits on the re-check.
    const stopping = studio.stopAll()
    const { timedOut } = await withDeadline(stopping, 100, () => {})
    expect(timedOut).toBe(true)
    expect(podman.stopped()).toEqual([])
    expect(claimsOnDisk(dir)[String(STUDIO)]).toEqual([])
    expect(claimsOnDisk(dir)[String(DAEMON)]?.sort()).toEqual(['adf-mcp', BOX_2].sort())

    // Had Studio lived on: the re-check finds the daemon alive; only Studio's own box stops.
    await stopping
    expect(podman.stopped()).toEqual([BOX_1])
    expect(podman.running().sort()).toEqual(['adf-mcp', BOX_2].sort())
  })

  it('the daemon\'s shutdown after Studio quit stops its own containers and Studio\'s unclaimed ones, never a live runtime\'s', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { podman, studio, daemon } = machine({ recheckMs: 10, staleOnce: 0 })
    await studio.ensureIsolatedRunning('agent-1', ID_1)
    await daemon.ensureIsolatedRunning('agent-2', ID_2)
    // Studio's quit was cut off before any stop: its claims are gone (released first), its box runs.
    const cut = studio.stopAll()
    await withDeadline(cut, 0, () => {})
    await cut
    podman.containers.get(BOX_1)!.running = true

    await daemon.stopAll()
    expect(podman.running()).toEqual([])
  })

  it('the daemon\'s bounded shutdown (20 s) leaves room for the re-check and the container stops (podman stop -t 5)', () => {
    expect(STALE_RECHECK_MS + 5_000).toBeLessThan(20_000)
  })
})
