/**
 * Small presentational pieces of the agent Config panel (and the Timers
 * notice that links into it). State lives in the callers; these render.
 */

import { PERMISSION_LABELS, PERMISSION_TIPS, mcpStatusView, saveStatusText, type ConfigSaveStatus, type PermissionKind } from './config-panel-model'
import type { McpServerStatus } from '../../../shared/types/adf-v02.types'

type IconProps = { size?: number; filled?: boolean; className?: string }

/** Needs approval: a person with a check. */
export function ApprovalIcon({ size = 14, filled = false, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={filled ? 2.2 : 1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" fill={filled ? 'currentColor' : 'none'} />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  )
}

/** Locked (closed) or unlocked (open shackle). */
export function LockIcon({ size = 14, open = false, className }: { size?: number; open?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      {open ? <path d="M7 11V7a5 5 0 0 1 9.9-1" /> : <path d="M7 11V7a5 5 0 0 1 10 0v4" />}
    </svg>
  )
}

/** Restricted: a shield. */
export function ShieldIcon({ size = 14, filled = false, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

export function EyeIcon({ size = 14, off = false, className }: { size?: number; off?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  )
}

/** Colour of each permission's "on" icon. */
export const PERMISSION_ON_CLASS: Record<PermissionKind, string> = {
  approval: 'text-violet-600 dark:text-violet-400',
  locked: 'text-amber-500 dark:text-amber-400',
  restricted: 'text-teal-600 dark:text-teal-400',
  visible: 'text-blue-500 dark:text-blue-400',
}

function LegendIcon({ kind }: { kind: PermissionKind }) {
  const cls = `inline shrink-0 ${PERMISSION_ON_CLASS[kind]}`
  if (kind === 'approval') return <ApprovalIcon size={11} className={cls} />
  if (kind === 'locked') return <LockIcon size={11} className={cls} />
  if (kind === 'restricted') return <ShieldIcon size={11} filled className={cls} />
  return <EyeIcon size={11} className={cls} />
}

/** One compact row naming the icons a list uses. */
export function PermissionLegend({ kinds }: { kinds: PermissionKind[] }) {
  return (
    <p className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-neutral-500 dark:text-neutral-400">
      {kinds.map((kind) => (
        <span key={kind} title={PERMISSION_TIPS[kind]} className="inline-flex items-center gap-1">
          <LegendIcon kind={kind} />
          {PERMISSION_LABELS[kind]}
        </span>
      ))}
    </p>
  )
}

/** "Locked" badge (click to unlock) or an open lock (click to lock). */
export function LockBadge({ locked, onClick, size = 'sm' }: { locked: boolean; onClick: () => void; size?: 'sm' | 'xs' }) {
  const px = size === 'xs' ? 10 : 12
  if (locked) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClick() }}
        aria-pressed
        title={`${PERMISSION_TIPS.locked} Click to unlock.`}
        className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1 py-px text-[10px] font-medium normal-case tracking-normal text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
      >
        <LockIcon size={px} />
        {PERMISSION_LABELS.locked}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      aria-pressed={false}
      aria-label="Lock"
      title={`${PERMISSION_TIPS.locked} Click to lock.`}
      className="shrink-0 text-[var(--adf-ui-icon-muted)] transition-colors hover:text-[var(--adf-ui-text-subtle)]"
    >
      <LockIcon size={px + 2} open />
    </button>
  )
}

export function WarningIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="7" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

/**
 * Row warning: an exclamation icon whose tooltip says why. With `onJump` it
 * is a button that opens the section holding the switch.
 */
export function RowWarning({ tip, onJump }: { tip: string; onJump?: () => void }) {
  const cls = 'inline-flex shrink-0 items-center text-amber-500 dark:text-amber-400'
  if (onJump) {
    return (
      <button type="button" title={tip} aria-label={tip} onClick={onJump} className={`${cls} hover:text-amber-600 dark:hover:text-amber-300`}>
        <WarningIcon />
      </button>
    )
  }
  return <span title={tip} aria-label={tip} role="img" className={cls}><WarningIcon /></span>
}

const MCP_TONE_CLASS = {
  ok: 'bg-green-500',
  pending: 'bg-amber-400 animate-pulse',
  failed: 'bg-red-500',
  idle: 'bg-neutral-400',
} as const

export function McpStatusChip({ status }: { status: McpServerStatus | undefined }) {
  const view = mcpStatusView(status)
  if (!view) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-normal text-neutral-500 dark:text-neutral-400" role="status">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${MCP_TONE_CLASS[view.tone]}`} />
      {view.label}
    </span>
  )
}

/** The panel header's save line: Saving…, Saved, or Not saved: reason with Retry. */
export function SaveStatusLine({ status, onRetry, onDiscard }: { status: ConfigSaveStatus; onRetry: () => void; onDiscard: () => void }) {
  if (status.kind === 'idle') return null
  const text = saveStatusText(status)
  if (status.kind !== 'error') {
    return <span role="status" className="shrink-0 px-2 text-[10px] text-[var(--adf-ui-text-subtle)]">{text}</span>
  }
  return (
    <span role="alert" className="flex min-w-0 items-center gap-1.5 px-2 text-[10px] text-[var(--adf-ui-danger)]">
      <span className="min-w-0 truncate" title={text}>{text}</span>
      <button type="button" onClick={onRetry} className="shrink-0 font-medium text-blue-500 hover:underline dark:text-blue-400">Retry</button>
      <button type="button" onClick={onDiscard} className="shrink-0 text-neutral-500 hover:underline dark:text-neutral-400">Discard</button>
    </span>
  )
}

/** Bottom-of-panel notice after a bulk change removed approval gates. */
export function UndoToast({ message, onUndo, onDismiss }: { message: string; onUndo: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="sticky bottom-2 z-20 mx-3 mb-2 flex items-center gap-2 rounded-lg border border-hairline bg-surface-0 px-3 py-2 text-xs shadow-lg">
      <span className="min-w-0 flex-1 truncate text-[var(--adf-ui-text)]">{message}</span>
      <button type="button" onClick={onUndo} className="shrink-0 font-medium text-blue-500 hover:underline dark:text-blue-400">Undo</button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-[var(--adf-ui-text-subtle)] hover:text-neutral-600 dark:hover:text-neutral-200">&times;</button>
    </div>
  )
}

/** Timers panel: the on_timer trigger is off, so nothing here fires. */
export const TIMERS_BLOCKED_TIP = 'Off: On timer trigger is off'

export function TimersBlockedNotice({ onJump }: { onJump: () => void }) {
  return (
    <p role="status" title={TIMERS_BLOCKED_TIP} className="mx-3 mb-1 flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
      <WarningIcon />
      <span>Off</span>
      <button type="button" onClick={onJump} className="ml-auto text-blue-500 hover:underline dark:text-blue-400">Triggers ›</button>
    </p>
  )
}
