import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-lease-test-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-lease-test', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import {
  AGENT_LEASED_CODE,
  AgentLeaseRegistry,
  agentLeasedMessage,
  canonicalLeasePath,
  LeasedStartTracker,
  leaseKeyForCanonicalPath,
  leaseDir,
  listRuntimeHosts,
  machineId,
  listStudioClients,
  processAgentLeases,
  type AgentLeaseRecord,
} from '../../src/main/runtime/agent-lease'
import { RuntimeLoopError, RuntimeService } from '../../src/main/runtime/runtime-service'
import { BackgroundAgentManager } from '../../src/main/runtime/background-agent-manager'
import { RuntimeGate } from '../../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { markConfigReviewed } from '../../src/main/services/agent-review'
import { daemonPaths, studioConflict } from '../../src/main/cli/daemon-control'
import { registerDaemonModeHandlers } from '../../src/main/backend/daemon-mode'
import type { AssembledAgent } from '../../src/main/runtime/assemble-agent'
import type { SettingsService } from '../../src/main/services/settings.service'
import type { AgentConfig } from '../../src/shared/types/adf-v02.types'

const IS_WIN = process.platform === 'win32'
const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  RuntimeGate._resetForTests()
})

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A registry standing in for one process (own runtime id and endpoint). */
function registry(dir: string, opts: ConstructorParameters<typeof AgentLeaseRegistry>[0] = {}): AgentLeaseRegistry {
  const reg = new AgentLeaseRegistry({ dir, kind: 'daemon', settingsPath: join(dir, 'adf-settings.json'), ...opts })
  cleanups.push(() => reg.close())
  return reg
}

function seedAgent(dir: string, name: string, autostart = true): { filePath: string; config: AgentConfig } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions: { handle: name, autostart, start_in_state: 'hibernate' },
  })
  const config = created.workspace.getAgentConfig() as AgentConfig
  created.dispose()
  return { filePath, config }
}

function leaseFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
}

function readOnlyLease(dir: string): AgentLeaseRecord {
  const files = leaseFiles(dir)
  expect(files).toHaveLength(1)
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) as AgentLeaseRecord
}

// --- child processes ---------------------------------------------------------

/** Kill a process tree for good (taskkill /T /F on Windows: plain kill leaves children). */
function killTree(pid: number): void {
  try {
    if (IS_WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    else process.kill(pid, 'SIGKILL')
  } catch { /* already gone */ }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((r) => child.once('exit', () => r()))
}

class Child {
  readonly lines: string[] = []
  stderr = ''
  private waiters: Array<{ prefix: string; resolve: (line: string) => void }> = []

  constructor(readonly proc: ChildProcess) {
    let buf = ''
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        this.lines.push(line)
        for (const w of [...this.waiters]) {
          if (line.startsWith(w.prefix)) {
            this.waiters.splice(this.waiters.indexOf(w), 1)
            w.resolve(line)
          }
        }
      }
    })
    proc.stderr!.on('data', (chunk: Buffer) => { this.stderr += chunk.toString() })
    cleanups.push(async () => {
      if (proc.exitCode === null && proc.signalCode === null) killTree(proc.pid!)
      await waitForExit(proc)
    })
  }

  get pid(): number { return this.proc.pid! }

  send(line: string): void { this.proc.stdin!.write(`${line}\n`) }

  /** Next line starting with `prefix` (lines already seen count once). */
  next(prefix: string, timeoutMs = 30_000): Promise<string> {
    const seen = this.lines.findIndex((l) => l.startsWith(prefix))
    if (seen >= 0) return Promise.resolve(this.lines.splice(seen, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${prefix}"; stderr:\n${this.stderr}`)), timeoutMs)
      this.waiters.push({ prefix, resolve: (line) => { clearTimeout(timer); this.lines.splice(this.lines.indexOf(line), 1); resolve(line) } })
    })
  }

  async report(): Promise<{ started: Array<{ filePath: string }>; skipped: Array<{ reason: string; message?: string }>; failed: unknown[] }> {
    return JSON.parse((await this.next('REPORT ')).slice('REPORT '.length))
  }
}

// Child bundles live inside the worktree (gitignored out/), so their bare
// imports resolve by walking up to node_modules: no link to it is created.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const bundleDir = join(repoRoot, 'out', 'test-fixtures')
const bundles: string[] = []
let childBundle = ''
let takerBundle = ''

