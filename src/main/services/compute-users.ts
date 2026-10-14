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
 * Layout: the `containers` field of each runtime's host record,
 * `<lease dir>/hosts/<pid>.json`, written by `runtime/agent-lease.ts` (one
 * writer per record). The lease dir is per user and machine, so runtimes on
 * different settings files see each other.
 *
 * Liveness (the injectable `liveness`). By default the record's holder is
 * judged by agent-lease.ts's holderLiveness: pid plus the runtime's local
 * endpoint, which rejects a reused pid. A record without a usable endpoint
 * falls back to a heartbeat: the pid runs AND the record was touched within
 * STALE_MS (its runtime touches it every HEARTBEAT_MS; a crashed runtime's
 * reused pid looks alive, but nobody touches the record). Suspend: the holder
 * checks every HEARTBEAT_TICK_MS whether a touch is due, so it refreshes
 * within seconds of resuming; a reader that finds a stale record of a running
 * pid waits STALE_RECHECK_MS once (one wait per read, however many records)
 * and re-checks before voiding it.
 *
 * Crash safety. A dead record is ignored and removed by the next reader (only
 * if unchanged since it was judged), so a crashed runtime can neither pin the
 * shared container nor protect its orphans: the next shutdown stops them, as
 * before this registry. Records from another machine (a shared network home)
 * are ignored and never removed: containers are per machine.
 *
 * Failure policy. A marker that cannot be written is logged and retried
 * (next claim/release/read, and a backoff timer); until then compute goes on
 * unprotected (today's behaviour). A live runtime's marker that cannot be
 * read makes the reader stop only its own containers.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import {
  AgentLeaseRegistry,
  fromOtherMachine,
  holderLiveness,
  parseHostRecord,
  pidAlive,
  processAgentLeases,
  trustedEndpoint,
  type RuntimeHostRecord,
} from '../runtime/agent-lease'

export type ComputeUserKind = 'studio-embedded' | 'daemon'

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

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** What a reader knows about another runtime's marker before reading it. */
export interface ComputeUserMarker {
  pid: number
  /** Last heartbeat (record mtime). */
  mtimeMs: number
  /** The host record, when it parsed. */
  record?: RuntimeHostRecord | null
}

/** `recheck`: not alive now, but may be after a short wait (stale heartbeat
 *  of a running pid, e.g. a holder that is resuming from suspend). */
export type ComputeUserLiveness = (marker: ComputeUserMarker) => Promise<{ alive: boolean; reason: string; recheck?: boolean }>

/** Heartbeat liveness: the pid runs and the record had a heartbeat within `staleMs`. */
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

/**
 * Default liveness: a record with this module's local endpoint is judged by
 * holderLiveness (pid + endpoint: definitive about reused pids); one without
 * falls back to the heartbeat.
 */
export function hostRecordLiveness(dir: string, heartbeat: ComputeUserLiveness = markerLiveness()): ComputeUserLiveness {
  return async (marker) => {
    const rec = marker.record
    if (rec && trustedEndpoint(rec, dir)) {
      const live = await holderLiveness(rec, dir)
      return { alive: live.alive, reason: live.reason }
    }
    return heartbeat(marker)
  }
}

const RECORD_RE = /^(\d+)\.json$/

export interface ComputeUserRegistryOptions {
  /** The lease dir (records in `<dir>/hosts`). */
  dir?: string
  pid?: number
  host?: string
  /** Recorded machine id (tests model another machine with it). */
  machineId?: string | null
  kind?: ComputeUserKind
  /**
   * The registry whose host record carries the claims. Default: this
   * process's (processAgentLeases), or a dedicated one when dir/pid/host/
   * machineId are given (tests modelling several runtimes in one process).
   */
  leases?: AgentLeaseRegistry
  /** Injectable for tests; defaults to hostRecordLiveness(). */
  liveness?: ComputeUserLiveness
  heartbeatMs?: number
  /** How often the holder checks whether a heartbeat is due. */
  heartbeatTickMs?: number
  /** Wait before re-checking a stale marker of a live pid. */
  recheckMs?: number
  /** First retry delay after a failed marker write (doubles up to 60 s). */
  retryMs?: number
  /** Kept for callers; the host record is removed at exit by agent-lease.ts. */
  exitHook?: boolean
}

export class ComputeUserRegistry implements ComputeUsers {
  readonly dir: string
  readonly file: string
  private readonly pid: number
  private readonly leases: AgentLeaseRegistry
  private readonly liveness: ComputeUserLiveness
  private readonly heartbeatMs: number
  private readonly tickMs: number
  private readonly recheckMs: number
  /** When this runtime last wrote or touched its marker (wall clock). */
  private lastTouch = 0
  private touching = false
  private readonly retryMs: number
  private readonly claimed = new Set<string>()
  /** Serializes marker writes so the file always reflects the latest set. */
  private writeChain: Promise<void> = Promise.resolve()
  /** The marker on disk does not match `claimed` (last write failed). */
  private dirty = false
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(opts: ComputeUserRegistryOptions = {}) {
    const dedicated = opts.dir !== undefined || opts.pid !== undefined || opts.host !== undefined || opts.machineId !== undefined
    this.leases = opts.leases ?? (dedicated
      // Made-up pids: the readers below judge them with the injected liveness.
      ? new AgentLeaseRegistry({ dir: opts.dir, pid: opts.pid, hostname: opts.host, machineId: opts.machineId, kind: opts.kind, sweepDeadEntries: false })
      : processAgentLeases())
    this.dir = this.leases.dir
    this.pid = opts.pid ?? process.pid
    this.liveness = opts.liveness ?? hostRecordLiveness(this.dir)
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
    this.tickMs = opts.heartbeatTickMs ?? HEARTBEAT_TICK_MS
    this.recheckMs = opts.recheckMs ?? STALE_RECHECK_MS
    this.retryMs = opts.retryMs ?? RETRY_BASE_MS
    this.file = this.leases.hostEntryFile
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
    const hostsDir = join(this.dir, 'hosts')
    let names: string[]
    try {
      names = await fsp.readdir(hostsDir)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') console.warn(`[Compute] Could not read the runtime host records in ${hostsDir}:`, err)
      return result
    }
    const records = names.flatMap((name) => {
      const m = RECORD_RE.exec(name)
      if (!m) return []
      const pid = Number(m[1])
      if (pid === this.pid) return []
      return [{ pid, file: join(hostsDir, name) }]
    })
    type Read = { raw: string; record: RuntimeHostRecord | null; mtimeMs: number }
    const read = async (file: string): Promise<Read | null> => {
      try {
        const [raw, st] = await Promise.all([fsp.readFile(file, 'utf-8'), fsp.stat(file)])
        return { raw, record: parseHostRecord(raw), mtimeMs: st.mtimeMs }
      } catch {
        return null // released between listing and reading
      }
    }
    const reads = await Promise.all(records.map(({ file }) => read(file)))
    const judge = (i: number) => {
      const r = reads[i]
      return r ? this.liveness({ pid: records[i].pid, mtimeMs: r.mtimeMs, record: r.record }) : Promise.resolve(null)
    }
    // Another machine's record (a shared network home): its containers are
    // not on this machine, and it is never judged or removed here.
    const elsewhere = await Promise.all(reads.map(async (r) => !!r?.record && await fromOtherMachine(r.record)))
    const verdicts = await Promise.all(records.map((_, i) => (elsewhere[i] ? Promise.resolve(null) : judge(i))))
    // One shared wait, however many records are stale: a holder resuming
    // from suspend touches its record within HEARTBEAT_TICK_MS.
    if (verdicts.some((v) => v && !v.alive && v.recheck)) {
      await new Promise((r) => setTimeout(r, this.recheckMs))
      await Promise.all(records.map(async ({ file }, i) => {
        const v = verdicts[i]
        if (!v || v.alive || !v.recheck) return
        reads[i] = await read(file)
        verdicts[i] = await judge(i)
      }))
    }
    await Promise.all(records.map(async ({ pid, file }, i) => {
      const live = verdicts[i]
      const r = reads[i]
      if (!live || !r) return
      if (!live.alive) {
        // Crashed, killed or reused-pid runtime: its claims are void. Remove
        // the record only if it is still the one judged.
        console.log(`[Compute] Ignoring container claims of pid ${pid}: ${live.reason}`)
        try {
          if ((await fsp.readFile(file, 'utf-8')) === r.raw) await fsp.rm(file, { force: true })
        } catch { /* gone */ }
        return
      }
      const rec = r.record
      if (!rec || rec.pid !== pid) {
        result.unreadable.push(`pid ${pid}`)
        return
      }
      const holder = `${rec.kind} pid ${pid}`
      for (const c of rec.containers ?? []) {
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
    await this.leases.setContainers([...this.claimed])
    if (this.claimed.size === 0) {
      this.stopHeartbeat()
      return
    }
    this.lastTouch = Date.now()
    this.startHeartbeat()
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
      this.leases.touchEntry().then(() => { this.lastTouch = now.getTime() }, () => {
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
}

let processRegistry: ComputeUserRegistry | null = null

/** The registry for this process (created on first use). */
export function processComputeUsers(): ComputeUserRegistry {
  processRegistry ??= new ComputeUserRegistry()
  return processRegistry
}
