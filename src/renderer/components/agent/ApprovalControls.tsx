import { useState, useRef, useCallback } from 'react'

/**
 * HIL approve/reject controls with a split-button affordance: clicking the
 * left ~3/4 of a button runs its primary action; clicking the rightmost
 * quarter (the caret zone) opens a one-item dropdown.
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
  compact
}: {
  toolName: string
  onApprove: () => void
  onAlwaysApprove: () => void
  /** feedback is undefined for a plain reject, a string for reject-with-feedback */
  onReject: (feedback?: string) => void
  compact?: boolean
}) {
  const [menu, setMenu] = useState<null | 'approve' | 'reject'>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  const btn = compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
  const caretW = compact ? 'w-4' : 'w-5'
  // Inline controls live at the bottom of the scrolling loop, so their popovers
  // open UPWARD to avoid being clipped; the modal's header buttons open down.
  const popPos = compact ? 'bottom-full mb-1' : 'top-full mt-1'

  // Click in the rightmost quarter → dropdown; otherwise the primary action.
  const split = useCallback(
    (which: 'approve' | 'reject', primary: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      if (e.clientX - rect.left > rect.width * 0.75) {
        setMenu((m) => (m === which ? null : which))
      } else {
        setMenu(null)
        primary()
      }
    },
    []
  )

  const openFeedback = () => {
    setMenu(null)
    setFeedbackOpen(true)
    setTimeout(() => feedbackRef.current?.focus(), 0)
  }

  const submitFeedback = () => {
    onReject(feedback.trim() || undefined)
    setFeedbackOpen(false)
    setFeedback('')
  }

  return (
    <span className="relative inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
      {/* Approve split button */}
      <span className="relative inline-flex">
        <button
          className={`${btn} font-medium rounded bg-green-500 hover:bg-green-600 text-white transition-colors inline-flex items-center gap-1`}
          onClick={split('approve', onApprove)}
          title="Approve — click the caret for more"
        >
          <span>Approve</span>
          <span className={`${caretW} text-center border-l border-white/30 -mr-1 pl-0.5 leading-none`}>▾</span>
        </button>
        {menu === 'approve' && (
          <DropMenu pos={popPos} onClose={() => setMenu(null)}>
            <MenuItem onClick={() => { setMenu(null); onAlwaysApprove() }}>Always approve</MenuItem>
          </DropMenu>
        )}
      </span>

      {/* Reject split button */}
      <span className="relative inline-flex">
        <button
          className={`${btn} font-medium rounded bg-red-500 hover:bg-red-600 text-white transition-colors inline-flex items-center gap-1`}
          onClick={split('reject', () => onReject())}
          title="Reject — click the caret for more"
        >
          <span>Reject</span>
          <span className={`${caretW} text-center border-l border-white/30 -mr-1 pl-0.5 leading-none`}>▾</span>
        </button>
        {menu === 'reject' && (
          <DropMenu pos={popPos} onClose={() => setMenu(null)}>
            <MenuItem onClick={openFeedback}>Reject with feedback…</MenuItem>
          </DropMenu>
        )}
      </span>

      {/* Feedback box */}
      {feedbackOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setFeedbackOpen(false)} />
          <div className={`absolute right-0 ${popPos} z-50 w-64 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-xl p-2`}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">
              Reject with feedback
            </div>
            <textarea
              ref={feedbackRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFeedback() }
                if (e.key === 'Escape') { e.preventDefault(); setFeedbackOpen(false) }
              }}
              rows={3}
              placeholder="Why is this rejected? (the agent sees this)"
              className="w-full text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 p-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[9px] text-neutral-400 dark:text-neutral-500">Enter to submit · Esc to cancel</span>
              <button
                onClick={submitFeedback}
                className="px-2 py-0.5 text-[10px] font-medium rounded bg-red-500 hover:bg-red-600 text-white"
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

function DropMenu({ children, onClose, pos }: { children: React.ReactNode; onClose: () => void; pos: string }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className={`absolute right-0 ${pos} z-50 min-w-max rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-xl py-1`}>
        {children}
      </div>
    </>
  )
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 whitespace-nowrap"
    >
      {children}
    </button>
  )
}
