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

import type { NotificationsSnapshot, PendingNotification, ResolvedNotification } from '../../shared/types/ipc.types'
import { noticeKey } from '../../shared/runtime-tag'
import { newFinished, seedFinished } from '../../shared/utils/finished-notices'

/** The Settings → Notifications switches the policy reads per notification. */
export interface NotificationPreferences {
  /** `nativeNotificationsEnabled`: OS notifications at all. Flipping it off silences the very next one. */
  enabled: boolean
  /** `finishedNotificationsEnabled`: 'finished' notices (bell rows, in-app and OS notices). */
  finished: boolean
  /** `inAppNotificationsEnabled`: in-app notices under the bell; while on, a focused window gets no OS notification. */
  inApp: boolean
  /** `notificationPreviewsEnabled`: OS notification bodies carry the question or reply text. */
  previews: boolean
}

/** Read the preferences from Studio's settings (client keys). Absent keys are on. */
export function notificationPreferences(settings: { get(key: string): unknown } | null | undefined): NotificationPreferences {
  return {
    enabled: settings?.get('nativeNotificationsEnabled') !== false,
    finished: settings?.get('finishedNotificationsEnabled') !== false,
    inApp: settings?.get('inAppNotificationsEnabled') !== false,
    previews: settings?.get('notificationPreviewsEnabled') !== false,
  }
}

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
  /** Settings → Notifications, read per notification (notificationPreferences). */
  preferences(): NotificationPreferences
  /**
   * True when the window that shows `entry` has focus — the one case we stay
   * silent. Embedded: any app window. Daemon mode with agent windows: the
   * window that owns the entry's notice (agent-windows.md).
   */
  isWindowFocused(entry: PendingNotification): boolean
  now(): number
  /** Show a toast. Returns null when the platform declined to create one. */
  show(request: NativeToastRequest): NativeToastHandle | null
  /** Focus the window and open this agent, revealing the request. */
  reveal(entry: PendingNotification): void
  /** Focus the window and open the notifications (bell) panel. */
  openPanel(): void
  /**
   * The name of the entry's runtime, named before its agent while Studio
   * has more than one runtime (docs/design/multi-runtime.md §6.1); null or
   * absent: the agent alone, as before.
   */
  runtimeName?(entry: PendingNotification): string | null
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

function displayName(entry: Pick<PendingNotification, 'agentName' | 'loop'>, runtime?: string | null): string {
  const agent = entry.loop && entry.loop !== 'main' ? `${entry.agentName} · ${entry.loop}` : entry.agentName
  return runtime ? `${runtime} · ${agent}` : agent
}

/** 'loop2 needs approval' / 'loop2 asked a question' / 'loop2 finished'. */
export function notificationTitle(entry: PendingNotification, runtime?: string | null): string {
  if (entry.kind === 'finished') return `${displayName(entry, runtime)} finished`
  return entry.kind === 'ask'
    ? `${displayName(entry, runtime)} asked a question`
    : `${displayName(entry, runtime)} needs approval`
}

/**
 * Body text. The hub already redacted and truncated `preview`, so this only
 * decides what it sits next to: an approval leads with the tool being gated,
 * a question is its own body.
 */
export function notificationBody(entry: PendingNotification, previews = true): string {
  if (entry.kind === 'finished') return previews ? entry.preview : 'Turn complete'
  if (entry.kind === 'ask') return previews ? entry.preview : 'Question waiting'
  if (!previews) return entry.toolName ?? 'Approval waiting'
  return entry.toolName ? `${entry.toolName} — ${entry.preview}` : entry.preview
}

/** '5 approvals waiting' / '5 questions waiting' / '5 finished turns' / '5 notifications'. */
export function summaryTitle(entries: PendingNotification[]): string {
  const count = (kind: PendingNotification['kind']) => entries.reduce((n, e) => n + (e.kind === kind ? 1 : 0), 0)
  const total = entries.length
  if (count('approval') === total) return `${total} approvals waiting`
  if (count('ask') === total) return `${total} questions waiting`
  if (count('finished') === total) return `${total} finished turns`
  return count('finished') === 0 ? `${total} notifications waiting` : `${total} notifications`
}

