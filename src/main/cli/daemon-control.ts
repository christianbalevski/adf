// Running the daemon for the user: auto-start in the background when `adf`
// needs a local daemon that is not up, and `adf daemon start|status|stop|
// restart|logs`. The daemon itself stays `adf daemon` (foreground).
//
// Background daemon = detached process (own process group / session, no
// console window on Windows) that outlives the terminal, stdout+stderr
// appended to a log file and a pid file in the daemon's data directory (next
// to its settings). Stopping is graceful (POST /daemon/shutdown, the same
// bounded teardown as Ctrl+C, which also stops shared compute containers):
// never a hard kill by default.

import { spawn, execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DAEMON_PORT, DEFAULT_DAEMON_URL, isLocalDaemonUrl, localProofHeaders, resolveDaemonToken } from './daemon-url'
import { defaultUserDataPath } from '../utils/user-data-path'

export { DEFAULT_DAEMON_PORT }
const DEFAULT_MESH_PORT = 7295
const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 30_000

export interface DaemonTarget {
  url: string
  host: string
  port: number
  loopback: boolean
}

export function daemonTarget(url: string): DaemonTarget {
  let host = '127.0.0.1'
  let port = DEFAULT_DAEMON_PORT
  try {
    const parsed = new URL(url)
    host = parsed.hostname.replace(/^\[|\]$/g, '')
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch { /* keep defaults */ }
  return { url: url.replace(/\/+$/, ''), host, port, loopback: isLoopbackHost(host) }
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

export interface DaemonPaths {
  /** The daemon's data directory (next to its settings file). */
  dataDir: string
  settingsFile: string
  pidFile: string
  logFile: string
  /** True when settings / data were redirected (ADF_DAEMON_SETTINGS, ADF_USER_DATA_DIR). */
  custom: boolean
}

/** Where a daemon on `port` keeps its settings, pid file and log (same rules as daemon/index.ts). */
export function daemonPaths(port: number, env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const settingsFile = env.ADF_DAEMON_SETTINGS ?? join(defaultUserDataPath({ quiet: true }), 'adf-settings.json')
  const dataDir = dirname(settingsFile)
  const suffix = port === DEFAULT_DAEMON_PORT ? '' : `-${port}`
  return {
    dataDir,
    settingsFile,
    pidFile: env.ADF_DAEMON_PIDFILE ?? join(dataDir, `adf-daemon${suffix}.pid`),
    logFile: join(dataDir, 'logs', `adf-daemon${suffix}.log`),
    custom: !!(env.ADF_DAEMON_SETTINGS || env.ADF_USER_DATA_DIR),
  }
}

export async function isHealthy(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export interface PidRecord { pid: number; startedAt?: number }

export function readPidFile(file: string): PidRecord | null {
  try {
    const raw = readFileSync(file, 'utf-8').trim()
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

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0) } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM' }
  // kill(pid, 0) succeeds for a zombie (exited, not yet reaped); on Linux read
  // its state so an exited daemon is not taken for a starting one.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false
    } catch { /* no /proc entry: fall through */ }
  }
  return true
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown> } catch { return null }
}

/**
 * ADF Studio (or another runtime on the same settings) is running while the
 * daemon is not: starting a daemon would run the same agents from the same
 * files twice. Detection is deliberately small: the mesh server of a runtime
 * on these settings answers /ping with our runtime_id, or (default settings
 * only) an `ADF Studio` process is running. Returns what to tell the user.
 */
