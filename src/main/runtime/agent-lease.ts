/**
 * Agent lease and runtime host registry (docs/design/daemon-backend.md §10).
 *
 * Two runtime hosts on one machine (embedded Studio and a daemon, or two
 * daemons on different settings files) must never run the same .adf file:
 * both would fire its timers and turns, and both would poll its Telegram bot
 * (HTTP 409). A host takes the agent's lease before it prepares the agent and
 * gives it back when the agent is gone from the process.
 *
 * Layout (one OS user, one machine):
 *
 *   <lease dir>/<sha256(hostname, canonical path)>.json   one lease per agent file
 *   <lease dir>/hosts/<pid>.json                          one entry per runtime host
 *   <lease dir>/clients/<pid>.json                        Studio in local/remote mode
 *
 * The lease dir is `<per-user config dir>/adf/leases` and ignores
 * ADF_USER_DATA_DIR, ADF_DAEMON_SETTINGS and ADF_INSTANCE: hosts on different
 * settings files must still see each other. ADF_LEASE_DIR overrides it (tests).
 * The hostname is part of the key so a config dir shared between machines
 * (roaming profiles) never mixes their leases.
 *
 * Crash safety. A lease names its holder's pid and a local endpoint (a named
 * pipe on Windows, a Unix socket elsewhere) the holder listens on for its
 * whole life. The OS closes the endpoint when the process dies, so:
 *   - pid not running                        → stale (crash, kill)
 *   - pid running, endpoint refuses/absent   → stale (the pid was reused)
 *   - endpoint connects                      → live, even if its event loop is
 *                                              blocked (the OS accepts the
 *                                              connection)
 *   - anything inconclusive (timeout, EBUSY) → live: a lease is never taken
 *                                              from a holder that may be alive
 * A stale lease is replaced with an atomic rename to a tomb file; the taker
 * checks the tomb holds the bytes it judged stale and puts a newer lease back
 * otherwise, so two takers racing on one stale lease cannot both win.
 *
 * In-process accounting. A process holds a lease once, however many of its
 * hosts (Studio foreground, BackgroundAgentManager, RuntimeService) touch the
 * agent, so foreground/background hand-offs keep it. Each host registers a
 * probe listing the paths it runs or is starting; reconcile() releases every
 * held lease no probe lists. Hosts call it after a failed start and after
 * disposing an agent. On process exit the remaining leases are removed.
 *
 * Failure policy. A live holder elsewhere refuses the start (`agent_leased`).
 * A lease dir that cannot be written (permissions, read-only volume) is
 * logged and the start proceeds without cross-process protection: that is
 * today's behaviour, and a broken config dir must not stop every agent.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp, readFileSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { homedir, hostname as osHostname, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { getUserDataPath } from '../utils/user-data-path'

export const AGENT_LEASED_CODE = 'agent_leased'

export type RuntimeHostKind = 'studio-embedded' | 'daemon'

export interface LeaseHolder {
  kind: RuntimeHostKind
  pid: number
  /** Random per process; names the endpoint. */
  runtimeId: string
  hostname: string
  settingsPath: string
  startedAt: number
  version: string | null
  /** Named pipe / Unix socket the holder answers on while alive; null if it could not listen. */
  endpoint: string | null
  /** Daemon holders: the daemon's HTTP base URL. */
  controlUrl?: string
}

export interface AgentLeaseRecord {
  v: 1
  /** Canonical (realpath) path of the agent file. */
  path: string
  agentId: string | null
  holder: LeaseHolder
  acquiredAt: number
}

/** `<lease dir>/hosts/<pid>.json` and `<lease dir>/clients/<pid>.json`. */
export interface RuntimeHostRecord extends Omit<LeaseHolder, 'kind'> {
  v: 1
  kind: RuntimeHostKind | 'studio-client'
  /** 'embedded' for Studio hosts, 'daemon' for daemons, 'local' | 'remote' for Studio clients. */
  mode: string
}

export type AgentLeaseResult =
  | {
      ok: true
      leaseFile: string
      /** Set when the lease could not be written and the start proceeds unprotected. */
      unprotected?: string
    }
  | {
      ok: false
      code: typeof AGENT_LEASED_CODE
      leaseFile: string
      record: AgentLeaseRecord
      /** Plain sentence for the user: who holds the agent and what to do. */
      message: string
    }

