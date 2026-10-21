/**
 * The agent server glyphs (Settings → Connections). Same stroke style as the
 * Settings nav icons: no fill, round caps and joins, `currentColor`.
 *
 * - `ServerIcon` (24 grid): an agent server, two stacked units. It is the
 *   Connections nav icon too.
 * - `ConnectIcon` and `ShareIcon` (48 grid): the two choices of Add.
 *   Connect: this computer, an arrow out to one server. Share: this
 *   computer on the left, three computers on the right, an arrow in from
 *   each.
 */

const STROKE = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function ServerIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.8" {...STROKE} aria-hidden="true" className={className} data-server-icon="">
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M8 7h.01M8 17h.01" />
    </svg>
  )
}

/** A computer with an arrow out to a server: Connect. */
export function ConnectIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" strokeWidth="1.8" {...STROKE} aria-hidden="true" data-choice-icon="connect">
      {/* This computer */}
      <rect x="3" y="15" width="17" height="11" rx="2" />
      <path d="M1.5 30.5h20" />
      {/* Out */}
      <path d="M24 23h8m-3-3 3 3-3 3" />
      {/* The server */}
      <rect x="35" y="13" width="11" height="9" rx="1.5" />
      <rect x="35" y="24" width="11" height="9" rx="1.5" />
      <path d="M38.5 17.5h.01M38.5 28.5h.01" />
    </svg>
  )
}

/** This computer on the left, three computers on the right, an arrow in from each: Share. */
export function ShareIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" strokeWidth="1.8" {...STROKE} aria-hidden="true" data-choice-icon="share">
      {/* This computer */}
      <rect x="2" y="16.5" width="16" height="12" rx="2" />
      <path d="M0.5 32.5h19" />
      {/* In, from each computer */}
      <path d="M33 9.5 21.5 18.5M25 18.3l-3.5.2 1-3.35" />
      <path d="M33 24H21.5m3-3-3 3 3 3" />
      <path d="M33 38.5 21.5 29.5m1 3.35-1-3.35 3.5.2" />
      {/* The other computers */}
      <rect x="36" y="6" width="10" height="7" rx="1.5" />
      <path d="M34.5 15.5h13" />
      <rect x="36" y="20.5" width="10" height="7" rx="1.5" />
      <path d="M34.5 30h13" />
      <rect x="36" y="35" width="10" height="7" rx="1.5" />
      <path d="M34.5 44.5h13" />
    </svg>
  )
}
