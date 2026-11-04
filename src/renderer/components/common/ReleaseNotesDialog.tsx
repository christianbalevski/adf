import { useMemo } from 'react'
import { Dialog } from './Dialog'
import { renderMarkdownToSafeHtml, useMarkdownHighlightVersion } from '../../utils/markdown'

/**
 * One version's release notes. `notes` is the markdown of
 * docs/release-notes/v<version>.md, or the GitHub release text the updater
 * reports for an available version (HTML, which the same sanitizer handles).
 */
type ReleaseNotesDialogProps = {
  open: boolean
  onClose: () => void
  title: string
  notes: string | null
  /** Buttons below the notes (e.g. Download and restart). */
  children?: React.ReactNode
}

/** Mounted only while open: the closed dialog renders (and parses) nothing. */
export function ReleaseNotesDialog(props: ReleaseNotesDialogProps) {
  return props.open ? <OpenReleaseNotesDialog {...props} /> : null
}

function OpenReleaseNotesDialog({ open, onClose, title, notes, children }: ReleaseNotesDialogProps) {
  const highlightVersion = useMarkdownHighlightVersion()
  const html = useMemo(() => (notes ? renderMarkdownToSafeHtml(notes) : ''), [notes, highlightVersion])
  return (
    <Dialog open={open} onClose={onClose} title={title} wide>
      {html ? (
        <div
          className="loop-markdown text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-200"
          // Sanitized by utils/markdown.ts (marked, then DOMPurify).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">No release notes for this version.</p>
      )}
      {children && <div className="mt-4 flex justify-end gap-2">{children}</div>}
    </Dialog>
  )
}
