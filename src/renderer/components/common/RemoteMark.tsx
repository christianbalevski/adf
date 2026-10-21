import { Tooltip } from './Tooltip'
import { REMOTE_TIP } from '../../../shared/runtime-name'

/** The remote glyph: a screen with an arrow down into it. */
export function RemoteIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-remote-mark="">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
      <path d="m15 8-3 3-3-3" />
    </svg>
  )
}

/**
 * Beside a remote runtime's name (docs/design/multi-runtime.md §1.3): the
 * remote icon, tooltip "Remote". The local runtime is named `<name> (Local)`
 * and has no mark.
 */
export function RemoteMark({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <Tooltip tip={REMOTE_TIP} className={`inline-flex shrink-0 items-center ${className}`}>
      <RemoteIcon size={size} />
    </Tooltip>
  )
}
