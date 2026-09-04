import { useCallback, useEffect, useRef, useState } from 'react'
import { approvalsBridge, useApprovalsStore } from '../../stores/approvals.store'
import { useJumpToAgent } from '../../hooks/useJumpToAgent'
import { loopColor } from '../../utils/loop-color'
import type { NotificationOutcome, PendingNotification, ResolvedNotification } from '../../../shared/types/ipc.types'

/**
 * The global notifications surface.
 *
 * An agent that needs a human blocks until it gets one, and until now the only
 * place to answer was the in-chat card of the agent you happened to have open
 * — so a backgrounded agent could sit blocked indefinitely with nothing on
 * screen saying so. This menu aggregates every pending request across every
 * agent and inner loop into one bell.
 *
 * Two kinds, two affordances:
 *  - approval → inline Approve/Reject, resolved through the same executor path
 *    the in-chat card uses, so a decision made in either place clears both;
 *  - ask → the answer is prose, so the row offers "Respond", which opens the
 *    agent and leaves the question pending for its chat composer.
 *
 * Under them sits the recently-RESOLVED tail, greyed and actionless. The bell
 * is a notification centre, not a work queue: HIL is only its first tenant, and
 * a surface that erases a row the instant you answer leaves you no way to check
 * what you just did — or to notice that an agent was torn down before you got
 * to it ('expired') rather than actually answered.
 */

