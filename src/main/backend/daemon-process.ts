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
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  isHealthy,
  processAlive as defaultProcessAlive,
  readPidFile,
  tailLines,
  type DaemonPaths,
} from '../cli/daemon-control'
import { readDaemonToken } from '../daemon/daemon-token'
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
}

export type DaemonDetection =
  /** Nothing answers and no live pid in the pid file. */
  | { state: 'absent' }
  /** The pid file names a live process that does not answer /health yet (starting, stuck, or shutting down). */
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
  env[DAEMON_STARTED_BY_ENV] = 'studio' satisfies DaemonStartedBy
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
  }

  /** The token of the daemon on Studio's data dir: ADF_DAEMON_TOKEN, else `<data dir>/daemon-token`. */
  private token(): string | null {
    return this.env.ADF_DAEMON_TOKEN || readDaemonToken(this.paths.dataDir)
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 3000): Promise<Response> {
    const token = this.token()
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
      const message = version.status === 401
        ? `A daemon answers on ${this.url} but does not accept the access token in ${this.paths.dataDir}; it runs on other settings.`
        : version.status === 404
          ? `A daemon answers on ${this.url} but has no GET /version; it is an older ADF build.`
          : `A daemon answers on ${this.url} but GET /version failed (${version.status ?? 'no answer'}).`
      return { state: 'unidentified', status: version.status, message }
    }
    const record = readPidFile(this.paths.pidFile)
    if (record && this.alive(record.pid)) return { state: 'starting', pid: record.pid }
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
      const up = await this.waitHealthy(() => this.alive(pid))
      if (!up && this.alive(pid)) {
        throw new DaemonProcessError(`The ADF daemon (pid ${pid}) did not answer ${this.url}/health within ${this.startTimeoutMs / 1000}s.`, this.paths.logFile)
      }
      detection = await this.detect()
    }
    if (detection.state === 'unidentified') {
      this.log(`[DaemonProcess] ${detection.message}`)
      return { kind: 'unidentified', message: detection.message }
    }
    if (detection.state === 'running') return this.attachOrRefuse(detection.info, 'attached')
    const handle = await this.spawn(onProgress)
    return this.attachOrRefuse(handle.info, 'spawned')
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

  /** §8.1, §8.2 step 5: spawn the daemon and wait for /health and /version. */
  async spawn(onProgress?: (text: string) => void): Promise<DaemonHandle> {
    const { paths } = this
    await mkdir(dirname(paths.logFile), { recursive: true })
    const env = buildDaemonEnv(this.env, {
      settingsPath: this.config.settingsPath,
      pidFile: paths.pidFile,
      port: this.port,
      userDataDir: this.config.userDataDir,
    })
    this.log(`[DaemonProcess] Starting the ADF daemon: ${this.config.execPath} ${this.config.daemonEntry} on ${this.url} (settings ${this.config.settingsPath}, log ${paths.logFile})`)
    onProgress?.('Starting the ADF daemon…')
    const started = Date.now()
    const log = await open(paths.logFile, 'a')
    let child: ReturnType<SpawnFn>
    try {
      child = this.spawnFn(this.config.execPath, [this.config.daemonEntry], {
        cwd: paths.dataDir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env,
      })
    } finally {
      // The child holds its own copy of the descriptor.
      await log.close()
    }
    let exited: number | null = null
    let spawnError: Error | null = null
    child.once('exit', (code: number | null) => { exited = code ?? -1 })
    child.once('error', (err: Error) => { spawnError = err })
    child.unref()
    const pid = child.pid ?? -1
    const up = await this.waitHealthy(() => exited === null && spawnError === null)
    if (!up) {
      const tail = tailLines(paths.logFile, 15)
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
      throw new DaemonProcessError(`The ADF daemon started (pid ${pid}) but GET /version failed (${version.status ?? 'no answer'}).`, paths.logFile)
    }
    this.spawnedPid = version.info.pid
    this.log(`[DaemonProcess] ADF daemon running (pid ${version.info.pid}, ${((Date.now() - started) / 1000).toFixed(1)}s)`)
    return { url: this.url, pid: version.info.pid, info: version.info, spawnedHere: true }
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

  private async waitHealthy(alive: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs
    while (Date.now() < deadline) {
      if (await isHealthy(this.url, this.fetchImpl, 1000)) return true
      if (!alive()) return false
      await this.sleep(POLL_MS)
    }
    return false
  }
}
