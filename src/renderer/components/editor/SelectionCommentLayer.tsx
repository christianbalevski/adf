import { useState, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { nanoid } from 'nanoid'
import { CommentPopover, useAnchoredPosition, type PopoverAnchor } from '../common/CommentPopover'
import { useDocumentStore } from '../../stores/document.store'
import { selectionCommentHeader } from '../../utils/selection-comment'
import { isPrimaryModifier } from '../../utils/keyboard'
import { IS_MAC } from '../../utils/platform'
import { COMMENT_ON_SELECTION, formatKey } from '../../../shared/constants/keyboard-shortcuts'

/** The selected text in a file editor, read from the editor's own model. */
export interface EditorTextSelection {
  text: string
  /** 1-based; left out for rendered text that could not be placed in the source. */
  startLine?: number
  endLine?: number
  /** Screen position of the selection's end, for the button and the box. */
  anchor: PopoverAnchor
}

/** Filled by the open editor: its selection now, or null when nothing is selected. */
export type SelectionGetter = () => EditorTextSelection | null

/** ⌘⌥M on macOS, Ctrl+Alt+M elsewhere. `code`, since ⌥M types µ on a Mac. */
function isCommentKey(e: React.KeyboardEvent): boolean {
  return isPrimaryModifier(e, IS_MAC) && e.altKey && !e.shiftKey && e.code === 'KeyM'
}

/** The Comment button at the end of a selection. */
function CommentButton({ anchor, onOpen }: { anchor: PopoverAnchor; onOpen: () => void }) {
  const { ref, style } = useAnchoredPosition<HTMLButtonElement>(anchor)
  return createPortal(
    <button
      ref={ref}
      type="button"
      // Keep the editor's focus and selection: the click only opens the box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      style={{ ...style, boxShadow: 'var(--shadow-pop)' }}
      className="z-[1000] inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--paper-raised)] px-2 py-1 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--paper-sunken)]"
    >
      Comment
      <span className="font-mono text-[10px] text-[var(--ink-faint)]">{formatKey(COMMENT_ON_SELECTION, IS_MAC)}</span>
    </button>,
    document.body,
  )
}

/**
 * The editor area, with commenting on a selection in it. Selecting text
 * offers a Comment button; it, or the shortcut, opens the comment box; its
 * submit puts the quote and the comment in the agent's composer as a chip
 * (document.store `draftComments`). The file is never touched: the comment
 * exists only as text in the message the owner sends.
 *
 * Keyed by agent and file where it is used, so a switch of either closes
 * whatever was open for the last one.
 */
export function SelectionCommentArea({ agentKey, path, getSelectionRef, className, children }: {
  agentKey: string | null
  path: string
  getSelectionRef: MutableRefObject<SelectionGetter | null>
  className: string
  children: ReactNode
}) {
  const [offer, setOffer] = useState<EditorTextSelection | null>(null)
  const [editing, setEditing] = useState<EditorTextSelection | null>(null)
  const read = () => getSelectionRef.current?.() ?? null
  const hide = () => setOffer(null)

  const open = (selection: EditorTextSelection) => {
    setOffer(null)
    setEditing(selection)
  }

  const add = (selection: EditorTextSelection, comment: string) => {
    if (agentKey) {
      const docs = useDocumentStore.getState()
      docs.setDraftComments(agentKey, [...(docs.draftComments[agentKey] ?? []), {
        id: nanoid(),
        path,
        startLine: selection.startLine,
        endLine: selection.endLine,
        quote: selection.text,
        comment: comment.trim(),
      }])
    }
    setEditing(null)
  }

  return (
    <div
      className={className}
      // A press here is read once its click has landed, wherever the drag
      // ended: the editors' own mouseup handling (CodeMirror's is on the
      // document, added on mousedown before this one) has settled the
      // selection by then. A click that collapses a selection collapses it
      // after the click event, so the next selection change is read too.
      onMouseDown={(e) => {
        const area = e.currentTarget
        const settle = () => { if (area.contains(document.activeElement)) setOffer(read()) }
        document.addEventListener('click', () => {
          settle()
          document.addEventListener('selectionchange', settle, { once: true })
        }, { once: true })
      }}
      // Keys move the selection on keydown.
      onKeyUp={() => setOffer(read())}
      onKeyDownCapture={(e) => {
        if (!isCommentKey(e)) return
        const selection = read()
        if (!selection) return
        e.preventDefault()
        e.stopPropagation()
        open(selection)
      }}
      onScrollCapture={hide}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hide() }}
    >
      {children}
      {offer && !editing && <CommentButton anchor={offer.anchor} onOpen={() => open(offer)} />}
      {editing && (
        <CommentPopover
          anchor={editing.anchor}
          header={selectionCommentHeader({ path, startLine: editing.startLine, endLine: editing.endLine })}
          quote={editing.text}
          submitLabel="Add to chat"
          onCancel={() => setEditing(null)}
          onSubmit={(comment) => add(editing, comment)}
        />
      )}
    </div>
  )
}
