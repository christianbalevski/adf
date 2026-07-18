import { memo, useMemo } from 'react'
import type { RemotePeerAgent } from '../../../shared/types/ipc.types'

/**
 * Hover card for a remote agent on a peer-runtime station — the agent's
 * signed card, nicely formatted: identity (handle, host, DID), what it says
 * about itself (description, live status), and how far to trust it
 * (signature verified, owner attested, visibility tier). Same presentation
 * rules as the other hover cards: screen-space, pointer-transparent, flipped
 * away from window edges.
 */

const CARD_W = 320
const CARD_EST_H = 260

/** Discovery route → human label, matching the Settings/station-card wording. */
const SOURCE_LABEL: Record<string, string> = {
  mdns: 'LAN · mDNS',
  tailnet: 'Tailnet',
  manual: 'manual peer'
}

export const FleetPeerAgentCard = memo(function FleetPeerAgentCard({
  agent,
  peerHost,
  peerSource,
  x,
  y
}: {
  agent: RemotePeerAgent
  peerHost: string
  /** How the hub was reached (route) — every agent under it shares it. */
  peerSource?: string
  x: number
  y: number
}) {
  const position = useMemo(() => {
    const left = x + 18 + CARD_W > window.innerWidth ? x - CARD_W - 18 : x + 18
    const top = Math.min(y + 14, window.innerHeight - CARD_EST_H)
    return { left: Math.max(8, left), top: Math.max(8, top) }
  }, [x, y])

  const didShort = agent.did
    ? agent.did.length > 34 ? `${agent.did.slice(0, 22)}…${agent.did.slice(-8)}` : agent.did
    : null

  return (
    <div
      className="fixed z-30 pointer-events-none rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm shadow-xl overflow-hidden"
      style={{ ...position, width: CARD_W, animation: 'meshFadeIn 150ms ease-out' }}
    >
      {/* Identity */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="text-2xl leading-none shrink-0">{agent.icon || '🤖'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
              {agent.handle}
            </span>
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">@ {peerHost}</span>
          </div>
          {agent.status ? (
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 italic truncate">{agent.status}</div>
          ) : (
            <div className="text-[11px] text-neutral-400 dark:text-neutral-500 italic">remote agent</div>
          )}
        </div>
      </div>

      {/* Trust + reach */}
      <div className="flex items-center gap-1.5 px-3.5 pb-2 flex-wrap">
        {agent.card_verified ? (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400">
            ✓ signed card
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500">
            unverified
          </span>
        )}
        {agent.owner_attested && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400">
            owner attested
          </span>
        )}
        {peerSource && (
          <span
            className="text-[10px] px-1.5 py-px rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
            title="How this runtime is reached"
          >
            via {SOURCE_LABEL[peerSource] ?? peerSource}
          </span>
        )}
        {agent.mesh_routes && agent.mesh_routes.length > 0 && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 tabular-nums">
            {agent.mesh_routes.length} route{agent.mesh_routes.length === 1 ? '' : 's'}
          </span>
        )}
        {agent.shared && agent.shared.length > 0 && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 tabular-nums">
            {agent.shared.length} shared file{agent.shared.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Description */}
      {agent.description && (
        <div className="px-3.5 pb-2 border-t border-neutral-100 dark:border-neutral-800 pt-2">
          <div
            className="text-[11px] leading-snug text-neutral-600 dark:text-neutral-300"
            style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {agent.description}
          </div>
        </div>
      )}

      {/* DID */}
      {didShort && (
        <div className="px-3.5 pb-1.5 pt-1">
          <span className="font-mono text-[9px] text-neutral-400 dark:text-neutral-500 break-all" title={agent.did}>
            {didShort}
          </span>
        </div>
      )}

      {/* Teaser → full card */}
      <div className="px-3.5 pb-2 text-[9px] text-neutral-300 dark:text-neutral-600">
        click tile for the full card
      </div>
    </div>
  )
})
