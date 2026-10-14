/**
 * Which runtime on this machine uses which ADF containers.
 *
 * Several runtimes (embedded Studio, the local daemon, a CLI daemon on
 * another settings file) share one podman and one shared `adf-mcp`
 * container. Before this registry, each runtime's graceful shutdown stopped
 * every running managed `adf-*` container, including the other runtimes'
 * (incident 2026-10-14). Now each runtime records the containers it started
 * or uses, and a shutdown leaves alone whatever another live runtime claims.
 *
 * Layout: `<lease dir>/compute/<host>-<pid>.json`, one marker per runtime
 * process: `{v:1, pid, host, kind, startedAt, containers}`. The lease dir is
 * the one `runtime/agent-lease.ts` uses (`<per-user config dir>/adf/leases`,
 * `ADF_LEASE_DIR` for tests), so runtimes on different settings files see
 * each other. This is meant to fold into that module's runtime host
 * registry (`hosts/<pid>.json`) as a `containers` field once it is merged.
 *
 * Liveness (markerLiveness, the one function to swap for agent-lease.ts's
 * holderLiveness). A marker counts while its pid is alive AND the marker was
 * touched within STALE_MS: its runtime touches it every HEARTBEAT_MS. The
 * heartbeat is what rejects a reused pid (a runtime killed by a crash or by
 * Defender, its pid later given to another process): the reused pid looks
 * alive, but nobody touches the marker any more. Suspend: the holder checks
 * every HEARTBEAT_TICK_MS whether a touch is due, so it refreshes within
 * seconds of resuming; a reader that finds a stale marker of a running pid
 * waits STALE_RECHECK_MS once (one wait per read, however many markers) and
 * re-checks before voiding it.
 *
 * Crash safety. A dead marker is ignored and removed by the next reader, so
 * a crashed runtime can neither pin the shared container nor protect its
 * orphans: the next shutdown stops them, as before this registry. Markers
 * from another host (roaming profiles) are ignored: containers are per
 * machine.
 *
 * Failure policy. A marker that cannot be written is logged and retried
 * (next claim/release/read, and a backoff timer); until then compute goes on
 * unprotected (today's behaviour). A live runtime's marker that cannot be
 * read makes the reader stop only its own containers.
 */

import { randomBytes } from 'node:crypto'
import { promises as fsp, unlinkSync } from 'node:fs'
import { homedir, hostname as osHostname } from 'node:os'
import { join, resolve } from 'node:path'

export type ComputeUserKind = 'studio-embedded' | 'daemon'

export interface ComputeUserRecord {
  v: 1
  pid: number
  host: string
  kind: ComputeUserKind
  startedAt: string
  containers: string[]
}

/** What the other live runtimes on this machine use. */
export interface OtherComputeUsers {
  /** container name → holders ("daemon pid 4242"). */
  claims: Map<string, string[]>
  /** Live runtimes whose marker could not be read: their containers are unknown. */
  unreadable: string[]
}

export interface ComputeUsers {
  /** Record that this runtime uses `name`. Resolves once the marker is on disk. */
  claim(name: string): Promise<void>
  /** Forget `names` (stopped, removed, or abandoned by this runtime). */
  release(names: string[]): Promise<void>
  /** Containers this runtime has claimed. */
  own(): ReadonlySet<string>
  /** Claims of every other live runtime on this host. */
  others(): Promise<OtherComputeUsers>
}

/** A runtime touches its marker this often while it holds claims. */
export const HEARTBEAT_MS = 30_000
/** A marker not touched for this long is dead, whatever its pid says. */
export const STALE_MS = 120_000
/** How often the holder checks whether a heartbeat is due. Short, so a resume
 *  from suspend (or a wall-clock jump) refreshes the marker within seconds. */
export const HEARTBEAT_TICK_MS = 5_000
/** A reader re-checks a stale marker of a live pid once, after this long,
 *  before voiding it: the holder may have just resumed from suspend. */
export const STALE_RECHECK_MS = 6_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000

/** `<per-user config dir>/adf/leases`, or ADF_LEASE_DIR (same as runtime/agent-lease.ts). */
export function leaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADF_LEASE_DIR) return resolve(env.ADF_LEASE_DIR)
  let base: string
  if (process.platform === 'darwin') base = join(homedir(), 'Library', 'Application Support')
  else if (process.platform === 'win32') base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  else base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'adf', 'leases')
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** process.kill(pid, 0), plus the Linux zombie check (same rule as agent-lease.ts). */
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

/** What a reader knows about another runtime's marker before reading it. */
export interface ComputeUserMarker {
  pid: number
  /** Last heartbeat (marker mtime). */
  mtimeMs: number
}

/** `recheck`: not alive now, but may be after a short wait (stale heartbeat
 *  of a running pid, e.g. a holder that is resuming from suspend). */
