import type { ReactNode } from 'react'

/**
 * Status dot color shown in the top-right of a tile.
 *  - 'ok'      → green (fully configured / working)
 *  - 'warn'    → yellow (partially configured / mixed state)
 *  - 'error'   → red (configured but failing)
 *  - 'idle'    → gray (nothing configured / N/A)
 *  - undefined → no dot rendered
 */
export type TileStatus = 'ok' | 'warn' | 'error' | 'idle'

interface DashboardTileProps {
  icon: ReactNode
  label: string
  /** Primary value, large. e.g. "3/4" or "12.3k". Ignored when `loading`. */
  value: ReactNode
  /** Smaller secondary line under the value. Ignored when `loading`. */
  subValue?: ReactNode
  status?: TileStatus
  /**
   * When true, replaces value/subValue with pulsing placeholders.
   * The label and icon stay visible so the user sees which slice is loading.
   */
  loading?: boolean
  /** Click handler — undefined renders a non-interactive tile. */
  onClick?: () => void
}

const STATUS_CLASSES: Record<TileStatus, string> = {
  ok: 'bg-green-500',
  warn: 'bg-yellow-500',
  error: 'bg-red-500',
  idle: 'bg-neutral-400 dark:bg-neutral-600',
}

export function DashboardTile({ icon, label, value, subValue, status, loading, onClick }: DashboardTileProps) {
  const interactive = !!onClick && !loading
  const Tag = interactive ? 'button' : 'div'

  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onClick : undefined}
      aria-busy={loading || undefined}
      className={[
        'relative flex flex-col items-start text-left',
        'rounded-xl border border-neutral-200/70 dark:border-neutral-700/60',
        'bg-white dark:bg-neutral-800/80',
        'shadow-sm',
        'px-4 py-4 min-h-[100px]',
        'transition-all duration-200',
        interactive
          ? 'hover:shadow-md hover:-translate-y-0.5 hover:border-neutral-300 dark:hover:border-neutral-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/50'
          : '',
      ].join(' ')}
    >
      {/* Status dot hidden while loading — we don't want a stale color */}
      {!loading && status && (
        <span
          aria-hidden
          className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${STATUS_CLASSES[status]}`}
        />
      )}
      {/* Loading shimmer in the dot's slot so the tile doesn't feel inert */}
      {loading && (
        <span
          aria-hidden
          className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600 animate-pulse"
        />
      )}

      <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-neutral-100 dark:bg-neutral-700/50 text-sm leading-none">
          {icon}
        </span>
        <span className="font-medium">{label}</span>
      </div>

      {loading ? (
        <>
          <div className="mt-3 h-5 w-12 rounded bg-neutral-200 dark:bg-neutral-700 animate-pulse" />
          <div className="mt-1.5 h-3 w-24 rounded bg-neutral-100 dark:bg-neutral-700/60 animate-pulse" />
        </>
      ) : (
        <>
          <div className="mt-3 text-lg font-semibold text-neutral-800 dark:text-neutral-100 leading-tight">
            {value}
          </div>
          {subValue !== undefined && (
            <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 leading-tight">
              {subValue}
            </div>
          )}
        </>
      )}
    </Tag>
  )
}