export interface AgentLeaseHostInfo {
  kind?: RuntimeHostKind
  settingsPath?: string
  version?: string | null
  mode?: string
  controlUrl?: string
}

export interface AgentLeaseRegistryOptions extends AgentLeaseHostInfo {
  /** Defaults to leaseDir(). */
  dir?: string
}

/** Paths a host runs or is starting. Any form: they are canonicalized here. */
export type HostedPathsProbe = () => Iterable<string>

const HOSTNAME = osHostname().toLowerCase()
const DEFAULT_DAEMON_PORT = 7385
/** How long a liveness probe may take before the holder counts as alive. */
const PROBE_TIMEOUT_MS = 1500
/** An unparsable lease younger than this may still be being written. */
const PARTIAL_WRITE_GRACE_MS = 2000
/** Upper bound for one acquire under contention. */
const ACQUIRE_BUDGET_MS = 5000
/** Unix socket paths are limited to ~104 bytes (macOS). */
const MAX_SOCKET_PATH = 100
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** `<per-user config dir>/adf/leases`, or ADF_LEASE_DIR. */
export function leaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADF_LEASE_DIR) return resolve(env.ADF_LEASE_DIR)
  let base: string
  if (process.platform === 'darwin') base = join(homedir(), 'Library', 'Application Support')
  else if (process.platform === 'win32') base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  else base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'adf', 'leases')
}

/**
 * Canonical form of an agent path for leasing: absolute, symlinks, junctions,
 * subst and mapped drives resolved, Windows 8.3 short names expanded, `\\?\`
 * stripped (fs.promises.realpath is the native GetFinalPathNameByHandle /
 * realpath(3)). Falls back to path.resolve for a file that does not exist.
 */
export async function canonicalLeasePath(filePath: string): Promise<string> {
  const abs = resolve(filePath)
  try {
    return stripLongPathPrefix(await fsp.realpath(abs))
  } catch {
    return stripLongPathPrefix(abs)
  }
}

