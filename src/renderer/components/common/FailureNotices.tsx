import { useFailureNoticesStore } from '../../stores/failure-notices.store'

/**
 * Failed starts, stops and folder actions, bottom right, until dismissed.
 * Every window has its own: a Stop in an agent window reports there.
 */
export function FailureNotices() {
  const notices = useFailureNoticesStore((s) => s.notices)
  const dismiss = useFailureNoticesStore((s) => s.dismiss)
  if (notices.length === 0) return null
  return (
    <div className="fixed bottom-8 right-3 z-[60] flex flex-col gap-1.5 pointer-events-none" role="alert" aria-live="assertive">
      {notices.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto w-72 flex items-start gap-2 rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-danger)]/40 bg-surface-raised shadow-float px-3 py-2"
        >
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--adf-ui-danger)]" aria-hidden />
          <span className="min-w-0 flex-1 text-[11px] leading-4 text-[var(--adf-ui-text)] [overflow-wrap:anywhere]">{n.text}</span>
          <button
            type="button"
            onClick={() => dismiss(n.id)}
            aria-label="Dismiss"
            className="shrink-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 text-xs leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
