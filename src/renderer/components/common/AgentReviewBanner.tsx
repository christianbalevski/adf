import { useCallback, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'

/**
 * Full-width strip below the title bar with two jobs:
 * - while the open agent is unreviewed (dialog dismissed), a warning banner
 *   that reopens the review dialog — always refetching checkAgentReview so a
 *   config edited since the dismissal is re-summarized, with the cached
 *   summary only as a fallback when the fetch fails;
 * - after an accept whose file move failed, a danger notice that the .adf is
 *   still in a temp folder.
 */
export function AgentReviewBanner() {
  const filePath = useDocumentStore((s) => s.filePath)
  const needsReview = useAppStore((s) => s.agentNeedsReview)
  const dialogOpen = useAppStore((s) => s.agentReviewDialogOpen)
  const moveWarning = useAppStore((s) => s.fileMoveWarning)
  const setDialog = useAppStore((s) => s.setAgentReviewDialog)
  const setNeedsReview = useAppStore((s) => s.setAgentNeedsReview)
  const setFileMoveWarning = useAppStore((s) => s.setFileMoveWarning)
  const [checkError, setCheckError] = useState<string | null>(null)

  const handleClick = useCallback(async () => {
    setCheckError(null)
    try {
      // Always refetch — the config may have been edited since the dialog was
      // dismissed, and accepting a stale summary would lock fields unseen.
      const review = await window.adfApi.checkAgentReview()
      if (review.needsReview) {
        setDialog(true, review.configSummary)
      } else {
        // Stale flag — main says the agent no longer needs review.
        setNeedsReview(false)
      }
    } catch (err) {
      console.error('[AgentReviewBanner] Review check error:', err)
      const cached = useAppStore.getState().agentReviewSummary
      if (cached) {
        setDialog(true, cached)
      } else {
        setCheckError("Couldn't check review status.")
      }
    }
  }, [setDialog, setNeedsReview])

  if (moveWarning) {
    return (
      <div
        role="alert"
        className="w-full shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 border-b border-[var(--adf-ui-danger)]/30 bg-[var(--adf-ui-danger)]/10 text-[11px] text-[var(--adf-ui-danger)]"
      >
        <span>{moveWarning}</span>
        <button
          type="button"
          onClick={() => setFileMoveWarning(null)}
          aria-label="Dismiss"
          className="rounded-[var(--adf-ui-control-radius)] p-0.5 hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    )
  }

  if (!filePath || !needsReview || dialogOpen) return null

  return (
    <div role="status" className="w-full shrink-0">
      <button
        type="button"
        onClick={handleClick}
        className="w-full flex items-center justify-center gap-2 px-3 py-1.5 border-b border-[var(--adf-ui-warning)]/30 bg-[var(--adf-ui-warning-subtle)] text-[11px] text-[var(--adf-ui-warning)] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]"
      >
        <span>This agent hasn't been reviewed yet — it can't run.</span>
        <span className="font-medium underline">Review</span>
      </button>
      {checkError && (
        <p className="w-full text-center px-3 py-1 text-[11px] text-[var(--adf-ui-danger)] border-b border-[var(--adf-ui-border)]">
          {checkError}
        </p>
      )}
    </div>
  )
}
