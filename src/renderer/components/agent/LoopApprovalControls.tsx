import { useCallback, useId, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, Textarea } from '../ui'

/** Loop-only HIL controls. Fleet views continue to use ApprovalControls unchanged. */
export function LoopApprovalControls({
  toolName,
  onApprove,
  onAlwaysApprove,
  onReject,
  compact,
  dropUp,
  overlay,
}: {
  toolName: string
  onApprove: () => void
  onAlwaysApprove: () => void
  onReject: (feedback?: string) => void
  compact?: boolean
  dropUp?: boolean
  overlay?: boolean
}) {
  const [menu, setMenu] = useState<null | 'approve' | 'reject'>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const feedbackId = useId()

  const opensUp = dropUp ?? compact
  const popPosition = opensUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
  const overlayStyle = (rect: DOMRect): CSSProperties => opensUp
    ? { position: 'fixed', right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 6 }
    : { position: 'fixed', right: window.innerWidth - rect.right, top: rect.bottom + 6 }
  const popoverProps = (rect: DOMRect | null): { className: string; style?: CSSProperties } => overlay && rect
    ? { className: 'z-50', style: overlayStyle(rect) }
    : { className: `absolute right-0 ${popPosition} z-50` }
  const host = (children: ReactNode): ReactNode => overlay ? createPortal(children, document.body) : children

  const handleSplit = useCallback(
    (which: 'approve' | 'reject', primary: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX - rect.left > rect.width * 0.75) {
        setAnchor(rect)
        setMenu((current) => current === which ? null : which)
      } else {
        setMenu(null)
        primary()
      }
    },
    [],
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
    <span className="relative inline-flex gap-1" onClick={(event) => event.stopPropagation()}>
      <span className="relative inline-flex">
        <Button
          size="compact"
          variant="primary"
          onClick={handleSplit('approve', onApprove)}
          aria-label={`Approve ${toolName}; use the arrow for approval options`}
          aria-expanded={menu === 'approve'}
          className={compact ? 'px-2' : ''}
        >
          <span>Approve</span>
          <span className="-mr-1 border-l border-current/20 pl-1.5 leading-none" aria-hidden="true">▾</span>
        </Button>
        {menu === 'approve' && host(
          <LoopMenu {...popoverProps(anchor)} onClose={() => setMenu(null)}>
            <LoopMenuItem onClick={() => { setMenu(null); onAlwaysApprove() }}>Always approve</LoopMenuItem>
          </LoopMenu>,
        )}
      </span>

      <span className="relative inline-flex">
        <Button
          size="compact"
          variant="danger"
          onClick={handleSplit('reject', () => onReject())}
          aria-label={`Reject ${toolName}; use the arrow for rejection options`}
          aria-expanded={menu === 'reject'}
          className={compact ? 'px-2' : ''}
        >
          <span>Reject</span>
          <span className="-mr-1 border-l border-current/20 pl-1.5 leading-none" aria-hidden="true">▾</span>
        </Button>
        {menu === 'reject' && host(
          <LoopMenu {...popoverProps(anchor)} onClose={() => setMenu(null)}>
            <LoopMenuItem onClick={openFeedback}>Reject with feedback…</LoopMenuItem>
          </LoopMenu>,
        )}
      </span>

      {feedbackOpen && host(
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setFeedbackOpen(false)}
            aria-label="Cancel feedback"
          />
          <div
            {...(() => {
              const props = popoverProps(anchor)
              return {
                className: `${props.className} w-72 rounded-[var(--adf-ui-dialog-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] p-3 shadow-[var(--adf-ui-dialog-shadow)]`,
                style: props.style,
              }
            })()}
          >
            <label className="mb-2 block text-[12px] font-medium text-[var(--adf-ui-text)]" htmlFor={feedbackId}>
              Reject with feedback
            </label>
            <Textarea
              id={feedbackId}
              ref={feedbackRef}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submitFeedback()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setFeedbackOpen(false)
                }
              }}
              rows={3}
              placeholder="Why is this rejected? The agent sees this."
              className="resize-none"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">Enter to submit · Esc to cancel</span>
              <Button size="compact" variant="danger" onClick={submitFeedback}>Submit</Button>
            </div>
          </div>
        </>,
      )}
    </span>
  )
}

function LoopMenu({
  children,
  onClose,
  className,
  style,
}: {
  children: ReactNode
  onClose: () => void
  className: string
  style?: CSSProperties
}) {
  return (
    <>
      <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={onClose} aria-label="Close menu" />
      <div
        role="menu"
        className={`${className} min-w-max rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] p-1 shadow-[var(--adf-ui-dialog-shadow)]`}
        style={style}
      >
        {children}
      </div>
    </>
  )
}

function LoopMenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full whitespace-nowrap rounded-[4px] px-2.5 py-1.5 text-left text-[12px] text-[var(--adf-ui-text)] outline-none hover:bg-[var(--adf-ui-surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
    >
      {children}
    </button>
  )
}