/** Which agents are blocked, deduped — the summary's one useful detail. */
export function summaryBody(entries: PendingNotification[], runtimeName?: (entry: PendingNotification) => string | null): string {
  const names: string[] = []
  for (const entry of entries) {
    const name = displayName(entry, runtimeName?.(entry))
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
  /** 'finished' history rows already decided about, pruned to the live history page. */
  private readonly knownFinished = new Set<string>()
  private burstStartedAt = 0
  private burstEntries: PendingNotification[] = []
  /** This burst's 'finished' toasts: not in `shown` (nothing answers them), retracted only by the summary. */
  private burstFinishedToasts: NativeToastHandle[] = []
  private summary: NativeToastHandle | null = null

  constructor(private readonly platform: NativeNotifierPlatform) {}

  /**
   * Adopt a snapshot's pending ids WITHOUT announcing them. Used when the
   * notifier attaches to a hub that is already holding requests (a late
   * attach, a test) — those were not raised just now, and a toast for each
   * would be a lie about when they happened.
   */
  seed(pending: PendingNotification[], history: ResolvedNotification[] = []): void {
    for (const entry of pending) this.known.add(noticeKey(entry.runtimeId, entry.id))
    seedFinished(history, this.knownFinished)
  }

  /**
   * Drive one hub snapshot through the policy. Arrivals are the ids we have
   * not seen; departures are ids we knew that are no longer pending.
   */
  apply(snapshot: NotificationsSnapshot): void {
    const pending = snapshot.pending ?? []
    // Keyed across runtimes: equal ids on two runtimes stay two requests (multi-runtime.md §6.1).
    const live = new Set(pending.map((entry) => noticeKey(entry.runtimeId, entry.id)))

    // Departures first: something answered elsewhere must not keep a clickable
    // toast on screen, and its id must be forgettable so a genuine
    // re-registration later still counts as new.
    for (const [id, handle] of [...this.shown]) {
      if (live.has(id)) continue
      this.shown.delete(id)
      closeQuietly(handle)
    }
    // The last pending request just left: a summary of them is stale. A push
    // with nothing pending before or after (a 'finished' row) leaves the burst.
    const hadPending = this.known.size > 0
    for (const id of [...this.known]) {
      if (!live.has(id)) this.known.delete(id)
    }
    if (hadPending && live.size === 0) this.endBurst()

    const arrivals = pending.filter((entry) => !this.known.has(noticeKey(entry.runtimeId, entry.id)))
    // Mark seen even when we decide not to toast: a request the user was
    // focused for is not "new" again the moment they alt-tab away.
    for (const entry of arrivals) this.known.add(noticeKey(entry.runtimeId, entry.id))

    // 'finished' never pends: it arrives as a new history row.
    const finished = newFinished(snapshot.history ?? [], this.knownFinished, this.platform.now())
    if (arrivals.length === 0 && finished.length === 0) return

    const prefs = this.platform.preferences()
    if (!prefs.enabled) return
    if (!this.platform.isSupported()) return
    // A focused window shows the in-app notice and the bell; with in-app
    // notices off, the OS notification is the only notice, focused or not.
    const announced = (entry: PendingNotification) => !prefs.inApp || !this.platform.isWindowFocused(entry)
    for (const entry of arrivals) if (announced(entry)) this.announce(entry, prefs)
    if (prefs.finished) for (const entry of finished) if (announced(entry)) this.announce(entry, prefs)
  }

  /** Close everything still on screen (app shutdown). */
  dispose(): void {
    for (const handle of this.shown.values()) closeQuietly(handle)
    this.shown.clear()
    this.known.clear()
    this.knownFinished.clear()
    this.endBurst()
  }

  private announce(entry: PendingNotification, prefs: NotificationPreferences): void {
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
        const key = noticeKey(shownEntry.runtimeId, shownEntry.id)
        const handle = this.shown.get(key)
        if (!handle) continue
        this.shown.delete(key)
        closeQuietly(handle)
      }
      for (const handle of this.burstFinishedToasts) closeQuietly(handle)
      this.burstFinishedToasts = []
      if (this.summary) closeQuietly(this.summary)
      const entries = [...this.burstEntries]
      this.summary = this.platform.show({
        title: summaryTitle(entries),
        body: summaryBody(entries, (e) => this.platform.runtimeName?.(e) ?? null),
        onClick: () => this.platform.openPanel(),
      })
      return
    }

    const handle = this.platform.show({
      title: notificationTitle(entry, this.platform.runtimeName?.(entry) ?? null),
      body: notificationBody(entry, prefs.previews),
      onClick: () => this.platform.reveal(entry),
    })
    // Only a pending request can be answered elsewhere and need retracting;
    // a 'finished' notice stays until the OS, the user or this burst's summary closes it.
    if (!handle) return
    if (entry.kind === 'finished') this.burstFinishedToasts.push(handle)
    else this.shown.set(noticeKey(entry.runtimeId, entry.id), handle)
  }

  private endBurst(): void {
    if (this.summary) closeQuietly(this.summary)
    this.summary = null
    this.burstEntries = []
    this.burstFinishedToasts = []
    this.burstStartedAt = 0
  }
}

/** A toast the OS already dismissed throws on close in some Electron builds. */
function closeQuietly(handle: NativeToastHandle): void {
  try { handle.close() } catch { /* already gone */ }
}