async function bundle(entry: string): Promise<string> {
  mkdirSync(bundleDir, { recursive: true })
  const outfile = join(bundleDir, `${entry}-${process.pid}-${Date.now()}.mjs`)
  bundles.push(outfile)
  await build({
    entryPoints: [fileURLToPath(new URL(`./fixtures/${entry}.ts`, import.meta.url))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    target: 'node22',
    logLevel: 'error',
  })
  return outfile
}

beforeAll(async () => {
  childBundle = await bundle('lease-child')
  takerBundle = await bundle('lease-taker')
}, 60_000)

afterAll(() => {
  for (const file of bundles) rmSync(file, { force: true })
})

async function spawnHost(trackedDir: string, leaseDirPath: string, extra: string[] = []): Promise<Child> {
  const proc = spawn(process.execPath, [childBundle, trackedDir, ...extra], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ADF_LEASE_DIR: leaseDirPath,
      ADF_USER_DATA_DIR: tempDir('adf-lease-child-userdata-'),
      NODE_ENV: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const child = new Child(proc)
  await child.next('READY ')
  return child
}

/** A process that only stays alive (stands in for an unrelated program that got a reused pid). */
function spawnSleeper(): ChildProcess {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true,
  })
  cleanups.push(async () => { killTree(proc.pid!); await waitForExit(proc) })
  return proc
}

/**
 * The endpoint of a holder that crashed: a process listened on it and was
 * killed (Windows: the pipe is gone; Unix: the socket file stays and refuses).
 */