export async function studioConflict(paths: DaemonPaths, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const settings = readJson(paths.settingsFile) ?? {}
  const meshPort = Number(env.MESH_PORT) || (typeof settings.meshPort === 'number' ? settings.meshPort : DEFAULT_MESH_PORT)
  const runtimeId = typeof settings.runtimeId === 'string' ? settings.runtimeId : null
  if (runtimeId) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${meshPort}/ping`, { signal: AbortSignal.timeout(800) })
      const body = res.ok ? await res.json() as { runtime_id?: unknown } : null
      if (body?.runtime_id === runtimeId) {
        return `Another ADF runtime on the same settings is already running (its mesh answers on 127.0.0.1:${meshPort}), most likely ADF Studio.`
      }
    } catch { /* nothing on the mesh port */ }
  }
  if (!paths.custom && studioProcessRunning()) return 'ADF Studio is running.'
  return null
}

function studioProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ADF Studio.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf-8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
      return /"ADF Studio\.exe"/i.test(out)
    }
    if (process.platform === 'darwin') {
      execFileSync('pgrep', ['-x', 'ADF Studio'], { stdio: 'ignore', timeout: 4000 })
      return true
    }
    execFileSync('pgrep', ['-f', 'adf-studio'], { stdio: 'ignore', timeout: 4000 })
    return true
  } catch {
    return false
  }
}

export const STUDIO_ADVICE = [
  'Studio and the daemon would run the same agents from the same files at once.',
  'Quit ADF Studio, then run adf again. Or keep using Studio.',
  '(Different data on purpose? Point the daemon elsewhere with ADF_DAEMON_SETTINGS, or override with: adf daemon start --force)',
].join('\n')

/** How to run `adf daemon` from here: the npm bundle, or the sources through tsx. */
export function daemonLaunch(): { command: string; args: string[]; cwd: string; source: boolean; root?: string } {
  const here = fileURLToPath(import.meta.url)
  const source = /\.tsx?$/.test(here)
  if (source) {
    const root = resolve(dirname(here), '..', '..', '..')
    // execArgv carries tsx's loader (--import/--require) into the child.
    return { command: process.execPath, args: [...process.execArgv, join(root, 'src', 'main', 'cli', 'bin.ts'), 'daemon'], cwd: root, source, root }
  }
  const entry = process.argv[1]
  return { command: process.execPath, args: [...process.execArgv, entry, 'daemon'], cwd: homedir(), source }
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Progress lines (stderr). */
  log?: (text: string) => void
  /** Skip the Studio check (`adf daemon start --force`). */
  force?: boolean
}

export interface StartResult { pid: number; paths: DaemonPaths; ms: number }

export class DaemonStartError extends Error {
  constructor(message: string, readonly advice?: string) { super(message) }
}

/** Start a daemon for `target` in the background and wait until /health answers. */
export async function startDaemon(target: DaemonTarget, options: StartOptions = {}): Promise<StartResult> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? fetch
  const log = options.log ?? (text => process.stderr.write(text))
  if (!target.loopback) throw new DaemonStartError(`${target.url} is not on this machine; start the daemon there.`)
  const paths = daemonPaths(target.port, env)
  if (!options.force) {
    const conflict = await studioConflict(paths, env, fetchImpl)
    if (conflict) throw new DaemonStartError(conflict, STUDIO_ADVICE)
  }
  const existing = readPidFile(paths.pidFile)
  if (existing && processAlive(existing.pid) && !await isHealthy(target.url, fetchImpl)) {
    // A daemon is starting, wedged, or shutting down under this pid file: wait
    // for it instead of racing it. If it exits without answering (it was
    // shutting down), start a fresh one below.
    log(`Waiting for the ADF daemon pid ${existing.pid}…\n`)
    const up = await waitHealthy(target.url, fetchImpl, START_TIMEOUT_MS, () => processAlive(existing.pid))
    if (up) return { pid: existing.pid, paths, ms: 0 }
    if (processAlive(existing.pid)) {
      throw new DaemonStartError(`The daemon (pid ${existing.pid}) did not answer ${target.url}/health within ${START_TIMEOUT_MS / 1000}s.`, `Log: ${paths.logFile}`)
    }
    try { rmSync(paths.pidFile, { force: true }) } catch { /* the exiting daemon may have removed it */ }
  }

  mkdirSync(dirname(paths.logFile), { recursive: true })
  const launch = daemonLaunch()
  const tty = process.stderr.isTTY
  const started = Date.now()
  log(`Starting the ADF daemon on ${target.host}:${target.port}…${tty ? '' : '\n'}`)
  if (launch.source && launch.root) {
    // `npm run daemon` does this first: better-sqlite3 built for this Node.
    const script = join(launch.root, 'scripts', 'rebuild-for-node.mjs')
    if (existsSync(script)) {
      const fd = openSync(paths.logFile, 'a')
      try {
        execFileSync(process.execPath, [script], { cwd: launch.root, stdio: ['ignore', fd, fd], windowsHide: true, timeout: 180_000 })
      } catch {
        closeSync(fd)
        throw new DaemonStartError('Could not prepare better-sqlite3 for this Node.js.', `Run: node scripts/rebuild-for-node.mjs (details in ${paths.logFile})`)
      }
      closeSync(fd)
    }
  }
  const out = openSync(paths.logFile, 'a')
  const childEnv: NodeJS.ProcessEnv = { ...env }
  // NODE_ENV=production set only for the TUI's React (bin.ts) is not the daemon's.
  if (childEnv.ADF_NODE_ENV_DEFAULTED === '1') { delete childEnv.NODE_ENV; delete childEnv.ADF_NODE_ENV_DEFAULTED }
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: {
      ...childEnv,
      ADF_DAEMON_PORT: String(target.port),
      ADF_DAEMON_HOST: target.host === 'localhost' ? '127.0.0.1' : target.host,
      ADF_DAEMON_PIDFILE: paths.pidFile,
      ADF_DAEMON_SETTINGS: paths.settingsFile,
    },
  })
  closeSync(out)
  let exited: number | null = null
  child.once('exit', code => { exited = code ?? -1 })
  child.unref()
  const pid = child.pid ?? -1
  const tick = tty ? setInterval(() => log('.'), 1000) : null
  try {
    const up = await waitHealthy(target.url, fetchImpl, START_TIMEOUT_MS, () => exited === null)
    if (!up) {
      const tail = tailLines(paths.logFile, 15)
      throw new DaemonStartError(
        exited !== null ? `The daemon exited during startup (code ${exited}).` : `The daemon did not answer ${target.url}/health within ${START_TIMEOUT_MS / 1000}s.`,
        `Log: ${paths.logFile}${tail ? `\n${tail}` : ''}`,
      )
    }
  } finally {
    if (tick) clearInterval(tick)
    if (tty) log('\n')
  }
  const ms = Date.now() - started
  log(`ADF daemon running in the background (pid ${pid}, ${(ms / 1000).toFixed(1)}s) · log ${paths.logFile}\n`)
  return { pid, paths, ms }
}

async function waitHealthy(url: string, fetchImpl: typeof fetch, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isHealthy(url, fetchImpl, 1000)) return true
    if (!alive()) return false
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

export interface EnsureOptions extends StartOptions {
  /** `--no-daemon` / ADF_NO_AUTOSTART=1. */
  disabled?: boolean
}

/**
 * `adf` needs a daemon at `url`: when it is this machine's (isLocalDaemonUrl:
 * loopback on the default port / ADF_DAEMON_PORT; not a forwarded port) and
 * not answering, start one in the background. Returns the start result, or
 * null when nothing had to be (or may be) started. Throws DaemonStartError
 * when a start failed.
 */
export async function ensureDaemon(url: string, options: EnsureOptions = {}): Promise<StartResult | null> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? fetch
  const target = daemonTarget(url)
  if (await isHealthy(target.url, fetchImpl)) return null
  if (!target.loopback || !isLocalDaemonUrl(target.url, env) || options.disabled || env.ADF_NO_AUTOSTART === '1') return null
  return await startDaemon(target, options)
}

// --- adf daemon status | stop | restart | logs ----------------------------------------

export interface StopResult { stopped: boolean; message: string }

/** Graceful stop: POST /daemon/shutdown, then wait for /health to go quiet and the pid to exit. */
export async function stopDaemon(target: DaemonTarget, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<StopResult> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? fetch
  const paths = daemonPaths(target.port, env)
  const record = readPidFile(paths.pidFile)
  const token = resolveDaemonToken(undefined, env, target.url)
  if (!await isHealthy(target.url, fetchImpl)) {
    if (record && processAlive(record.pid)) {
      return { stopped: false, message: `No daemon answers ${target.url}, but pid ${record.pid} from ${paths.pidFile} is alive. It may be starting or stuck; see adf daemon logs.` }
    }
    return { stopped: true, message: `No daemon running at ${target.url}.` }
  }
  let accepted = false
  try {
    const res = await fetchImpl(`${target.url}/daemon/shutdown`, { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...localProofHeaders(target.url, '/daemon/shutdown', env) }, signal: AbortSignal.timeout(5000) })
    accepted = res.ok
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      return { stopped: false, message: `The daemon refused to stop: ${body?.error ?? `HTTP ${res.status}`}` }
    }
  } catch { /* connection closed while shutting down counts as accepted below */ }
  if (!accepted) {
    // An older daemon without the endpoint: a signal is graceful on POSIX.
    if (record && process.platform !== 'win32' && processAlive(record.pid)) {
      try { process.kill(record.pid, 'SIGTERM'); accepted = true } catch { /* gone */ }
    }
    if (!accepted) {
      return { stopped: false, message: 'This daemon has no stop endpoint (older build). Stop it with Ctrl+C in its terminal, or update it.' }
    }
  }
  const deadline = Date.now() + (options.timeoutMs ?? STOP_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const up = await isHealthy(target.url, fetchImpl, 800)
    const alive = record ? processAlive(record.pid) : false
    if (!up && !alive) return { stopped: true, message: 'ADF daemon stopped.' }
    await new Promise(r => setTimeout(r, 300))
  }
  return { stopped: false, message: `The daemon is still shutting down after ${(options.timeoutMs ?? STOP_TIMEOUT_MS) / 1000}s (unloading agents, stopping containers). Check adf daemon logs.` }
}

export async function daemonStatus(target: DaemonTarget, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Promise<{ running: boolean; lines: string[] }> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? fetch
  const paths = daemonPaths(target.port, env)
  const running = await isHealthy(target.url, fetchImpl)
  const record = readPidFile(paths.pidFile)
  const lines = [`url       ${target.url}`, `status    ${running ? 'running' : 'not running'}`]
  if (running) {
    try {
      const token = resolveDaemonToken(undefined, env, target.url)
      const res = await fetchImpl(`${target.url}/runtime`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) })
      const body = await res.json() as { daemon?: { pid?: number; uptime?: number; version?: string | null }; agents?: unknown[] }
      if (body.daemon?.pid) lines.push(`pid       ${body.daemon.pid}`)
      if (typeof body.daemon?.uptime === 'number') lines.push(`uptime    ${formatUptime(body.daemon.uptime)}`)
      if (body.daemon?.version) lines.push(`version   ${body.daemon.version}`)
      if (Array.isArray(body.agents)) lines.push(`agents    ${body.agents.length} loaded`)
    } catch { /* health is enough */ }
  } else if (record && processAlive(record.pid)) {
    lines.push(`pid       ${record.pid} (alive, not answering: starting or stuck)`)
  }
  if (target.loopback) {
    lines.push(`data      ${paths.dataDir}`)
    lines.push(`log       ${paths.logFile}${existsSync(paths.logFile) ? '' : ' (none yet)'}`)
  }
  return { running, lines }
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

export function tailLines(file: string, count: number): string {
  try {
    const size = statSync(file).size
    const len = Math.min(size, 64 * 1024)
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    closeSync(fd)
    return buf.toString('utf-8').split(/\r?\n/).filter(Boolean).slice(-count).join('\n')
  } catch {
    return ''
  }
}

/** `adf daemon logs [-f] [-n N]`: print the tail; with -f keep printing what is appended. */
export async function followLog(file: string, options: { lines: number; follow: boolean; write: (text: string) => void; signal?: AbortSignal }): Promise<void> {
  const tail = tailLines(file, options.lines)
  if (tail) options.write(`${tail}\n`)
  if (!options.follow) return
  let offset = existsSync(file) ? statSync(file).size : 0
  while (!options.signal?.aborted) {
    await new Promise(r => setTimeout(r, 500))
    let size = 0
    try { size = statSync(file).size } catch { continue }
    if (size < offset) offset = 0
    if (size === offset) continue
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    closeSync(fd)
    offset = size
    options.write(buf.toString('utf-8'))
  }
}

/** The daemon URL for `adf daemon <sub>`: --url, else --port, else ADF_DAEMON_URL / ADF_DAEMON_PORT, else the default. */
export function daemonUrlFrom(args: string[], env: NodeJS.ProcessEnv = process.env): { url: string; rest: string[] } {
  let url: string | undefined
  let port: string | undefined
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--url' || arg === '-u') url = args[++i]
    else if (arg.startsWith('--url=')) url = arg.slice(6)
    else if (arg === '--port' || arg === '-p') port = args[++i]
    else if (arg.startsWith('--port=')) port = arg.slice(7)
    else rest.push(arg)
  }
  if (url) return { url: url.replace(/\/+$/, ''), rest }
  const p = port ?? env.ADF_DAEMON_PORT
  if (p) return { url: `http://127.0.0.1:${p}`, rest }
  return { url: (env.ADF_DAEMON_URL ?? DEFAULT_DAEMON_URL).replace(/\/+$/, ''), rest }
}
