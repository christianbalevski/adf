import { memo, useEffect, useMemo } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import { hueFromPath, formatTokens } from './FleetTerrainNode'
import { isUnder, pathSegments } from './fleet-layout'

/**
 * Group readout — the full-screen answer to clicking a voice chip: the
 * complete (untruncated) group status, cluster vitals, and the member
 * roster. Same presentation family as the shortcuts overlay: backdrop blur,
 * centered card, Esc or click-away to close.
 */

const STATE_DOT: Record<string, string> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400',
  hibernate: 'bg-sky-400',
  suspended: 'bg-orange-400'
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export const FleetGroupReadout = memo(function FleetGroupReadout({
  dir,
  onClose,
  onFocusAgent
}: {
  dir: string
  onClose: () => void
  onFocusAgent: (filePath: string) => void
}) {
  const agents = useMeshStore((s) => s.agents)
  const stewards = useFleetStore((s) => s.stewards)
  const burn = useFleetStore((s) => s.burn)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const { members, steward, voice, stats } = useMemo(() => {
    const members = agents
      .filter((a) => isUnder(a.filePath, dir))
      .sort((a, b) => a.handle.localeCompare(b.handle))
    const stewardDid = stewards[dir]
    const steward = stewardDid ? members.find((a) => a.did === stewardDid) : undefined
    // Voice mirrors the map: steward if appointed, else most recently active
    let voice = steward
    if (!voice) {
      let bestAt = -1
      for (const a of members) {
        const acts = nodeActivities[a.filePath]
        const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
        const score = a.state === 'active' ? last + 1e15 : last
        if (score > bestAt) {
          bestAt = score
          voice = a
        }
      }
    }
    let online = 0, active = 0, error = 0, pending = 0, held = 0
    let burnSum = 0, burnRate = 0, lastActivity = 0
    for (const a of members) {
      if (a.online) online++
      if (a.state === 'active') active++
      if (a.state === 'error') error++
      if (a.held) held++
      if (pendingInteractions[a.filePath]) pending++
      const b = burn?.perAgent[a.filePath]
      if (b) {
        burnSum += b.totalTokens
        burnRate += b.tokensPerMin
      }
      const acts = nodeActivities[a.filePath]
      if (acts && acts.length > 0) lastActivity = Math.max(lastActivity, acts[acts.length - 1].timestamp)
    }
    return {
      members,
      steward,
      voice,
      stats: { online, active, error, pending, held, burnSum, burnRate, lastActivity }
    }
  }, [agents, dir, stewards, burn, pendingInteractions, nodeActivities])

  const hue = hueFromPath(dir)
  const label = pathSegments(dir).slice(-2).join('/')

  const stat = (value: string, name: string, accent?: string): JSX.Element => (
    <div className="flex flex-col items-center px-4 py-2">
      <span className={`text-lg font-semibold tabular-nums ${accent ?? 'text-neutral-800 dark:text-neutral-100'}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{name}</span>
    </div>
  )

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="w-[620px] max-w-[90vw] max-h-[80vh] flex flex-col rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <span
            className="w-3.5 h-3.5 shrink-0"
            style={{
              backgroundColor: `hsla(${hue}, 45%, 55%, 0.9)`,
              clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)'
            }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">{label}</div>
            {voice && (
              <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {steward ? '♛ steward' : 'voice'} · {voice.handle}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Full status — the whole line the chip could only hint at */}
        {voice?.status && (
          <div className="mx-5 mb-3 px-4 py-3 rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60">
            <div className="text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap">
              {voice.status}
            </div>
            {voice.statusSince && (
              <div className="mt-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                status set {ago(Date.now() - voice.statusSince)}
              </div>
            )}
          </div>
        )}

        {/* Cluster vitals */}
        <div className="mx-5 mb-3 flex flex-wrap justify-center divide-x divide-neutral-100 dark:divide-neutral-800 rounded-xl border border-neutral-100 dark:border-neutral-800">
          {stat(`${stats.online}/${members.length}`, 'online')}
          {stat(`${stats.active}`, 'active', stats.active > 0 ? 'text-yellow-500' : undefined)}
          {stat(`${stats.error}`, 'errors', stats.error > 0 ? 'text-red-500' : undefined)}
          {stat(`${stats.pending}`, 'need you', stats.pending > 0 ? 'text-amber-500' : undefined)}
          {stat(formatTokens(stats.burnSum), 'Σ tokens')}
          {stat(`${formatTokens(stats.burnRate)}/m`, 'burn')}
          {stat(stats.lastActivity ? ago(Date.now() - stats.lastActivity) : '—', 'last activity')}
        </div>

        {/* Roster */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
          {members.map((a) => (
            <button
              key={a.filePath}
              onClick={() => {
                onClose()
                onFocusAgent(a.filePath)
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-neutral-100/70 dark:hover:bg-neutral-800/70"
              title={a.status ?? a.handle}
            >
              <span className={`text-base leading-none shrink-0 ${a.online === false ? 'grayscale opacity-60' : ''}`}>
                {a.icon || pickAgentIcon(a.agentId || a.filePath)}
              </span>
              <span className="w-28 shrink-0 truncate text-[12px] font-medium text-neutral-700 dark:text-neutral-200">
                {a.handle}
              </span>
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                a.online === false ? 'border border-dashed border-neutral-400' : STATE_DOT[a.state] ?? 'bg-neutral-400'
              }`} />
              <span className="flex-1 min-w-0 truncate text-[11px] text-neutral-500 dark:text-neutral-400 italic">
                {a.online === false ? 'not started' : a.status || a.state}
              </span>
            </button>
          ))}
          {members.length === 0 && (
            <div className="py-6 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
              No agents in this group.
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
