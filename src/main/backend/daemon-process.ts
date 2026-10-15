// Studio's control over a local ADF daemon process (design daemon-backend.md
// §8.1, §8.2): find one, decide whether to attach, spawn one, stop one.
//
// Studio and the CLI share one daemon per settings file: Studio spawns
// out/main/daemon.js with its own executable in Node mode
// (ELECTRON_RUN_AS_NODE=1), detached and without a console window, on the
// CLI's pid file and log paths (cli/daemon-control.ts daemonPaths), so
// `adf daemon status|stop|logs` see the daemon Studio started and Studio
// finds the one the CLI started.
//
// Studio never stops a daemon it did not start: stop() asks the running
// daemon who launched it (GET /version `startedBy`) and refuses unless the
// answer is `studio` and the pid is the one this handle attached to. A CLI or
// service daemon keeps running whatever Studio does. Every action is logged.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { uptime as osUptime } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  isHealthy,
  processAlive as defaultProcessAlive,
  type DaemonPaths,
} from '../cli/daemon-control'
import { daemonTokenPath } from '../daemon/daemon-token'
import { LOCAL_PROOF_HEADER, readLocalProof } from '../daemon/local-access'
import {
  CLIENT_API_VERSION,
  DAEMON_STARTED_BY_ENV,
  type DaemonStartedBy,
  type DaemonVersionInfo,
} from '../daemon/routes/meta-routes'

/** Same budget as `adf daemon start` (cli/daemon-control.ts). */
const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 30_000
const POLL_MS = 250
/**
 * How long a live pid from the pid file may stay silent before the record is
 * treated as stale: the daemon's bounded shutdown (20 s, daemon/index.ts) plus
 * margin. The pid file is written only after the daemon listens.
 */
const STALE_PID_WAIT_MS = 25_000
/** After losing a start race, how long the winning daemon gets to answer. */
const RACE_SETTLE_MS = 3_000

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'pid' | 'once' | 'unref'>

export interface DaemonProcessConfig {
  /** Studio's settings file; the daemon runs on the same one. */
  settingsPath: string
  /** Studio's userData directory, passed as ADF_USER_DATA_DIR so the daemon's other stores match Studio's. */
  userDataDir?: string
  /** Default: ADF_DAEMON_PORT, else 7385. */
  port?: number
  /** out/main/daemon.js next to Studio's main bundle. */
  daemonEntry: string
  /** The executable that runs daemonEntry: Studio's own (process.execPath). */
  execPath: string
  /** Base environment of the child (default process.env). See buildDaemonEnv. */
  env?: NodeJS.ProcessEnv
}

export interface DaemonProcessDeps {
  spawn?: SpawnFn
  fetch?: typeof fetch
  processAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  startTimeoutMs?: number
  stopTimeoutMs?: number
  staleWaitMs?: number
  raceSettleMs?: number
}

export type DaemonDetection =
  /** Nothing answers and no live pid in the pid file. */
  | { state: 'absent' }
  /**
   * The pid file names a live process that does not answer /health: shutting
   * down, stuck, or a reused pid (the daemon writes the file after it listens).
   */
  | { state: 'starting'; pid: number }
  | { state: 'running'; info: DaemonVersionInfo }
  /**
   * Something answers /health but not /version with this data dir's token:
   * a daemon on another settings file (other token), or a build without /version.
   */
  | { state: 'unidentified'; status: number | null; message: string }

export type AttachDecision =
  | { kind: 'attach' }
  | { kind: 'settings-mismatch'; daemonSettingsPath: string | null; message: string }
  | { kind: 'version-mismatch'; daemonVersion: string; daemonClientApiVersion: number; message: string }

export interface DaemonHandle {
  url: string
  pid: number
  info: DaemonVersionInfo
  /** True when this controller spawned the process in this Studio run. */
  spawnedHere: boolean
}

export type EnsureResult =
  | { kind: 'attached'; handle: DaemonHandle }
  | { kind: 'spawned'; handle: DaemonHandle }
  | { kind: 'refused'; decision: Exclude<AttachDecision, { kind: 'attach' }>; info: DaemonVersionInfo }
  | { kind: 'unidentified'; message: string }

export interface DaemonStopResult {
  stopped: boolean
  message: string
}