/** Lease file name for a canonical path. Case-insensitive on Windows and macOS (like AdfDatabase.canonicalPathKey). */
export function leaseKeyForCanonicalPath(canonicalPath: string, platform: NodeJS.Platform = process.platform): string {
  let norm = canonicalPath
  if (platform === 'win32') norm = norm.replace(/\//g, '\\').toLowerCase()
  else if (platform === 'darwin') norm = norm.normalize('NFC').toLowerCase()
  return createHash('sha256').update(`${HOSTNAME}\n${norm}`).digest('hex')
}

function stripLongPathPrefix(p: string): string {
  if (process.platform !== 'win32') return p
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

function agentNameOf(path: string): string {
  return basename(path).replace(/\.adf$/i, '')
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'linux' ? resolve(p) : resolve(p).toLowerCase())
  return norm(a) === norm(b)
}

/**
 * The sentence a refused start shows: which process holds the agent and what
 * to do about it. `ownSettingsPath` adds the holder's settings file when it
 * differs from the caller's (two hosts on different data).
 */
export function agentLeasedMessage(record: AgentLeaseRecord, ownSettingsPath?: string): string {
  const name = agentNameOf(record.path)
  const h = record.holder
  let text: string
  if (h.kind === 'daemon') {
    const url = h.controlUrl && !/^http:\/\/(127\.0\.0\.1|localhost):7385\/?$/.test(h.controlUrl) ? h.controlUrl : null
    const target = url ? ` --url ${url}` : ''
    text = `${name} is already running in the ADF daemon (pid ${h.pid}${url ? `, ${url}` : ''}). ` +
      `Stop it there with "adf${target} stop ${name}", or stop that daemon with "adf daemon stop", then start it here.`
  } else {
    text = `${name} is already running in another ADF Studio (pid ${h.pid}). Stop the agent there or quit that Studio, then start it here.`
  }
  if (ownSettingsPath && h.settingsPath && !samePath(ownSettingsPath, h.settingsPath)) {
    text += ` That process uses the settings file ${h.settingsPath}.`
  }
  return text
}

function describeHolder(h: LeaseHolder): string {
  return `${h.kind === 'daemon' ? 'the ADF daemon' : 'ADF Studio'} pid ${h.pid}`
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** process.kill(pid, 0), plus the Linux zombie check (an exited, unreaped pid is not alive). */
export async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (err) { return errCode(err) === 'EPERM' }
  if (process.platform === 'linux') {
    try {
      const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf-8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false
    } catch { /* no /proc entry: fall through */ }
  }
  return true
}

type EndpointProbe = 'connected' | 'refused' | 'missing' | 'unknown'

function probeEndpoint(endpoint: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<EndpointProbe> {
  return new Promise((resolveProbe) => {
    let settled = false
    let sock: Socket | null = null
    const done = (result: EndpointProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock?.destroy()
      resolveProbe(result)
    }
    const timer = setTimeout(() => done('unknown'), timeoutMs)
    try {
      sock = createConnection(endpoint)
    } catch {
      done('unknown')
      return
    }
    sock.once('connect', () => done('connected'))
    sock.once('error', (err) => {
      const code = errCode(err)
      done(code === 'ECONNREFUSED' ? 'refused' : code === 'ENOENT' ? 'missing' : 'unknown')
    })
  })
}

async function fetchDaemonPid(controlUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${controlUrl.replace(/\/+$/, '')}/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return null
    const body = await res.json() as { pid?: unknown }
    return typeof body.pid === 'number' ? body.pid : null
  } catch {
    return null
  }
}

/**
 * Is the process that wrote this holder record still the one running? Only a
 * definite answer counts as dead; everything inconclusive is alive.
 */
export async function holderLiveness(holder: LeaseHolder): Promise<{ alive: boolean; reason: string }> {
  if (!(await pidAlive(holder.pid))) return { alive: false, reason: `pid ${holder.pid} is not running` }
  if (holder.endpoint) {
    const probe = await probeEndpoint(holder.endpoint)
    if (probe === 'connected') return { alive: true, reason: 'endpoint answered' }
    // A named pipe disappears with its process; a Unix socket file stays
    // behind and refuses. A missing socket file was deleted by someone else
    // and proves nothing.
    if (probe === 'refused' || (probe === 'missing' && process.platform === 'win32')) {
      return { alive: false, reason: `pid ${holder.pid} now belongs to another program` }
    }
    return { alive: true, reason: `pid ${holder.pid} is running (endpoint ${probe})` }
  }
  if (holder.kind === 'daemon' && holder.controlUrl) {
    const pid = await fetchDaemonPid(holder.controlUrl)
    if (pid !== null && pid !== holder.pid) {
      return { alive: false, reason: `${holder.controlUrl} is served by pid ${pid}, not ${holder.pid}` }
    }
  }
  return { alive: true, reason: `pid ${holder.pid} is running` }
}

function parseRecord(raw: string): AgentLeaseRecord | null {
  try {
    const rec = JSON.parse(raw) as AgentLeaseRecord
    if (rec?.v !== 1 || typeof rec.path !== 'string' || typeof rec.holder?.pid !== 'number' || typeof rec.holder.runtimeId !== 'string') return null
    return rec
  } catch {
    return null
  }
}

interface ReadLease { raw: string; record: AgentLeaseRecord | null; mtimeMs: number }

async function readLease(file: string): Promise<ReadLease | null> {
  try {
    const [raw, st] = await Promise.all([fsp.readFile(file, 'utf-8'), fsp.stat(file)])
    return { raw, record: parseRecord(raw), mtimeMs: st.mtimeMs }
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null
    throw err
  }
}

/** Write `data` to `file` through a temp file and a rename (readers never see a partial file). */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

interface LeaseTarget { key: string; canonical: string; file: string }

interface HeldLease { file: string; record: AgentLeaseRecord }

/** One process 'exit' listener for every registry that holds something. */
const exitHookRegistries = new Set<AgentLeaseRegistry>()
let exitHookInstalled = false

function inferKind(): RuntimeHostKind {
  const electronMain = !!process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1' &&
    (process as NodeJS.Process & { type?: string }).type === 'browser'
  return electronMain ? 'studio-embedded' : 'daemon'
}

function defaultControlUrl(env: NodeJS.ProcessEnv): string {
  const port = Number(env.ADF_DAEMON_PORT) || DEFAULT_DAEMON_PORT
  let host = env.ADF_DAEMON_HOST ?? '127.0.0.1'
  if (host === '0.0.0.0' || host === '::' || host === 'localhost') host = '127.0.0.1'
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

export class AgentLeaseRegistry {
  readonly dir: string
  readonly runtimeId = randomBytes(8).toString('hex')
  private readonly startedAt = Date.now()
  private info: Required<Omit<AgentLeaseHostInfo, 'controlUrl'>> & { controlUrl?: string }
  private readonly held = new Map<string, HeldLease>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly probes = new Set<HostedPathsProbe>()
  /** abs path → target, for paths whose realpath resolved. */
  private readonly targetCache = new Map<string, LeaseTarget>()
  private endpoint: string | null = null
  private server: Server | null = null
  private ready: Promise<void> | null = null
  private hostEntryWritten = false
  private clientMode: string | null = null

  constructor(opts: AgentLeaseRegistryOptions = {}) {
    this.dir = opts.dir ?? leaseDir()
    const kind = opts.kind ?? inferKind()
    this.info = {
      kind,
      settingsPath: opts.settingsPath ?? process.env.ADF_DAEMON_SETTINGS ?? join(getUserDataPath(), 'adf-settings.json'),
      version: opts.version ?? process.env.npm_package_version ?? null,
      mode: opts.mode ?? (kind === 'daemon' ? 'daemon' : 'embedded'),
      controlUrl: opts.controlUrl ?? (kind === 'daemon' ? defaultControlUrl(process.env) : undefined),
    }
  }

  /**
   * Who this process is, for lease and host records. Composition roots call
   * it at boot (Studio embedded: registerAllIpcHandlers; daemon: its index)
   * and it (re)writes the host entry.
   */
  configure(info: AgentLeaseHostInfo): Promise<void> {
    this.info = {
      ...this.info,
      ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)),
    }
    if (info.kind && !info.mode) this.info.mode = info.kind === 'daemon' ? 'daemon' : 'embedded'
    if (info.kind === 'studio-embedded' && !info.controlUrl) delete this.info.controlUrl
    return this.ensureReady(true)
  }

  /** Register a host's view of the agents it runs or is starting. Returns the unregister function. */
  addHostedPathsProbe(probe: HostedPathsProbe): () => void {
    this.probes.add(probe)
    return () => { this.probes.delete(probe) }
  }

  holder(): LeaseHolder {
    return {
      kind: this.info.kind,
      pid: process.pid,
      runtimeId: this.runtimeId,
      hostname: HOSTNAME,
      settingsPath: this.info.settingsPath,
      startedAt: this.startedAt,
      version: this.info.version,
      endpoint: this.endpoint,
      ...(this.info.kind === 'daemon' && this.info.controlUrl ? { controlUrl: this.info.controlUrl } : {}),
    }
  }

  /**
   * Take the lease for `filePath` before preparing the agent. Re-entrant
   * within the process. The caller MUST keep the path visible to its probe
   * from before this call until it no longer runs the agent, and call
   * reconcile() when it stops (or fails to start).
   */
  async acquire(filePath: string, opts: { agentId?: string | null } = {}): Promise<AgentLeaseResult> {
    const target = await this.target(filePath)
    return this.withKey(target.key, () => this.acquireLocked(target, opts.agentId ?? null))
  }

  /** Release every held lease no probe lists. Never throws. */
  async reconcile(): Promise<void> {
    if (this.held.size === 0) return
    try {
      for (const key of [...this.held.keys()]) {
        await this.withKey(key, async () => {
          if (!this.held.has(key)) return
          // Re-checked under the key lock: a start may have claimed it meanwhile.
          if ((await this.hostedKeys()).has(key)) return
          await this.releaseLocked(key)
        })
      }
    } catch (err) {
      console.error('[AgentLease] Reconcile failed:', err)
    }
  }

  /**
   * The agent file moved (rename while held). Hosts update their own path
   * maps first, then call this: the lease moves to the new path's key.
   */
  async rekey(oldPath: string, newPath: string): Promise<AgentLeaseResult | null> {
    const oldKey = await this.findHeldKey(oldPath)
    if (!oldKey) return null
    const target = await this.target(newPath)
    const previous = this.held.get(oldKey)!
    if (target.key === oldKey) {
      // Case-only rename on a case-insensitive volume: same key, new path.
      return this.withKey(oldKey, async () => {
        const entry = this.held.get(oldKey)
        if (!entry) return null
        entry.record = { ...entry.record, path: target.canonical }
        try { await writeAtomic(entry.file, JSON.stringify(entry.record, null, 2)) } catch (err) {
          console.warn(`[AgentLease] Could not update the lease of ${agentNameOf(target.canonical)}:`, err)
        }
        return { ok: true as const, leaseFile: entry.file }
      })
    }
    const result = await this.withKey(target.key, () => this.acquireLocked(target, previous.record.agentId))
    if (!result.ok) console.warn(`[AgentLease] Rename of ${agentNameOf(previous.record.path)}: ${result.message}`)
    await this.withKey(oldKey, () => this.releaseLocked(oldKey))
    return result
  }

  /** True when this process holds the lease for `filePath`. */
  async isHeld(filePath: string): Promise<boolean> {
    return this.held.has((await this.target(filePath)).key)
  }

  /** Canonical paths of the agents this process holds leases for. */
  heldPaths(): string[] {
    return [...this.held.values()].map((h) => h.record.path)
  }

  /**
   * Studio in local/remote mode runs no agents, so it is not a host; it
   * records itself as a client so `adf daemon start` knows the running
   * Studio is not a conflict.
   */
  registerClient(mode: 'local' | 'remote', info: { settingsPath?: string; version?: string | null } = {}): Promise<void> {
    this.clientMode = mode
    if (info.settingsPath) this.info.settingsPath = info.settingsPath
    if (info.version !== undefined) this.info.version = info.version
    return this.ensureReady(true)
  }

  /** Test / shutdown helper: release everything, remove host entries, close the endpoint. */
  async close(): Promise<void> {
    for (const key of [...this.held.keys()]) await this.withKey(key, () => this.releaseLocked(key))
    await this.removeOwnEntries()
    const server = this.server
    this.server = null
    this.endpoint = null
    this.ready = null
    this.hostEntryWritten = false
    if (server) await new Promise<void>((r) => server.close(() => r()))
    exitHookRegistries.delete(this)
  }

  // --- internals -----------------------------------------------------------

  private async target(filePath: string): Promise<LeaseTarget> {
    const abs = resolve(filePath)
    const cached = this.targetCache.get(abs)
    if (cached) return cached
    let canonical: string
    let resolved = true
    try {
      canonical = stripLongPathPrefix(await fsp.realpath(abs))
    } catch {
      // Not cached: once the file exists its realpath may differ.
      canonical = stripLongPathPrefix(abs)
      resolved = false
    }
    const key = leaseKeyForCanonicalPath(canonical)
    const target = { key, canonical, file: join(this.dir, `${key}.json`) }
    if (resolved) this.targetCache.set(abs, target)
    return target
  }

  private async findHeldKey(path: string): Promise<string | null> {
    const key = (await this.target(path)).key
    if (this.held.has(key)) return key
    // After a rename the old path no longer resolves: match the recorded path.
    const abs = resolve(path)
    for (const [k, h] of this.held) {
      if (samePath(h.record.path, abs)) return k
      for (const [raw, t] of this.targetCache) {
        if (t.key === k && samePath(raw, abs)) return k
      }
    }
    return null
  }

  private async hostedKeys(): Promise<Set<string>> {
    const keys = new Set<string>()
    for (const probe of [...this.probes]) {
      let paths: string[]
      try { paths = [...probe()] } catch (err) {
        console.error('[AgentLease] Hosted-paths probe failed:', err)
        continue
      }
      for (const p of paths) keys.add((await this.target(p)).key)
    }
    return keys
  }

  private withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    this.chains.set(key, tail)
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key) })
    return run
  }

  private async acquireLocked(target: LeaseTarget, agentId: string | null): Promise<AgentLeaseResult> {
    await this.ensureReady(false)
    const name = agentNameOf(target.canonical)
    const own = this.held.get(target.key)
    if (own) {
      await this.verifyOwn(target, own)
      return { ok: true, leaseFile: target.file }
    }
    const record: AgentLeaseRecord = { v: 1, path: target.canonical, agentId, holder: this.holder(), acquiredAt: Date.now() }
    const body = JSON.stringify(record, null, 2)
    const deadline = Date.now() + ACQUIRE_BUDGET_MS
    let lastError: unknown = null
    let sawLease = false
    while (Date.now() < deadline) {
      try {
        await fsp.mkdir(this.dir, { recursive: true })
        await fsp.writeFile(target.file, body, { flag: 'wx' })
        this.held.set(target.key, { file: target.file, record })
        this.installExitHook()
        return { ok: true, leaseFile: target.file }
      } catch (err) {
        const code = errCode(err)
        if (code !== 'EEXIST') {
          lastError = err
          if (code && TRANSIENT_FS_CODES.has(code)) { await delay(50); continue }
          return this.unprotected(name, target, err)
        }
        sawLease = true
      }
      let existing: ReadLease | null
      try { existing = await readLease(target.file) } catch (err) {
        lastError = err
        await delay(50)
        continue
      }
      if (!existing) continue // released meanwhile
      if (!existing.record) {
        // Being written right now, or left half-written by a crash.
        const age = Date.now() - existing.mtimeMs
        if (age < PARTIAL_WRITE_GRACE_MS) { await delay(Math.min(250, PARTIAL_WRITE_GRACE_MS - age + 10)); continue }
        console.warn(`[AgentLease] ${name}: replacing an unreadable lease file ${target.file}`)
        await this.takeOver(target.file, existing.raw)
        continue
      }
      const holder = existing.record.holder
      if (holder.runtimeId === this.runtimeId) {
        this.held.set(target.key, { file: target.file, record: existing.record })
        return { ok: true, leaseFile: target.file }
      }
      const liveness = await holderLiveness(holder)
      if (liveness.alive) {
        return {
          ok: false,
          code: AGENT_LEASED_CODE,
          leaseFile: target.file,
          record: existing.record,
          message: agentLeasedMessage(existing.record, this.info.settingsPath),
        }
      }
      console.warn(`[AgentLease] ${name}: replacing a stale lease held by ${describeHolder(holder)} (${liveness.reason})`)
      await this.takeOver(target.file, existing.raw)
    }
    // The lease dir never accepted a write and no lease file was there: an
    // unusable dir, not a competitor.
    if (!sawLease) return this.unprotected(name, target, lastError)
    // Contention that never settled (or a lease file that cannot be replaced).
    // Refuse rather than risk running the agent twice; the message says where
    // to look.
    const reason = lastError instanceof Error ? lastError.message : 'the lease file kept changing'
    console.error(`[AgentLease] ${name}: could not take the lease (${reason})`)
    const placeholder: AgentLeaseRecord = { ...record, holder: { ...record.holder, pid: 0 } }
    return {
      ok: false,
      code: AGENT_LEASED_CODE,
      leaseFile: target.file,
      record: placeholder,
      message: `${name} could not be started: its lease file ${target.file} could not be read or replaced (${reason}). ` +
        'If no other ADF Studio or daemon runs this agent, delete that file and start it again.',
    }
  }

  private unprotected(name: string, target: LeaseTarget, err: unknown): AgentLeaseResult {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[AgentLease] ${name}: cannot write the lease in ${this.dir} (${reason}). Starting without protection against a second ADF process running it.`)
    return { ok: true, leaseFile: target.file, unprotected: reason }
  }

  /** Our lease file should exist and name us. Recreate it if it was deleted. */
  private async verifyOwn(target: LeaseTarget, own: HeldLease): Promise<void> {
    try {
      const current = await readLease(own.file)
      if (!current) {
        await fsp.mkdir(this.dir, { recursive: true })
        await fsp.writeFile(own.file, JSON.stringify(own.record, null, 2), { flag: 'wx' })
        console.warn(`[AgentLease] ${agentNameOf(target.canonical)}: lease file was missing; recreated`)
      } else if (current.record && current.record.holder.runtimeId !== this.runtimeId) {
        console.warn(`[AgentLease] ${agentNameOf(target.canonical)}: lease file now names ${describeHolder(current.record.holder)} while this process runs the agent`)
      }
    } catch (err) {
      console.warn(`[AgentLease] ${agentNameOf(target.canonical)}: could not verify the lease:`, err)
    }
  }

  /**
   * Remove a stale lease file whose content was `expectedRaw`. The rename is
   * atomic; if what we moved is not what we judged stale, a newer lease won
   * the race and is put back.
   */
  private async takeOver(file: string, expectedRaw: string): Promise<void> {
    const tomb = `${file}.${this.runtimeId}-${randomBytes(4).toString('hex')}.stale`
    try {
      await fsp.rename(file, tomb)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') await delay(50)
      return
    }
    let moved: string | null = null
    try { moved = await fsp.readFile(tomb, 'utf-8') } catch { /* gone */ }
    if (moved !== null && moved !== expectedRaw) {
      try {
        await fsp.writeFile(file, moved, { flag: 'wx' })
      } catch (err) {
        console.warn(`[AgentLease] Lease race on ${file}: could not restore a newer lease (${errCode(err) ?? err})`)
      }
    }
    await fsp.rm(tomb, { force: true }).catch(() => {})
  }

  private async releaseLocked(key: string): Promise<void> {
    const entry = this.held.get(key)
    if (!entry) return
    this.held.delete(key)
    try {
      const current = await readLease(entry.file)
      if (!current) return
      if (current.record && current.record.holder.runtimeId !== this.runtimeId) {
        console.warn(`[AgentLease] ${agentNameOf(entry.record.path)}: lease now names ${describeHolder(current.record.holder)}; left in place`)
        return
      }
      await fsp.rm(entry.file, { force: true })
    } catch (err) {
      console.error(`[AgentLease] Could not release the lease of ${agentNameOf(entry.record.path)}:`, err)
    }
  }

  private installExitHook(): void {
    exitHookRegistries.add(this)
    if (exitHookInstalled) return
    exitHookInstalled = true
    process.once('exit', () => { for (const reg of exitHookRegistries) reg.releaseAllSync() })
  }

  /** Process exit: synchronous by necessity. Removes only files that still name us. */
  releaseAllSync(): void {
    for (const entry of this.held.values()) this.unlinkIfOwnSync(entry.file)
    this.held.clear()
    if (this.hostEntryWritten) this.unlinkIfOwnSync(this.entryFile())
  }

  private unlinkIfOwnSync(file: string): void {
    try {
      const rec = JSON.parse(readFileSync(file, 'utf-8')) as { holder?: { runtimeId?: string }; runtimeId?: string }
      if ((rec.holder?.runtimeId ?? rec.runtimeId) === this.runtimeId) unlinkSync(file)
    } catch { /* already gone or unreadable */ }
  }

  private entryFile(): string {
    return join(this.dir, this.clientMode ? 'clients' : 'hosts', `${process.pid}.json`)
  }

  private ensureReady(rewriteEntry: boolean): Promise<void> {
    if (!this.ready) {
      this.ready = this.startEndpoint().then(() => this.writeEntry())
    } else if (rewriteEntry) {
      this.ready = this.ready.then(() => this.writeEntry())
    }
    return this.ready
  }

  private async startEndpoint(): Promise<void> {
    let endpoint: string
    if (process.platform === 'win32') {
      endpoint = `\\\\.\\pipe\\adf-runtime-${this.runtimeId}`
    } else {
      endpoint = join(this.dir, 'hosts', `${this.runtimeId}.sock`)
      if (endpoint.length > MAX_SOCKET_PATH) endpoint = join(tmpdir(), `adf-runtime-${this.runtimeId}.sock`)
    }
    try {
      if (process.platform !== 'win32') await fsp.mkdir(join(this.dir, 'hosts'), { recursive: true })
      const server = createServer((socket) => {
        socket.on('error', () => {})
        socket.end(`${JSON.stringify({ pid: process.pid, runtimeId: this.runtimeId })}\n`)
      })
      await new Promise<void>((ok, fail) => {
        server.once('error', fail)
        server.listen(endpoint, () => { server.off('error', fail); ok() })
      })
      server.on('error', (err) => console.error('[AgentLease] Endpoint error:', err))
      server.unref()
      this.server = server
      this.endpoint = endpoint
    } catch (err) {
      // Liveness then falls back to the pid alone (PID reuse can hold a lease).
      console.warn(`[AgentLease] Could not listen on ${endpoint}; leases fall back to pid checks:`, err instanceof Error ? err.message : err)
    }
  }

  private async writeEntry(): Promise<void> {
    const kind = this.clientMode ? 'studio-client' : this.info.kind
    // A Studio switching between modes must not leave the other entry behind.
    const other = join(this.dir, this.clientMode ? 'hosts' : 'clients', `${process.pid}.json`)
    this.unlinkIfOwnSync(other)
    const entry: RuntimeHostRecord = {
      v: 1,
      ...this.holder(),
      kind,
      mode: this.clientMode ?? this.info.mode,
    }
    try {
      await fsp.mkdir(join(this.dir, this.clientMode ? 'clients' : 'hosts'), { recursive: true })
      await writeAtomic(this.entryFile(), JSON.stringify(entry, null, 2))
      this.hostEntryWritten = true
      this.installExitHook()
      void sweepDeadEntries(this.dir).catch(() => {})
    } catch (err) {
      console.warn(`[AgentLease] Could not write the runtime host entry in ${this.dir}:`, err instanceof Error ? err.message : err)
    }
  }

  private async removeOwnEntries(): Promise<void> {
    for (const sub of ['hosts', 'clients']) this.unlinkIfOwnSync(join(this.dir, sub, `${process.pid}.json`))
    this.hostEntryWritten = false
  }
}

async function readEntries(dir: string): Promise<Array<{ file: string; raw: string; record: RuntimeHostRecord }>> {
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return [] }
  const out: Array<{ file: string; raw: string; record: RuntimeHostRecord }> = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    const file = join(dir, name)
    try {
      const raw = await fsp.readFile(file, 'utf-8')
      const record = JSON.parse(raw) as RuntimeHostRecord
      if (record?.v === 1 && typeof record.pid === 'number' && typeof record.runtimeId === 'string') out.push({ file, raw, record })
    } catch { /* partial or foreign file */ }
  }
  return out
}

/** Remove host/client entries of processes that are definitely gone. */
async function sweepDeadEntries(dir: string): Promise<void> {
  for (const sub of ['hosts', 'clients']) {
    for (const { file, raw, record } of await readEntries(join(dir, sub))) {
      if (record.hostname && record.hostname !== HOSTNAME) continue
      if (record.pid === process.pid) continue
      if ((await holderLiveness(record as LeaseHolder)).alive) continue
      try {
        if ((await fsp.readFile(file, 'utf-8')) === raw) await fsp.rm(file, { force: true })
      } catch { /* gone */ }
    }
  }
}

export interface LiveRuntimeHost extends RuntimeHostRecord { alive: boolean }

/** Runtime hosts (embedded Studio, daemons) on this machine, with liveness. */
export async function listRuntimeHosts(dir: string = leaseDir()): Promise<LiveRuntimeHost[]> {
  return listEntries(join(dir, 'hosts'))
}

/** Studio instances running in local or remote mode (clients, not hosts). */
export async function listStudioClients(dir: string = leaseDir()): Promise<LiveRuntimeHost[]> {
  return listEntries(join(dir, 'clients'))
}

async function listEntries(dir: string): Promise<LiveRuntimeHost[]> {
  const entries = (await readEntries(dir)).filter((e) => !e.record.hostname || e.record.hostname === HOSTNAME)
  return Promise.all(entries.map(async ({ record }) => ({
    ...record,
    alive: record.pid === process.pid ? true : (await holderLiveness(record as LeaseHolder)).alive,
  })))
}

/**
 * For a start entry point that can throw anywhere between taking the lease
 * and installing the agent (Studio's AGENT_START). The host's probe lists
 * `startingPaths()`, which reports the host's in-progress set only while a
 * wrapped start runs (an exception can leave an entry behind), and every
 * wrapped start ends with reconcile(): a lease the start took but did not
 * install is released whether it returned or threw.
 */
export class LeasedStartTracker {
  private inFlight = 0

  constructor(
    private readonly starting: () => Iterable<string>,
    private readonly registry: () => AgentLeaseRegistry = processAgentLeases,
  ) {}

  startingPaths(): string[] {
    return this.inFlight > 0 ? [...this.starting()] : []
  }

  wrap<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => {
      this.inFlight++
      try {
        return await handler(...args)
      } finally {
        this.inFlight--
        await this.registry().reconcile()
      }
    }
  }
}

let processRegistry: AgentLeaseRegistry | null = null

/**
 * The lease registry of this process. Hosts (RuntimeService,
 * BackgroundAgentManager, Studio's foreground) share it, so one process holds
 * one lease per agent. Its identity is inferred until a composition root
 * calls configure().
 */
export function processAgentLeases(): AgentLeaseRegistry {
  processRegistry ??= new AgentLeaseRegistry()
  return processRegistry
}
