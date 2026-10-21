/**
 * The agent server glyphs (Settings → Connections). Same stroke style as the
 * Settings nav icons: no fill, round caps and joins, `currentColor`.
 *
 * - `ServerIcon` (24 grid): an agent server, two stacked units. It is the
 *   Connections nav icon too.
 * - `ConnectIcon` and `ShareIcon` (48 grid): the two choices of Add.
 *   Connect: this computer, an arrow out to one server. Share: three
 *   computers, an arrow in from each to this server.
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

/** Three computers with an arrow in from each to a server: Share. */
export function ShareIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" strokeWidth="1.8" {...STROKE} aria-hidden="true" data-choice-icon="share">
      {/* The computers */}
      <rect x="3" y="5" width="11" height="7" rx="1.5" />
      <path d="M6 15h5" />
      <rect x="3" y="20.5" width="11" height="7" rx="1.5" />
      <path d="M6 30.5h5" />
      <rect x="3" y="36" width="11" height="7" rx="1.5" />
      <path d="M6 46h5" />
      {/* In */}
      <path d="M17.5 10 29 18.5m-.4-3.5.4 3.5-3.5.5" />
      <path d="M17.5 24H29m-3-3 3 3-3 3" />
      <path d="M17.5 38 29 29.5m-3.5-.5 3.5.5-.4 3.5" />
      {/* This server */}
      <rect x="33" y="13" width="12" height="9.5" rx="1.5" />
      <rect x="33" y="25.5" width="12" height="9.5" rx="1.5" />
      <path d="M36.5 17.75h.01M36.5 30.25h.01" />
    </svg>
  )
}
