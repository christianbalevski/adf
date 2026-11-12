import type { ReactNode } from 'react'

/** Grid of PickerTiles, as in the Add channel and Add MCP server dialogs. */
export function PickerGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 md:grid-cols-3">{children}</div>
}

/** One choice in a PickerGrid: icon, name, one or two lines of detail. */
export function PickerTile({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-2.5 text-left transition-colors hover:border-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium text-[var(--adf-ui-text)]">{title}</span>
        <span className="mt-0.5 line-clamp-2 block break-words text-[10.5px] leading-4 text-[var(--adf-ui-text-muted)]">{detail}</span>
      </span>
    </button>
  )
}
