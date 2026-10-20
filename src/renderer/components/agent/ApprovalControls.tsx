import { useState, useRef, useCallback, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'

type MenuKind = 'approve' | 'reject'

/**
 * HIL approve/reject controls as two split buttons. Each has a primary button
 * and a separate caret button that opens a one-item menu, so both menus are
 * reachable by keyboard (Tab to the caret, Enter, arrows, Escape).
 *
 * - Approve ▸ "Always approve" — drops the HIL gate on this tool going forward.
 * - Reject  ▸ "Reject with feedback" — opens a box whose text is handed back
 *   to the agent with the rejection so it can course-correct.
 */
export function ApprovalControls({
  toolName,
  onApprove,
  onAlwaysApprove,
  onReject,
  alwaysApproveDisabled,
  alwaysApproveDisabledReason,
  busy,
  compact,
  dropUp,
  overlay
}: {
  toolName: string
  onApprove: () => void
  onAlwaysApprove: () => void
  /** feedback is undefined for a plain reject, a string for reject-with-feedback */
  onReject: (feedback?: string) => void
  /** Grey out "Always approve" (locked tool declaration or protection-triggered approval). */
  alwaysApproveDisabled?: boolean
  /** Why "Always approve" is unavailable; shown under the disabled item. */
  alwaysApproveDisabledReason?: string
  /** A decision is in flight: every button is disabled. */
  busy?: boolean
  compact?: boolean
  /** Force popovers upward (e.g. controls at the bottom edge of a modal). */
  dropUp?: boolean
  /**
   * Render the feedback box position:fixed at the caret's screen rect — for
   * hosts whose boxes clip absolute children (the loop's overflow-hidden rows).
   * Do NOT use inside transformed ancestors (React Flow nodes): a transform
   * re-roots fixed positioning and the box lands in the wrong place.
   */
  overlay?: boolean
}) {
  const [menu, setMenu] = useState<null | { which: MenuKind; at: { x: number; y: number } }>(null)
  const menuRef = useRef(menu)
  menuRef.current = menu
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  // Screen rect of the caret that opened the feedback box (overlay mode)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const approveCaretRef = useRef<HTMLButtonElement>(null)
  const rejectCaretRef = useRef<HTMLButtonElement>(null)
  // The menu closes on the caret's own pointerdown (outside the menu); the
  // click that follows must not reopen it.
  const lastClose = useRef<{ which: MenuKind; at: number } | null>(null)

  // 24px minimum hit target in both sizes.
  const size = compact ? 'h-6 text-[10px]' : 'h-7 text-xs'
  const up = dropUp ?? compact
  // Inline controls live at the bottom of the scrolling loop, so their popovers
  // open UPWARD to avoid being clipped; header-mounted buttons open down.
  const popPos = up ? 'bottom-full mb-1' : 'top-full mt-1'

  // Overlay mode: pin the feedback box to the viewport at the anchor's edge so
  // no ancestor overflow can cut it off. Rendered through a portal to <body> —
  // any transformed/filtered ancestor would otherwise re-root the fixed
  // positioning and strand the box somewhere unrelated.
  const overlayStyle = (r: DOMRect): CSSProperties =>
    up
      ? { position: 'fixed', right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 4 }
      : { position: 'fixed', right: window.innerWidth - r.right, top: r.bottom + 4 }
  const popProps = (r: DOMRect | null): { className: string; style?: CSSProperties } =>
    overlay && r
      ? { className: 'z-50', style: overlayStyle(r) }
      : { className: `absolute right-0 ${popPos} z-50` }
  const host = (children: ReactNode): ReactNode =>
    overlay ? createPortal(children, document.body) : children

  const caretFor = (which: MenuKind) => (which === 'approve' ? approveCaretRef : rejectCaretRef)

  const openMenu = (which: MenuKind) => {
    const last = lastClose.current
    if (last && last.which === which && Date.now() - last.at < 300) return
    const rect = caretFor(which).current?.getBoundingClientRect()
    if (!rect) return
    setAnchor(rect)
    setMenu({ which, at: { x: rect.right, y: up ? rect.top - 4 : rect.bottom + 4 } })
  }

  const closeMenu = useCallback(() => {
    const current = menuRef.current
    setMenu(null)
    if (!current) return
    lastClose.current = { which: current.which, at: Date.now() }
    // Focus goes back to the caret that opened the menu.
    ;(current.which === 'approve' ? approveCaretRef : rejectCaretRef).current?.focus()
  }, [])

  const openFeedback = () => {
    setFeedbackOpen(true)
    setTimeout(() => feedbackRef.current?.focus(), 0)
  }

  const closeFeedback = () => {
    setFeedbackOpen(false)
    rejectCaretRef.current?.focus()
  }

  const submitFeedback = () => {
    onReject(feedback.trim() || undefined)
    setFeedbackOpen(false)
    setFeedback('')
  }

  const items: ContextMenuItem[] = menu?.which === 'approve'
    ? [{
        label: 'Always approve',
        disabled: alwaysApproveDisabled,
        hint: alwaysApproveDisabled ? alwaysApproveDisabledReason : undefined,
        onSelect: onAlwaysApprove
      }]
    : [{ label: 'Reject with feedback…', onSelect: openFeedback }]

  return (
    <span className="relative inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      {/* Approve split button */}
      <span className="inline-flex">
        <button
          type="button"
          disabled={busy}
          className={`${size} px-2 font-medium rounded-l border border-transparent bg-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-accent-hover)] text-[var(--adf-ui-on-accent)] transition-colors inline-flex items-center disabled:opacity-50`}
          onClick={onApprove}
        >
          Approve
        </button>
        <button
          ref={approveCaretRef}
          type="button"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu?.which === 'approve'}
          aria-label={`More approve options for ${toolName}`}
          title="More approve options"
          className={`${size} w-6 justify-center rounded-r border border-transparent border-l-[color:var(--adf-ui-on-accent)]/30 bg-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-accent-hover)] text-[var(--adf-ui-on-accent)] transition-colors inline-flex items-center leading-none disabled:opacity-50`}
          onClick={() => openMenu('approve')}
        >
          <span aria-hidden>▾</span>
        </button>
      </span>

      {/* Reject split button */}
      <span className="inline-flex">
        <button
          type="button"
          disabled={busy}
          className={`${size} px-2 font-medium rounded-l border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] hover:bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)] transition-colors inline-flex items-center disabled:opacity-50`}
          onClick={() => onReject()}
        >
          Reject
        </button>
        <button
          ref={rejectCaretRef}
          type="button"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu?.which === 'reject'}
          aria-label={`More reject options for ${toolName}`}
          title="More reject options"
          className={`${size} w-6 -ml-px justify-center rounded-r border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] hover:bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)] transition-colors inline-flex items-center leading-none disabled:opacity-50`}
          onClick={() => openMenu('reject')}
        >
          <span aria-hidden>▾</span>
        </button>
      </span>

      <ContextMenu
        position={menu?.at ?? null}
        placement={{ x: 'end', y: up ? 'above' : 'below' }}
        label={menu?.which === 'approve' ? 'Approve options' : 'Reject options'}
        items={items}
        onClose={closeMenu}
      />

      {/* Feedback box — anchored to the reject caret that opened it */}
      {feedbackOpen && host(
        <>
          <div className="fixed inset-0 z-40" onClick={closeFeedback} />
          <div
            role="dialog"
            aria-label="Reject with feedback"
            {...(() => {
              const p = popProps(anchor)
              return { className: `${p.className} w-64 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] shadow-float p-2`, style: p.style }
            })()}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--adf-ui-text-subtle)] mb-1">
              Reject with feedback
            </div>
            <textarea
              ref={feedbackRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFeedback() }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFeedback() }
              }}
              rows={3}
              aria-label="Feedback for the agent"
              placeholder="Why is this rejected? (the agent sees this)"
              className="w-full text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 p-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[9px] text-[var(--adf-ui-text-subtle)]">Enter to submit · Esc to cancel</span>
              <button
                type="button"
                onClick={submitFeedback}
                className="h-6 px-2 text-[10px] font-medium rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] hover:bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)]"
              >
                Submit
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  )
}

/** Marks a protection override (a one-time exception to a lock) apart from a routine gated call. */
export function OverrideBadge() {
  return (
    <span className="shrink-0 px-1 rounded text-[10px] leading-4 bg-[var(--status-deprecated-bg)] text-[var(--status-deprecated)]">
      override
    </span>
  )
}
