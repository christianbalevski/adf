import type { SavedRemote } from '../../cli/remotes'
import {
  CLOSED_WINDOW_SENTENCE,
  LOCAL_RUNTIME,
  notConnectedSentence,
  otherRuntimeSentence,
  type RuntimeId,
} from '../../../shared/runtime-tag'
import type { DaemonModeContext } from './context'
import type { RuntimeConnection } from './runtime-connection'
import type { WindowTarget } from './index'
import type { WindowView } from './windows'

/**
 * The runtime set of one Studio (docs/design/multi-runtime.md §3): the
 * primary runtime (`local` in local mode) and, in phase 1 behind the
 * development flag, one RuntimeConnection per saved connection.
 *
 * - Order is fixed (§3.1, §12 item 5): the primary first, then the remotes in
 *   the order this launch first saw them; remotes seen together are ordered
 *   by `pairedAt`, then name.
 * - `sync(saved)` connects what appeared and disconnects what disappeared
 *   (§12 item 2: saving connects, forgetting disconnects).
 * - `contextFor(window, runtime)` is §4.3's routing table.
 * - An unreachable or failed runtime affects only its own windows and calls.
 */

/** A call the routing table refuses (§4.3). The message is the sentence the renderer shows. */
export class RuntimeRouteError extends Error {
  constructor(message: string) {
    // Named Error: the renderer sees "Error: <sentence>", as for every refusal before.
    super(message)
  }
}

export interface RuntimeManagerOptions {
  primary: RuntimeConnection
  /** A RuntimeConnection for a saved connection (`remote:<name>`). */
  create(id: RuntimeId, name: string): RuntimeConnection
  /** Agent windows that closed: calls from them are refused. Shared with every RuntimeConnection. */
  closedWindows: Set<number>
  /** Close an agent window (its runtime left the set, or was replaced). */
  closeWindow?: (windowId: number) => void
  /** A runtime left the set or was replaced: its approvals and notices go. */
  onRemoved?: (id: RuntimeId) => void
  /** The set or its order changed. */
  onChange?: () => void
  log: Pick<Console, 'log' | 'warn' | 'error'>
}

/** The id of a saved connection. */
export function savedRuntimeId(name: string): RuntimeId {
  return `remote:${name}`
}

/**
 * The order of the remotes (§3.1): `previous` kept as it is, minus ids no
 * longer saved; ids not in it appended in `pairedAt` order, then by name.
 */
export function runtimeOrder(previous: readonly RuntimeId[], saved: Record<string, Pick<SavedRemote, 'pairedAt'>>): RuntimeId[] {
  const ids = new Map(Object.entries(saved).map(([name, r]) => [savedRuntimeId(name), { name, pairedAt: r.pairedAt ?? '' }]))
  const kept = previous.filter((id) => ids.has(id))
  const added = [...ids].filter(([id]) => !kept.includes(id))
    .sort(([, a], [, b]) => (a.pairedAt < b.pairedAt ? -1 : a.pairedAt > b.pairedAt ? 1 : a.name.localeCompare(b.name)))
    .map(([id]) => id)
  return [...kept, ...added]
}

export class RuntimeManager {
  private order: RuntimeId[] = []
  private readonly remotes = new Map<RuntimeId, RuntimeConnection>()
  /** webContents id of an agent window → its runtime (main binds it at open, §5.5). */
  private readonly windowRuntime = new Map<number, RuntimeId>()
  /** The runtime of the main window's open file (§4.3). */
  private mainOpen: RuntimeId
  private disposed = false

  constructor(private readonly opts: RuntimeManagerOptions) {
    this.mainOpen = opts.primary.id
  }

  get primary(): RuntimeConnection {
    return this.opts.primary
  }

  /** Every runtime in the set, in order: the primary first. */
  runtimes(): RuntimeConnection[] {
    return [this.opts.primary, ...this.order.map((id) => this.remotes.get(id)!).filter(Boolean)]
  }

  /** The runtime `id`, or null when it is not in the set. `local` names the primary in local mode. */
  get(id: RuntimeId | null | undefined): RuntimeConnection | null {
    if (id === null || id === undefined || id === this.opts.primary.id) return this.opts.primary
    return this.remotes.get(id) ?? null
  }

  /** Follow the saved connections (cli-remotes.json): connect what appeared, disconnect what disappeared. */
  sync(saved: Record<string, SavedRemote>): void {
    if (this.disposed) return
    const next = runtimeOrder(this.order, saved).filter((id) => id !== this.opts.primary.id)
    const gone = this.order.filter((id) => !next.includes(id))
    const added = next.filter((id) => !this.remotes.has(id))
    for (const id of gone) void this.remove(id, 'it is no longer saved')
    for (const id of added) {
      const name = id.slice('remote:'.length)
      this.opts.log.log(`[Runtimes] ${name} is saved: connecting (${id})`)
      this.remotes.set(id, this.opts.create(id, name))
    }
    const changed = gone.length > 0 || added.length > 0 || next.join('\n') !== this.order.join('\n')
    this.order = next
    if (changed) {
      this.opts.log.log(`[Runtimes] Runtime set: ${[this.opts.primary.id, ...this.order].join(', ')}`)
      this.opts.onChange?.()
    }
  }

