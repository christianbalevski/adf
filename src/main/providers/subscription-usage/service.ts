/**
 * Subscription usage: the latest quota figures per signed-in subscription,
 * plus a downsampled history, kept in `<userData>/subscription-usage.json`.
 *
 * Figures arrive passively off real agent calls (`record`) or from an
 * on-demand probe (`refresh`, Codex only). Every source is undocumented, so a
 * failure only ever becomes a plain status on the snapshot: `record` and
 * `markError` never throw, and nothing here runs on the agent call path except
 * an in-memory merge.
 */
import { join } from 'node:path'
import { readJsonOrQuarantine, writeJsonAtomic, writeJsonAtomicAsync } from '../../utils/atomic-json'
import { SUBSCRIPTION_TYPES, isSubscriptionType } from '../../../shared/constants/provider-catalog'
import type {
  SubscriptionProviderId,
  SubscriptionUsageHistoryRequest,
  SubscriptionUsageSample,
  SubscriptionUsageSnapshot,
  SubscriptionUsageState,
  SubscriptionUsageWindow,
} from '../../../shared/types/subscription-usage.types'
import { isRecord, num, type UsageReport } from './adapters'

/** Figures older than this read as `stale`. */
export const FRESH_MS = 6 * 60 * 60_000
/** At most one history sample per provider/window per interval. */
export const SAMPLE_INTERVAL_MS = 5 * 60_000
const SAVE_DEBOUNCE_MS = 5000
const EMIT_DEBOUNCE_MS = 250

export const PROBE_THROTTLE_MS = 10_000
export const PROBE_BACKOFF_AFTER = 3
export const PROBE_BACKOFF_MS = 15 * 60_000

type Stored = Omit<SubscriptionUsageSnapshot, 'provider' | 'status' | 'windows'> & { windows: Record<string, SubscriptionUsageWindow> }
/** `cleared`: when each subscription was last seen signed out; data observed before it belongs to the previous account. */
interface Disk { snapshots: Map<SubscriptionProviderId, Stored>; samples: SubscriptionUsageSample[]; cleared: Map<SubscriptionProviderId, number> }

interface ProbeState { lastAttempt: number; failures: number; inFlight: Promise<void> | null }

export interface SubscriptionAccount {
  /** Undefined when it cannot tell. */
  signedIn?: boolean
  /** Plan from the sign-in, for providers whose reports carry none (Claude). */
  plan?: string
}

export interface SubscriptionUsageDeps {
  filePath: string
  now?: () => number
  /**
   * Sign-in state per provider; undefined when it cannot tell. Never throws.
   * May cache where reading is costly; `fresh` asks it not to.
   */
  account: (provider: SubscriptionProviderId, fresh?: boolean) => Promise<SubscriptionAccount | undefined>
  /** On-demand probes. Resolve with a report, or throw an Error whose message is shown as is. */
  probes?: Partial<Record<SubscriptionProviderId, () => Promise<UsageReport>>>
}

function sanitizeWindow(key: string, raw: unknown): SubscriptionUsageWindow | null {
  if (!isRecord(raw)) return null
  const observedAt = num(raw.observedAt)
  if (observedAt === undefined) return null
  const usedPercent = num(raw.usedPercent)
  const resetsAt = num(raw.resetsAt)
  return {
    key,
    label: typeof raw.label === 'string' ? raw.label : key,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(typeof raw.limited === 'boolean' ? { limited: raw.limited } : {}),
    observedAt,
  }
}

function sanitizeStored(raw: unknown): Stored | null {
  if (!isRecord(raw)) return null
  const windows: Record<string, SubscriptionUsageWindow> = {}
  if (isRecord(raw.windows)) {
    for (const [key, w] of Object.entries(raw.windows)) {
      const clean = sanitizeWindow(key, w)
      if (clean) windows[key] = clean
    }
  }
  const out: Stored = { windows }
  if (typeof raw.plan === 'string') out.plan = raw.plan
  if (isRecord(raw.credits)) {
    const balance = num(raw.credits.balance)
    out.credits = { ...(balance !== undefined ? { balance } : {}), ...(typeof raw.credits.hasCredits === 'boolean' ? { hasCredits: raw.credits.hasCredits } : {}) }
  }
  const observedAt = num(raw.observedAt)
  if (observedAt !== undefined) out.observedAt = observedAt
  if (typeof raw.error === 'string') out.error = raw.error
  const errorAt = num(raw.errorAt)
  if (errorAt !== undefined) out.errorAt = errorAt
  return out
}

