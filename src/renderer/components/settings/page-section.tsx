import { DocsLink } from '../common/DocsLink'

/**
 * A section of Settings → Connections: a heading, one help sentence, and the
 * rows. `collapsible` sections fold to their heading line, which keeps the
 * summary (a state or a count) in view, so nothing is hidden outright.
 * `open` is where a collapsible section starts; the user can open or close
 * it at any time.
 */
export function PageSection({ id, title, icon, help, summary, docs, collapsible = false, open = true, children }: {
  id: string
  title: string
  icon?: React.ReactNode
  help?: React.ReactNode
  /** On the heading line, right-aligned: the state or the count. */
  summary?: React.ReactNode
  docs?: string
  collapsible?: boolean
  open?: boolean
  children?: React.ReactNode
}) {
  const heading = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {collapsible && (
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0 text-[var(--adf-ui-text-subtle)] transition-transform group-open:rotate-90">
          <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {icon && <span className="shrink-0 text-[var(--adf-ui-text-muted)]">{icon}</span>}
      <h2 className="truncate text-[13px] font-semibold text-[var(--adf-ui-text)]">{title}</h2>
      {summary !== undefined && summary !== null && <span className="ml-auto shrink-0 text-[12px] text-[var(--adf-ui-text-muted)]" data-section-summary="">{summary}</span>}
      {docs && <span className={summary !== undefined && summary !== null ? 'shrink-0' : 'ml-auto shrink-0'}><DocsLink href={docs} /></span>}
    </div>
  )
  const helpLine = help ? <p className="px-4 pb-2.5 -mt-1 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">{help}</p> : null
  const shell = 'rounded-[var(--adf-ui-container-radius)] border border-hairline bg-[var(--adf-ui-surface)]'
  if (!collapsible) {
    return (
      <section className={shell} data-section={id}>
        <div className="flex items-center px-4 pt-3.5 pb-2.5">{heading}</div>
        {helpLine}
        {children}
      </section>
    )
  }
  return (
    <section className={shell} data-section={id}>
      <details className="group" open={open}>
        <summary className="flex cursor-pointer select-none list-none items-center rounded-[var(--adf-ui-container-radius)] px-4 pt-3.5 pb-2.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] [&::-webkit-details-marker]:hidden">
          {heading}
        </summary>
        {helpLine}
        {children}
      </details>
    </section>
  )
}

/** A row of a section: content on the left, controls on the right, aligned on one grid. */
export function SectionRow({ children, actions, separator = true, className = '', ...rest }: {
  children: React.ReactNode
  actions?: React.ReactNode
  separator?: boolean
  className?: string
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`flex items-center justify-between gap-4 px-4 py-3 ${separator ? 'border-t border-[var(--adf-ui-separator)]' : ''} ${className}`}>
      <div className="min-w-0 flex-1 text-[12px]">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}

/** A state word with its dot: green connected, amber in progress, red down, grey off. */
export function StateDot({ tone, children }: { tone: 'ok' | 'busy' | 'down' | 'off'; children: React.ReactNode }) {
  const dot = tone === 'ok' ? 'bg-[var(--adf-ui-success)]' : tone === 'busy' ? 'bg-[var(--adf-ui-warning)]' : tone === 'down' ? 'bg-[var(--adf-ui-danger)]' : 'bg-[var(--adf-ui-border)]'
  const text = tone === 'down' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-normal ${text}`} data-state={tone}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  )
}

/** Technical detail kept off a status line: a native disclosure, closed by default. */
export function DetailsList({ lines, label = 'Details' }: { lines: string[]; label?: string }) {
  if (lines.length === 0) return null
  return (
    <details className="mt-1 text-[11px] text-[var(--adf-ui-text-subtle)]">
      <summary className="cursor-pointer select-none hover:text-[var(--adf-ui-text-muted)]">{label}</summary>
      <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 break-all">
        {lines.map((line) => {
          const at = line.indexOf(': ')
          return at > 0
            ? <div key={line} className="contents"><dt className="text-[var(--adf-ui-text-muted)]">{line.slice(0, at)}</dt><dd>{line.slice(at + 2)}</dd></div>
            : <div key={line} className="col-span-2">{line}</div>
        })}
      </dl>
    </details>
  )
}