/** Compact "how long has this been blocking" label. */
function relativeAge(requestedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - requestedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

/**
 * The title-bar trigger. A bell, NOT the shield the rows use: the shield says
 * "tool gate", and this menu already carries questions and will carry whatever
 * else the runtime needs to tell you about. The per-row icon still distinguishes
 * approval from ask.
 */
function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

/** Asks are a question, not a gate — a speech bubble, not a shield. */
function AskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function ApprovalRow({
  approval,
  now,
  onJump
}: {
  approval: PendingNotification
  now: number
  onJump: (filePath: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const colors = loopColor(approval.loop)
  const isAsk = approval.kind === 'ask'
  const isProtection = approval.reason === 'protection'

  const respond = useCallback(async (approved: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const result = await approvalsBridge()?.resolvePendingApproval?.(approval.filePath, approval.id, approved)
      // The row normally vanishes on the next snapshot; a refusal (already
      // resolved, timed out, agent stopped) must say so instead of hanging.
      if (result && result.success === false) {
        setError(result.error ?? 'Could not resolve this approval')
        setBusy(false)
      }
    } catch {
      setError('Could not reach the agent runtime')
      setBusy(false)
    }
  }, [approval.filePath, approval.id])

  return (
    <div className="px-3 py-2 border-b border-hairline last:border-b-0 hover:bg-neutral-50 dark:hover:bg-neutral-800/60">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onJump(approval.filePath)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onJump(approval.filePath) }}
        className="cursor-pointer"
        title="Open this agent to see the request in context"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`shrink-0 ${isAsk ? 'text-sky-600 dark:text-sky-400' : 'text-amber-600 dark:text-amber-400'}`}
            title={isAsk ? 'Question' : 'Tool approval'}
          >
            {isAsk ? <AskIcon /> : <ShieldIcon />}
          </span>
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200 truncate">
            {approval.agentName}
          </span>
          {approval.loop !== 'main' && (
            <span className={`shrink-0 px-1 rounded text-[10px] leading-4 ${colors.badge}`}>
              {approval.loop}
            </span>
          )}
          {isProtection && (
            <span className="shrink-0 px-1 rounded text-[10px] leading-4 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
              override
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500 tabular-nums">
            {relativeAge(approval.requestedAt, now)}
          </span>
        </div>
        {!isAsk && (
          <div className="mt-0.5 text-[11px] font-mono text-neutral-600 dark:text-neutral-300 truncate">
            {approval.toolName}
          </div>
        )}
        <div
          className={`text-[11px] truncate ${isAsk ? 'mt-0.5 text-neutral-600 dark:text-neutral-300' : 'text-neutral-500 dark:text-neutral-400'}`}
          title={approval.question ?? approval.preview}
        >
          {approval.preview}
        </div>
      </div>

      {error && (
        <div className="mt-1 text-[10px] text-red-600 dark:text-red-400">{error}</div>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        {isAsk ? (
          // An answer is prose — there is nothing sane to type into a 14px
          // dropdown row, so this hands off to the agent's own composer.
          <button
            onClick={() => onJump(approval.filePath)}
            className="px-2 py-0.5 rounded text-[11px] font-medium bg-sky-600 text-white hover:bg-sky-700"
          >
            Respond
          </button>
        ) : (
          <>
            <button
              onClick={() => void respond(true)}
              disabled={busy}
              className="px-2 py-0.5 rounded text-[11px] font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => void respond(false)}
              disabled={busy}
              className="px-2 py-0.5 rounded text-[11px] font-medium bg-neutral-200 text-neutral-700 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-600 disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Outcome word + its (muted) colour. 'expired' is deliberately colourless. */
const OUTCOME_APPEARANCE: Record<NotificationOutcome, { label: string; tone: string }> = {
  approved: { label: 'approved', tone: 'text-green-600 dark:text-green-500' },
  rejected: { label: 'rejected', tone: 'text-red-600 dark:text-red-500' },
  answered: { label: 'answered', tone: 'text-sky-600 dark:text-sky-500' },
  // No one decided — the agent stopped, the turn was interrupted, or the
  // auto-deny timer fired. Reading that as "rejected" would be a lie.
  expired: { label: 'expired', tone: 'text-neutral-400 dark:text-neutral-500' },
}

/**
 * A resolved row: same identity cluster as a pending one so the eye tracks it
 * to the same place, but dimmed and stripped of every control. It states what
 * happened and when — nothing here is still actionable.
 */
function ResolvedRow({ entry, now }: { entry: ResolvedNotification; now: number }) {
  const colors = loopColor(entry.loop)
  const isAsk = entry.kind === 'ask'
  const outcome = OUTCOME_APPEARANCE[entry.outcome] ?? OUTCOME_APPEARANCE.expired

  return (
    <div className="px-3 py-1.5 border-b border-hairline last:border-b-0 opacity-55">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="shrink-0 text-neutral-400 dark:text-neutral-500">
          {isAsk ? <AskIcon /> : <ShieldIcon />}
        </span>
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300 truncate">
          {entry.agentName}
        </span>
        {entry.loop !== 'main' && (
          <span className={`shrink-0 px-1 rounded text-[10px] leading-4 ${colors.badge}`}>
            {entry.loop}
          </span>
        )}
        <span className={`shrink-0 text-[10px] font-medium ${outcome.tone}`}>{outcome.label}</span>
        <span className="ml-auto shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500 tabular-nums">
          {relativeAge(entry.resolvedAt, now)} ago
        </span>
      </div>
      <div
        className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate"
        title={entry.question ?? entry.preview}
      >
        {entry.toolName ? <span className="font-mono">{entry.toolName}</span> : null}
        {entry.toolName ? ' · ' : ''}
        {entry.preview}
      </div>
    </div>
  )
}

export function ApprovalsMenu({ align = 'right' }: { align?: 'left' | 'right' } = {}) {
  const approvals = useApprovalsStore((s) => s.approvals)
  const history = useApprovalsStore((s) => s.history)
  const panelOpen = useApprovalsStore((s) => s.panelOpen)
  const togglePanel = useApprovalsStore((s) => s.togglePanel)
  const setPanelOpen = useApprovalsStore((s) => s.setPanelOpen)
  const jumpToAgent = useJumpToAgent()
  const containerRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())

  // Ages are only interesting to the second while the panel is open.
  useEffect(() => {
    if (!panelOpen) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setPanelOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanelOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panelOpen, setPanelOpen])

  const count = approvals.length
  const askCount = approvals.reduce((total, a) => total + (a.kind === 'ask' ? 1 : 0), 0)

  const handleJump = (filePath: string) => {
    setPanelOpen(false)
    jumpToAgent(filePath)
  }

  // The bell is permanent — it is the app's notification centre, not a HIL
  // popup, so it must occupy the same pixels whether or not anything is
  // waiting. The BADGE carries the urgency; the icon carries the affordance.
  const label = count === 0
    ? 'Notifications'
    : askCount === 0
      ? `${count} waiting for approval`
      : askCount === count
        ? `${count} waiting for an answer`
        : `${count - askCount} approvals, ${askCount} questions waiting`

  return (
    <div ref={containerRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        onClick={togglePanel}
        title={label}
        aria-label={label}
        className={`relative w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
          panelOpen
            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'
            : count > 0
              ? 'text-amber-600 dark:text-amber-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
              : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
        }`}
      >
        <BellIcon />
        {/* Pending only. A badge that counted history would never reach zero. */}
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] flex items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-semibold leading-none tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {panelOpen && (
        <div className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-8 z-50 w-80 max-h-[60vh] overflow-y-auto rounded-md border border-hairline bg-surface-raised shadow-card`}>
          {count === 0 && history.length === 0 ? (
            <div className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400">
              No notifications
            </div>
          ) : (
            <>
              {count > 0 && (
                <>
                  <div className="px-3 py-1.5 border-b border-hairline text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                    Waiting on you
                  </div>
                  {approvals.map((approval) => (
                    <ApprovalRow key={approval.id} approval={approval} now={now} onJump={handleJump} />
                  ))}
                </>
              )}
              {history.length > 0 && (
                <>
                  <div className="px-3 py-1.5 border-y border-hairline text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
                    Recent
                  </div>
                  {history.map((entry) => (
                    // Resolved ids repeat across a session (a re-registered
                    // request, an agent restarted at ask_1), so the row needs a
                    // key that includes WHEN it ended.
                    <ResolvedRow key={`${entry.id}@${entry.resolvedAt}`} entry={entry} now={now} />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Corner notices for approvals and questions raised by an agent that is not on
 * screen. The in-chat card covers the open agent; this covers everyone else,
 * which in practice means every backgrounded agent.
 */
export function ApprovalToasts() {
  const toasts = useApprovalsStore((s) => s.toasts)
  const panelOpen = useApprovalsStore((s) => s.panelOpen)
  const dismissToast = useApprovalsStore((s) => s.dismissToast)
  const setPanelOpen = useApprovalsStore((s) => s.setPanelOpen)
  const jumpToAgent = useJumpToAgent()

  // Both the toasts and the bell panel anchor top-left; an open panel already
  // lists every pending request, and a toast on top of it would cover its
  // Approve buttons (B13). Defer to the panel while it is open — the toasts
  // (and their TTL timers, owned by useApprovalEvents) are untouched and
  // reappear if it closes with anything still pending.
  if (toasts.length === 0 || panelOpen) return null

  // Anchored under the title-bar nav cluster so toasts read as emerging from
  // the bell they belong to — their history lives one click above.
  return (
    <div className="fixed top-9 left-2 z-[60] flex flex-col gap-1.5 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto w-64 rounded-md border bg-surface-raised shadow-card px-3 py-2 ${
            toast.kind === 'ask'
              ? 'border-sky-300 dark:border-sky-700/60'
              : 'border-amber-300 dark:border-amber-700/60'
          }`}
        >
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 shrink-0 ${toast.kind === 'ask' ? 'text-sky-600 dark:text-sky-400' : 'text-amber-600 dark:text-amber-400'}`}>
              {toast.kind === 'ask' ? <AskIcon /> : <ShieldIcon />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-neutral-700 dark:text-neutral-200 truncate">
                {toast.agentName} {toast.kind === 'ask' ? 'has a question' : 'needs approval'}
              </div>
              <div className={`text-[11px] text-neutral-500 dark:text-neutral-400 truncate ${toast.kind === 'ask' ? '' : 'font-mono'}`}>
                {toast.detail}{toast.loop !== 'main' ? ` · ${toast.loop}` : ''}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  onClick={() => { dismissToast(toast.id); setPanelOpen(true) }}
                  className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Review
                </button>
                <button
                  onClick={() => { dismissToast(toast.id); jumpToAgent(toast.filePath) }}
                  className="text-[11px] text-neutral-500 dark:text-neutral-400 hover:underline"
                >
                  Open agent
                </button>
              </div>
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
              className="shrink-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 text-xs leading-none"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