function sanitizeSample(raw: unknown): SubscriptionUsageSample | null {
  if (!isRecord(raw)) return null
  const t = num(raw.t)
  const usedPercent = num(raw.usedPercent)
  const provider = typeof raw.provider === 'string' ? raw.provider : undefined
  if (t === undefined || usedPercent === undefined || !isSubscriptionType(provider) || typeof raw.window !== 'string') return null
  return { t, provider, window: raw.window, usedPercent }
}

/**
 * Two processes' views of one subscription (Studio and the daemon share the
 * file): each window by its newer report, the rest from the newer report, the
 * error only when it is newer than every report.
 */
export function mergeStored(a: Stored | undefined, b: Stored | undefined): Stored | undefined {
  if (!a || !b) return a ?? b
  const [older, newer] = (a.observedAt ?? 0) <= (b.observedAt ?? 0) ? [a, b] : [b, a]
  const out: Stored = { ...older, ...newer, windows: { ...older.windows } }
  for (const [key, w] of Object.entries(newer.windows)) {
    if ((out.windows[key]?.observedAt ?? -1) <= w.observedAt) out.windows[key] = w
  }
  const failed = (a.errorAt ?? -1) >= (b.errorAt ?? -1) ? a : b
  delete out.error
  delete out.errorAt
  if (failed.error && (failed.errorAt ?? 0) >= (out.observedAt ?? 0)) Object.assign(out, { error: failed.error, errorAt: failed.errorAt })
  return out
}

/** Windows whose reset has not passed: an expired one no longer describes the quota. */
function liveWindows(s: Stored | undefined, now: number): SubscriptionUsageWindow[] {
  return s ? Object.values(s.windows).filter((w) => w.resetsAt === undefined || w.resetsAt > now) : []
}

/**
 * Status from stored figures alone (sign-in is applied by the caller): `ok`
 * while the freshest live window was reported within FRESH_MS, whatever a
 * later failed check said (that stays a note in `error`).
 */
export function deriveStatus(s: Stored | undefined, now: number): SubscriptionUsageSnapshot['status'] {
  if (!s) return 'unavailable'
  const live = liveWindows(s, now)
  // A report with no windows at all (credits only) dates itself.
  const reported = live.length > 0 ? Math.max(...live.map((w) => w.observedAt)) : Object.keys(s.windows).length === 0 ? s.observedAt : undefined
  if (reported !== undefined && now - reported <= FRESH_MS) return 'ok'
  if (s.observedAt !== undefined) return 'stale'
  return s.error ? 'error' : 'unavailable'
}

export class SubscriptionUsageService {
  private readonly now: () => number
  private snapshots = new Map<SubscriptionProviderId, Stored>()
  private samples: SubscriptionUsageSample[] = []
  private probes = new Map<SubscriptionProviderId, ProbeState>()
  /** When each subscription was last seen signed out: older figures and history are the previous account's. */
  private cleared = new Map<SubscriptionProviderId, number>()
  private listeners = new Set<(state: SubscriptionUsageState) => void>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** Set when a corrupt file could not be preserved: never write over it. */
  private readOnly = false

  constructor(private readonly deps: SubscriptionUsageDeps) {
    this.now = deps.now ?? Date.now
    const disk = this.read()
    if (disk) this.adopt(disk)
  }

  // --- input ---------------------------------------------------------------------------

  /** Merge a report (windows by key). Never throws. */
  record(provider: SubscriptionProviderId, report: UsageReport | null): void {
    if (!report) return
    try {
      const now = this.now()
      const prev = this.snapshots.get(provider)
      const next: Stored = { ...prev, windows: { ...prev?.windows }, observedAt: now }
      delete next.error
      delete next.errorAt
      if (report.plan) next.plan = report.plan
      if (report.credits) next.credits = report.credits
      for (const w of report.windows) {
        next.windows[w.key] = w
        if (w.usedPercent !== undefined) this.sample(provider, w.key, w.usedPercent, now)
      }
      this.snapshots.set(provider, next)
      this.changed()
    } catch (err) {
      console.warn('[SubscriptionUsage] record failed:', err)
    }
  }

