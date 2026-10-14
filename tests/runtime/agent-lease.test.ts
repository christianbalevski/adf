import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
  listRuntimeHosts,
  processAgentLeases,
  type AgentLeaseRecord,
} from '../../src/main/runtime/agent-lease'
import { RuntimeLoopError, RuntimeService } from '../../src/main/runtime/runtime-service'
import { BackgroundAgentManager } from '../../src/main/runtime/background-agent-manager'
import { RuntimeGate } from '../../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { markConfigReviewed } from '../../src/main/services/agent-review'
import { daemonPaths, studioConflict } from '../../src/main/cli/daemon-control'
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

let childBundle = ''
let childRoot = ''

beforeAll(async () => {
  childRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-lease-child-')))
  const nodeModules = realpathSync(fileURLToPath(new URL('../../node_modules', import.meta.url)))
  symlinkSync(nodeModules, join(childRoot, 'node_modules'), 'junction')
  childBundle = join(childRoot, 'lease-child.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/lease-child.ts', import.meta.url))],
    outfile: childBundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    target: 'node22',
    logLevel: 'error',
  })
}, 60_000)

afterAll(() => {
  if (!childRoot) return
  // Remove the node_modules link FIRST and on its own: rmSync({ recursive })
  // follows a Windows junction and deletes the shared node_modules behind it.
  const link = join(childRoot, 'node_modules')
  try { rmdirSync(link) } catch { /* not created */ }
  if (existsSync(link)) throw new Error(`could not remove the node_modules link ${link}; left ${childRoot} in place`)
  rmSync(childRoot, { recursive: true, force: true })
})

async function spawnHost(trackedDir: string, leaseDirPath: string, extra: string[] = []): Promise<Child> {
  const proc = spawn(process.execPath, [childBundle, trackedDir, ...extra], {
    cwd: childRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ADF_LEASE_DIR: leaseDirPath,
      ADF_USER_DATA_DIR: join(leaseDirPath, '..'),
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

  it('replaces a lease whose pid now belongs to another program (pid reuse)', async () => {
    const leases = tempDir('adf-lease-reuse-')
    const work = tempDir('adf-lease-reuse-work-')
    const { filePath } = seedAgent(work, 'agent-1', false)

    // A holder that crashed: its endpoint is dead (Windows: the pipe is gone;
    // Unix: the socket file stays and refuses).
    const crashed = new AgentLeaseRegistry({ dir: leases, kind: 'studio-embedded', settingsPath: join(work, 's.json') })
    const endpointHolder = spawn(process.execPath, ['-e', [
      "const net = require('net')",
      `const p = ${JSON.stringify(IS_WIN ? `\\\\.\\pipe\\adf-runtime-${crashed.runtimeId}` : join(leases, `${crashed.runtimeId}.sock`))}`,
      "net.createServer().listen(p, () => console.log('LISTENING'))",
      'setInterval(() => {}, 1000)',
    ].join(';')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const endpointChild = new Child(endpointHolder)
    await endpointChild.next('LISTENING')
    const endpoint = IS_WIN ? `\\\\.\\pipe\\adf-runtime-${crashed.runtimeId}` : join(leases, `${crashed.runtimeId}.sock`)
    killTree(endpointHolder.pid!)
    await waitForExit(endpointHolder)

    // ...and its pid is now some unrelated live process.
    const sleeper = spawnSleeper()
    const canonical = await canonicalLeasePath(filePath)
    const stale: AgentLeaseRecord = {
      v: 1,
      path: canonical,
      agentId: null,
      holder: {
        kind: 'studio-embedded', pid: sleeper.pid!, runtimeId: crashed.runtimeId, hostname: hostname().toLowerCase(),
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
    expect(result).toMatchObject({ ok: true, unprotected: expect.any(String) })
    expect(error.mock.calls.some(([m]) => String(m).includes('Starting without protection'))).toBe(true)
    vi.restoreAllMocks()
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
