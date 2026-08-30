/**
 * The global HIL notification hub.
 *
 * Every request an executor raises that BLOCKS on a human — a tool approval or
 * an `ask` question — is registered here the moment it is emitted, and removed
 * the moment it is answered, times out, or its agent is torn down. The renderer
 * gets a full snapshot on every change, so the title bar can show "3 agents are
 * waiting on you" no matter which agent is open — including agents running in
 * the BACKGROUND, whose in-chat card is not rendered anywhere.
 *
 * It is also the single source of truth for the fleet map's per-agent pending
 * badge (`mesh-graph.store.pendingInteractions`), which previously kept its own
 * ad-hoc feed: a 5s pull plus live events that, for background agents, had no
 * resolved-event to clear them, so a badge could stick until the next poll.
 *
 * Why a registry and not "ask the executors":
 *
 *   Pending requests live only in executor memory (`pendingHilTasks` /
 *   `pendingAsks`), and the teardown paths (`abort()`, the chat-interrupt
 *   drain, an owner state transition) clear those maps WITHOUT emitting a
 *   resolved event. A renderer that built its list from events alone would keep
 *   rows that can never resolve — the failure this hub is designed against. The
 *   executor calls `unregister` from the same helpers that mutate those maps,
 *   so a hub row and an executor row are created and destroyed together.
 *
 * Resolution is NOT a second mechanism: each entry carries a callback bound to
 * its own executor's `resolveApproval(requestId, approved, feedback)` — the
 * exact method the in-chat approval card's IPC handler calls. Resolving from
 * the hub therefore emits the same `tool_approval_resolved` event and clears
 * the in-chat card too. Asks are registered but NOT resolvable here: an answer
 * is prose, so the UI jumps to the agent's chat rather than faking a composer.
 *
 * Everything that LEAVES the pending list lands in a small, session-scoped
 * history (newest first, capped at HISTORY_MAX) carrying how it ended. The menu
 * is a notification centre, not a queue: a bell that empties itself the instant
 * you answer gives you no way to check what you just did, and no way to tell
 * "I approved that" from "that agent was torn down before I looked".
 */

import type {
  NotificationOutcome,
  NotificationsSnapshot,
  PendingNotification,
  PendingNotificationKind,
  ResolvedNotification,
} from '../../shared/types/ipc.types'

export type {
  NotificationOutcome,
  NotificationsSnapshot,
  PendingNotification,
  PendingNotificationKind,
  ResolvedNotification,
} from '../../shared/types/ipc.types'

interface RegisteredNotification extends PendingNotification {
  /**
   * Bound to the emitting executor's resolveApproval — see file header.
   * Absent for asks, which the hub can only surface, never answer.
   */
  resolve?: (approved: boolean, feedback?: string) => void
}

export interface ApprovalResolveResult {
  success: boolean
  error?: string
}

export const PREVIEW_MAX = 120

/**
 * How many resolved rows the menu remembers. Deliberately small and in-memory
 * only: this is "what did I just answer?", not an audit log — the umbilical
 * (`hil.resolved`, `ask.resolved`) is the durable record.
 */
export const HISTORY_MAX = 50

/** Hub key. Ask ids are a per-executor counter, so they need the agent + loop. */
export function notificationKey(filePath: string, loop: string, requestId: string): string {
  return `${filePath}|${loop}|${requestId}`
}

/** Keys whose values never appear in a preview, however they are nested. */
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[_-]?key|credential|auth|private[_-]?key|cookie|session)/i

/** Internal flags the model never typed — noise in a one-line preview. */
const INTERNAL_KEY_PATTERN = /^_/

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= 3) return '…'
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_KEY_PATTERN.test(key)) continue
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(raw, depth + 1)
  }
  return out
}

/**
 * One-line summary of a tool call's arguments.
 *
 * Mirrors the in-chat approval card's precedence (AgentLoop.tsx): the model's
 * own `_reason` if it wrote one, else the shell command, else a compact JSON
 * dump — so the same call reads the same way in both surfaces.
 */
export function summarizeApprovalArgs(input: unknown): string {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null

  let text: string
  const reason = record?._reason
  const command = record?.command
  if (typeof reason === 'string' && reason.trim()) {
    text = reason.trim()
  } else if (typeof command === 'string' && command.trim()) {
    text = command.trim()
  } else if (record) {
    try { text = JSON.stringify(redact(record)) } catch { text = '' }
  } else if (input === undefined || input === null) {
    text = ''
  } else {
    try { text = JSON.stringify(input) } catch { text = '' }
  }

  return truncateLine(text) || 'no arguments'
}

/** Collapse to one line and cap at PREVIEW_MAX. Shared by both kinds. */
export function truncateLine(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat || flat === '{}') return ''
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat
}

/** One-line preview of an `ask` question. */
export function summarizeQuestion(question: string): string {
  return truncateLine(question) || 'The agent is waiting for your answer'
}

export class ApprovalHub {
  private entries = new Map<string, RegisteredNotification>()
  /** Newest first, capped at HISTORY_MAX. Session-scoped, never persisted. */
  private history: ResolvedNotification[] = []
  private listeners = new Set<(snapshot: NotificationsSnapshot) => void>()