export type ComputeUserLiveness = (marker: ComputeUserMarker) => Promise<{ alive: boolean; reason: string; recheck?: boolean }>

/**
 * Interim liveness until W0-C's holderLiveness (agent-lease.ts) replaces it:
 * the pid runs and the marker had a heartbeat within `staleMs`.
 */
export function markerLiveness(opts: {
  isAlive?: (pid: number) => Promise<boolean>
  staleMs?: number
  now?: () => number
} = {}): ComputeUserLiveness {
  const isAlive = opts.isAlive ?? pidAlive
  const staleMs = opts.staleMs ?? STALE_MS
  const now = opts.now ?? Date.now
  return async ({ pid, mtimeMs }) => {
    if (!await isAlive(pid)) return { alive: false, reason: 'pid not running' }
    const age = now() - mtimeMs
    if (age > staleMs) return { alive: false, recheck: true, reason: `no heartbeat for ${Math.round(age / 1000)}s (pid reused)` }
    return { alive: true, reason: 'pid running, heartbeat fresh' }
  }
}

function inferKind(): ComputeUserKind {
  const electronMain = !!process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1' &&
    (process as NodeJS.Process & { type?: string }).type === 'browser'
  return electronMain ? 'studio-embedded' : 'daemon'
}

function safeHost(host: string): string {
  return host.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64) || 'host'
}

const MARKER_RE = /^(.+)-(\d+)\.json$/

function parseRecord(raw: string): ComputeUserRecord | null {
  try {
    const rec = JSON.parse(raw) as ComputeUserRecord
    if (rec?.v !== 1 || typeof rec.pid !== 'number' || typeof rec.host !== 'string' || !Array.isArray(rec.containers)) return null
    if (!rec.containers.every((c) => typeof c === 'string')) return null
    return rec
  } catch {
    return null
  }
}

export interface ComputeUserRegistryOptions {
  dir?: string
  pid?: number
  host?: string
  kind?: ComputeUserKind
  /** Injectable for tests; defaults to markerLiveness(). */
  liveness?: ComputeUserLiveness
  heartbeatMs?: number
  /** How often the holder checks whether a heartbeat is due. */
  heartbeatTickMs?: number
  /** Wait before re-checking a stale marker of a live pid. */
  recheckMs?: number
  /** First retry delay after a failed marker write (doubles up to 60 s). */
  retryMs?: number
  /** Remove the marker on process exit (default true). */
  exitHook?: boolean
}

export class ComputeUserRegistry implements ComputeUsers {
  readonly dir: string
  readonly file: string
  private readonly pid: number
  private readonly host: string
  private readonly kind: ComputeUserKind
  private readonly liveness: ComputeUserLiveness
  private readonly heartbeatMs: number
  private readonly tickMs: number
  private readonly recheckMs: number
  /** When this runtime last wrote or touched its marker (wall clock). */
  private lastTouch = 0
  private touching = false
  private readonly retryMs: number
  private readonly startedAt = new Date().toISOString()
  private readonly claimed = new Set<string>()
  /** Serializes marker writes so the file always reflects the latest set. */
  private writeChain: Promise<void> = Promise.resolve()
  /** The marker on disk does not match `claimed` (last write failed). */
  private dirty = false
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private exitHook: boolean
  private exitHookInstalled = false

  constructor(opts: ComputeUserRegistryOptions = {}) {
    this.dir = opts.dir ?? join(leaseDir(), 'compute')
    this.pid = opts.pid ?? process.pid
    this.host = opts.host ?? osHostname()
    this.kind = opts.kind ?? inferKind()
    this.liveness = opts.liveness ?? markerLiveness()
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
    this.tickMs = opts.heartbeatTickMs ?? HEARTBEAT_TICK_MS
    this.recheckMs = opts.recheckMs ?? STALE_RECHECK_MS
    this.retryMs = opts.retryMs ?? RETRY_BASE_MS
    this.exitHook = opts.exitHook ?? true
    this.file = join(this.dir, `${safeHost(this.host)}-${this.pid}.json`)
  }

  own(): ReadonlySet<string> {
    return this.claimed
  }

  claim(name: string): Promise<void> {
    if (this.claimed.has(name) && !this.dirty) return this.writeChain
    this.claimed.add(name)
    return this.persist()
  }

  release(names: string[]): Promise<void> {
    let changed = false
    for (const n of names) changed = this.claimed.delete(n) || changed
    return changed || this.dirty ? this.persist() : this.writeChain
  }

