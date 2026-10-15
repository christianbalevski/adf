import { useEffect, useState } from 'react'
import { recoveredEditsMessage } from '../../utils/edit-recovery'

/**
 * W3-F: at launch, the unsaved versions a quit or crash left under a
 * "changed elsewhere" notice (<userData>/recovered). Show folder opens it;
 * Dismiss moves the copies under recovered/archive/<time>/ (nothing is
 * deleted) so the notice does not come back.
 */
export function RecoveredEditsNotice() {
  const [files, setFiles] = useState<Array<{ agent: string; path: string }>>([])
  useEffect(() => {
    let alive = true
    window.adfApi?.recoveryList?.().then((r) => { if (alive && r?.files?.length) setFiles(r.files) }).catch(() => { /* older main */ })
    return () => { alive = false }
  }, [])
  if (files.length === 0) return null
  const button = 'px-2 py-0.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-warning)]/40 font-medium hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]'
  return (
    <div role="status" className="w-full shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] text-[11px] text-[var(--adf-ui-warning)]">
      <span className="flex-1 min-w-0">{recoveredEditsMessage(files)}</span>
      <button type="button" className={button} onClick={() => { void window.adfApi?.recoveryReveal?.() }}>Show folder</button>
      <button type="button" className={button} onClick={() => { void window.adfApi?.recoveryArchive?.().finally(() => setFiles([])) }}>Dismiss</button>
    </div>
  )
}