export class DaemonProcessError extends Error {
  constructor(message: string, readonly logFile?: string) { super(message) }
}

/**
 * The environment of a Studio-spawned daemon: Studio's own minus anything
 * that configures Electron or Studio's Node (ELECTRON_*, NODE_OPTIONS), plus
 * the daemon's location variables. Studio adds no token, key or other
 * secret; whatever the user put in Studio's environment (ADF_DAEMON_TOKEN,
 * provider variables) reaches the daemon as it would `adf daemon`.
 */
export function buildDaemonEnv(base: NodeJS.ProcessEnv, opts: {
  settingsPath: string
  pidFile: string
  port: number
  userDataDir?: string
  /** Who the daemon run counts as started by (GET /version). Default `studio`; a restart keeps the replaced run's. */
  startedBy?: DaemonStartedBy
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (/^ELECTRON_/i.test(key)) continue
    if (/^NODE_OPTIONS$/i.test(key)) continue
    if (/^ADF_DAEMON_(PORT|HOST|SETTINGS|PIDFILE|STARTED_BY)$/i.test(key)) continue
    env[key] = value
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  env.ADF_DAEMON_PORT = String(opts.port)
  env.ADF_DAEMON_HOST = '127.0.0.1'
  env.ADF_DAEMON_SETTINGS = opts.settingsPath
  env.ADF_DAEMON_PIDFILE = opts.pidFile
  env[DAEMON_STARTED_BY_ENV] = opts.startedBy ?? ('studio' satisfies DaemonStartedBy)
  if (opts.userDataDir) env.ADF_USER_DATA_DIR = opts.userDataDir
  return env
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p)
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** §8.2 steps 2-4: attach only to a daemon on Studio's settings file that speaks Studio's client API. */
export function decideAttach(info: DaemonVersionInfo, expected: { settingsPath: string; clientApiVersion?: number }): AttachDecision {
  const clientApiVersion = expected.clientApiVersion ?? CLIENT_API_VERSION
  if (!info.settingsPath || !samePath(info.settingsPath, expected.settingsPath)) {
    return {
      kind: 'settings-mismatch',
      daemonSettingsPath: info.settingsPath,
      message: `The ADF daemon running on this machine (pid ${info.pid}) uses ${info.settingsPath ?? 'in-memory settings'}, not ${expected.settingsPath}.`,
    }
  }
  if (info.clientApiVersion !== clientApiVersion) {
    return {
      kind: 'version-mismatch',
      daemonVersion: info.version,
      daemonClientApiVersion: info.clientApiVersion,
      message: `The running ADF daemon (version ${info.version}, client API ${info.clientApiVersion}) does not match this Studio (client API ${clientApiVersion}).`,
    }
  }
  return { kind: 'attach' }
}

export class DaemonProcessController {
  readonly url: string
  readonly port: number
  readonly paths: DaemonPaths
  private readonly config: DaemonProcessConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly spawnFn: SpawnFn
  private readonly fetchImpl: typeof fetch
  private readonly alive: (pid: number) => boolean
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private readonly startTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly staleWaitMs: number
  private readonly raceSettleMs: number
  private spawnedPid: number | null = null

  constructor(config: DaemonProcessConfig, deps: DaemonProcessDeps = {}) {
    this.config = config
    this.env = config.env ?? process.env
    this.port = config.port ?? (Number(this.env.ADF_DAEMON_PORT) || DEFAULT_DAEMON_PORT)
    this.url = `http://127.0.0.1:${this.port}`
    this.paths = daemonPaths(this.port, { ...this.env, ADF_DAEMON_SETTINGS: config.settingsPath })
    this.spawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn)
    this.fetchImpl = deps.fetch ?? fetch
    this.alive = deps.processAlive ?? defaultProcessAlive
    this.sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
    this.log = deps.log ?? ((line) => console.log(line))
    this.startTimeoutMs = deps.startTimeoutMs ?? START_TIMEOUT_MS
    this.stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS
    this.staleWaitMs = deps.staleWaitMs ?? STALE_PID_WAIT_MS
    this.raceSettleMs = deps.raceSettleMs ?? RACE_SETTLE_MS
  }

  /** The token of the daemon on Studio's data dir: ADF_DAEMON_TOKEN, else `<data dir>/daemon-token`. */
  private async token(): Promise<string | null> {
    if (this.env.ADF_DAEMON_TOKEN) return this.env.ADF_DAEMON_TOKEN
    try {
      const raw = (await readFile(daemonTokenPath(this.paths.dataDir), 'utf-8')).trim()
      // Same shape check as daemon-token.ts readDaemonToken (sync there).
      return /^[A-Za-z0-9_-]{32,}$/.test(raw) ? raw : null
    } catch {
      return null
    }
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 3000): Promise<Response> {
    const token = await this.token()
    return this.fetchImpl(`${this.url}${path}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /** GET /version: the info, or the HTTP status (null = no answer). */
  private async fetchVersion(): Promise<{ info: DaemonVersionInfo } | { status: number | null }> {
    try {
      const res = await this.request('/version')
      if (!res.ok) return { status: res.status }
      return { info: await res.json() as DaemonVersionInfo }
    } catch {
      return { status: null }
    }
  }

  /** §8.2 step 1: is a daemon on this port, and which one. */
  async detect(): Promise<DaemonDetection> {
    if (await isHealthy(this.url, this.fetchImpl)) {
      const version = await this.fetchVersion()
      if ('info' in version) return { state: 'running', info: version.info }
      const tokenSource = this.env.ADF_DAEMON_TOKEN ? 'ADF_DAEMON_TOKEN' : daemonTokenPath(this.paths.dataDir)
      const message = version.status === 401
        ? `A daemon is running on port ${this.port} but Studio cannot authenticate to it (token from ${tokenSource}).`
        : version.status === 404
          ? `A daemon is running on port ${this.port} but has no GET /version; it is an older ADF build.`
          : `A daemon is running on port ${this.port} but GET /version failed (${version.status ?? 'no answer'}).`
      return { state: 'unidentified', status: version.status, message }
    }
    const record = await readPidRecord(this.paths.pidFile)
    if (record && this.alive(record.pid)) {
      // A record from before this OS boot cannot be the same process, whatever
      // now runs under that pid (same rule as DaemonHost, which also removes it).
      const bootTimeMs = Date.now() - osUptime() * 1000
      if (record.startedAt !== undefined && record.startedAt < bootTimeMs) {
        this.log(`[DaemonProcess] Pid file ${this.paths.pidFile} predates this boot (pid ${record.pid} is another process); ignoring it`)
        return { state: 'absent' }
      }
      return { state: 'starting', pid: record.pid }
    }
    return { state: 'absent' }
  }

  /**
   * §8.2: attach to the daemon on Studio's settings, or spawn one when none
   * runs. A daemon on other settings or another client API version is never
   * restarted here; the caller shows the decision to the user.
   */
  async ensure(onProgress?: (text: string) => void): Promise<EnsureResult> {
    let detection = await this.detect()
    if (detection.state === 'starting') {
      const pid = detection.pid
      this.log(`[DaemonProcess] Waiting for the ADF daemon pid ${pid} to answer ${this.url}`)
      onProgress?.(`Waiting for the ADF daemon (pid ${pid})…`)
      const up = await this.waitHealthy(() => this.alive(pid), this.staleWaitMs)
      if (!up && this.alive(pid)) {
        // A daemon writes its pid file only once it listens, and its shutdown
        // is capped at 20 s: a live pid that stays silent this long is not a
        // working daemon (stuck, or Windows reused the pid). Remove the record
        // so a new daemon can start; if a stuck one still holds the port, the
        // new one fails with EADDRINUSE and the error names the log.
        this.log(`[DaemonProcess] Pid ${pid} from ${this.paths.pidFile} has not answered ${this.url} for ${this.staleWaitMs / 1000}s; treating the pid file as stale and removing it`)
        await rm(this.paths.pidFile, { force: true })
      }
      detection = await this.detect()
    }
    if (detection.state === 'unidentified') {
      this.log(`[DaemonProcess] ${detection.message}`)
      return { kind: 'unidentified', message: detection.message }
    }
    if (detection.state === 'running') return this.attachOrRefuse(detection.info, 'attached')
    const handle = await this.spawn(onProgress)
    return this.attachOrRefuse(handle.info, handle.spawnedHere ? 'spawned' : 'attached')
  }

  private attachOrRefuse(info: DaemonVersionInfo, kind: 'attached' | 'spawned'): EnsureResult {
    const decision = decideAttach(info, { settingsPath: this.config.settingsPath })
    if (decision.kind !== 'attach') {
      this.log(`[DaemonProcess] Not attaching: ${decision.message}`)
      return { kind: 'refused', decision, info }
    }
    this.log(`[DaemonProcess] ${kind === 'spawned' ? 'Started and attached to' : 'Attached to'} the ADF daemon pid ${info.pid} on ${this.url} (version ${info.version}, started by ${info.startedBy})`)
    return { kind, handle: { url: this.url, pid: info.pid, info, spawnedHere: this.spawnedPid === info.pid } }
  }

  /**
   * §8.1, §8.2 step 5: spawn the daemon and wait for /health and /version.
   * `spawnedHere` is true only when the daemon that answers is the child
   * spawned here: another start (CLI, a second Studio) can win the port.
   */
  async spawn(onProgress?: (text: string) => void, retried = false, startedBy: DaemonStartedBy = 'studio'): Promise<DaemonHandle> {
    const { paths } = this
    await mkdir(dirname(paths.logFile), { recursive: true })
    const env = buildDaemonEnv(this.env, {
      settingsPath: this.config.settingsPath,
      pidFile: paths.pidFile,
      port: this.port,
      userDataDir: this.config.userDataDir,
      startedBy,
    })
    this.log(`[DaemonProcess] Starting the ADF daemon: ${this.config.execPath} ${this.config.daemonEntry} on ${this.url} (settings ${this.config.settingsPath}, log ${paths.logFile})`)
    onProgress?.('Starting the ADF daemon…')
    const started = Date.now()
    const log = await open(paths.logFile, 'a')
    let child: ReturnType<SpawnFn>
    let exited: number | null = null
    let spawnError: Error | null = null
    try {
      child = this.spawnFn(this.config.execPath, [this.config.daemonEntry], {
        cwd: paths.dataDir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env,
      })
      // Before any await: a child that exits at once must not be missed (it would read as "did not answer").
      child.once('exit', (code: number | null) => { exited = code ?? -1 })
      child.once('error', (err: Error) => { spawnError = err })
    } finally {
      // The child holds its own copy of the descriptor.
      await log.close()
    }
    child.unref()
    const childPid = child.pid ?? -1
    const up = await this.waitHealthy(() => exited === null && spawnError === null)
    if (!up) {
      if (!spawnError && exited !== null) {
        // Lost a start race: a daemon that started at the same time took the
        // port or the pid file (EADDRINUSE / pid file conflict). Use that one,
        // also while it is still booting.
        const winner = await this.waitForRaceWinner(onProgress)
        if (winner) {
          this.log(`[DaemonProcess] The daemon Studio started (pid ${childPid}) exited (code ${exited}); ADF daemon pid ${winner.pid} (started by ${winner.startedBy}) answers on ${this.url} instead`)
          return { url: this.url, pid: winner.pid, info: winner, spawnedHere: false }
        }
        if (!retried) {
          // Nothing took over: the other start failed too, or ours crashed. One more try, then the error with the log.
          this.log(`[DaemonProcess] The daemon Studio started (pid ${childPid}) exited (code ${exited}) and no other ADF daemon answers ${this.url}; starting it once more`)
          return this.spawn(onProgress, true, startedBy)
        }
      }
      const tail = await tailFile(paths.logFile, 15)
      const reason = spawnError
        ? `The ADF daemon could not be started: ${(spawnError as Error).message}`
        : exited !== null
          ? `The ADF daemon exited during startup (code ${exited}).`
          : `The ADF daemon did not answer ${this.url}/health within ${this.startTimeoutMs / 1000}s.`
      this.log(`[DaemonProcess] ${reason} Log: ${paths.logFile}${tail ? `\n${tail}` : ''}`)
      throw new DaemonProcessError(reason, paths.logFile)
    }
    const version = await this.fetchVersion()
    if (!('info' in version)) {
      throw new DaemonProcessError(`The ADF daemon started (pid ${childPid}) but GET /version failed (${version.status ?? 'no answer'}).`, paths.logFile)
    }
    const info = version.info
    if (info.pid !== childPid) {
      // Another daemon bound the port first; the child exits on its own
      // (EADDRINUSE or the pid file check) and its reason is in the log.
      this.log(`[DaemonProcess] ADF daemon pid ${info.pid} (started by ${info.startedBy}) answered on ${this.url} before the one Studio started (pid ${childPid}); using it`)
      return { url: this.url, pid: info.pid, info, spawnedHere: false }
    }
    this.spawnedPid = childPid
    this.log(`[DaemonProcess] ADF daemon running (pid ${childPid}, ${((Date.now() - started) / 1000).toFixed(1)}s)`)
    return { url: this.url, pid: childPid, info, spawnedHere: true }
  }

  /**
   * After the child lost a start race: the daemon that won, once it answers.
   * A winner that is still booting writes its pid file only once it listens,
   * so this polls for up to the settle time, then waits for a pid it finds
   * (progress: "Waiting for the ADF daemon (pid N)…"). Null when none appears.
   */
  private async waitForRaceWinner(onProgress?: (text: string) => void): Promise<DaemonVersionInfo | null> {
    const deadline = Date.now() + this.raceSettleMs
    for (;;) {
      const found = await this.detect()
      if (found.state === 'running') return found.info
      if (found.state === 'unidentified') return null
      if (found.state === 'starting') {
        this.log(`[DaemonProcess] Waiting for the ADF daemon pid ${found.pid}, which won the start race, to answer ${this.url}`)
        onProgress?.(`Waiting for the ADF daemon (pid ${found.pid})…`)
        if (!await this.waitHealthy(() => this.alive(found.pid), this.staleWaitMs)) return null
        const version = await this.fetchVersion()
        return 'info' in version ? version.info : null
      }
      if (Date.now() >= deadline) return null
      await this.sleep(POLL_MS)
    }
  }

  /**
   * §8.2 step 3, the user's "Restart the daemon with Studio's version": stop
   * the daemon that answers now (whoever started it; the user chose this),
   * wait for it to exit, then start Studio's. Never called without that choice.
   */
  async restart(running: DaemonVersionInfo, onProgress?: (text: string) => void): Promise<EnsureResult> {
    this.log(`[DaemonProcess] Restarting the ADF daemon pid ${running.pid} (version ${running.version}, client API ${running.clientApiVersion}, started by ${running.startedBy}) with Studio's version, as the user chose`)
    onProgress?.(`Stopping the ADF daemon (pid ${running.pid})…`)
    try {
      const res = await this.request('/daemon/shutdown', { method: 'POST' }, 5000)
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new DaemonProcessError(`The running ADF daemon refused to stop: ${body?.error ?? `HTTP ${res.status}`}`, this.paths.logFile)
      }
    } catch (err) {
      if (err instanceof DaemonProcessError) throw err
      /* the connection may close while it shuts down */
    }
    const deadline = Date.now() + this.stopTimeoutMs
    while (this.alive(running.pid) || await isHealthy(this.url, this.fetchImpl, 800)) {
      if (Date.now() >= deadline) {
        throw new DaemonProcessError(`The ADF daemon pid ${running.pid} is still shutting down after ${this.stopTimeoutMs / 1000}s.`, this.paths.logFile)
      }
      await this.sleep(POLL_MS)
    }
    // The replacement counts as started by whoever started the one it replaces: a CLI user's daemon is not stopped by Studio's quit later.
    this.log(`[DaemonProcess] ADF daemon pid ${running.pid} stopped; starting Studio's (started by ${running.startedBy}, as the one it replaces)`)
    const handle = await this.spawn(onProgress, false, running.startedBy)
    return this.attachOrRefuse(handle.info, handle.spawnedHere ? 'spawned' : 'attached')
  }

  /** The clients connected to the running daemon (GET /client/sessions); null when it cannot say (an older daemon). */
  async listClientSessions(): Promise<Array<{ client: string; version: string }> | null> {
    try {
      const res = await this.request('/client/sessions')
      if (!res.ok) return null
      const body = await res.json() as { sessions?: Array<{ client: string; version: string }> }
      return Array.isArray(body.sessions) ? body.sessions : null
    } catch {
      return null
    }
  }

  /**
   * After a handover at an embedded boot (handover.ts): a daemon that keeps
   * running on Studio's settings re-reads the stores Studio moved credentials
   * out of (POST /client/reload-credentials, local-only, no secrets). Returns
   * what happened, for the log; never throws.
   */
  async notifyCredentialsMoved(): Promise<string> {
    try {
      const found = await this.detect()
      if (found.state !== 'running') return 'no ADF daemon runs on these settings'
      if (decideAttach(found.info, { settingsPath: this.config.settingsPath }).kind === 'settings-mismatch') return `the ADF daemon on ${this.url} uses other settings`
      const proof = readLocalProof(this.paths.dataDir, this.port)
      const res = await this.request('/client/reload-credentials', { method: 'POST', headers: proof ? { [LOCAL_PROOF_HEADER]: proof } : {} }, 10_000)
      if (!res.ok) return `the ADF daemon pid ${found.info.pid} answered HTTP ${res.status}`
      const body = await res.json() as { runtime?: { state?: string } | null }
      return `the ADF daemon pid ${found.info.pid} reloaded its credential stores (runtime identity ${body.runtime?.state ?? 'n/a'})`
    } catch (err) {
      return `the ADF daemon could not be asked to reload its credential stores: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /**
   * Graceful stop (POST /daemon/shutdown) of a daemon Studio started.
   * Refuses, and says why, when the daemon answering now is not the one in
   * `handle` or reports that something other than Studio launched it.
   */
  async stop(handle: DaemonHandle): Promise<DaemonStopResult> {
    const version = await this.fetchVersion()
    if (!('info' in version)) {
      if (this.alive(handle.pid)) {
        return this.result(false, `Not stopping the ADF daemon pid ${handle.pid}: it does not answer GET /version (${version.status ?? 'no answer'}).`)
      }
      return this.result(true, `The ADF daemon pid ${handle.pid} is not running.`)
    }
    const live = version.info
    if (live.pid !== handle.pid) {
      return this.result(false, `Not stopping the ADF daemon on ${this.url}: it is pid ${live.pid}, not the pid ${handle.pid} Studio attached to.`)
    }
    if (live.startedBy !== 'studio') {
      return this.result(false, `Not stopping the ADF daemon pid ${live.pid}: it was started by ${live.startedBy}, not Studio.`)
    }
    this.log(`[DaemonProcess] Stopping the ADF daemon pid ${live.pid} (started by Studio)`)
    try {
      const res = await this.request('/daemon/shutdown', { method: 'POST' }, 5000)
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        return this.result(false, `The ADF daemon refused to stop: ${body?.error ?? `HTTP ${res.status}`}`)
      }
    } catch { /* the connection may close while it shuts down */ }
    const deadline = Date.now() + this.stopTimeoutMs
    while (Date.now() < deadline) {
      if (!this.alive(live.pid) && !await isHealthy(this.url, this.fetchImpl, 800)) {
        return this.result(true, `ADF daemon pid ${live.pid} stopped.`)
      }
      await this.sleep(POLL_MS)
    }
    return this.result(false, `The ADF daemon pid ${live.pid} is still shutting down after ${this.stopTimeoutMs / 1000}s. Log: ${this.paths.logFile}`)
  }

  private result(stopped: boolean, message: string): DaemonStopResult {
    this.log(`[DaemonProcess] ${message}`)
    return { stopped, message }
  }

  private async waitHealthy(alive: () => boolean, budgetMs = this.startTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (await isHealthy(this.url, this.fetchImpl, 1000)) return true
      if (!alive()) return false
      await this.sleep(POLL_MS)
    }
    return false
  }
}

interface PidRecord { pid: number; startedAt?: number }

/** The CLI pid file (cli/daemon-control.ts readPidFile), read without blocking. */
async function readPidRecord(file: string): Promise<PidRecord | null> {
  try {
    const raw = (await readFile(file, 'utf-8')).trim()
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown }
      return typeof parsed.pid === 'number' ? { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined } : null
    }
    const pid = Number.parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? { pid } : null
  } catch {
    return null
  }
}

/** The last `count` lines of a log file (at most its last 64 KiB). */
async function tailFile(file: string, count: number): Promise<string> {
  try {
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      const len = Math.min(size, 64 * 1024)
      const buf = Buffer.alloc(len)
      await handle.read(buf, 0, len, size - len)
      return buf.toString('utf-8').split(/\r?\n/).filter(Boolean).slice(-count).join('\n')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}
