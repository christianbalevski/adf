/**
 * OS-level notifications for the approvals/asks hub.
 *
 * The in-app toast (ApprovalsMenu's `ApprovalToasts`) only helps someone who is
 * LOOKING at Studio. An agent that blocks on a human while the window is
 * minimised, buried behind an editor, or on another desktop is invisible — and
 * because HIL blocks the executor, "invisible" means "stalled until you happen
 * to alt-tab back". This bridges exactly that gap and nothing more:
 *
 *   - a native toast fires ONLY when no app window is focused. A focused window
 *     already has the in-app toast plus the bell badge, and two notices for one
 *     event is noise;
 *   - clicking one restores/focuses the window and jumps to the agent through
 *     the SAME renderer path the bell's row click uses;
 *   - a burst collapses. Five agents unblocking at once must not stack five OS
 *     toasts; past the threshold they are replaced by a single "5 approvals
 *     waiting" that opens the bell panel;
 *   - a toast for a request that has already been answered elsewhere (in-chat
 *     card, the bell, an auto-deny timeout) is closed, best effort, so clicking
 *     a stale notification cannot be the only way you learn it is gone.
 *
 * Everything Electron- and window-shaped lives behind `NativeNotifierPlatform`
 * so the policy above is testable as pure state: the tests drive `apply()` with
 * hub snapshots and a fake platform, exactly as the real wiring drives it from
 * `approvalHub.subscribe`.
 */

import type { NotificationsSnapshot, PendingNotification } from '../../shared/types/ipc.types'

/** A live OS notification we can still retract. */
export interface NativeToastHandle {
  close(): void
}

export interface NativeToastRequest {
  title: string
  body: string
  /** Invoked on the OS notification's click/activation. */
  onClick: () => void
}

/**
 * Everything the policy needs from the outside world. The production
 * implementation (src/main/ipc/index.ts) wires these to Electron's
 * `Notification`, `BrowserWindow.getFocusedWindow()` and the settings store.
 */
export interface NativeNotifierPlatform {
  /** `Notification.isSupported()` — false on headless/unsupported sessions. */
  isSupported(): boolean
  /** The user's "System notifications" toggle. Checked per notification, so
   *  flipping it off silences the very next one without a restart. */
  isEnabled(): boolean
  /** True when ANY app window has focus — the one case we stay silent. */
  isWindowFocused(): boolean
  now(): number
  /** Show a toast. Returns null when the platform declined to create one. */
  show(request: NativeToastRequest): NativeToastHandle | null
  /** Focus the window and open this agent, revealing the request. */
  reveal(entry: PendingNotification): void
  /** Focus the window and open the notifications (bell) panel. */
  openPanel(): void
}

/**
 * How long a run of arrivals counts as ONE burst. Long enough to catch a fleet
 * of background agents hitting the same gate on the same tick, short enough
 * that two unrelated requests a few seconds apart still read as two events.
 */
export const COALESCE_WINDOW_MS = 2_000

/**
 * More than this many inside one window collapses to a summary. Three toasts
 * is the most an OS notification stack shows without becoming a wall.
 */
export const COALESCE_THRESHOLD = 3

function displayName(entry: Pick<PendingNotification, 'agentName' | 'loop'>): string {
  return entry.loop && entry.loop !== 'main' ? `${entry.agentName} · ${entry.loop}` : entry.agentName
}

/** 'loop2 needs approval' / 'loop2 asked a question'. */
export function notificationTitle(entry: PendingNotification): string {
  return entry.kind === 'ask'
    ? `${displayName(entry)} asked a question`
    : `${displayName(entry)} needs approval`
}

/**
 * Body text. The hub already redacted and truncated `preview`, so this only
 * decides what it sits next to: an approval leads with the tool being gated,
 * a question is its own body.
 */
export function notificationBody(entry: PendingNotification): string {
  if (entry.kind === 'ask') return entry.preview
  return entry.toolName ? `${entry.toolName} — ${entry.preview}` : entry.preview
}

/** '5 approvals waiting' / '5 questions waiting' / '5 notifications waiting'. */
export function summaryTitle(entries: PendingNotification[]): string {
  const asks = entries.reduce((n, e) => n + (e.kind === 'ask' ? 1 : 0), 0)
  const total = entries.length
  if (asks === 0) return `${total} approvals waiting`
  if (asks === total) return `${total} questions waiting`
  return `${total} notifications waiting`
}