  /** Keep the last good figures with the failure as a note (see deriveStatus). Never throws. */
  markError(provider: SubscriptionProviderId, message: string): void {
    try {
      const prev = this.snapshots.get(provider)
      this.snapshots.set(provider, { ...prev, windows: { ...prev?.windows }, error: message, errorAt: this.now() })
      this.changed()
    } catch (err) {
      console.warn('[SubscriptionUsage] markError failed:', err)
    }
  }

  // --- probes --------------------------------------------------------------------------

  /**
   * Re-read every sign-in and, unless `probe` is false, run the probes that
   * exist, subject to throttle and backoff; then return the current state. A
   * probe failure is recorded on the snapshot, never thrown.
   */
  async refresh({ probe = true }: { probe?: boolean } = {}): Promise<SubscriptionUsageState> {
    if (probe) await Promise.all(SUBSCRIPTION_TYPES.map((p) => this.runProbe(p)))
    return this.getState(true)
  }

  private async runProbe(provider: SubscriptionProviderId): Promise<void> {
    const probe = this.deps.probes?.[provider]
    if (!probe) return
    const state = this.probes.get(provider) ?? { lastAttempt: 0, failures: 0, inFlight: null }
    this.probes.set(provider, state)
    if (state.inFlight) return state.inFlight
    const now = this.now()
    const since = now - state.lastAttempt
    if (state.failures >= PROBE_BACKOFF_AFTER && since < PROBE_BACKOFF_MS) return
    if (since < PROBE_THROTTLE_MS) return
    // Claimed before the sign-in read, so a concurrent refresh cannot pass the throttle too.
    state.lastAttempt = now
    state.inFlight = (async () => {
      try {
        if ((await this.account(provider, true))?.signedIn === false) return
        this.record(provider, await probe())
        state.failures = 0
      } catch (err) {
        state.failures++
        this.markError(provider, err instanceof Error ? err.message : String(err))
      } finally {
        state.inFlight = null
      }
    })()
    return state.inFlight
  }

  // --- output --------------------------------------------------------------------------

  private account(provider: SubscriptionProviderId, fresh = false): Promise<SubscriptionAccount | undefined> {
    return this.deps.account(provider, fresh).catch(() => undefined)
  }

  /** `fresh` re-reads sign-ins the account dependency would otherwise serve from its cache. */
  async getState(fresh = false): Promise<SubscriptionUsageState> {
    const accounts = await Promise.all(SUBSCRIPTION_TYPES.map((p) => this.account(p, fresh)))
    const now = this.now()
    return {
      snapshots: SUBSCRIPTION_TYPES.map((provider, i): SubscriptionUsageSnapshot => {
        const account = accounts[i]
        if (account?.signedIn === false) {
          this.clear(provider, now)
          return { provider, status: 'signed_out', windows: [] }
        }
        const s = this.snapshots.get(provider)
        const { windows: _windows, ...rest } = s ?? { windows: {} }
        const plan = rest.plan ?? account?.plan
        return { ...rest, ...(plan ? { plan } : {}), provider, status: deriveStatus(s, now), windows: liveWindows(s, now) }
      }),
    }
  }

  getHistory(req: SubscriptionUsageHistoryRequest = {}): SubscriptionUsageSample[] {
    const since = num(req.since) ?? 0
    return this.samples.filter((s) => s.t >= since)
  }

  /** Full state after every change (coalesced). Returns the unsubscribe. */
  onChange(listener: (state: SubscriptionUsageState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Signed out: another account may sign in next, and its figures and history
   * must not start as these. Drop both, and remember when, so the file (which
   * another process may still write) cannot bring them back.
   */
  private clear(provider: SubscriptionProviderId, now: number): void {
    const had = this.snapshots.delete(provider)
    const kept = this.samples.filter((s) => s.provider !== provider)
    if (!had && kept.length === this.samples.length) return
    this.samples = kept
    this.cleared.set(provider, now)
    this.changed()
  }

  // --- history + persistence -----------------------------------------------------------

  private sample(provider: SubscriptionProviderId, window: string, usedPercent: number, now: number): void {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]
      if (s.provider !== provider || s.window !== window) continue
      if (now - s.t < SAMPLE_INTERVAL_MS) return
      break
    }
    this.samples.push({ t: now, provider, window, usedPercent })
  }

