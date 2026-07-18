import { memo, useEffect, useMemo, useState } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { pathBasename } from './fleet-layout'
import type { StationNodeData } from './FleetStationNode'
import type { RemotePeerAgent } from '../../../shared/types/ipc.types'

/**
 * Remote runtime readout — the full-detail modal for a peer hub, same family
 * as the agent readouts: who it is (alias, owner, verified), how we reach it
 * (route, address), what it hosts (its agents, click-through to their cards),
 * and what traffic has moved. Opened by clicking the peer station platform.
 */

const SOURCE_LABEL: Record<string, string> = {
  mdns: 'LAN · mDNS',
  tailnet: 'Tailnet',
  manual: 'manual peer'
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export const FleetStationReadout = memo(function FleetStationReadout({
  stationId,
  data,
  onClose,
  onOpenAgent,
  onOpenLocalAgent
}: {
  stationId: string
  data: StationNodeData
  onClose: () => void
  onOpenAgent: (agent: RemotePeerAgent) => void
  /** A top-talker chip was clicked — open that LOCAL agent's readout. */
  onOpenLocalAgent: (filePath: string) => void
}) {
  const agents = useMeshStore((s) => s.agents)
  const edgeHeat = useMeshGraphStore((s) => s.edgeHeat)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // An agent readout opened from here paints on top — let IT take the Esc
      if (useFleetStore.getState().peerReadout) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const detail = data.detail
  const peerAgents = data.peerAgents ?? []

  // Traffic through this station, from the same persisted heat ledger the
  // hover card reads — counts survive restarts (7-day prune). Each "talker"
  // is one of OUR local agents (or another station) that exchanged messages
  // with this runtime; local agents click through to their readout.
  const stats = useMemo(() => {
    let inbound = 0
    let outbound = 0
    let lastAt = 0
    const per = new Map<string, number>()
    for (const [key, entry] of Object.entries(edgeHeat)) {
      const [from, to] = key.split('|')
      if (from !== stationId && to !== stationId) continue
      if (from === stationId) inbound += entry.count
      else outbound += entry.count
      lastAt = Math.max(lastAt, entry.lastAt)
      const other = from === stationId ? to : from
      per.set(other, (per.get(other) ?? 0) + entry.count)
    }
    const top = [...per.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p, count]) => {
        const local = p.startsWith('station:') ? undefined : agents.find((ag) => ag.filePath === p)
        return {
          key: p,
          count,
          handle: local?.handle
            ?? (p.startsWith('station:') ? p.slice('station:'.length) : pathBasename(p).replace(/\.adf$/, '')),
          icon: local?.icon,
          localFilePath: local?.filePath
        }
      })
    return { inbound, outbound, lastAt, top }
  }, [edgeHeat, stationId, agents])

  const ownerLine = detail?.isSelfOwned
    ? { text: '✓ your runtime', tone: 'text-indigo-600 dark:text-indigo-400' }
    : detail?.ownerAlias
      ? detail.ownerVerified
        ? { text: `owned by ${detail.ownerAlias}`, tone: 'text-neutral-600 dark:text-neutral-300' }
        : { text: `${detail.ownerAlias} · unverified`, tone: 'text-neutral-400 dark:text-neutral-500' }
      : null

  const reachable = detail?.agentCount != null

  const copy = (label: string, value: string): void => {
    void navigator.clipboard.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied(null), 1200)
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] max-h-[82vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <span className="text-3xl leading-none shrink-0">🛰️</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
                {data.label}
              </span>
              <span className={`w-2 h-2 rounded-full shrink-0 ${reachable ? 'bg-green-400' : 'bg-amber-400'}`} />
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {reachable ? `${detail?.agentCount} agent${detail?.agentCount === 1 ? '' : 's'}` : 'directory unreachable'}
              </span>
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
              remote runtime
              {detail?.source && ` — ${SOURCE_LABEL[detail.source] ?? detail.source}`}
              {ownerLine && <span className={`ml-1.5 ${ownerLine.tone}`}>· {ownerLine.text}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 shrink-0"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-3">
          {/* Reach — where this runtime lives */}
          <div className="space-y-1.5">
            {detail?.host && (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 w-10 shrink-0">host</span>
                <span className="font-mono text-[11px] text-neutral-600 dark:text-neutral-300 truncate">{detail.host}</span>
              </div>
            )}
            {detail?.url && (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 w-10 shrink-0">url</span>
                <button
                  onClick={() => copy('url', detail.url!)}
                  className="flex-1 min-w-0 text-left font-mono text-[11px] text-neutral-600 dark:text-neutral-300 truncate hover:text-neutral-800 dark:hover:text-neutral-100"
                  title="Click to copy"
                >
                  {detail.url}
                </button>
                {copied === 'url' && <span className="text-[10px] text-green-500 shrink-0">copied</span>}
              </div>
            )}
            {detail?.firstSeen && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 w-10 shrink-0">seen</span>
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">first discovered {ago(Date.now() - detail.firstSeen)}</span>
              </div>
            )}
          </div>

          {/* Its agents — click through to the full card readout */}
          {peerAgents.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1.5">
                agents · {peerAgents.length}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {peerAgents.map((a) => (
                  <button
                    key={a.did ?? a.handle}
                    onClick={() => onOpenAgent(a)}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-left min-w-0"
                    title={`${a.handle} — open card`}
                  >
                    <span className="text-lg leading-none shrink-0">{a.icon || '🤖'}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12px] font-medium text-neutral-700 dark:text-neutral-200 truncate">{a.handle}</span>
                      {a.status && <span className="block text-[10px] italic text-neutral-400 dark:text-neutral-500 truncate">{a.status}</span>}
                    </span>
                    {a.card_verified && <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" title="card signature verified" />}
                  </button>
                ))}
              </div>
            </div>
          )}
          {peerAgents.length === 0 && (
            <div className="py-2 text-center text-[11px] italic text-neutral-400 dark:text-neutral-500">
              {reachable ? 'No agents visible to this runtime.' : 'Directory unreachable — agent list unknown.'}
            </div>
          )}

          {/* Traffic with your fleet */}
          <div className="pt-1 border-t border-neutral-100 dark:border-neutral-800">
            <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 pt-2">
              traffic with your fleet
            </div>
            <div className="flex items-center gap-3 text-[11px] text-neutral-600 dark:text-neutral-300 tabular-nums mt-1">
              <span>↓ {stats.inbound} received from it</span>
              <span>↑ {stats.outbound} sent to it</span>
              {stats.lastAt > 0 && (
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto">last {ago(Date.now() - stats.lastAt)}</span>
              )}
            </div>
            {stats.top.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500">
                  Who's been talking to this runtime:
                </div>
                {stats.top.map((t) =>
                  t.localFilePath ? (
                    <button
                      key={t.key}
                      onClick={() => onOpenLocalAgent(t.localFilePath!)}
                      className="w-full flex items-center gap-2 px-2 py-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-left"
                      title={`${t.handle} — open its readout`}
                    >
                      {t.icon && <span className="text-sm leading-none shrink-0">{t.icon}</span>}
                      <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-200 truncate">{t.handle}</span>
                      <span className="text-[9px] px-1.5 py-px rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 shrink-0">
                        your agent
                      </span>
                      <span className="text-[11px] text-neutral-400 dark:text-neutral-500 tabular-nums ml-auto shrink-0">
                        {t.count} msg{t.count === 1 ? '' : 's'}
                      </span>
                    </button>
                  ) : (
                    <div key={t.key} className="flex items-baseline gap-2 text-[11px] px-2">
                      <span className="text-neutral-700 dark:text-neutral-200 truncate">{t.handle}</span>
                      <span className="text-neutral-400 dark:text-neutral-500 tabular-nums ml-auto shrink-0">
                        {t.count} msg{t.count === 1 ? '' : 's'}
                      </span>
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="mt-1.5 text-[11px] italic text-neutral-400 dark:text-neutral-500">no traffic yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
