import { useEffect, useRef } from 'react'
import type { ResourceWriter } from '../../../shared/types/resource-revision.types'
import { conflictMessage } from '../../utils/edit-conflict'

/**
 * W3-F: "changed elsewhere" strip over an editor whose unsaved text someone
 * else's change overtook (the agent, another Studio window, the terminal
 * app, the CLI). Nothing is written until the user picks: Reload takes their
 * version and drops the unsaved text; Keep mine saves this version over
 * theirs. Used by the editor tabs and the config panel alike.
 */
export function ChangedElsewhereNotice({ what, writer, onReload, onKeep, focusSeq }: {
  what: string
  writer: ResourceWriter | null | undefined
  onReload: () => void
  onKeep: () => void
  /** Each change moves focus to Reload (a save was asked for while the notice is up). */
  focusSeq?: number
}) {
  const reloadRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (focusSeq) reloadRef.current?.focus() }, [focusSeq])
  const button = 'px-2 py-0.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/40 font-medium hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]'
  return (
    <div
      role="alert"
      className="w-full shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] text-[11px] text-[var(--adf-ui-warning)]"
    >
      <span className="flex-1 min-w-0">{conflictMessage(what, writer)} Your changes are not saved.</span>
      <button ref={reloadRef} type="button" onClick={onReload} className={button} title="Discard your unsaved changes and show their version">
        Reload
      </button>
      <button type="button" onClick={onKeep} className={button} title="Save your version over theirs">
        Keep mine
      </button>
    </div>
  )
}
