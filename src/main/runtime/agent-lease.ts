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
 *   <lease dir>/<sha256(canonical path)>.json   one lease per agent file
 *   <lease dir>/hosts/<pid>.json                one entry per runtime host
 *   <lease dir>/clients/<pid>.json              Studio in local/remote mode
 *
 * The lease dir is per user and per machine (%LOCALAPPDATA%\adf\leases on
 * Windows, so a roaming profile never carries it to another machine; the
 * config dir elsewhere). It ignores ADF_USER_DATA_DIR, ADF_DAEMON_SETTINGS and
 * ADF_INSTANCE: hosts on different settings files must still see each other.
 * ADF_LEASE_DIR overrides it (tests). Directories are created 0700. The key is
 * the canonical path alone; the hostname is recorded for people and never
 * compared (a machine rename must not split one file into two leases).
 *
 * Crash safety. A lease names its holder's pid and a local endpoint (a named
 * pipe on Windows, a Unix socket elsewhere) the holder listens on for its
 * whole life. The OS closes the endpoint when the process dies, so:
 *   - pid not running                        → stale (crash, kill)
 *   - pid running, endpoint refuses          → stale (the pid was reused)
 *   - pid running, endpoint missing          → stale for a named pipe or a
 *                                              socket in the 0700 hosts dir;
 *                                              live for the tmpdir() fallback
 *                                              socket (tmp cleaners delete it)
 *   - endpoint connects                      → live, even if its event loop is
 *                                              blocked (the OS accepts the
 *                                              connection)
 *   - anything inconclusive (timeout, EBUSY) → live: a lease is never taken
 *                                              from a holder that may be alive
 * A stale lease is replaced under a per-lease takeover lock
 * (`<lease>.takeover`, created exclusively): the taker re-reads the lease,
 * removes it only if it still holds the bytes judged stale, and writes its
 * own exclusively. Any number of takers racing on one stale lease leave
 * exactly one holder. The lock is broken only when its holder's pid is gone
 * or its endpoint refuses or is missing (missing as above); a timeout is a live holder (a
 * blocked event loop stops answering but keeps the lock), and only a lock
 * without a readable pid expires by TTL. A lock is removed only if it still
 * holds the bytes judged. Endpoints are probed
 * only in the exact local form this module creates (never a UNC/SMB path).
 *
 * Machines. Records carry a machine id (Linux /etc/machine-id, macOS
 * IOPlatformUUID, Windows MachineGuid; ADF_MACHINE_ID overrides). A record
 * from another machine (a network home shared by two machines) is never
 * judged by this machine's pids: it counts as alive and is never swept.
 *
 * In-process accounting. A process holds a lease once, however many of its
 * hosts (Studio foreground, BackgroundAgentManager, RuntimeService) touch the
 * agent, so foreground/background hand-offs keep it. Each host registers a
 * probe listing the paths it runs or is starting; reconcile() releases every
 * held lease no probe lists. Hosts call it after a failed start and after
 * disposing an agent. On process exit the remaining leases are removed.
 *
 * Failure policy. A live holder elsewhere refuses the start (`agent_leased`).
 * A lease dir that cannot be written (permissions, read-only volume) lets the
 * start proceed without cross-process protection (today's behaviour: a broken
 * dir must not stop every agent). The result carries `unprotected`, a
 * sentence hosts show the user; the process remembers the broken dir for a
 * minute so starts do not stall on it.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp, readFileSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { homedir, hostname as osHostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  /** machineId() of the machine the holder runs on; null when unknown. */
  machineId?: string | null
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
  /** Containers this runtime started or uses (services/compute-users.ts). */
  containers?: string[]
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
  /** Tests that model several runtimes in one process: the pid, hostname and machine id recorded. */
  pid?: number
  hostname?: string
  machineId?: string | null
  /** Tests: how long an inconclusive takeover lock lives (default 10 s). */
  takeoverLockTtlMs?: number
  /** Tests: runs after a taker has read the stale lease under the lock, before it replaces it. */
  beforeTakeoverReplace?: () => Promise<void>
  /**
   * Remove dead host records after writing ours (default true). Off for
   * test registries that model runtimes with made-up pids.
   */
  sweepDeadEntries?: boolean
}

/** Paths a host runs or is starting. Any form: they are canonicalized here. */
export type HostedPathsProbe = () => Iterable<string>

const DEFAULT_DAEMON_PORT = 7385
/** How long a liveness probe may take before the holder counts as alive. */
const PROBE_TIMEOUT_MS = 1500
/** An unparsable lease younger than this may still be being written. */
const PARTIAL_WRITE_GRACE_MS = 2000
/** Upper bound for one acquire under contention. */
const ACQUIRE_BUDGET_MS = 5000
/** Unix socket paths are limited to ~104 bytes (macOS). */
const MAX_SOCKET_PATH = 100
/**
 * Windows reports a file in delete-pending state (another process still has
 * it open) as EPERM/EACCES/EBUSY. Such an error is retried; it marks the dir
 * unusable only when a write of a fresh probe file fails the same way.
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** How long a broken lease dir is remembered before it is tried again. */
const UNUSABLE_DIR_MEMO_MS = 60_000
/** A takeover lock this old (or whose pid is gone) was left by a crash. */
const TAKEOVER_LOCK_TTL_MS = 10_000
const TAKEOVER_LOCK_WAIT_MS = 2_000
/** How often a takeover lock judged live is probed again during one wait. */
const TAKEOVER_LOCK_REPROBE_MS = 250
/** A takeover lock older than this has its pid checked. */
const TAKEOVER_LOCK_SUSPECT_MS = 500
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** `<per-user config dir>/adf/leases`, or ADF_LEASE_DIR. */
export function leaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADF_LEASE_DIR) return resolve(env.ADF_LEASE_DIR)
  let base: string
  if (process.platform === 'darwin') base = join(homedir(), 'Library', 'Application Support')
  else if (process.platform === 'win32') base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
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
  return createHash('sha256').update(norm).digest('hex')
}