/** Which agents are blocked, deduped — the summary's one useful detail. */
export function summaryBody(entries: PendingNotification[]): string {
  const names: string[] = []
  for (const entry of entries) {
    const name = displayName(entry)
    if (!names.includes(name)) names.push(name)
  }
  const head = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${head} and ${names.length - 3} more` : head
}

export class NativeNotifier {
  /** Live per-request toasts, keyed by hub id, so a resolve can retract them. */
  private readonly shown = new Map<string, NativeToastHandle>()
  /** Ids we have already decided about — the "is this NEW?" test. */
  private readonly known = new Set<string>()
  private burstStartedAt = 0
  private burstEntries: PendingNotification[] = []
  private summary: NativeToastHandle | null = null

  constructor(private readonly platform: NativeNotifierPlatform) {}

  /**
   * Adopt a snapshot's pending ids WITHOUT announcing them. Used when the
   * notifier attaches to a hub that is already holding requests (a late
   * attach, a test) — those were not raised just now, and a toast for each
   * would be a lie about when they happened.
   */
  seed(pending: PendingNotification[]): void {
    for (const entry of pending) this.known.add(entry.id)
  }

  /**
   * Drive one hub snapshot through the policy. Arrivals are the ids we have
   * not seen; departures are ids we knew that are no longer pending.
   */
  apply(snapshot: NotificationsSnapshot): void {
    const pending = snapshot.pending ?? []
    const live = new Set(pending.map((entry) => entry.id))

    // Departures first: something answered elsewhere must not keep a clickable
    // toast on screen, and its id must be forgettable so a genuine
    // re-registration later still counts as new.
    for (const [id, handle] of [...this.shown]) {
      if (live.has(id)) continue
      this.shown.delete(id)
      closeQuietly(handle)
    }
    for (const id of [...this.known]) {
      if (!live.has(id)) this.known.delete(id)
    }
    if (live.size === 0) this.endBurst()

    const arrivals = pending.filter((entry) => !this.known.has(entry.id))
    // Mark seen even when we decide not to toast: a request the user was
    // focused for is not "new" again the moment they alt-tab away.
    for (const entry of arrivals) this.known.add(entry.id)
    if (arrivals.length === 0) return

    if (!this.platform.isEnabled()) return
    if (!this.platform.isSupported()) return
    // The whole point: the in-app toast owns the focused case.
    if (this.platform.isWindowFocused()) return

    for (const entry of arrivals) this.announce(entry)
  }

  /** Close everything still on screen (app shutdown). */
  dispose(): void {
    for (const handle of this.shown.values()) closeQuietly(handle)
    this.shown.clear()
    this.known.clear()
    this.endBurst()
  }

  private announce(entry: PendingNotification): void {
    const now = this.platform.now()
    if (this.burstStartedAt === 0 || now - this.burstStartedAt > COALESCE_WINDOW_MS) {
      this.endBurst()
      this.burstStartedAt = now
    }
    this.burstEntries.push(entry)

    if (this.burstEntries.length > COALESCE_THRESHOLD) {
      // Past the threshold the burst becomes ONE notice: retract the
      // individual toasts it already produced and re-issue the summary with
      // the current count (the OS has no "edit this toast").
      for (const shownEntry of this.burstEntries) {
        const handle = this.shown.get(shownEntry.id)
        if (!handle) continue
        this.shown.delete(shownEntry.id)
        closeQuietly(handle)
      }
      if (this.summary) closeQuietly(this.summary)
      const entries = [...this.burstEntries]
      this.summary = this.platform.show({
        title: summaryTitle(entries),
        body: summaryBody(entries),
        onClick: () => this.platform.openPanel(),
      })
      return
    }

    const handle = this.platform.show({
      title: notificationTitle(entry),
      body: notificationBody(entry),
      onClick: () => this.platform.reveal(entry),
    })
    if (handle) this.shown.set(entry.id, handle)
  }

  private endBurst(): void {
    if (this.summary) closeQuietly(this.summary)
    this.summary = null
    this.burstEntries = []
    this.burstStartedAt = 0
  }
}

/** A toast the OS already dismissed throws on close in some Electron builds. */
function closeQuietly(handle: NativeToastHandle): void {
  try { handle.close() } catch { /* already gone */ }
}