  async others(): Promise<OtherComputeUsers> {
    if (this.dirty) await this.persist()
    const result: OtherComputeUsers = { claims: new Map(), unreadable: [] }
    let names: string[]
    try {
      names = await fsp.readdir(this.dir)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') console.warn(`[Compute] Could not read the container user registry ${this.dir}:`, err)
      return result
    }
    const markers = names.flatMap((name) => {
      const m = MARKER_RE.exec(name)
      if (!m) return []
      const pid = Number(m[2])
      if (m[1] !== safeHost(this.host) || pid === this.pid) return []
      return [{ pid, file: join(this.dir, name) }]
    })
    const judge = async ({ pid, file }: { pid: number; file: string }) => {
      let mtimeMs: number
      try { mtimeMs = (await fsp.stat(file)).mtimeMs } catch { return null } // released meanwhile
      return this.liveness({ pid, mtimeMs })
    }
    const verdicts = await Promise.all(markers.map(judge))
    // One shared wait, however many markers are stale: a holder resuming
    // from suspend touches its marker within HEARTBEAT_TICK_MS.
    if (verdicts.some((v) => v && !v.alive && v.recheck)) {
      await new Promise((r) => setTimeout(r, this.recheckMs))
      await Promise.all(markers.map(async (mk, i) => {
        const v = verdicts[i]
        if (v && !v.alive && v.recheck) verdicts[i] = await judge(mk)
      }))
    }
    await Promise.all(markers.map(async ({ pid, file }, i) => {
      const live = verdicts[i]
      if (!live) return
      if (!live.alive) {
        // Crashed, killed or reused-pid runtime: its claims are void.
        console.log(`[Compute] Ignoring container claims of pid ${pid}: ${live.reason}`)
        await fsp.rm(file, { force: true }).catch(() => {})
        return
      }
      let rec: ComputeUserRecord | null = null
      try { rec = parseRecord(await fsp.readFile(file, 'utf-8')) } catch (err) {
        if (errCode(err) === 'ENOENT') return // released between stat and read
      }
      if (!rec || rec.pid !== pid) {
        result.unreadable.push(`pid ${pid}`)
        return
      }
      const holder = `${rec.kind} pid ${pid}`
      for (const c of rec.containers) {
        const list = result.claims.get(c) ?? []
        list.push(holder)
        result.claims.set(c, list)
      }
    }))
    return result
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeMarker()).then(() => {
      if (this.failures > 0) console.log(`[Compute] Container use is recorded in ${this.dir} again`)
      this.dirty = false
      this.failures = 0
      this.clearRetry()
    }, (err) => {
      this.dirty = true
      if (this.failures === 0) {
        console.warn(`[Compute] Could not record container use in ${this.dir} (will retry); until then another runtime's shutdown may stop this runtime's containers:`, err instanceof Error ? err.message : err)
      }
      this.failures++
      this.scheduleRetry()
    })
    return this.writeChain
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    const delay = Math.min(this.retryMs * 2 ** (this.failures - 1), RETRY_MAX_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.dirty) void this.persist()
    }, delay)
    this.retryTimer.unref?.()
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private async writeMarker(): Promise<void> {
    if (this.claimed.size === 0) {
      this.stopHeartbeat()
      await fsp.rm(this.file, { force: true })
      return
    }
    const rec: ComputeUserRecord = {
      v: 1, pid: this.pid, host: this.host, kind: this.kind, startedAt: this.startedAt,
      containers: [...this.claimed].sort(),
    }
    await fsp.mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(rec))
    try {
      await renameWithRetry(tmp, this.file)
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    this.lastTouch = Date.now()
    this.startHeartbeat()
    this.installExitHook()
  }

  /** Touch the marker so readers can tell this runtime from a reused pid.
   *  A short tick decides whether a touch is due, so after a suspend or a
   *  wall-clock jump the marker is fresh again within HEARTBEAT_TICK_MS. */
  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      if (this.touching || Date.now() - this.lastTouch <= this.heartbeatMs) return
      this.touching = true
      const now = new Date()
      fsp.utimes(this.file, now, now).then(() => { this.lastTouch = now.getTime() }, () => {
        // Removed by a reader that judged it stale (e.g. after a long
        // suspend), or unwritable: write it again.
        this.dirty = true
        void this.persist()
      }).finally(() => { this.touching = false })
    }, this.tickMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private installExitHook(): void {
    if (!this.exitHook || this.exitHookInstalled) return
    this.exitHookInstalled = true
    // Sync on purpose: 'exit' handlers cannot await. Runs once, at exit.
    process.once('exit', () => { try { unlinkSync(this.file) } catch { /* already gone */ } })
  }
}

/** Windows refuses a rename over a file another process has open (a reader). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(errCode(err) ?? '')) throw err
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
    }
  }
}

let processRegistry: ComputeUserRegistry | null = null

/** The registry for this process (created on first use). */
export function processComputeUsers(): ComputeUserRegistry {
  processRegistry ??= new ComputeUserRegistry()
  return processRegistry
}