function stripLongPathPrefix(p: string): string {
  if (process.platform !== 'win32') return p
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

/** Either separator: a lease folder shared between machines holds Windows and POSIX paths alike. */
function agentNameOf(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.adf$/i, '')
}

/**
 * Two paths name one agent file, folded as the lease key folds them
 * (leaseKeyForCanonicalPath): NFC on macOS, whose APFS/HFS+ names may come
 * back decomposed, and case-insensitive except on Linux.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    const abs = platform === 'darwin' ? resolve(p).normalize('NFC') : resolve(p)
    return platform === 'linux' ? abs : abs.toLowerCase()
  }
  return norm(a) === norm(b)
}

/**
 * The sentence a refused start shows: which process holds the agent and what
 * to do about it. `ownSettingsPath` adds the holder's settings file when it
 * differs from the caller's (two hosts on different data). `unconfirmedLeaseFile`
 * is set when the holder left nothing to check but its pid (holderLiveness
 * `unconfirmed`: no endpoint, no control URL): the pid may belong to another
 * program by now, so the sentence names the lease file and how to clear it.
 * `noAnswerFrom` is set when a daemon holder's control URL gave no usable
 * answer (holderLiveness `noAnswer`): it may just be busy, so the sentence
 * never advises deleting the lease.
 */
export function agentLeasedMessage(
  record: AgentLeaseRecord,
  ownSettingsPath?: string,
  otherMachine = false,
  check: { unconfirmedLeaseFile?: string; noAnswerFrom?: string } = {},
): string {
  const name = agentNameOf(record.path)
  const h = record.holder
  let text: string
  if (otherMachine) {
    text = `${name} is already running on another machine (${h.hostname || 'unknown host'}, pid ${h.pid}) that shares this lease folder. Stop it there, then start it here.`
  } else if (h.kind === 'daemon') {
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
  if (otherMachine) return text
  if (check.unconfirmedLeaseFile) {
    text += ` ADF cannot confirm that pid ${h.pid} is still that process: it recorded no endpoint to check. ` +
      `If no ADF Studio or daemon runs ${name}, delete the lease file ${check.unconfirmedLeaseFile} and start it again.`
  } else if (check.noAnswerFrom) {
    text += ` ADF could not confirm it: ${check.noAnswerFrom} did not answer the check, which a busy daemon also does. ` +
      'Wait a moment and try again; "adf daemon status" shows whether that daemon runs.'
  }
  return text
}

/**
 * The sentence a start refused for its agent id shows: `path` is a copy of
 * the agent `record.path` runs (same id), and where that one runs.
 */
export function agentIdLeasedMessage(path: string, agentId: string, record: AgentLeaseRecord, ownProcess: boolean, otherMachine = false): string {
  const h = record.holder
  const where = ownProcess
    ? (h.kind === 'daemon' ? 'in this ADF daemon' : 'in this ADF Studio')
    : otherMachine
      ? `on another machine (${h.hostname || 'unknown host'}, pid ${h.pid}) that shares this lease folder`
      : h.kind === 'daemon'
        ? `in the ADF daemon (pid ${h.pid}${h.controlUrl ? `, ${h.controlUrl}` : ''})`
        : `in another ADF Studio (pid ${h.pid})`
  return `${agentNameOf(path)} was not started: ${path} has the agent id ${agentId}, and ${record.path} with the same id is already running ${where}. ` +
    'The two files are copies of one agent; running both would answer its timers and messages twice and poll its Telegram bot twice. ' +
    'Stop the running copy first, or keep only one of the two files.'
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

/**
 * Per-attempt timeouts of the machine id lookup. reg.exe / ioreg can take
 * seconds on a loaded machine; a second, longer attempt rides that out.
 */
const MACHINE_ID_ATTEMPT_TIMEOUTS_MS = [3_000, 10_000]
/** A failed lookup (timeout, spawn error) is remembered this long; the next caller after it asks again. */
const MACHINE_ID_RETRY_MS = 15_000
/**
 * How long anything that needs the id waits for it (a registry's first
 * write, an agent start, a liveness check): the old lookup timeout. A slower
 * lookup goes on in the background, and the records are rewritten once it
 * answers.
 */
const MACHINE_ID_WAIT_MS = 3_000

/** One lookup: an id, a definite "this platform has none", or a failure worth asking again about. */
type MachineIdOutcome = { id: string } | { none: true } | { failed: true }
type MachineIdReader = (timeoutMs: number) => Promise<string | null>
let machineIdReader: MachineIdReader = readMachineId
let machineIdRetryMs = MACHINE_ID_RETRY_MS
let machineIdWaitMs = MACHINE_ID_WAIT_MS
let machineIdLookup: { promise: Promise<string | null>; failedAt: number | null } | null = null

/**
 * A stable id of this machine, or null when there is none or it cannot be
 * read. A read id, and a definite none (no /etc/machine-id in a container),
 * are cached for the process; a failed lookup only for MACHINE_ID_RETRY_MS,
 * so one slow reg.exe does not leave every record of this process without it.
 */
export function machineId(): Promise<string | null> {
  const cached = machineIdLookup
  if (cached && (cached.failedAt === null || Date.now() - cached.failedAt < machineIdRetryMs)) return cached.promise
  const entry: { promise: Promise<string | null>; failedAt: number | null } = { promise: Promise.resolve(null), failedAt: null }
  entry.promise = lookupMachineId().then((outcome) => {
    if ('failed' in outcome) entry.failedAt = Date.now()
    return 'id' in outcome ? outcome.id : null
  })
  machineIdLookup = entry
  return entry.promise
}

/** The last lookup failed (and is asked again after MACHINE_ID_RETRY_MS); false for an id or a definite none. */
function machineIdLookupFailed(): boolean {
  return machineIdLookup?.failedAt != null
}

/** machineId(), waiting at most MACHINE_ID_WAIT_MS: null meanwhile, the lookup goes on. */
export function machineIdWithin(waitMs: number = machineIdWaitMs): Promise<string | null> {
  const lookup = machineId()
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); timer.unref?.() })
  return Promise.race([lookup, waited]).finally(() => clearTimeout(timer))
}

