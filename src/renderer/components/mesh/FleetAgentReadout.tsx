import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore, type NodeActivity } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import { formatTokens } from './FleetTerrainNode'
import { ACTIVITY_TYPE_MARKS } from './MeshGraphNode'
import type { AgentState } from '../../../shared/types/ipc.types'

/**
 * Agent readout — the full-detail answer to clicking a hover card (or the
 * I key / the command bar's Details): everything the map knows about one
 * LOCAL agent, untruncated. Same presentation family as the group and
 * peer readouts: backdrop blur, centered card, Esc or click-away to close.
 */

const STATE_LABEL: Partial<Record<AgentState, string>> = {
  active: 'active',
  idle: 'idle',
  hibernate: 'hibernating',
  suspended: 'suspended',
  error: 'error',
  off: 'off'
}

const STATE_DOT: Partial<Record<AgentState, string>> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  hibernate: 'bg-purple-400',
  suspended: 'bg-red-300',
  error: 'bg-red-400',
  off: 'bg-neutral-400'
}

const TOOL_COLORS: Record<string, string> = {
  fs: 'text-blue-500 dark:text-blue-400',
  db: 'text-green-500 dark:text-green-400',
  msg: 'text-purple-500 dark:text-purple-400',
  sys: 'text-orange-500 dark:text-orange-400',
  loop: 'text-neutral-500 dark:text-neutral-400'
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function eta(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const emptyActivities: NodeActivity[] = []

export const FleetAgentReadout = memo(function FleetAgentReadout({
  filePath,
  onClose,
  onOpenAgent,
  onFocusAgent
}: {
  filePath: string
  onClose: () => void
  onOpenAgent: (filePath: string) => void
  onFocusAgent: (filePath: string) => void
}) {
  const agent = useMeshStore((s) => s.agents.find((a) => a.filePath === filePath))
  const agents = useMeshStore((s) => s.agents)
  const activities = useMeshGraphStore((s) => s.nodeActivities[filePath] ?? emptyActivities)
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const burnEntry = useFleetStore((s) => s.burn?.perAgent[filePath])
  const [copied, setCopied] = useState<string | null>(null)

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

  // Lineage by declared parent reference (DID, or config.id for legacy files)
  const { parent, children } = useMemo(() => {
    if (!agent) return { parent: undefined, children: [] as typeof agents }
    const parent = agent.parentDid
      ? agents.find((a) => a.did === agent.parentDid) ??
        agents.find((a) => a.agentId && a.agentId === agent.parentDid)
      : undefined
    const children = agents.filter(
      (c) =>
        c.filePath !== agent.filePath &&
        c.parentDid &&
        (c.parentDid === agent.did || (agent.agentId && c.parentDid === agent.agentId))
    )
    return { parent, children }
  }, [agent, agents])

  if (!agent) return null
  const isGhost = agent.online === false
  const recent = activities.slice(-12).reverse()

  const copy = (label: string, value: string): void => {
    void navigator.clipboard.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied(null), 1200)
  }

  const pill = (content: ReactNode, cls: string, title?: string): JSX.Element => (
    <span className={`text-[10px] px-2 py-0.5 rounded-full ${cls}`} title={title}>
      {content}
    </span>
  )

  const relative = (a: typeof agent, role: string): JSX.Element => (
    <button
      key={a.filePath}
      onClick={() => {
        onClose()
        onFocusAgent(a.filePath)
      }}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 text-[10px] hover:bg-violet-100 dark:hover:bg-violet-900/50"
      title={`${role} — fly to ${a.handle}`}
    >
      <span className={a.online === false ? 'grayscale opacity-60' : ''}>
        {a.icon || pickAgentIcon(a.agentId || a.filePath)}
      </span>
      {a.handle}
    </button>
  )

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] max-h-[82vh] flex flex-col rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <span className={`text-3xl leading-none shrink-0 ${isGhost ? 'grayscale opacity-60' : ''}`}>
            {agent.icon || pickAgentIcon(agent.agentId || agent.filePath)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
                {agent.handle}
              </span>
              <span className={`w-2 h-2 rounded-full shrink-0 ${isGhost ? 'border border-dashed border-neutral-400' : STATE_DOT[agent.state] ?? 'bg-neutral-400'}`} />
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {isGhost ? 'not started' : STATE_LABEL[agent.state] ?? agent.state}
              </span>
              {agent.held && pill('⏸ held', 'bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 font-medium')}
            </div>
            <div className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate" title={agent.filePath}>
              {agent.filePath}
            </div>
          </div>
          <button
            onClick={() => onOpenAgent(agent.filePath)}
            className="px-3 py-1 text-[11px] rounded-full whitespace-nowrap bg-blue-500 text-white hover:bg-blue-600 shrink-0"
            title="Open this agent's file and loop panel"
          >
            Open
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 shrink-0"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-3">
          {/* Full status — the whole line the tile could only hint at */}
          {agent.status && (
            <div className="px-4 py-3 rounded-xl bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/60">
              <div className="text-[13px] leading-relaxed text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap">
                {agent.status}
              </div>
              {agent.statusSince && (
                <div className="mt-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                  status set {ago(Date.now() - agent.statusSince)}
                </div>
              )}
            </div>
          )}

          {/* Vitals */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {agent.model && pill(agent.model, 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400')}
            {burnEntry && burnEntry.totalTokens > 0 &&
              pill(
                <>Σ {formatTokens(burnEntry.totalTokens)}{burnEntry.tokensPerMin > 0 ? ` · ↑${formatTokens(burnEntry.inPerMin ?? 0)} ↓${formatTokens(burnEntry.outPerMin ?? 0)}/m` : ''}</>,
                'bg-orange-50 dark:bg-orange-900/30 text-orange-500 dark:text-orange-400 tabular-nums',
                'Σ total · ↑ input / ↓ output tokens per minute'
              )}
            {pending && pill('needs you', 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 font-medium')}
            {agent.visibility && agent.visibility !== 'off' &&
              pill(`mesh: ${agent.visibility}`, 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400', 'Mesh visibility')}
            {(agent.apiRouteCount ?? 0) > 0 &&
              pill(`serves ${agent.apiRouteCount} route${agent.apiRouteCount === 1 ? '' : 's'}`, 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400')}
            {(agent.sharedCount ?? 0) > 0 &&
              pill(`${agent.sharedCount} shared file${agent.sharedCount === 1 ? '' : 's'}`, 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400')}
            {(agent.wsConnections ?? 0) > 0 &&
              pill(`${agent.wsConnections} ws`, 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400', 'Active WebSocket connections')}
            {agent.servedUrl && (
              <a
                href={agent.servedUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 hover:underline"
                title={`Serving ${agent.servedUrl} — click to open`}
              >
                🌐 {agent.servedUrl.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>

          {/* Timer horizon */}
          {agent.nextWakeAt && agent.nextWakeAt > Date.now() && (
            <div className="px-3 py-2 rounded-lg bg-sky-50 dark:bg-sky-900/20 border border-sky-100 dark:border-sky-900/40 text-[11px] text-sky-700 dark:text-sky-300">
              ⏰ wakes in {eta(agent.nextWakeAt - Date.now())}
              {agent.nextWakeLabel && <span className="text-sky-600/80 dark:text-sky-400/80"> — {agent.nextWakeLabel}</span>}
            </div>
          )}

          {/* Family */}
          {(parent || children.length > 0) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">family</span>
              {parent && relative(parent, 'parent')}
              {children.map((c) => relative(c, 'child'))}
            </div>
          )}

          {/* Identity */}
          {agent.did && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 shrink-0">did</span>
              <button
                onClick={() => copy('did', agent.did!)}
                className="flex-1 min-w-0 text-left font-mono text-[10px] text-neutral-500 dark:text-neutral-400 truncate hover:text-neutral-700 dark:hover:text-neutral-200"
                title="Click to copy"
              >
                {agent.did}
              </button>
              {copied === 'did' && <span className="text-[10px] text-green-500 shrink-0">copied</span>}
            </div>
          )}

          {/* Recent activity — deeper than the hover card's five */}
          {recent.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">
                recent activity
              </div>
              <div className="rounded-xl border border-neutral-100 dark:border-neutral-800 divide-y divide-neutral-50 dark:divide-neutral-800/60">
                {recent.map((act) => {
                  const typeMark = ACTIVITY_TYPE_MARKS[act.type]
                  const prefix = act.toolName.split('_')[0]
                  const color = typeMark?.nameColor ?? TOOL_COLORS[prefix] ?? 'text-neutral-500 dark:text-neutral-400'
                  const mark = typeMark?.mark ?? (act.type === 'message_sent' ? '>' : act.type === 'message_recv' ? '<' : act.isError === true ? '✗' : act.isError === false ? '✓' : '~')
                  const markColor = typeMark?.markColor ?? (act.isError === true ? 'text-red-500' : act.isError === false ? 'text-green-500' : 'text-neutral-400')
                  return (
                    <div key={act.id} className="flex items-center gap-1.5 text-[11px] leading-tight px-2.5 py-1.5">
                      <span className={`font-mono shrink-0 w-3 text-center ${markColor}`}>{mark}</span>
                      <span className={`font-medium shrink-0 ${color}`}>{act.toolName}</span>
                      <span className="flex-1 min-w-0 text-neutral-500 dark:text-neutral-400 truncate">{act.args ?? ''}</span>
                      <span className="shrink-0 text-[9px] text-neutral-300 dark:text-neutral-600 tabular-nums">
                        {ago(Date.now() - act.timestamp)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {recent.length === 0 && (
            <div className="py-3 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
              No activity recorded this session.
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