  /**
   * §4.3: the context of a call from `windowId` (undefined: no sender) tagged
   * with `runtimeId` (null: no tag). Throws RuntimeRouteError with the
   * refusal sentence.
   */
  contextFor(windowId: number | undefined, runtimeId: RuntimeId | null): DaemonModeContext {
    if (windowId !== undefined && this.opts.closedWindows.has(windowId)) throw new RuntimeRouteError(CLOSED_WINDOW_SENTENCE)
    const target = runtimeId === null ? this.opts.primary : this.get(runtimeId)
    if (!target) throw new RuntimeRouteError(notConnectedSentence(runtimeId ?? LOCAL_RUNTIME))
    const bound = windowId === undefined ? undefined : this.windowRuntime.get(windowId)
    if (bound === undefined) return target.ctx
    const own = this.get(bound)
    if (!own) throw new RuntimeRouteError(CLOSED_WINDOW_SENTENCE)
    if (runtimeId !== null && own !== target) throw new RuntimeRouteError(otherRuntimeSentence(own.name()))
    const ctx = own.windows.ctx(windowId!)
    if (!ctx) throw new RuntimeRouteError(CLOSED_WINDOW_SENTENCE)
    return ctx
  }

  /** The runtime of an agent window; null for the main window or an unknown sender. */
  runtimeOfWindow(windowId: number): RuntimeConnection | null {
    const id = this.windowRuntime.get(windowId)
    return id === undefined ? null : this.get(id)
  }

  /** A new agent window on `runtimeId` (default the primary): its session opens there. */
  openWindow(target: WindowTarget, runtimeId?: RuntimeId | null): void {
    const runtime = this.get(runtimeId)
    if (!runtime) throw new RuntimeRouteError(notConnectedSentence(runtimeId!))
    this.windowRuntime.set(target.id, runtime.id)
    runtime.windows.open(target)
  }

  async closeWindow(windowId: number): Promise<void> {
    const runtime = this.runtimeOfWindow(windowId)
    this.windowRuntime.delete(windowId)
    await runtime?.windows.close(windowId)
  }

  /** The runtime of the main window's open file (§4.3, §4.4). */
  mainOpenRuntime(): RuntimeConnection {
    return this.get(this.mainOpen) ?? this.opts.primary
  }

  /** The main window opened a file on `id`. */
  setMainOpenRuntime(id: RuntimeId): void {
    if (id === this.mainOpen || !this.get(id)) return
    this.opts.log.log(`[Runtimes] The main window's open agent is on ${id}`)
    this.mainOpen = id
  }

  /** Every window as the notice rule sees it (§6.1), with the main window's view. */
  windowViews(main: { id: number; focused: boolean } | null): WindowView[] {
    const views: WindowView[] = []
    if (main) {
      const rt = this.mainOpenRuntime()
      views.push({ id: main.id, main: true, focused: main.focused, filePath: rt.session.filePath, ...(rt.primary ? {} : { runtimeId: rt.id }) })
    }
    for (const rt of this.runtimes()) views.push(...rt.windows.views())
    return views
  }

  /** How many agent windows are open, on every runtime. */
  windowCount(): number {
    return this.runtimes().reduce((n, rt) => n + rt.windows.ids().length, 0)
  }

  /**
   * Reconnect a failed runtime other than the primary (§3.4): its
   * RuntimeConnection is replaced; Studio does not restart. Its agent windows
   * kept their unsaved text first (the connection's reconnect); they close.
   */
  async replace(id: RuntimeId): Promise<void> {
    const old = this.remotes.get(id)
    if (!old || this.disposed) return
    this.opts.log.log(`[Runtimes] Reconnecting ${id}: its connection is replaced`)
    await this.retire(old)
    if (this.disposed || !this.order.includes(id)) return
    this.remotes.set(id, this.opts.create(id, old.name()))
    this.opts.onChange?.()
  }

  /** A runtime left the set (§3.3 Remove): its agent windows close, its sessions end (bounded), it is disposed. */
  async remove(id: RuntimeId, why: string): Promise<void> {
    const runtime = this.remotes.get(id)
    if (!runtime) return
    this.opts.log.log(`[Runtimes] Disconnecting ${id}: ${why}`)
    this.order = this.order.filter((o) => o !== id)
    await this.retire(runtime)
    this.opts.onChange?.()
  }

  private async retire(runtime: RuntimeConnection): Promise<void> {
    const windows = runtime.windows.ids()
    for (const windowId of windows) {
      this.windowRuntime.delete(windowId)
      this.opts.closeWindow?.(windowId)
    }
    if (this.mainOpen === runtime.id) this.mainOpen = this.opts.primary.id
    await runtime.shutdown().catch((err) => this.opts.log.warn(`[Runtimes] Ending the sessions of ${runtime.id} failed:`, err))
    if (this.remotes.get(runtime.id) === runtime) this.remotes.delete(runtime.id)
    this.opts.onRemoved?.(runtime.id)
    this.opts.log.log(`[Runtimes] ${runtime.id} disconnected${windows.length ? `; ${windows.length} agent window(s) closed` : ''}`)
  }

  /**
   * Quit (§3.3): every runtime in parallel, each ending its agent-window
   * sessions first, then the main window's. The primary follows
   * keepDaemonRunning; a remote's daemon keeps running.
   */
  async shutdown(opts: { waitForDaemonExitMs?: number; keepDaemonRunning?: boolean } = {}): Promise<void> {
    this.disposed = true
    const others = [...this.remotes.values()]
    await Promise.all([
      this.opts.primary.shutdown(opts),
      ...others.map((rt) => rt.shutdown().catch((err) => this.opts.log.warn(`[Runtimes] Quit: ending the sessions of ${rt.id} failed:`, err))),
    ])
  }
}