  private changed(): void {
    this.dirty = true
    this.scheduleSave()
    if (this.listeners.size > 0 && !this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null
        void this.getState().then((state) => {
          for (const l of this.listeners) {
            try { l(state) } catch (err) { console.warn('[SubscriptionUsage] listener failed:', err) }
          }
        })
      }, EMIT_DEBOUNCE_MS)
      this.emitTimer.unref?.()
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.readOnly) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.saveAsync() }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  /** The file as it is now, sanitized; null when it must not be written over (corrupt and not preserved). */
  private read(): Disk | null {
    const disk: Disk = { snapshots: new Map(), samples: [], cleared: new Map() }
    try {
      const { data, quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<unknown>(this.deps.filePath)
      if (quarantinedTo) console.warn(`[SubscriptionUsage] unreadable usage file moved aside to ${quarantinedTo}; starting empty`)
      if (corruptUnpreserved) {
        this.readOnly = true
        return null
      }
      if (!isRecord(data)) return disk
      if (isRecord(data.snapshots)) {
        for (const [provider, raw] of Object.entries(data.snapshots)) {
          const clean = isSubscriptionType(provider) ? sanitizeStored(raw) : null
          if (clean) disk.snapshots.set(provider as SubscriptionProviderId, clean)
        }
      }
      if (isRecord(data.cleared)) {
        for (const [provider, raw] of Object.entries(data.cleared)) {
          const t = num(raw)
          if (t !== undefined && isSubscriptionType(provider)) disk.cleared.set(provider, t)
        }
      }
      if (Array.isArray(data.samples)) {
        disk.samples = data.samples.map(sanitizeSample).filter((s): s is SubscriptionUsageSample => s !== null)
      }
    } catch (err) {
      console.warn('[SubscriptionUsage] could not read saved usage:', err)
    }
    return disk
  }

  /**
   * Fold the file into memory: snapshots by mergeStored, samples as a union,
   * and nothing observed before a subscription's latest sign-out.
   */
  private adopt(disk: Disk): void {
    for (const [provider, t] of disk.cleared) if (t > (this.cleared.get(provider) ?? 0)) this.cleared.set(provider, t)
    const before = (provider: SubscriptionProviderId, t: number | undefined) => (t ?? 0) <= (this.cleared.get(provider) ?? -1)
    for (const [provider, stored] of [...disk.snapshots, ...this.snapshots]) {
      if (!before(provider, stored.observedAt)) continue
      // A whole snapshot from before the sign-out; a newer one keeps only its newer windows.
      if (disk.snapshots.get(provider) === stored) disk.snapshots.delete(provider)
      else this.snapshots.delete(provider)
    }
    for (const [provider, stored] of disk.snapshots) {
      const windows = Object.fromEntries(Object.entries(stored.windows).filter(([, w]) => !before(provider, w.observedAt)))
      this.snapshots.set(provider, mergeStored({ ...stored, windows }, this.snapshots.get(provider))!)
    }
    const byKey = new Map<string, SubscriptionUsageSample>()
    for (const s of [...disk.samples, ...this.samples]) {
      if (!before(s.provider, s.t)) byKey.set(`${s.t}|${s.provider}|${s.window}`, s)
    }
    this.samples = [...byKey.values()].sort((a, b) => a.t - b.t)
  }

  /**
   * Studio and the daemon share the file: re-read it and merge before every
   * write (as token-usage.service.ts does), so neither drops the other's
   * figures or history. Null when the file must not be written.
   */
  private prepareSave(): unknown {
    const disk = this.read()
    if (!disk) return null
    this.adopt(disk)
    return { version: 1, snapshots: Object.fromEntries(this.snapshots), samples: this.samples, cleared: Object.fromEntries(this.cleared) }
  }

  private async saveAsync(): Promise<void> {
    if (!this.dirty || this.readOnly) return
    this.dirty = false
    try {
      const data = this.prepareSave()
      if (data) await writeJsonAtomicAsync(this.deps.filePath, data)
    } catch (err) {
      this.dirty = true
      console.warn('[SubscriptionUsage] save failed:', err)
      this.scheduleSave()
    }
  }

  /**
   * Write pending changes now, synchronously (app quit). An async write
   * already mid-rename can still land after this one; as with
   * token-usage.service.ts's flush, that costs at most one debounce window.
   */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (!this.dirty || this.readOnly) return
    try {
      const data = this.prepareSave()
      if (data) writeJsonAtomic(this.deps.filePath, data)
      this.dirty = false
    } catch (err) {
      console.warn('[SubscriptionUsage] save failed:', err)
    }
  }
}

export function defaultFilePath(userData: string): string {
  return join(userData, 'subscription-usage.json')
}
