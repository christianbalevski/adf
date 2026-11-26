import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'

/** A point on screen to hang a floating box from: below `bottom`, or above `top` when it does not fit. */
export interface PopoverAnchor {
  left: number
  top: number
  bottom: number
}

/**
 * Fixed position for a floating box at `anchor`, measured (floating-ui, as
 * Tooltip): below it, flipped above when there is no room, and kept inside
 * the window even when the anchor has scrolled out of it.
 */
export function useAnchoredPosition<T extends HTMLElement>(anchor: PopoverAnchor) {
  const ref = useRef<T>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const { left, top, bottom } = anchor
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    const reference = { getBoundingClientRect: () => DOMRect.fromRect({ x: left, y: top, width: 0, height: bottom - top }) }
    void computePosition(reference, el, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8, crossAxis: true })],
    }).then(({ x, y }) => { if (live) setAt({ x, y }) })
    return () => { live = false }
  }, [left, top, bottom])
  // Transparent, not hidden, until placed: a hidden field could not take focus on open.
  const style: CSSProperties = { position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0, opacity: at ? 1 : 0 }
  return { ref, style }
}

/**
 * The comment box for a file selection: the quote it is about, a field for the
 * comment, Enter to submit. Esc, Cancel or focus moving elsewhere closes it unchanged.
 * Focus goes to the field on open and back where it was on close.
 */
export function CommentPopover({ anchor, header, quote, initial = '', submitLabel, onSubmit, onCancel }: {
  anchor: PopoverAnchor
  header: string
  quote: string
  initial?: string
  submitLabel: string
  onSubmit: (comment: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const { ref, style } = useAnchoredPosition<HTMLDivElement>(anchor)
  const returnFocus = useRef<Element | null>(null)
  const field = useCallback((node: HTMLTextAreaElement | null) => {
    if (node) {
      returnFocus.current = document.activeElement
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    } else if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected
      && (document.activeElement === document.body || document.activeElement === null)) {
      // Back to the editor (or the chip) the box was opened from, unless the
      // owner has just put focus somewhere else.
      returnFocus.current.focus()
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys typed here are the box's own, not the editor's or the chat's.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSubmit(text)
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Comment"
      onKeyDown={onKeyDown}
      // Focus leaving the box for anything else in the window closes it, and
      // the click that moved it still lands. Switching apps does not.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && document.hasFocus()) onCancel()
      }}
      style={{ ...style, width: 320, boxShadow: 'var(--shadow-pop)' }}
      className="z-[1000] flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--paper-raised)] p-2 text-[var(--ink)]"
    >
      <div className="break-all font-mono text-[10px] text-[var(--ink-faint)]">{header}</div>
      <blockquote className="line-clamp-3 whitespace-pre-wrap border-l-2 border-[var(--rule-strong)] pl-2 text-[11px] text-[var(--ink-faint)]">
        {quote}
      </blockquote>
      <textarea
        ref={field}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Comment (optional)"
        className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--rule)] bg-[var(--paper)] px-2 py-1 text-[12px] text-[var(--ink)]"
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[10px] text-[var(--ink-faint)]">Shift+Enter for a new line</span>
        <button type="button" onClick={onCancel} className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink)]">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSubmit(text)}
          className="rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--paper)] px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--paper-sunken)]"
        >
          {submitLabel}
        </button>
      </div>
    </div>,
    document.body,
  )
}