/** Tests: replace the platform reader, the retry interval and the wait (undefined restores them) and forget the cached id. */
export function __setMachineIdReaderForTests(reader?: MachineIdReader, opts: { retryMs?: number; waitMs?: number } = {}): void {
  machineIdReader = reader ?? readMachineId
  machineIdRetryMs = opts.retryMs ?? MACHINE_ID_RETRY_MS
  machineIdWaitMs = opts.waitMs ?? MACHINE_ID_WAIT_MS
  machineIdLookup = null
}

async function lookupMachineId(): Promise<MachineIdOutcome> {
  let lastError: unknown = null
  for (const timeoutMs of MACHINE_ID_ATTEMPT_TIMEOUTS_MS) {
    try {
      const id = (await machineIdReader(timeoutMs))?.trim().toLowerCase() || null
      if (id) return { id }
      // Read, and the platform has none: cached for the process, said once.
      console.warn("[AgentLease] This machine has no machine id (e.g. no /etc/machine-id in a container); this process's records carry none, and records of other runtimes are judged by this machine's pids")
      return { none: true }
    } catch (err) {
      lastError = err
    }
  }
  console.warn(`[AgentLease] Could not read this machine's id (${lastError instanceof Error ? lastError.message : String(lastError)}); asked again after ${Math.ceil(machineIdRetryMs / 1000)} s. Until then this process's records carry no machine id and records of other runtimes are judged by this machine's pids`)
  return { failed: true }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf-8' }, (err, stdout) => (err ? fail(err) : ok(stdout)))
    } catch (err) {
      fail(err)
    }
  })
}

async function readMachineId(timeoutMs: number): Promise<string | null> {
  if (process.env.ADF_MACHINE_ID) return process.env.ADF_MACHINE_ID
  if (process.platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = (await fsp.readFile(file, 'utf-8')).trim()
        if (id) return id
      } catch { /* next */ }
    }
    return null
  }
  if (process.platform === 'darwin') {
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], timeoutMs))?.[1] ?? null
  }
  if (process.platform === 'win32') {
    // By full path: never a reg.exe found first on PATH.
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    return /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], timeoutMs))?.[1] ?? null
  }
  return null
}

/** Both ids known and different: the record was written on another machine. Waits at most MACHINE_ID_WAIT_MS for ours. */
export async function fromOtherMachine(record: { machineId?: string | null }): Promise<boolean> {
  if (!record.machineId) return false
  const ours = await machineIdWithin()
  return !!ours && record.machineId !== ours
}

/**
 * The sentence naming the live runtime that holds `filePath`'s agent lease
 * (W0-C), or null when nobody else does. A file another runtime runs must not
 * be written, moved or deleted from here.
 */
