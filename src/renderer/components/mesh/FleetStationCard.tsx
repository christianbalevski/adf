import { memo, useMemo } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { pathBasename } from './fleet-layout'

/**
 * Station hover/click card — screen-space stats for a base station: what it
 * is, whether it's healthy, how much traffic it has moved and with whom.
 * Same presentation rules as the agent hover card (pointer-transparent,
 * flipped away from window edges, readable at any zoom).
 */

const CARD_W = 300
const CARD_EST_H = 240

export interface StationCardInfo {
  id: string
  kind: string
  label: string
  status: string
  detail?: { host?: string; agentCount?: number; firstSeen?: number; source?: string; ownerAlias?: string; ownerVerified?: boolean; isSelfOwned?: boolean }
}

const KIND_LABEL: Record<string, string> = {
  telegram: 'channel adapter',
  email: 'channel adapter',
  discord: 'channel adapter',
  imessage: 'channel adapter',
  slack: 'channel adapter',
  web: 'web gateway — sys_fetch + WS links',
  peer: 'peer runtime'
}

/** How this peer was reached — the same routes shown in Settings. */
const SOURCE_LABEL: Record<string, string> = {
  mdns: 'LAN · mDNS',
  tailnet: 'Tailnet',
  manual: 'manual peer'
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-green-400',
  connected: 'bg-green-400',
  error: 'bg-red-400',
  stopped: 'bg-neutral-400'
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export const FleetStationCard = memo(function FleetStationCard({
  station,
  x,
  y
}: {
  station: StationCardInfo
  x: number
  y: number
}) {
  const agents = useMeshStore((s) => s.agents)
  const edgeHeat = useMeshGraphStore((s) => s.edgeHeat)

  // Traffic through this station, from the same heat ledger that grows its
  // platform: counts survive restarts (persisted, 7-day prune), so this is
  // "recent" traffic rather than an exact 24h window.
  const stats = useMemo(() => {
    let inbound = 0 // station → fleet (messages arriving from outside)
    let outbound = 0 // fleet → station (replies / fetches going out)
    let lastAt = 0
    const per = new Map<string, number>()
    for (const [key, entry] of Object.entries(edgeHeat)) {
      const [from, to] = key.split('|')
      if (from !== station.id && to !== station.id) continue
      if (from === station.id) inbound += entry.count
      else outbound += entry.count
      lastAt = Math.max(lastAt, entry.lastAt)
      const other = from === station.id ? to : from
      per.set(other, (per.get(other) ?? 0) + entry.count)
    }
    const handleOf = (p: string): string => {
      if (p.startsWith('station:')) return p.slice('station:'.length)
      const a = agents.find((ag) => ag.filePath === p)
      return a?.handle ?? pathBasename(p).replace(/\.adf$/, '')
    }
    const top = [...per.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, count]) => ({ handle: handleOf(p), count }))
    return { inbound, outbound, lastAt, top }
  }, [edgeHeat, station.id, agents])

  const position = useMemo(() => {
    const left = x + 18 + CARD_W > window.innerWidth ? x - CARD_W - 18 : x + 18
    const top = Math.min(y + 14, window.innerHeight - CARD_EST_H)
    return { left: Math.max(8, left), top: Math.max(8, top) }
  }, [x, y])

  const detail = station.detail

  return (
    <div
      className="fixed z-30 pointer-events-none rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm shadow-xl overflow-hidden"
      style={{ ...position, width: CARD_W, animation: 'meshFadeIn 150ms ease-out' }}
    >
      {/* Identity */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
              {station.label}
            </span>
            <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[station.status] ?? 'bg-neutral-400'}`} />
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 italic shrink-0">
              {station.status}
            </span>
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
            {KIND_LABEL[station.kind] ?? 'base station'}
            {station.kind === 'peer' && station.detail?.source &&
              ` — ${SOURCE_LABEL[station.detail.source] ?? station.detail.source}`}
          </div>
          {station.kind === 'peer' && (station.detail?.isSelfOwned || station.detail?.ownerAlias) && (
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
              {station.detail.isSelfOwned
                ? '✓ your runtime'
                : station.detail.ownerVerified
                  ? `owned by ${station.detail.ownerAlias}`
                  : `${station.detail.ownerAlias} · unverified`}
            </div>
          )}
        </div>
      </div>

      {/* Peer runtime details */}
      {detail && (
        <div className="flex items-center gap-1.5 px-3.5 pb-2 flex-wrap">
          {detail.host && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
              {detail.host}
            </span>
          )}
          {detail.agentCount != null && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 tabular-nums">
              {detail.agentCount} agents
            </span>
          )}
          {detail.firstSeen && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
              first seen {ago(Date.now() - detail.firstSeen)}
            </span>
          )}
        </div>
      )}

      {/* Traffic */}
      <div className="px-3.5 pb-2.5 border-t border-neutral-100 dark:border-neutral-800 pt-2">
        <div className="flex items-center gap-3 text-[11px] text-neutral-600 dark:text-neutral-300 tabular-nums">
          <span title="Messages from the outside world into the fleet">↓ {stats.inbound} in</span>
          <span title="Messages from the fleet out through this station">↑ {stats.outbound} out</span>
          {stats.lastAt > 0 && (
            <span className="text-neutral-400 dark:text-neutral-500 ml-auto">{ago(Date.now() - stats.lastAt)}</span>
          )}
        </div>
        {stats.top.length > 0 ? (
          <div className="mt-1.5 space-y-0.5">
            {stats.top.map((t) => (
              <div key={t.handle} className="flex items-baseline gap-2 text-[11px]">
                <span className="text-neutral-700 dark:text-neutral-200 truncate">{t.handle}</span>
                <span className="text-neutral-400 dark:text-neutral-500 tabular-nums ml-auto shrink-0">
                  {t.count} msg{t.count === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] italic text-neutral-400 dark:text-neutral-500">no traffic yet</div>
        )}
      </div>
    </div>
  )
})
