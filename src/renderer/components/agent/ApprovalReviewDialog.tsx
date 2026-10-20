import { Dialog } from '../common/Dialog'
import { Button } from '../ui'

/** One gated call in the review list: its tool and a short target, never the full input. */
export interface ReviewCall {
  requestId: string
  toolName: string
  target: string
}

/**
 * "Review N calls": the pending gated calls of one loop, listed before one
 * confirm approves exactly these, each once. Protection overrides are never
 * listed; each one is decided on its own card.
 */
export function ApprovalReviewDialog({
  open,
  calls,
  overrideCount,
  busy,
  error,
  onConfirm,
  onClose
}: {
  open: boolean
  calls: ReviewCall[]
  /** Pending protection overrides, left out of the list. */
  overrideCount: number
  busy: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  const n = calls.length
  return (
    <Dialog open={open} onClose={onClose} title={`Review ${n} call${n === 1 ? '' : 's'}`} preventClose={busy} wide>
      <ul className="max-h-[50vh] overflow-y-auto rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] divide-y divide-[var(--adf-ui-border)]">
        {calls.map((call) => (
          <li key={call.requestId} className="flex min-w-0 items-center gap-3 px-3 py-1.5">
            <span className="shrink-0 font-mono text-[12px] text-[var(--adf-ui-text)]">{call.toolName}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--adf-ui-text-muted)]">{call.target}</span>
          </li>
        ))}
      </ul>
      {overrideCount > 0 && (
        <p className="mt-2 text-[12px] text-[var(--adf-ui-text-muted)]">
          {overrideCount} protection override{overrideCount === 1 ? ' is' : 's are'} not included.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-[var(--adf-ui-danger)]">{error}</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={onConfirm} loading={busy} disabled={busy || n === 0}>
          Approve {n} call{n === 1 ? '' : 's'}
        </Button>
      </div>
    </Dialog>
  )
}