export async function leaseHolderElsewhere(leases: AgentLeaseRegistry | null, filePath: string): Promise<string | null> {
  if (!leases) return null
  try {
    if (await leases.isHeld(filePath)) return null
    const canonical = await canonicalLeasePath(filePath)
    let raw: string
    try { raw = await fsp.readFile(join(leases.dir, `${leaseKeyForCanonicalPath(canonical)}.json`), 'utf-8') } catch { return null }
    const record = JSON.parse(raw) as AgentLeaseRecord
    if (record?.v !== 1 || typeof record.holder?.pid !== 'number' || typeof record.holder.runtimeId !== 'string') return null
    if (record.holder.runtimeId === leases.runtimeId) return null
    const liveness = await holderLiveness(record.holder, leases.dir)
    return liveness.alive ? agentLeasedMessage(record, undefined, liveness.otherMachine) : null
  } catch (err) {
    console.warn(`[AgentLease] Lease check of ${agentNameOf(filePath)} failed:`, err)
    return null
  }
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

/**
 * The holder's endpoint, if it has exactly the local form startEndpoint()
 * creates for that runtime id. Anything else (a UNC path, a foreign socket)
 * is never connected to; liveness then rests on the pid.
 */
export function trustedEndpoint(holder: Pick<LeaseHolder, 'endpoint' | 'runtimeId'>, dir: string): string | null {
  const { endpoint, runtimeId } = holder
  if (!endpoint || !/^[0-9a-f]{16}$/.test(runtimeId)) return null
  if (process.platform === 'win32') return endpoint === pipeName(runtimeId) ? endpoint : null
  return endpoint === join(dir, 'hosts', `${runtimeId}.sock`) || endpoint === join(tmpdir(), `adf-runtime-${runtimeId}.sock`) ? endpoint : null
}

/**
 * Does this probe prove the endpoint's process is gone? A refusing endpoint
 * does. A missing one only where nothing but its process removes it: a named
 * pipe, or a socket in the 0700 hosts dir. The tmpdir() fallback socket
 * (hosts path too long for a socket) can be deleted under a live holder by a
 * tmp cleaner, so there a missing file proves nothing.
 */
function probeProvesDead(endpoint: string, probe: EndpointProbe, dir: string): boolean {
  if (probe === 'refused') return true
  if (probe !== 'missing') return false
  return process.platform === 'win32' || dirname(endpoint) === join(dir, 'hosts')
}

function pipeName(runtimeId: string): string {
  return `\\\\.\\pipe\\adf-runtime-${runtimeId}`
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
export async function holderLiveness(
  holder: Pick<LeaseHolder, 'pid' | 'runtimeId' | 'endpoint'> & { machineId?: string | null; kind?: string; controlUrl?: string },
  dir: string = leaseDir(),
): Promise<{ alive: boolean; reason: string; otherMachine?: boolean; unconfirmed?: boolean; noAnswer?: boolean }> {
  // Another machine's pids mean nothing here: never stale.
  if (await fromOtherMachine(holder)) return { alive: true, otherMachine: true, reason: 'held on another machine' }
  if (!(await pidAlive(holder.pid))) return { alive: false, reason: `pid ${holder.pid} is not running` }
  const endpoint = trustedEndpoint(holder, dir)
  if (endpoint) {
    const probe = await probeEndpoint(endpoint)
    if (probe === 'connected') return { alive: true, reason: 'endpoint answered' }
    // A named pipe disappears with its process; a Unix socket file stays
    // behind and refuses (probeProvesDead). A timeout is a live holder whose
    // event loop is busy.
    if (probeProvesDead(endpoint, probe, dir)) {
      return { alive: false, reason: `pid ${holder.pid} now belongs to another program` }
    }
    return { alive: true, reason: `pid ${holder.pid} is running (endpoint ${probe})` }
  }
  if (holder.kind === 'daemon' && holder.controlUrl) {
    const pid = await fetchDaemonPid(holder.controlUrl)
    if (pid !== null && pid !== holder.pid) {
      return { alive: false, reason: `${holder.controlUrl} is served by pid ${pid}, not ${holder.pid}` }
    }
    if (pid === holder.pid) return { alive: true, reason: `${holder.controlUrl} is served by pid ${pid}` }
    // A busy (or token-guarded) daemon answers like this too: alive.
    return { alive: true, noAnswer: true, reason: `pid ${holder.pid} is running; ${holder.controlUrl} did not answer` }
  }
  // Nothing to ask (the holder could not listen and has no control URL): a
  // running pid is all there is, and a reused pid looks the same.
  if (!holder.endpoint && !holder.controlUrl) return { alive: true, unconfirmed: true, reason: `pid ${holder.pid} is running` }
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
  await fsp.writeFile(tmp, data, { mode: FILE_MODE })
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (err) {
      // Windows refuses a rename over a file a reader has open: retry briefly.
      const code = errCode(err)
      if (attempt < 5 && code && TRANSIENT_FS_CODES.has(code)) { await delay(20 * (attempt + 1)); continue }
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
}

interface LeaseTarget { key: string; canonical: string; file: string }

/**
 * Remove our takeover lock. A process reading or stat-ing it at that moment
 * leaves it delete-pending on Windows (EPERM): retry, since a lock left
 * behind would block every taker until its TTL.
 */
async function unlockTakeover(lock: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await fsp.rm(lock, { force: true })
      return
    } catch (err) {
      const code = errCode(err)
      if (!code || !TRANSIENT_FS_CODES.has(code)) break
      await delay(5)
    }
  }
  console.warn(`[AgentLease] Could not remove the takeover lock ${lock}; it expires after ${TAKEOVER_LOCK_TTL_MS / 1000}s`)
}

interface HeldLease {
  file: string
  record: AgentLeaseRecord
  /** Bumped by every acquire (re-entrant ones too); reconcile releases only an unchanged lease. */
  generation: number
}

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
  private generation = 0
  private readonly pid: number
  private readonly hostnameOverride: string | undefined
  private machineIdValue: string | null = null
  private readonly machineIdOverride: string | null | undefined
  /** Pending retry of a failed machine id lookup (scheduleMachineIdRetry). */
  private machineIdRetry: NodeJS.Timeout | null = null
  private readonly takeoverLockTtlMs: number
  private readonly beforeTakeoverReplace?: () => Promise<void>
  private readonly sweepEntries: boolean
  /** Containers this runtime uses, written into its host record. */
  private containers: string[] = []
  /** The lease dir refused writes: remembered so every start does not stall on it. */
  private unusable: { reason: string; at: number } | null = null

  constructor(opts: AgentLeaseRegistryOptions = {}) {
    this.dir = opts.dir ?? leaseDir()
    this.pid = opts.pid ?? process.pid
    this.hostnameOverride = opts.hostname
    this.machineIdOverride = opts.machineId
    this.takeoverLockTtlMs = opts.takeoverLockTtlMs ?? TAKEOVER_LOCK_TTL_MS
    this.beforeTakeoverReplace = opts.beforeTakeoverReplace
    this.sweepEntries = opts.sweepDeadEntries ?? true
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
      pid: this.pid,
      runtimeId: this.runtimeId,
      hostname: this.hostnameOverride ?? osHostname(),
      machineId: this.machineIdValue,
      settingsPath: this.info.settingsPath,
      startedAt: this.startedAt,
      version: this.info.version,
      endpoint: this.endpoint,
      ...((this.info.kind === 'daemon' || this.clientMode) && this.info.controlUrl ? { controlUrl: this.info.controlUrl } : {}),
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
    const agentId = opts.agentId ?? null
    const { result, fresh } = await this.withKey(target.key, async () => {
      const heldBefore = this.held.has(target.key)
      return { result: await this.acquireLocked(target, agentId), fresh: !heldBefore }
    })
    if (!result.ok || result.unprotected || !agentId) return result
    const generation = this.held.get(target.key)?.generation
    const conflict = await this.agentIdConflict(target, agentId)
    if (!conflict) return result
    // A path lease this call took is given back now (not at the caller's
    // reconcile), unless another start in this process took it again since.
    if (fresh) {
      await this.withKey(target.key, async () => {
        if (this.held.get(target.key)?.generation === generation) await this.releaseLocked(target.key)
      })
    }
    return conflict
  }

  /** Release every held lease no probe lists. Never throws. */
  async reconcile(): Promise<void> {
    if (this.held.size === 0) return
    try {
      // Every probe and every lease generation in one synchronous snapshot:
      // awaiting between probes could miss an agent handed from one host to
      // another in between.
      const paths: string[] = []
      for (const probe of [...this.probes]) {
        try { for (const p of probe()) paths.push(p) } catch (err) {
          console.error('[AgentLease] Hosted-paths probe failed; nothing released:', err)
          return
        }
      }
      const generations = new Map([...this.held].map(([key, h]) => [key, h.generation]))
      const hosted = new Set<string>()
      for (const p of paths) hosted.add((await this.target(p)).key)
      for (const [key, generation] of generations) {
        if (hosted.has(key)) continue
        await this.withKey(key, async () => {
          // Acquired again since the snapshot (a new start): still in use.
          if (this.held.get(key)?.generation !== generation) return
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

  /**
   * Record the agent id in a lease taken before the file was opened (a
   * daemon load and a background start acquire first, then read the
   * config), then check it as acquire() does: a refusal when another live
   * holder runs that agent id from another file, else null. No-op (null)
   * when this process does not hold the lease. Never throws.
   */
  async noteAgentId(filePath: string, agentId: string): Promise<AgentLeaseResult | null> {
    try {
      const target = await this.target(filePath)
      const held = await this.withKey(target.key, async () => {
        const entry = this.held.get(target.key)
        if (!entry) return false
        if (entry.record.agentId === agentId) return true
        entry.record = { ...entry.record, agentId }
        await writeAtomic(entry.file, JSON.stringify(entry.record, null, 2))
        return true
      })
      return held ? await this.agentIdConflict(target, agentId) : null
    } catch (err) {
      console.warn(`[AgentLease] Could not record the agent id in the lease of ${agentNameOf(filePath)}:`, err)
      return null
    }
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
  registerClient(mode: 'local' | 'remote', info: { settingsPath?: string; version?: string | null; controlUrl?: string } = {}): Promise<void> {
    this.clientMode = mode
    if (info.settingsPath) this.info.settingsPath = info.settingsPath
    if (info.version !== undefined) this.info.version = info.version
    // The daemon this client uses, once known; never a guessed default port.
    if (info.controlUrl) this.info.controlUrl = info.controlUrl
    else delete this.info.controlUrl
    return this.ensureReady(true)
  }

  /** Test / shutdown helper: release everything, remove host entries, close the endpoint. */
  async close(): Promise<void> {
    await this.ready?.catch(() => {})
    if (this.machineIdRetry) clearTimeout(this.machineIdRetry)
    this.machineIdRetry = null
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
      own.generation = ++this.generation
      await this.verifyOwn(target, own)
      return { ok: true, leaseFile: target.file }
    }
    if (this.unusable && Date.now() - this.unusable.at < UNUSABLE_DIR_MEMO_MS) {
      return this.unprotected(name, target, this.unusable.reason, false)
    }
    const record: AgentLeaseRecord = { v: 1, path: target.canonical, agentId, holder: this.holder(), acquiredAt: Date.now() }
    const body = JSON.stringify(record, null, 2)
    const deadline = Date.now() + ACQUIRE_BUDGET_MS
    const won = async (): Promise<AgentLeaseResult> => {
      const entry: HeldLease = { file: target.file, record, generation: ++this.generation }
      this.held.set(target.key, entry)
      this.unusable = null
      this.installExitHook()
      // The machine id arrived while this acquire was under way (stampMachineId
      // rewrote only the leases held then): this one gets it now.
      const id = this.machineIdValue
      if (id && record.holder.machineId !== id) await this.stampLease(entry, id)
      return { ok: true, leaseFile: target.file }
    }
    let lastError: unknown = null
    try {
      await fsp.mkdir(this.dir, { recursive: true, mode: DIR_MODE })
    } catch (err) {
      return this.unprotected(name, target, err instanceof Error ? err.message : String(err), true)
    }
    while (Date.now() < deadline) {
      try {
        await fsp.writeFile(target.file, body, { flag: 'wx', mode: FILE_MODE })
        return await won()
      } catch (err) {
        const code = errCode(err)
        if (code !== 'EEXIST') {
          lastError = err
          if (code && TRANSIENT_FS_CODES.has(code) && await this.dirWritable()) { await delay(20); continue }
          return this.unprotected(name, target, err instanceof Error ? err.message : String(err), true)
        }
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
        if (await this.takeOver(target.file, existing.raw, body)) return await won()
        continue
      }
      const holder = existing.record.holder
      if (holder.runtimeId === this.runtimeId) {
        this.held.set(target.key, { file: target.file, record: existing.record, generation: ++this.generation })
        return { ok: true, leaseFile: target.file }
      }
      const liveness = await holderLiveness(holder, this.dir)
      if (liveness.alive) {
        return {
          ok: false,
          code: AGENT_LEASED_CODE,
          leaseFile: target.file,
          record: existing.record,
          message: agentLeasedMessage(existing.record, this.info.settingsPath, liveness.otherMachine, {
            ...(liveness.unconfirmed ? { unconfirmedLeaseFile: target.file } : {}),
            ...(liveness.noAnswer && holder.controlUrl ? { noAnswerFrom: holder.controlUrl } : {}),
          }),
        }
      }
      console.warn(`[AgentLease] ${name}: replacing a stale lease held by ${describeHolder(holder)} (${liveness.reason})`)
      if (await this.takeOver(target.file, existing.raw, body)) return await won()
    }
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

  /**
   * The lease is keyed by path, so a copied or restored `.adf` (same agent
   * id, another file) got its own lease, and two runtimes, or one runtime
   * twice, ran one agent: both answered its timers and both polled its
   * Telegram bot (W5-D3). Checked after our path lease is written: two
   * hosts starting two copies at once each see the other's lease (at worst
   * both refuse; never both run). Another holder's lease that is stale or
   * unreadable is ignored here; whoever starts its path replaces it.
   */
  private async agentIdConflict(target: LeaseTarget, agentId: string): Promise<AgentLeaseResult | null> {
    for (const [key, h] of this.held) {
      if (key !== target.key && h.record.agentId === agentId) {
        return this.agentIdRefusal(target, agentId, h.file, h.record, true)
      }
    }
    let names: string[]
    try { names = await fsp.readdir(this.dir) } catch { return null }
    for (const name of names) {
      const m = /^([0-9a-f]{64})\.json$/.exec(name)
      if (!m || m[1] === target.key || this.held.has(m[1])) continue
      const file = join(this.dir, name)
      let record: AgentLeaseRecord | null = null
      try { record = (await readLease(file))?.record ?? null } catch { continue }
      if (!record || record.agentId !== agentId || record.holder.runtimeId === this.runtimeId) continue
      const liveness = await holderLiveness(record.holder, this.dir)
      if (!liveness.alive) continue
      return this.agentIdRefusal(target, agentId, file, record, false, liveness.otherMachine)
    }
    return null
  }

  private agentIdRefusal(target: LeaseTarget, agentId: string, leaseFile: string, record: AgentLeaseRecord, ownProcess: boolean, otherMachine = false): AgentLeaseResult {
    const message = agentIdLeasedMessage(target.canonical, agentId, record, ownProcess, otherMachine)
    console.warn(`[AgentLease] ${message}`)
    return { ok: false, code: AGENT_LEASED_CODE, leaseFile, record, message }
  }

  /** Can a fresh file be created in the lease dir? Tells a delete-pending lease from an unusable dir. */
  private async dirWritable(): Promise<boolean> {
    const probe = join(this.dir, `.${this.runtimeId}-${randomBytes(4).toString('hex')}.probe`)
    try {
      await fsp.writeFile(probe, '', { flag: 'wx', mode: FILE_MODE })
      await fsp.rm(probe, { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * The lease dir refused a write: proceed without a lease and say so. The
   * dir is remembered as unusable for a minute (`remember`), so the next
   * starts skip it instead of retrying.
   */
  private unprotected(name: string, target: LeaseTarget, reason: string, remember: boolean): AgentLeaseResult {
    const message = `Agent leases unavailable: ${this.dir} cannot be written (${reason}). ` +
      `${name} runs without protection against a second ADF Studio or daemon on this machine running it.`
    if (remember) {
      this.unusable = { reason, at: Date.now() }
      console.error(`[AgentLease] ${message}`)
    }
    return { ok: true, leaseFile: target.file, unprotected: message }
  }

  /** Our lease file should exist and name us. Recreate it if it was deleted. */
  private async verifyOwn(target: LeaseTarget, own: HeldLease): Promise<void> {
    try {
      const current = await readLease(own.file)
      if (!current) {
        await fsp.mkdir(this.dir, { recursive: true, mode: DIR_MODE })
        await fsp.writeFile(own.file, JSON.stringify(own.record, null, 2), { flag: 'wx', mode: FILE_MODE })
        console.warn(`[AgentLease] ${agentNameOf(target.canonical)}: lease file was missing; recreated`)
      } else if (current.record && current.record.holder.runtimeId !== this.runtimeId) {
        console.warn(`[AgentLease] ${agentNameOf(target.canonical)}: lease file now names ${describeHolder(current.record.holder)} while this process runs the agent`)
      }
    } catch (err) {
      console.warn(`[AgentLease] ${agentNameOf(target.canonical)}: could not verify the lease:`, err)
    }
  }

  /**
   * Replace a lease judged stale (its bytes were `expectedRaw`) with ours,
   * under the takeover lock. Under the lock the lease is re-read: it is
   * removed only if it still holds exactly those bytes, and ours is written
   * exclusively (a plain acquirer that slipped in wins; the caller then
   * re-evaluates). Returns true when our lease was written.
   */
  private async takeOver(file: string, expectedRaw: string, body: string): Promise<boolean> {
    const lock = `${file}.takeover`
    if (!(await this.lockTakeover(lock))) return false
    try {
      let current: string | null = null
      try { current = await fsp.readFile(file, 'utf-8') } catch (err) {
        if (errCode(err) !== 'ENOENT') return false
      }
      if (current !== null && current !== expectedRaw) return false
      await this.beforeTakeoverReplace?.()
      // Re-verify right before the unlink: replace only the exact bytes judged stale.
      try { current = await fsp.readFile(file, 'utf-8') } catch (err) {
        if (errCode(err) !== 'ENOENT') return false
        current = null
      }
      if (current !== null && current !== expectedRaw) return false
      if (current !== null) await fsp.rm(file, { force: true })
      // A reader that still has the old file open leaves it delete-pending
      // for a moment (Windows): retry the exclusive create briefly.
      for (let attempt = 0; ; attempt++) {
        try {
          await fsp.writeFile(file, body, { flag: 'wx', mode: FILE_MODE })
          return true
        } catch (err) {
          const code = errCode(err)
          if (code === 'EEXIST') return false
          if (!code || !TRANSIENT_FS_CODES.has(code) || attempt >= 20) throw err
          await delay(10)
        }
      }
    } catch (err) {
      console.warn(`[AgentLease] Takeover of ${file} failed:`, err instanceof Error ? err.message : err)
      return false
    } finally {
      await unlockTakeover(lock)
    }
  }

  /**
   * Create `<lease>.takeover` exclusively. A lock left by a crash (its pid
   * gone, or older than the TTL, while the critical section takes
   * milliseconds) is removed.
   */
  private async lockTakeover(lock: string): Promise<boolean> {
    const deadline = Date.now() + TAKEOVER_LOCK_WAIT_MS
    // A live holder is probed again only every TAKEOVER_LOCK_REPROBE_MS, not
    // on every retry: a holder whose event loop is blocked accepts no probe,
    // each one waits in its socket's accept queue, and macOS refuses
    // connections once that queue is full (ECONNREFUSED, which reads as a
    // dead holder). Often enough to see a holder that died during the wait.
    const judged = new Map<string, { state: 'live' | 'dead' | 'unknown'; at: number }>()
    while (Date.now() < deadline) {
      try {
        await fsp.writeFile(lock, JSON.stringify({ pid: this.pid, runtimeId: this.runtimeId, endpoint: this.endpoint, machineId: this.machineIdValue, at: Date.now() }), { flag: 'wx', mode: FILE_MODE })
        return true
      } catch (err) {
        const code = errCode(err)
        if (code && TRANSIENT_FS_CODES.has(code)) { await delay(5); continue } // previous lock delete-pending
        if (code !== 'EEXIST') return false
      }
      try {
        // The critical section takes milliseconds: only an older lock is
        // opened to read its pid (an open handle would delay its removal).
        const st = await fsp.stat(lock)
        const age = Date.now() - st.mtimeMs
        if (age > TAKEOVER_LOCK_SUSPECT_MS) {
          const raw = await fsp.readFile(lock, 'utf-8')
          const last = judged.get(raw)
          const fresh = last && (last.state !== 'live' || Date.now() - last.at < TAKEOVER_LOCK_REPROBE_MS)
          const state = fresh ? last.state : await this.lockHolderState(raw)
          if (!fresh) judged.set(raw, { state, at: Date.now() })
          // A live holder keeps its lock however long it stalls or blocks;
          // the TTL is only for a lock without a readable pid.
          if (state === 'dead' || (state === 'unknown' && age > this.takeoverLockTtlMs)) {
            // Several takers may judge one crashed lock: remove it only if it
            // still holds the bytes judged (another taker's fresh lock stays).
            if ((await fsp.readFile(lock, 'utf-8')) === raw) {
              console.warn(`[AgentLease] Removing a takeover lock left by a ${state === 'dead' ? 'crashed' : 'stuck'} process: ${lock}`)
              await fsp.rm(lock, { force: true })
            }
            continue
          }
        }
      } catch { /* released meanwhile */ }
      await delay(5 + Math.floor(Math.random() * 15))
    }
    return false
  }

  /**
   * Who holds a takeover lock: 'dead' (pid gone, endpoint missing or
   * refusing) is removed; 'live' (anything else while the pid runs,
   * including a probe timeout) never expires; 'unknown' (no readable pid,
   * e.g. a crash between create and write) waits for the TTL.
   */
  private async lockHolderState(raw: string): Promise<'live' | 'dead' | 'unknown'> {
    let holder: { pid?: unknown; runtimeId?: unknown; endpoint?: unknown; machineId?: unknown }
    try { holder = JSON.parse(raw) } catch { return 'unknown' }
    const pid = Number(holder.pid)
    const rec = {
      pid,
      runtimeId: typeof holder.runtimeId === 'string' ? holder.runtimeId : '',
      endpoint: typeof holder.endpoint === 'string' ? holder.endpoint : null,
      machineId: typeof holder.machineId === 'string' ? holder.machineId : null,
    }
    if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
    if (await fromOtherMachine(rec)) return 'live'
    if (!(await pidAlive(pid))) return 'dead'
    const endpoint = trustedEndpoint(rec, this.dir)
    if (!endpoint) return 'live'
    const probe = await probeEndpoint(endpoint)
    return probeProvesDead(endpoint, probe, this.dir) ? 'dead' : 'live'
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
    return join(this.dir, this.clientMode ? 'clients' : 'hosts', `${this.pid}.json`)
  }

  /** This runtime's host record (`hosts/<pid>.json`). */
  get hostEntryFile(): string {
    return this.entryFile()
  }

  /**
   * services/compute-users.ts: record the containers this runtime uses in
   * its host record. Rejects when the record cannot be written.
   */
  setContainers(names: string[]): Promise<void> {
    this.containers = [...new Set(names)].sort()
    const run = this.ensureReady(false).then(() => this.writeEntryOrThrow())
    this.ready = run.catch(() => {})
    return run
  }

  /** Refresh the host record's mtime (compute-users heartbeat). Rejects when it is gone. */
  async touchEntry(): Promise<void> {
    const now = new Date()
    await fsp.utimes(this.entryFile(), now, now)
  }

  private ensureReady(rewriteEntry: boolean): Promise<void> {
    if (!this.ready) {
      let lookup: Promise<string | null> | undefined
      this.ready = this.startEndpoint()
        .then(async () => {
          if (this.machineIdOverride !== undefined) { this.machineIdValue = this.machineIdOverride; return }
          lookup = machineId()
          this.machineIdValue = await machineIdWithin()
        })
        .then(() => this.writeEntry())
        .then(() => this.scheduleMachineIdRetry(lookup))
    } else if (rewriteEntry) {
      this.ready = this.ready.then(() => this.writeEntry())
    }
    return this.ready
  }

  /**
   * The machine id was not read when the host record was first written: wait
   * for the lookup still running (`pending`), else, after a failed lookup,
   * ask again every MACHINE_ID_RETRY_MS (15 s), and once read rewrite the
   * host record and every lease this process holds. A platform with no
   * machine id at all is not asked again. A record without a machine id is judged
   * by the reader's own pids, so a runtime on another machine sharing the
   * lease folder could take a live agent from this one.
   */
  private scheduleMachineIdRetry(pending?: Promise<string | null>): void {
    if (this.machineIdValue || this.machineIdOverride !== undefined || this.machineIdRetry || !this.ready) return
    const settle = (lookup: Promise<string | null>): void => {
      void lookup.then(async (id) => {
        if (!this.ready || this.machineIdValue) return // closed meanwhile, or already stamped
        if (!id) { if (machineIdLookupFailed()) this.scheduleMachineIdRetry(); return }
        this.machineIdValue = id
        await this.stampMachineId(id)
      })
    }
    if (pending) { settle(pending); return }
    this.machineIdRetry = setTimeout(() => {
      this.machineIdRetry = null
      settle(machineId())
    }, machineIdRetryMs)
    this.machineIdRetry.unref?.()
  }

  /** Write `id` into the host record and into every held lease that still names this runtime. */
  private async stampMachineId(id: string): Promise<void> {
    if (this.ready) await this.ensureReady(true)
    let leases = 0
    for (const [key, entry] of [...this.held]) {
      await this.withKey(key, async () => {
        if (this.held.get(key) === entry && await this.stampLease(entry, id)) leases++
      })
    }
    console.log(`[AgentLease] Read this machine's id late; added it to the host record and ${leases} held lease(s)`)
  }

  /**
   * Rewrite one held lease with machine id `id`. The caller holds the key's
   * chain. The read and the write run under the lease's takeover lock, and
   * only a lease that still names this runtime is rewritten: a taker that
   * judged it stale and replaced it keeps its own.
   */
  private async stampLease(entry: HeldLease, id: string): Promise<boolean> {
    const lock = `${entry.file}.takeover`
    try {
      if (!(await this.lockTakeover(lock))) return false
    } catch (err) {
      console.warn(`[AgentLease] ${agentNameOf(entry.record.path)}: could not add the machine id to its lease:`, err instanceof Error ? err.message : err)
      return false
    }
    try {
      const current = await readLease(entry.file)
      if (!current?.record || current.record.holder.runtimeId !== this.runtimeId) return false
      const record: AgentLeaseRecord = { ...current.record, holder: { ...current.record.holder, machineId: id } }
      await writeAtomic(entry.file, JSON.stringify(record, null, 2))
      entry.record = record
      return true
    } catch (err) {
      console.warn(`[AgentLease] ${agentNameOf(entry.record.path)}: could not add the machine id to its lease:`, err instanceof Error ? err.message : err)
      return false
    } finally {
      await unlockTakeover(lock)
    }
  }

  private async startEndpoint(): Promise<void> {
    let endpoint: string
    if (process.platform === 'win32') {
      endpoint = pipeName(this.runtimeId)
    } else {
      endpoint = join(this.dir, 'hosts', `${this.runtimeId}.sock`)
      if (endpoint.length > MAX_SOCKET_PATH) endpoint = join(tmpdir(), `adf-runtime-${this.runtimeId}.sock`)
    }
    try {
      if (process.platform !== 'win32') await fsp.mkdir(join(this.dir, 'hosts'), { recursive: true, mode: DIR_MODE })
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
    try {
      await this.writeEntryOrThrow()
    } catch (err) {
      console.warn(`[AgentLease] Could not write the runtime host entry in ${this.dir}:`, err instanceof Error ? err.message : err)
    }
  }

  private async writeEntryOrThrow(): Promise<void> {
    const kind = this.clientMode ? 'studio-client' : this.info.kind
    // A Studio switching between modes must not leave the other entry behind.
    const other = join(this.dir, this.clientMode ? 'hosts' : 'clients', `${this.pid}.json`)
    this.unlinkIfOwnSync(other)
    const entry: RuntimeHostRecord = {
      v: 1,
      ...this.holder(),
      kind,
      mode: this.clientMode ?? this.info.mode,
      ...(this.clientMode ? {} : { containers: this.containers }),
    }
    await fsp.mkdir(join(this.dir, this.clientMode ? 'clients' : 'hosts'), { recursive: true, mode: DIR_MODE })
    await writeAtomic(this.entryFile(), JSON.stringify(entry, null, 2))
    this.hostEntryWritten = true
    this.installExitHook()
    if (this.sweepEntries) void sweepDeadEntries(this.dir, this.pid).catch(() => {})
  }

  private async removeOwnEntries(): Promise<void> {
    for (const sub of ['hosts', 'clients']) this.unlinkIfOwnSync(join(this.dir, sub, `${this.pid}.json`))
    this.hostEntryWritten = false
  }
}

/** Parse a host/client record; null when it is not one. */
export function parseHostRecord(raw: string): RuntimeHostRecord | null {
  try {
    const record = JSON.parse(raw) as RuntimeHostRecord
    if (record?.v !== 1 || typeof record.pid !== 'number' || typeof record.runtimeId !== 'string') return null
    if (record.containers !== undefined && !(Array.isArray(record.containers) && record.containers.every((c) => typeof c === 'string'))) return null
    return record
  } catch {
    return null
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
      const record = parseHostRecord(raw)
      if (record) out.push({ file, raw, record })
    } catch { /* partial or foreign file */ }
  }
  return out
}

/** Remove host/client entries of processes that are definitely gone (never another machine's). */
async function sweepDeadEntries(dir: string, ownPid: number): Promise<void> {
  for (const sub of ['hosts', 'clients']) {
    for (const { file, raw, record } of await readEntries(join(dir, sub))) {
      if (record.pid === ownPid) continue
      if ((await holderLiveness(record, dir)).alive) continue
      try {
        if ((await fsp.readFile(file, 'utf-8')) === raw) await fsp.rm(file, { force: true })
      } catch { /* gone */ }
    }
  }
}

export interface LiveRuntimeHost extends RuntimeHostRecord { alive: boolean }

/** Runtime hosts (embedded Studio, daemons) on this machine, with liveness. */
export async function listRuntimeHosts(dir: string = leaseDir()): Promise<LiveRuntimeHost[]> {
  return listEntries(dir, 'hosts')
}

/** Studio instances running in local or remote mode (clients, not hosts). */
export async function listStudioClients(dir: string = leaseDir()): Promise<LiveRuntimeHost[]> {
  return listEntries(dir, 'clients')
}

async function listEntries(dir: string, sub: 'hosts' | 'clients'): Promise<LiveRuntimeHost[]> {
  const entries = await readEntries(join(dir, sub))
  return Promise.all(entries.map(async ({ record }) => ({
    ...record,
    alive: record.pid === process.pid ? true : (await holderLiveness(record, dir)).alive,
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

/** Tests: release and forget the process registry, if one was created. */
export async function resetProcessAgentLeases(): Promise<void> {
  const registry = processRegistry
  processRegistry = null
  await registry?.close()
}