  /**
   * Register a pending request. Idempotent per id: a re-register (e.g. both
   * the foreground host and the background manager observing the same
   * executor during a handoff) replaces the row rather than duplicating it.
   */
  register(entry: RegisteredNotification): void {
    const existing = this.entries.get(entry.id)
    // Keep the original requestedAt so "age" does not reset on a re-register.
    this.entries.set(entry.id, existing ? { ...entry, requestedAt: existing.requestedAt } : entry)
    this.notify()
  }

  /**
   * Drop one entry and record how it ended. Returns false when it was already
   * gone (no notify, no duplicate history row) — which is exactly what makes a
   * double-resolve, a resolve-after-timeout and a hub-initiated resolve (the
   * hub removes its own row first, then the executor calls back in here)
   * idempotent on both sides.
   *
   * The default outcome is 'expired': every caller that ends a request WITHOUT
   * a human decision — the drains, teardown — omits the argument, so forgetting
   * to pass one can never mislabel a timeout as a rejection.
   */
  unregister(id: string, outcome: NotificationOutcome = 'expired'): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    this.remember(entry, outcome)
    this.notify()
    return true
  }

  /**
   * Drop every entry for an agent. Teardown already drains the executor's
   * pending map (which unregisters each entry), so this is the safety net for
   * a host that disposes an agent by another route — an orphaned row that can
   * never resolve is worse than a missing one.
   */
  unregisterAgent(filePath: string): number {
    let removed = 0
    for (const [id, entry] of this.entries) {
      if (entry.filePath !== filePath) continue
      this.entries.delete(id)
      // Teardown is not an answer — these read as 'expired' in the history.
      this.remember(entry, 'expired')
      removed++
    }
    if (removed > 0) this.notify()
    return removed
  }

  /**
   * Resolve from a global surface (title-bar panel). Routes to the emitting
   * executor's own `resolveApproval`, i.e. the in-chat card's path.
   *
   * A double-resolve, a resolve after the auto-deny timeout, and a resolve
   * after the agent stopped all land here with the entry already gone and
   * return `{ success: false }` with a reason rather than throwing or
   * silently doing nothing.
   */
  resolve(filePath: string, approvalId: string, approved: boolean, feedback?: string): ApprovalResolveResult {
    const entry = this.entries.get(approvalId)
    if (!entry) {
      return { success: false, error: 'This approval is no longer pending — it was already resolved, timed out, or its agent stopped.' }
    }
    if (entry.filePath !== filePath) {
      return { success: false, error: 'Approval belongs to a different agent.' }
    }
    if (!entry.resolve) {
      // Asks need prose, not a verdict. The UI offers "Respond" (jump to the
      // agent's chat) instead of Approve/Reject, and this guards the IPC.
      return { success: false, error: 'This request needs a typed answer — open the agent to respond.' }
    }
    // Delete BEFORE resolving: the executor's resolve path calls back into
    // unregister(), and a concurrent second click must find nothing.
    const resolveEntry = entry.resolve
    this.entries.delete(approvalId)
    this.remember(entry, approved ? 'approved' : 'rejected')
    this.notify()
    resolveEntry(approved, feedback)
    return { success: true }
  }

  /** Oldest first — the thing that has been blocking longest reads first. */
  snapshot(): PendingNotification[] {
    return [...this.entries.values()]
      .map(({ resolve: _resolve, ...rest }) => rest)
      .sort((a, b) => a.requestedAt - b.requestedAt)
  }

  /** Recently resolved, newest first. A copy — callers must not mutate it. */
  historySnapshot(): ResolvedNotification[] {
    return [...this.history]
  }

  /** Pending + history in one object — the shape pushed to every window. */
  fullSnapshot(): NotificationsSnapshot {
    return { pending: this.snapshot(), history: this.historySnapshot() }
  }

  /**
   * Move an entry into the bounded history. The raw tool `input` and the
   * resolve callback are dropped: one is only useful while the request is live,
   * the other would pin the executor for the life of the history.
   */
  private remember(entry: RegisteredNotification, outcome: NotificationOutcome): void {
    const { resolve: _resolve, input: _input, ...rest } = entry
    this.history.unshift({ ...rest, outcome, resolvedAt: Date.now() })
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX
  }

  count(): number {
    return this.entries.size
  }

  /** How many rows of one kind are pending (badge segmentation). */
  countOfKind(kind: PendingNotificationKind): number {
    let total = 0
    for (const entry of this.entries.values()) if (entry.kind === kind) total++
    return total
  }

  subscribe(listener: (snapshot: NotificationsSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Test/reset hook — drops entries without resolving them, and forgets the
   * history too. Not a teardown path: nothing here is recorded as 'expired',
   * because a reset is the absence of a session, not the end of one.
   */
  clear(): void {
    const had = this.entries.size > 0 || this.history.length > 0
    this.entries.clear()
    this.history = []
    if (had) this.notify()
  }

  private notify(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.fullSnapshot()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch (err) {
        console.error('[ApprovalHub] listener failed:', err)
      }
    }
  }
}

/**
 * Process-wide singleton. Executors register into it unconditionally; hosts
 * that have no UI (daemon, CLI, tests) simply never subscribe, so the hub is
 * an inert map for them.
 */
export const approvalHub = new ApprovalHub()
