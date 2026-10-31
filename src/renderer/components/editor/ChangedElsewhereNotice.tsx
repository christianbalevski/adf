import { useEffect, useMemo, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { describeWriter, type ResourceWriter } from '../../../shared/types/resource-revision.types'
import { conflictMessage } from '../../utils/edit-conflict'

const BUTTON = 'px-2 py-0.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/40 font-medium hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]'

/**
 * W3-F: "changed elsewhere" strip over an editor whose unsaved text someone
 * else's change overtook (the agent, another Studio window, the terminal
 * app, the CLI). Nothing is written until the user picks: Reload takes their
 * version and drops the unsaved text; Overwrite saves this version over
 * theirs. Compare (when both texts are known) shows the difference first.
 * Used by the editor tabs and the config panel alike.
 */
export function ChangedElsewhereNotice({ what, writer, onReload, onKeep, focusSeq, mine, theirs }: {
  what: string
  writer: ResourceWriter | null | undefined
  onReload: () => void
  onKeep: () => void
  /** Each change moves focus to Reload (a save was asked for while the notice is up). */
  focusSeq?: number
  /** The unsaved text. With `theirs`, offers Compare. */
  mine?: string
  /** Their text, when the change carried it (null: Reload reads it, no Compare). */
  theirs?: string | null
}) {
  const reloadRef = useRef<HTMLButtonElement>(null)
  const [comparing, setComparing] = useState(false)
  useEffect(() => { if (focusSeq) reloadRef.current?.focus() }, [focusSeq])
  const canCompare = mine !== undefined && typeof theirs === 'string'
  return (
    <div role="alert" className="w-full shrink-0 border-b border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] text-[11px] text-[var(--adf-ui-warning)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <span className="flex-1 min-w-0">{conflictMessage(what, writer)} Your changes are not saved.</span>
        {canCompare && (
          <button type="button" onClick={() => setComparing((c) => !c)} className={BUTTON} aria-expanded={comparing} title="Show the differences between the saved version and your unsaved changes">
            {comparing ? 'Hide compare' : 'Compare'}
          </button>
        )}
        <button ref={reloadRef} type="button" onClick={onReload} className={BUTTON} title="Discard your unsaved changes and load the saved version">
          Reload
        </button>
        <button type="button" onClick={onKeep} className={BUTTON} title="Save your version over the saved version">
          Overwrite
        </button>
      </div>
      {comparing && canCompare && <CompareView mine={mine} theirs={theirs} />}
    </div>
  )
}

export interface CompareLine {
  kind: 'same' | 'theirs' | 'mine'
  text: string
}

/** Line diff of mine against theirs: `theirs` lines only they have, `mine` lines only you have. */
export function compareLines(mine: string, theirs: string): CompareLine[] {
  const lines: CompareLine[] = []
  for (const part of diffLines(theirs, mine)) {
    const kind: CompareLine['kind'] = part.added ? 'mine' : part.removed ? 'theirs' : 'same'
    const text = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value
    for (const line of text.split('\n')) lines.push({ kind, text: line })
  }
  return lines
}

/** Unchanged runs longer than this either side of a change fold to a count, so the differences stay in view. */
const CONTEXT = 3

export type CompareRow = CompareLine | { kind: 'fold'; count: number }

export function foldUnchanged(lines: readonly CompareLine[]): CompareRow[] {
  const out: CompareRow[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind !== 'same') { out.push(lines[i++]); continue }
    let j = i
    while (j < lines.length && lines[j].kind === 'same') j++
    const head = i === 0 ? 0 : CONTEXT
    const tail = j === lines.length ? 0 : CONTEXT
    if (j - i > head + tail + 1) {
      out.push(...lines.slice(i, i + head), { kind: 'fold', count: j - i - head - tail }, ...lines.slice(j - tail, j))
    } else {
      out.push(...lines.slice(i, j))
    }
    i = j
  }
  return out
}

function CompareView({ mine, theirs }: { mine: string; theirs: string }) {
  const lines = useMemo(() => compareLines(mine, theirs), [mine, theirs])
  const rows = useMemo(() => foldUnchanged(lines), [lines])
  const same = !lines.some((l) => l.kind !== 'same')
  return (
    <div className="px-3 pb-2">
      <div className="flex gap-3 mb-1 text-[10px] text-[var(--adf-ui-text-muted)]">
        <span><span className="text-red-600 dark:text-red-400">−</span> saved</span>
        <span><span className="text-green-600 dark:text-green-400">+</span> unsaved</span>
      </div>
      <pre className="max-h-[40vh] overflow-auto rounded border border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-surface)] text-[11px] leading-[16px] font-mono text-[var(--adf-ui-text)]">
        {same ? (
          <div className="px-2 py-1 text-[var(--adf-ui-text-muted)]">No differences.</div>
        ) : rows.map((row, i) =>
          row.kind === 'fold' ? (
            <div key={i} className="px-2 text-[var(--adf-ui-text-muted)] select-none">⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}</div>
          ) : (
            <div
              key={i}
              className={`px-2 whitespace-pre-wrap break-words ${
                row.kind === 'mine' ? 'bg-green-50 dark:bg-green-900/30' : row.kind === 'theirs' ? 'bg-red-50 dark:bg-red-900/30' : ''
              }`}
            >
              <span className="select-none text-[var(--adf-ui-text-muted)]">{row.kind === 'mine' ? '+ ' : row.kind === 'theirs' ? '− ' : '  '}</span>
              {row.text}
            </div>
          )
        )}
      </pre>
    </div>
  )
}

/** How long the "Updated by" strip stays up. */
export const EXTERNAL_UPDATE_NOTICE_MS = 8000

/**
 * A clean editor tab took someone else's change (no unsaved text was at
 * stake, so nothing was asked). The strip says who changed it and offers
 * Undo, which puts the previous text back as an unsaved edit and saves it.
 * It goes away on its own after a few seconds.
 */
export function ExternalUpdateNotice({ writer, seq, onUndo, onDismiss }: {
  writer: ResourceWriter | null | undefined
  /** A new replacement restarts the timer. */
  seq: number
  onUndo: () => void
  onDismiss: () => void
}) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), EXTERNAL_UPDATE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [seq])
  return (
    <div
      role="status"
      className="w-full shrink-0 flex items-center gap-2 px-3 py-1 border-b border-hairline bg-[var(--adf-ui-accent-subtle)] text-[11px] text-[var(--adf-ui-text)]"
    >
      <span className="min-w-0 truncate">Updated by {describeWriter(writer)}</span>
      <span aria-hidden="true" className="text-[var(--adf-ui-text-muted)]">·</span>
      <button type="button" onClick={onUndo} className="font-medium hover:underline" title="Put back the text this tab showed before, and save it">
        Undo
      </button>
      <div className="flex-1" />
      <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="text-[var(--adf-ui-text-muted)] hover:text-[var(--adf-ui-text)]">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}