async function deadEndpoint(leases: string): Promise<{ runtimeId: string; endpoint: string }> {
  const runtimeId = randomBytes(8).toString('hex')
  mkdirSync(join(leases, 'hosts'), { recursive: true })
  const endpoint = IS_WIN ? `\\\\.\\pipe\\adf-runtime-${runtimeId}` : join(leases, 'hosts', `${runtimeId}.sock`)
  const proc = spawn(process.execPath, ['-e', [
    "const net = require('net')",
    `net.createServer().listen(${JSON.stringify(endpoint)}, () => console.log('LISTENING'))`,
    'setInterval(() => {}, 1000)',
  ].join(';')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  await new Child(proc).next('LISTENING')
  killTree(proc.pid!)
  await waitForExit(proc)
  return { runtimeId, endpoint }
}

// --- cross-process -------------------------------------------------------------

describe('agent lease across processes', () => {
  it('two hosts autostarting one agent: without the lease both run it; with it one runs, the other reports leased_elsewhere', async () => {
    const tracked = tempDir('adf-lease-tracked-')
    seedAgent(tracked, 'agent-1')

    // The bug as it exists without leases: both processes run agent-1.
    const control = tempDir('adf-lease-control-')
    const [a, b] = await Promise.all([spawnHost(tracked, control, ['--no-lease']), spawnHost(tracked, control, ['--no-lease'])])
    a.send('go'); b.send('go')
    const [ra, rb] = await Promise.all([a.report(), b.report()])
    expect(ra.started).toHaveLength(1)
    expect(rb.started).toHaveLength(1)
    a.send('exit'); b.send('exit')
    await Promise.all([a.next('BYE'), b.next('BYE')])

    // With the lease: exactly one wins the race.
    const leases = tempDir('adf-lease-dir-')
    const [c, d] = await Promise.all([spawnHost(tracked, leases), spawnHost(tracked, leases)])
    c.send('go'); d.send('go')
    const [rc, rd] = await Promise.all([c.report(), d.report()])
    const winner = rc.started.length === 1 ? c : d
    const loser = winner === c ? d : c
    const winnerReport = winner === c ? rc : rd
    const loserReport = winner === c ? rd : rc
    expect(winnerReport.started).toHaveLength(1)
    expect(loserReport.started).toHaveLength(0)
    expect(loserReport.skipped).toEqual([expect.objectContaining({ reason: 'leased_elsewhere' })])
    expect(loserReport.skipped[0].message).toBe(
      `agent-1 is already running in the ADF daemon (pid ${winner.pid}, http://127.0.0.1:1). ` +
      'Stop it there with "adf --url http://127.0.0.1:1 stop agent-1", or stop that daemon with "adf daemon stop", then start it here.',
    )
    expect(readOnlyLease(leases).holder.pid).toBe(winner.pid)

    // A live holder keeps its lease even while its event loop is blocked.
    const probe = registry(leases)
    winner.send('block 4000')
    await winner.next('BLOCKED')
    const whileBlocked = await probe.acquire(join(tracked, 'agent-1.adf'))
    expect(whileBlocked.ok).toBe(false)

    // The holder crashes: its lease is stale and the other host takes it over.
    killTree(winner.pid)
    await waitForExit(winner.proc)
    expect(leaseFiles(leases)).toHaveLength(1) // a crash leaves the file behind
    loser.send('go')
    const retry = await loser.report()
    expect(retry.started).toHaveLength(1)
    expect(readOnlyLease(leases).holder.pid).toBe(loser.pid)

    // A clean exit removes the lease and the host entry.
    loser.send('exit')
    await loser.next('BYE')
    await waitForExit(loser.proc)
    expect(leaseFiles(leases)).toEqual([])
    expect(existsSync(join(leases, 'hosts', `${loser.pid}.json`))).toBe(false)
  }, 120_000)

  it('five processes racing to take over one stale lease: exactly one wins, 300 trials in a row', async () => {
    const leases = tempDir('adf-lease-takeover-race-')
    const work = tempDir('adf-lease-takeover-race-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    // The stale holder: its pid exited and its endpoint is dead. The endpoint
    // decides even when Windows hands the pid to a new process mid-test.
    const sleeper = spawnSleeper()
    killTree(sleeper.pid!)
    await waitForExit(sleeper)
    const dead = await deadEndpoint(leases)
    const canonical = await canonicalLeasePath(filePath)
    const file = join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`)
    const takers = await Promise.all(Array.from({ length: 5 }, async () => {
      const proc = spawn(process.execPath, [takerBundle, filePath], {
        cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ADF_LEASE_DIR: leases }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      const child = new Child(proc)
      await child.next('READY')
      return child
    }))
    const failures: string[] = []
    for (let trial = 0; trial < 300; trial++) {
      writeFileSync(file, JSON.stringify({
        v: 1, path: canonical, agentId: null, acquiredAt: trial,
        holder: { kind: 'daemon', pid: sleeper.pid, runtimeId: dead.runtimeId, hostname: 'x', settingsPath: 's', startedAt: 1, version: null, endpoint: dead.endpoint },
      }))
      const at = Date.now() + 40 // every taker starts at this instant
      for (const t of takers) t.send(`take ${trial} ${at}`)
      const outcomes = await Promise.all(takers.map((t) => t.next(`TOOK ${trial} `)))
      const wins = outcomes.filter((o) => o.endsWith(' ok')).length
      if (wins !== 1) failures.push(`trial ${trial}: ${wins} winners: ${outcomes.map((o) => o.slice(0, 100)).join(' | ')}`)
      for (const t of takers) t.send(`release ${trial}`)
      await Promise.all(takers.map((t) => t.next(`RELEASED ${trial}`)))
    }
    expect(failures).toEqual([])
  }, 300_000)

  it('a taker that stalls after reading the stale lease keeps its live takeover lock: one holder', async () => {
    const leases = tempDir('adf-lease-stall-')
    const work = tempDir('adf-lease-stall-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const sleeper = spawnSleeper()
    killTree(sleeper.pid!)
    await waitForExit(sleeper)
    const dead = await deadEndpoint(leases)
    const canonical = await canonicalLeasePath(filePath)
    const file = join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`)
    writeFileSync(file, JSON.stringify({
      v: 1, path: canonical, agentId: null, acquiredAt: 1,
      holder: { kind: 'daemon', pid: sleeper.pid, runtimeId: dead.runtimeId, hostname: 'x', settingsPath: 's', startedAt: 1, version: null, endpoint: dead.endpoint },
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resume!: () => void
    const stalled = new Promise<void>((r) => { resume = r })
    let stalls = 0
    // A short TTL: without the liveness rule B would break A's lock after 200 ms.
    const a = registry(leases, { takeoverLockTtlMs: 200, beforeTakeoverReplace: async () => { if (stalls++ === 0) await stalled } })
    const b = registry(leases, { takeoverLockTtlMs: 200 })

    const first = a.acquire(filePath)
    await vi.waitFor(() => expect(stalls).toBe(1), { timeout: 5000 })
    const second = b.acquire(filePath)
    await new Promise((r) => setTimeout(r, 1500)) // A stalls well past the TTL
    resume()
    const [ra, rb] = await Promise.all([first, second])
    vi.restoreAllMocks()

    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(false)
    expect(readOnlyLease(leases).holder.runtimeId).toBe(a.runtimeId)
  }, 30_000)

  it('an inconclusive takeover lock (no endpoint) expires after its TTL', async () => {
    const leases = tempDir('adf-lease-lock-ttl-')
    const work = tempDir('adf-lease-lock-ttl-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const sleeper = spawnSleeper()
    killTree(sleeper.pid!)
    await waitForExit(sleeper)
    const canonical = await canonicalLeasePath(filePath)
    const file = join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`)
    writeFileSync(file, JSON.stringify({
      v: 1, path: canonical, agentId: null, acquiredAt: 1,
      holder: { kind: 'daemon', pid: sleeper.pid, runtimeId: 'gone', hostname: 'x', settingsPath: 's', startedAt: 1, version: null, endpoint: null },
    }))
    // Left by a live pid (this one) without an endpoint: inconclusive.
    writeFileSync(`${file}.takeover`, JSON.stringify({ pid: process.pid, runtimeId: 'unknown', endpoint: null, at: 1 }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${file}.takeover`, old, old)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await registry(leases, { takeoverLockTtlMs: 1000 }).acquire(filePath)
    vi.restoreAllMocks()
    expect(result.ok).toBe(true)
    expect(existsSync(`${file}.takeover`)).toBe(false)
  })

  it('replaces a lease whose pid now belongs to another program (pid reuse)', async () => {
    const leases = tempDir('adf-lease-reuse-')
    mkdirSync(join(leases, 'hosts'), { recursive: true })
    const work = tempDir('adf-lease-reuse-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)

    // A holder that crashed: its endpoint is dead.
    const { runtimeId, endpoint } = await deadEndpoint(leases)

    // ...and its pid is now some unrelated live process.
    const sleeper = spawnSleeper()
    const canonical = await canonicalLeasePath(filePath)
    const stale: AgentLeaseRecord = {
      v: 1,
      path: canonical,
      agentId: null,
      holder: {
        kind: 'studio-embedded', pid: sleeper.pid!, runtimeId, hostname: hostname().toLowerCase(),
        settingsPath: join(work, 's.json'), startedAt: 1, version: null, endpoint,
      },
      acquiredAt: 1,
    }
    mkdirSync(leases, { recursive: true })
    writeFileSync(join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`), JSON.stringify(stale))

    const taker = registry(leases)
    const result = await taker.acquire(filePath)
    expect(result.ok).toBe(true)
    expect(readOnlyLease(leases).holder.runtimeId).toBe(taker.runtimeId)
  }, 60_000)
})

// --- one process, several registries ---------------------------------------

describe('agent lease semantics', () => {
  it('a live holder is never displaced; a race between two acquirers has one winner', async () => {
    const leases = tempDir('adf-lease-race-')
    const work = tempDir('adf-lease-race-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const one = registry(leases)
    const two = registry(leases, { kind: 'studio-embedded' })

    const results = await Promise.all([one.acquire(filePath), two.acquire(filePath)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)!
    expect(loser.ok === false && loser.code).toBe(AGENT_LEASED_CODE)

    // Re-entrant for the holder; still refused for the other.
    const holder = results[0].ok ? one : two
    const other = holder === one ? two : one
    expect((await holder.acquire(filePath)).ok).toBe(true)
    expect((await other.acquire(filePath)).ok).toBe(false)
    expect(leaseFiles(leases)).toHaveLength(1)

    // Release (no probe lists it) frees it for the other.
    await holder.reconcile()
    expect(leaseFiles(leases)).toEqual([])
    expect((await other.acquire(filePath)).ok).toBe(true)
  })

  it('a process that died holding the lease (pid not running) loses it', async () => {
    const leases = tempDir('adf-lease-dead-')
    const work = tempDir('adf-lease-dead-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const sleeper = spawnSleeper()
    const deadPid = sleeper.pid!
    killTree(deadPid)
    await waitForExit(sleeper)
    const canonical = await canonicalLeasePath(filePath)
    mkdirSync(leases, { recursive: true })
    writeFileSync(join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`), JSON.stringify({
      v: 1, path: canonical, agentId: null, acquiredAt: 1,
      holder: { kind: 'daemon', pid: deadPid, runtimeId: 'gone', hostname: 'x', settingsPath: 's', startedAt: 1, version: null, endpoint: null },
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const reg = registry(leases)
    expect((await reg.acquire(filePath)).ok).toBe(true)
    expect(warn.mock.calls.some(([m]) => String(m).includes(`replacing a stale lease held by the ADF daemon pid ${deadPid}`))).toBe(true)
  })

  it('an unreadable lease is waited for while young and replaced once old', async () => {
    const leases = tempDir('adf-lease-corrupt-')
    const work = tempDir('adf-lease-corrupt-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const file = join(leases, `${leaseKeyForCanonicalPath(await canonicalLeasePath(filePath))}.json`)
    writeFileSync(file, '{"v":1,"pa')
    const old = new Date(Date.now() - 60_000)
    utimesSync(file, old, old)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = registry(leases)
    expect((await reg.acquire(filePath)).ok).toBe(true)
    expect(readOnlyLease(leases).holder.runtimeId).toBe(reg.runtimeId)
    vi.restoreAllMocks()
  })

  it('an unusable lease dir lets the start proceed unprotected, with an error logged', async () => {
    const work = tempDir('adf-lease-unusable-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const blocker = join(work, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = registry(join(blocker, 'leases'))
    const result = await reg.acquire(filePath)
    expect(result).toMatchObject({ ok: true, unprotected: expect.stringMatching(/^Agent leases unavailable: .+ agent-1 runs without protection/) })
    expect(error).toHaveBeenCalledTimes(1)

    // Remembered: the next start neither retries nor logs again, and still carries the sentence.
    const t0 = Date.now()
    const again = await reg.acquire(filePath)
    expect(Date.now() - t0).toBeLessThan(100)
    expect(again).toMatchObject({ ok: true, unprotected: expect.stringMatching(/^Agent leases unavailable/) })
    expect(error).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('never probes an endpoint that is not this module\'s local form (no UNC/SMB); the pid decides', async () => {
    const leases = tempDir('adf-lease-untrusted-')
    const work = tempDir('adf-lease-untrusted-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const sleeper = spawnSleeper()
    const canonical = await canonicalLeasePath(filePath)
    const runtimeId = '0123456789abcdef'
    // Absent, so a probe would read "dead" and take the lease over.
    const endpoint = IS_WIN ? `\\\\127.0.0.1\\pipe\\adf-runtime-${runtimeId}` : join(work, `${runtimeId}.sock`)
    writeFileSync(join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`), JSON.stringify({
      v: 1, path: canonical, agentId: null, acquiredAt: 1,
      holder: { kind: 'daemon', pid: sleeper.pid, runtimeId, hostname: 'x', settingsPath: 's', startedAt: 1, version: null, endpoint },
    }))
    const result = await registry(leases).acquire(filePath)
    expect(result.ok).toBe(false)
  })

  it('a reconcile racing a host-to-host hand-off keeps the lease (probes are read in one snapshot)', async () => {
    const leases = tempDir('adf-lease-snapshot-')
    const work = tempDir('adf-lease-snapshot-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const reg = registry(leases)
    let inForeground = true
    let inBackground = false
    // Registered first: lists an uncached path, so canonicalizing it awaits.
    reg.addHostedPathsProbe(() => [join(work, 'not-yet-created.adf'), ...(inBackground ? [filePath] : [])])
    reg.addHostedPathsProbe(() => (inForeground ? [filePath] : []))
    expect((await reg.acquire(filePath)).ok).toBe(true)
    for (let i = 0; i < 20; i++) {
      setImmediate(() => { inForeground = !inForeground; inBackground = !inBackground })
      await reg.reconcile()
      expect(await reg.isHeld(filePath)).toBe(true)
    }
  })

  it('records the hostname but never keys on it; the Windows lease dir is local, not roaming', () => {
    expect(leaseKeyForCanonicalPath('/a/agent-1.adf', 'linux')).toBe(leaseKeyForCanonicalPath('/a/agent-1.adf', 'linux'))
    if (IS_WIN) {
      expect(leaseDir({ LOCALAPPDATA: 'X:\\Local', APPDATA: 'X:\\Roaming' })).toBe('X:\\Local\\adf\\leases')
    }
  })

  it('rename re-keys a held lease to the new path', async () => {
    const leases = tempDir('adf-lease-rename-')
    const work = tempDir('adf-lease-rename-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const reg = registry(leases)
    const other = registry(leases)
    let hosted = filePath
    reg.addHostedPathsProbe(() => [hosted])
    expect((await reg.acquire(filePath)).ok).toBe(true)

    const renamed = join(work, 'agent-2.adf')
    renameSync(filePath, renamed)
    hosted = renamed // the host updates its own map first
    const moved = await reg.rekey(filePath, renamed)
    expect(moved?.ok).toBe(true)
    expect(readOnlyLease(leases).path).toBe(await canonicalLeasePath(renamed))
    expect((await other.acquire(renamed)).ok).toBe(false)
    await reg.reconcile()
    expect(leaseFiles(leases)).toHaveLength(1) // still hosted under the new path
  })

  it('canonicalizes path case, separators, \\\\?\\ prefixes and 8.3 short names to one lease', async () => {
    const leases = tempDir('adf-lease-canon-')
    const work = tempDir('adf-lease-canon-work-with-a-long-name-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const reg = registry(leases)
    const other = registry(leases)
    expect((await reg.acquire(filePath)).ok).toBe(true)

    const variants = [filePath]
    if (IS_WIN || process.platform === 'darwin') variants.push(filePath.toUpperCase(), filePath.toLowerCase())
    if (IS_WIN) {
      variants.push(filePath.replace(/\\/g, '/'), `\\\\?\\${filePath}`)
      const short = execSync(`for %I in ("${filePath}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf-8', windowsHide: true }).trim()
      if (short && short.toLowerCase() !== filePath.toLowerCase()) variants.push(short)
    }
    for (const variant of variants) {
      const result = await other.acquire(variant)
      expect(result.ok, variant).toBe(false)
      expect(await reg.isHeld(variant)).toBe(true)
    }
    expect(leaseFiles(leases)).toHaveLength(1)
    expect(leaseKeyForCanonicalPath('C:\\Agents\\agent-1.adf', 'win32')).toBe(leaseKeyForCanonicalPath('c:/agents/AGENT-1.ADF', 'win32'))
    expect(leaseKeyForCanonicalPath('/a/agent-1.adf', 'linux')).not.toBe(leaseKeyForCanonicalPath('/a/Agent-1.adf', 'linux'))
  })

  it('a record from another machine (shared network home) is alive, never taken over or swept', async () => {
    const leases = tempDir('adf-lease-machine-')
    const work = tempDir('adf-lease-machine-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    expect(await machineId()).toBe('test-machine') // tests/isolate-user-data.setup.ts
    const sleeper = spawnSleeper()
    const pid = sleeper.pid!
    killTree(pid)
    await waitForExit(sleeper)
    const canonical = await canonicalLeasePath(filePath)
    const holder = { kind: 'daemon', pid, runtimeId: 'fedcba9876543210', hostname: 'machine-2', machineId: 'other-machine', settingsPath: 's', startedAt: 1, version: null, endpoint: null }
    writeFileSync(join(leases, `${leaseKeyForCanonicalPath(canonical)}.json`), JSON.stringify({ v: 1, path: canonical, agentId: null, acquiredAt: 1, holder }))
    mkdirSync(join(leases, 'hosts'), { recursive: true })
    const entry = join(leases, 'hosts', `${pid}.json`)
    writeFileSync(entry, JSON.stringify({ v: 1, ...holder, kind: 'studio-embedded', mode: 'embedded' }))

    const reg = registry(leases)
    const result = await reg.acquire(filePath)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain(
      `agent-1 is already running on another machine (machine-2, pid ${pid}) that shares this lease folder. Stop it there, then start it here.`,
    )
    await reg.configure({ kind: 'daemon' }) // writes our entry and sweeps dead ones
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(entry)).toBe(true)
    expect((await listRuntimeHosts(leases)).find((h) => h.pid === pid)).toMatchObject({ alive: true, machineId: 'other-machine' })
    expect(readOnlyLease(leases).holder.machineId).toBe('other-machine')
    // Our own records carry our machine id.
    expect(JSON.parse(readFileSync(reg.hostEntryFile, 'utf-8')).machineId).toBe('test-machine')
  })

  it('names the holder and what to do in the agent_leased sentence', () => {
    const base = { v: 1 as const, path: 'C:\\agents\\agent-1.adf', agentId: null, acquiredAt: 1 }
    const holder = { runtimeId: 'r', hostname: 'h', startedAt: 1, version: null, endpoint: null }
    expect(agentLeasedMessage({ ...base, holder: { ...holder, kind: 'daemon', pid: 4242, settingsPath: 'C:\\s.json', controlUrl: 'http://127.0.0.1:7385' } }, 'C:\\s.json'))
      .toBe('agent-1 is already running in the ADF daemon (pid 4242). Stop it there with "adf stop agent-1", or stop that daemon with "adf daemon stop", then start it here.')
    expect(agentLeasedMessage({ ...base, holder: { ...holder, kind: 'studio-embedded', pid: 77, settingsPath: 'D:\\other.json' } }, 'C:\\s.json'))
      .toBe('agent-1 is already running in another ADF Studio (pid 77). Stop the agent there or quit that Studio, then start it here. That process uses the settings file D:\\other.json.')
  })
})

// --- hosts ---------------------------------------------------------------------

describe('RuntimeService lease hooks', () => {
  function runtimeWith(leases: AgentLeaseRegistry, providerFactory: () => MockLLMProvider = () => new MockLLMProvider()) {
    const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory, agentLeases: leases })
    cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }) })
    return runtime
  }

  it('load takes the lease, unload and a failed load release it, a leased file is refused with 409 agent_leased', async () => {
    const leases = tempDir('adf-lease-rs-')
    const work = tempDir('adf-lease-rs-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const mine = registry(leases)
    const theirs = registry(leases, { kind: 'studio-embedded' })

    const runtime = runtimeWith(mine)
    const ref = await runtime.loadAgent(filePath)
    expect(leaseFiles(leases)).toHaveLength(1)
    await runtime.unloadAgent(ref.id)
    expect(leaseFiles(leases)).toEqual([])

    const failing = runtimeWith(mine, () => { throw new Error('no provider') })
    await expect(failing.loadAgent(filePath)).rejects.toThrow('no provider')
    expect(leaseFiles(leases)).toEqual([])

    expect((await theirs.acquire(filePath)).ok).toBe(true)
    const refused = await runtime.loadAgent(filePath).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(RuntimeLoopError)
    expect(refused).toMatchObject({ statusCode: 409, code: AGENT_LEASED_CODE })
    expect((refused as Error).message).toMatch(/^agent-1 is already running in another ADF Studio \(pid \d+\)/)
    expect(runtime.listAgents()).toEqual([])
  })

  it('autostart reports leased_elsewhere for an agent another process runs', async () => {
    const leases = tempDir('adf-lease-auto-')
    const work = tempDir('adf-lease-auto-work-')
    const one = seedAgent(work, 'agent-1')
    const two = seedAgent(work, 'agent-2')
    const theirs = registry(leases, { kind: 'studio-embedded' })
    expect((await theirs.acquire(one.filePath)).ok).toBe(true)

    const reviewed = markConfigReviewed(markConfigReviewed(undefined, one.config), two.config)
    const runtime = new RuntimeService({
      settings: { get: (k: string) => (k === 'reviewedAgents' ? reviewed : undefined) },
      providerFactory: () => new MockLLMProvider(),
      agentLeases: registry(leases),
    })
    cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = await runtime.autostartFromDirectories([work])
    vi.restoreAllMocks()
    expect(report.started.map((s) => s.name)).toEqual(['agent-2'])
    expect(report.skipped).toEqual([expect.objectContaining({
      name: 'agent-1', reason: 'leased_elsewhere', agentId: one.config.id,
      message: expect.stringMatching(/^agent-1 is already running in another ADF Studio \(pid \d+\)/),
    })])
  })
})

describe('Studio hosts (BackgroundAgentManager and the foreground) share one lease', () => {
  function makeSettings(): SettingsService {
    return {
      get: () => undefined,
      getProvider: (id: string) => ({ id: id || 'mock', type: 'anthropic', name: 'mock-provider', apiKey: 'test-key' }),
    } as unknown as SettingsService
  }

  function makeManager(): BackgroundAgentManager {
    const manager = new BackgroundAgentManager(makeSettings(), '', {})
    cleanups.push(async () => { await manager.stopAll(); manager.dispose() })
    return manager
  }

  function fakeHandle(): AssembledAgent<'studioForeground'> {
    return {
      executor: { isMessageTriggered: false, getState: () => 'idle', getPendingApprovals: () => [] },
      session: { flushToLoop: () => {}, getMessages: () => [{}] },
      workspace: { getLoop: () => [] },
      triggerEvaluator: { getDisplayState: () => 'idle' },
      attachHost: () => ({ detach: () => {} }),
      disposeAsync: async () => {},
      setWorkspaceOwnership: () => {},
    } as unknown as AssembledAgent<'studioForeground'>
  }

  it('background start takes the lease, a failed start releases it, a leased start fails with agent_leased', async () => {
    const work = tempDir('adf-lease-bam-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const leases = processAgentLeases()
    const other = registry(leases.dir, { kind: 'daemon' })
    const manager = makeManager()

    expect(await manager.startAgent(filePath)).toBe(true)
    expect(await leases.isHeld(filePath)).toBe(true)
    expect((await other.acquire(filePath)).ok).toBe(false)
    await manager.stopAgent(filePath)
    expect(await leases.isHeld(filePath)).toBe(false)

    // A start that fails after taking the lease gives it back.
    const corrupt = join(work, 'agent-2.adf')
    writeFileSync(corrupt, 'not a database')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await manager.startAgent(corrupt)).toBe(false)
    expect(await leases.isHeld(corrupt)).toBe(false)

    // Another process holds it: refused with the sentence, nothing opened.
    expect((await other.acquire(filePath)).ok).toBe(true)
    expect(await manager.startAgent(filePath)).toBe(false)
    vi.restoreAllMocks()
    expect(manager.getLastStartError(filePath)).toEqual({
      code: AGENT_LEASED_CODE,
      error: expect.stringMatching(/^agent-1 is already running in the ADF daemon \(pid \d+/),
    })
    expect(manager.hasAgent(filePath)).toBe(false)
  })

  it('foreground ↔ background hand-offs keep the lease; the final stop releases it', async () => {
    const work = tempDir('adf-lease-handoff-')
    const { filePath, config } = seedAgent(work, 'agent-1', false)
    const leases = processAgentLeases()
    const other = registry(leases.dir)
    const manager = makeManager()
    const handle = fakeHandle()

    // The foreground probe as ipc/index.ts registers it.
    let foreground: string | null = filePath
    const unregister = leases.addHostedPathsProbe(() => (foreground ? [foreground] : []))
    cleanups.push(unregister)
    expect((await leases.acquire(filePath)).ok).toBe(true)

    for (let cycle = 0; cycle < 3; cycle++) {
      foreground = null // cleanupCurrentFile: globals cleared, then the transition
      await manager.transitionToBackground(filePath, config, handle)
      await leases.reconcile()
      expect(await leases.isHeld(filePath)).toBe(true)

      manager.extractBackgroundAgent(filePath) // FILE_OPEN adopts it
      foreground = filePath
      await leases.reconcile()
      expect(await leases.isHeld(filePath)).toBe(true)
      expect((await other.acquire(filePath)).ok).toBe(false)
    }

    foreground = null
    await manager.transitionToBackground(filePath, config, handle)
    await manager.stopAgent(filePath)
    expect(await leases.isHeld(filePath)).toBe(false)
    expect((await other.acquire(filePath)).ok).toBe(true)
  })

  it('AGENT_START wrapper: a start that throws or fails after taking the lease releases it; one that installs keeps it', async () => {
    const leases = tempDir('adf-lease-fg-')
    const work = tempDir('adf-lease-fg-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)
    const reg = registry(leases, { kind: 'studio-embedded' })
    const starting = new Set<string>()
    let installed: string | null = null
    const tracker = new LeasedStartTracker(() => starting, () => reg)
    reg.addHostedPathsProbe(() => [...tracker.startingPaths(), ...(installed ? [installed] : [])])

    const start = tracker.wrap(async (outcome: 'throw' | 'fail' | 'install') => {
      starting.add(filePath)
      const lease = await reg.acquire(filePath)
      if (!lease.ok) { starting.delete(filePath); return { success: false, code: lease.code } }
      // A concurrent reconcile (a background stop) must not take it mid-start.
      await reg.reconcile()
      expect(await reg.isHeld(filePath)).toBe(true)
      if (outcome === 'throw') throw new Error('boom') // leaves `starting` behind, like AGENT_START
      if (outcome === 'fail') { starting.delete(filePath); return { success: false } }
      installed = filePath
      starting.delete(filePath)
      return { success: true }
    })

    await expect(start('throw')).rejects.toThrow('boom')
    expect(await reg.isHeld(filePath)).toBe(false)
    expect(await start('fail')).toEqual({ success: false })
    expect(await reg.isHeld(filePath)).toBe(false)
    expect(await start('install')).toEqual({ success: true })
    expect(await reg.isHeld(filePath)).toBe(true)
    installed = null // AGENT_STOP
    await reg.reconcile()
    expect(await reg.isHeld(filePath)).toBe(false)
  })
})

describe('runtime host registry and the adf daemon start check', () => {
  it('an embedded Studio on the same settings refuses; on other settings, or in local mode, it does not', async () => {
    const leases = tempDir('adf-lease-hosts-')
    const data = tempDir('adf-lease-hosts-data-')
    const settingsFile = join(data, 'adf-settings.json')
    writeFileSync(settingsFile, '{}')
    const env = { ADF_DAEMON_SETTINGS: settingsFile, ADF_LEASE_DIR: leases }
    const paths = daemonPaths(7385, env)
    const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

    expect(await studioConflict(paths, env, down)).toBeNull()

    const studio = registry(leases, { kind: 'studio-embedded', settingsPath: settingsFile.toUpperCase() })
    await studio.configure({ kind: 'studio-embedded', mode: 'embedded' })
    const hosts = await listRuntimeHosts(leases)
    expect(hosts).toEqual([expect.objectContaining({ kind: 'studio-embedded', pid: process.pid, alive: true, mode: 'embedded' })])
    // The machine was renamed since Studio started: it must still be seen.
    const entryFile = join(leases, 'hosts', `${process.pid}.json`)
    writeFileSync(entryFile, JSON.stringify({ ...JSON.parse(readFileSync(entryFile, 'utf-8')), hostname: 'renamed-machine' }))
    const refusal = await studioConflict(paths, env, down)
    if (process.platform === 'linux') expect(refusal).toBeNull() // case-sensitive paths differ
    else expect(refusal).toBe(`ADF Studio (pid ${process.pid}) is running agents from the same settings file (${settingsFile}).`)

    await studio.configure({ settingsPath: join(data, 'other-settings.json') })
    expect(await studioConflict(paths, env, down)).toBeNull()

    // Studio in local mode is a client of the daemon, not a host.
    await studio.close()
    const client = registry(leases)
    await client.registerClient('local', { settingsPath: settingsFile })
    expect(await listRuntimeHosts(leases)).toEqual([])
    expect(await studioConflict(paths, env, down)).toBeNull()
  })

  it('daemon-mode Studio boot registers it as a client, so adf daemon start does not refuse it', async () => {
    const leases = tempDir('adf-lease-daemon-mode-')
    const client = registry(leases, { kind: 'studio-embedded' })
    let registered: Promise<void> | null = null
    registerDaemonModeHandlers({
      mode: 'local',
      ipcMain: { handle: () => {} } as never,
      app: { getVersion: () => '9.9.9', setBadgeCount: () => true },
      log: { warn: () => {} },
      leases: { registerClient: (...args) => (registered = client.registerClient(...args)) },
    })
    expect(registered).not.toBeNull()
    await registered
    expect(await listStudioClients(leases)).toEqual([expect.objectContaining({ kind: 'studio-client', mode: 'local', pid: process.pid, alive: true, version: '9.9.9' })])
    expect(await listRuntimeHosts(leases)).toEqual([])
  })

  it('ignores the entry of a host that is gone', async () => {
    const leases = tempDir('adf-lease-gone-')
    const data = tempDir('adf-lease-gone-data-')
    const settingsFile = join(data, 'adf-settings.json')
    const sleeper = spawnSleeper()
    const pid = sleeper.pid!
    killTree(pid)
    await waitForExit(sleeper)
    mkdirSync(join(leases, 'hosts'), { recursive: true })
    writeFileSync(join(leases, 'hosts', `${pid}.json`), JSON.stringify({
      v: 1, kind: 'studio-embedded', pid, runtimeId: 'x', hostname: hostname().toLowerCase(),
      settingsPath: settingsFile, startedAt: 1, version: null, endpoint: null, mode: 'embedded',
    }))
    const env = { ADF_DAEMON_SETTINGS: settingsFile, ADF_LEASE_DIR: leases }
    expect(await listRuntimeHosts(leases)).toEqual([expect.objectContaining({ pid, alive: false })])
    expect(await studioConflict(daemonPaths(7385, env), env, (async () => { throw new Error('down') }) as unknown as typeof fetch)).toBeNull()
  })
})
