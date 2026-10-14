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
 * Crash safety. A marker counts only while its pid is alive. A crashed
 * runtime's marker is ignored (and removed) by the next reader, so it can
 * neither pin the shared container forever nor protect its orphans: the next
 * shutdown stops them, as before this registry. PID reuse can make a dead
 * runtime look alive; that only leaves containers running (never stops a
 * live runtime's), and ends when the reusing process exits. Markers from
 * another host (roaming profiles) are ignored: containers are per machine.
 *
 * Failure policy. A marker that cannot be written is logged and compute goes
 * on unprotected (today's behaviour). A live runtime's marker that cannot be
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
  /** Injectable for tests. */
  isAlive?: (pid: number) => Promise<boolean>
  /** Remove the marker on process exit (default true). */
  exitHook?: boolean
}

export class ComputeUserRegistry implements ComputeUsers {
  readonly dir: string
  readonly file: string
  private readonly pid: number
  private readonly host: string
  private readonly kind: ComputeUserKind
  private readonly isAlive: (pid: number) => Promise<boolean>
  private readonly startedAt = new Date().toISOString()
  private readonly claimed = new Set<string>()
  /** Serializes marker writes so the file always reflects the latest set. */
  private writeChain: Promise<void> = Promise.resolve()
  private warned = false
  private exitHook: boolean
  private exitHookInstalled = false

  constructor(opts: ComputeUserRegistryOptions = {}) {
    this.dir = opts.dir ?? join(leaseDir(), 'compute')
    this.pid = opts.pid ?? process.pid
    this.host = opts.host ?? osHostname()
    this.kind = opts.kind ?? inferKind()
    this.isAlive = opts.isAlive ?? pidAlive
    this.exitHook = opts.exitHook ?? true
    this.file = join(this.dir, `${safeHost(this.host)}-${this.pid}.json`)
  }

  own(): ReadonlySet<string> {
    return this.claimed
  }

  claim(name: string): Promise<void> {
    if (this.claimed.has(name)) return this.writeChain
    this.claimed.add(name)
    return this.persist()
  }

  release(names: string[]): Promise<void> {
    let changed = false
    for (const n of names) changed = this.claimed.delete(n) || changed
    return changed ? this.persist() : this.writeChain
  }

  async others(): Promise<OtherComputeUsers> {
    const result: OtherComputeUsers = { claims: new Map(), unreadable: [] }
    let names: string[]
    try {
      names = await fsp.readdir(this.dir)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') console.warn(`[Compute] Could not read the container user registry ${this.dir}:`, err)
      return result
    }
    await Promise.all(names.map(async (name) => {
      const m = MARKER_RE.exec(name)
      if (!m) return
      const pid = Number(m[2])
      if (m[1] !== safeHost(this.host) || pid === this.pid) return
      const file = join(this.dir, name)
      if (!await this.isAlive(pid)) {
        // Crashed or killed runtime: its claims are void. Best-effort sweep.
        await fsp.rm(file, { force: true }).catch(() => {})
        return
      }
      let rec: ComputeUserRecord | null = null
      try { rec = parseRecord(await fsp.readFile(file, 'utf-8')) } catch (err) {
        if (errCode(err) === 'ENOENT') return // released between readdir and read
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
    this.writeChain = this.writeChain.then(() => this.writeMarker()).catch((err) => {
      if (!this.warned) {
        this.warned = true
        console.warn(`[Compute] Could not record container use in ${this.dir}; another runtime's shutdown may stop this runtime's containers:`, err instanceof Error ? err.message : err)
      }
    })
    return this.writeChain
  }

  private async writeMarker(): Promise<void> {
    if (this.claimed.size === 0) {
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
    this.installExitHook()
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
