import { memo, useState, useCallback } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshGraphStore, type NodeActivity, type PendingInteraction } from '../../stores/mesh-graph.store'
import { useDocumentStore } from '../../stores/document.store'
import { useFleetStore } from '../../stores/fleet.store'
import type { AgentState } from '../../../shared/types/ipc.types'

export interface MeshNodeData {
  filePath: string
  handle: string
  state: AgentState
  status?: string
  icon?: string
  model?: string
  /** False for on-disk agents with no running executor (ghost/building nodes) */
  online?: boolean
}

const NODE_FIXED_WIDTH = 260

const TOOL_COLORS: Record<string, string> = {
  fs: 'text-blue-500 dark:text-blue-400',
  db: 'text-green-500 dark:text-green-400',
  msg: 'text-purple-500 dark:text-purple-400',
  sys: 'text-orange-500 dark:text-orange-400',
  loop: 'text-neutral-500 dark:text-neutral-400'
}

function getToolColor(toolName: string): string {
  const prefix = toolName.split('_')[0]
  return TOOL_COLORS[prefix] ?? 'text-neutral-500 dark:text-neutral-400'
}

const STATE_DOT: Record<AgentState, { color: string; pulse?: boolean; ring?: boolean }> = {
  active: { color: 'bg-yellow-400', pulse: true },
  idle: { color: 'bg-green-400' },
  hibernate: { color: 'bg-purple-500' },
  suspended: { color: 'border-red-400', ring: true },
  off: { color: 'bg-neutral-400' },
  error: { color: 'bg-red-400' },
  not_participating: { color: 'bg-neutral-300 dark:bg-neutral-600' }
}

function StateDot({ state }: { state: AgentState }) {
  const cfg = STATE_DOT[state] ?? STATE_DOT.off
  return (
    <span className="relative inline-block w-2 h-2 shrink-0" title={state}>
      {cfg.pulse && (
        <span className={`absolute inset-0 rounded-full ${cfg.color} animate-ping opacity-75`} />
      )}
      {cfg.ring ? (
        <span className={`absolute inset-0 rounded-full border-[1.5px] ${cfg.color}`} />
      ) : (
        <span className={`absolute inset-0 rounded-full ${cfg.color}`} />
      )}
    </span>
  )
}

const emptyActivities: NodeActivity[] = []

/** Card accent edge + avatar tile tint per state */
const CARD_ACCENT: Record<AgentState, { bar: string; tile: string }> = {
  active: { bar: 'bg-yellow-400', tile: 'bg-yellow-50 dark:bg-yellow-900/30' },
  idle: { bar: 'bg-green-400', tile: 'bg-green-50 dark:bg-green-900/25' },
  hibernate: { bar: 'bg-purple-400', tile: 'bg-purple-50 dark:bg-purple-900/25' },
  suspended: { bar: 'bg-red-300', tile: 'bg-red-50 dark:bg-red-900/20' },
  off: { bar: 'bg-neutral-300 dark:bg-neutral-600', tile: 'bg-neutral-100 dark:bg-neutral-700/60' },
  error: { bar: 'bg-red-400', tile: 'bg-red-50 dark:bg-red-900/25' },
  not_participating: { bar: 'bg-neutral-200 dark:bg-neutral-700', tile: 'bg-neutral-100 dark:bg-neutral-700/60' }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Semantic zoom levels — dot < 0.3, dot+label < 0.4, chip < 0.75, card otherwise */
type LodLevel = 'dot' | 'dot-label' | 'chip' | 'card'

/** State ring color for the compact dot LOD (active=yellow, idle=green, error=red, off/ghost=neutral) */
const DOT_STATE_RING: Record<AgentState, string> = {
  active: 'border-yellow-400',
  idle: 'border-green-400',
  hibernate: 'border-purple-400',
  suspended: 'border-red-400',
  off: 'border-neutral-400 dark:border-neutral-500',
  error: 'border-red-400',
  not_participating: 'border-neutral-300 dark:border-neutral-600'
}

/** Compact "start this ghost" affordance — shown on offline agents. */
function GhostStartButton({ filePath, compact }: { filePath: string; compact?: boolean }) {
  const [starting, setStarting] = useState(false)
  const onStart = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (starting) return
    setStarting(true)
    try {
      await window.adfApi.startBackgroundAgent(filePath)
    } catch { /* poll reflects the outcome */ }
    setStarting(false)
  }, [filePath, starting])

  return (
    <button
      onClick={onStart}
      disabled={starting}
      title="Start agent"
      className={`shrink-0 flex items-center justify-center rounded-full bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 ${
        compact ? 'w-4 h-4' : 'w-5 h-5'
      }`}
    >
      <svg width={compact ? 7 : 8} height={compact ? 7 : 8} viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </button>
  )
}

export const MeshGraphNode = memo(function MeshGraphNode({ data }: NodeProps) {
  const nodeData = data as unknown as MeshNodeData
  const { filePath, handle, state, status, icon, model, online } = nodeData
  const isGhost = online === false
  const burnPerMin = useFleetStore((s) => s.burn?.perAgent[filePath]?.tokensPerMin ?? 0)
  const cumulativeTokens = useFleetStore((s) => s.burn?.perAgent[filePath]?.totalTokens ?? 0)
  // Discrete LOD level — selector returns a string so nodes only re-render
  // when the level changes, not on every zoom tick
  const lod = useStore((s): LodLevel =>
    s.transform[2] < 0.3 ? 'dot' : s.transform[2] < 0.4 ? 'dot-label' : s.transform[2] < 0.75 ? 'chip' : 'card'
  )
  const activities = useMeshGraphStore((s) => s.nodeActivities[filePath] ?? emptyActivities)
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const isFocused = useMeshGraphStore((s) => s.focusedFilePath === filePath)
  const foregroundFilePath = useDocumentStore((s) => s.filePath)
  const isSelected = filePath === foregroundFilePath

  const handleStyle = { width: 6, height: 6, background: '#94a3b8', border: 'none' } as const

  // Ring priority: needs-input (amber, visible zoomed out) > hotkey focus > foreground doc
  const ringClass = pending
    ? 'border-amber-400 dark:border-amber-500 ring-2 ring-amber-400/60'
    : isFocused
      ? 'border-violet-400 dark:border-violet-500 ring-2 ring-violet-400/60'
      : isSelected
        ? 'border-blue-400 dark:border-blue-500 ring-1 ring-blue-400/50'
        : 'border-neutral-200 dark:border-neutral-700'

  // Handles must render at every LOD or edges detach
  const handles = (
    <>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} id="left" />
      <Handle type="source" position={Position.Right} style={handleStyle} id="right" />
    </>
  )

  // Far zoom — the terrain layer draws the agent's hex cell, icon, and
  // state lighting; the node keeps only its footprint (selection/marquee
  // bounds) and handles (edge anchors). Nothing visible here.
  if (lod === 'dot' || lod === 'dot-label') {
    return (
      <div className="relative" style={{ width: NODE_FIXED_WIDTH, height: 40 }}>
        {handles}
      </div>
    )
  }

  // Chip LOD — single-row pill: icon + state dot + handle + model
  if (lod === 'chip') {
    return (
      <div className={`relative ${isGhost ? 'opacity-60' : ''}`} style={{ width: NODE_FIXED_WIDTH }}>
        {handles}
        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-neutral-800 border rounded-full shadow-md select-none w-full ${
            isGhost ? 'border-dashed' : ''
          } ${ringClass}`}
        >
          {icon && <span className="text-sm leading-none shrink-0">{icon}</span>}
          <StateDot state={state} />
          <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 truncate shrink-0">
            {handle}
          </span>
          <span className="flex-1" />
          {model && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate max-w-[100px] shrink-0">
              {model}
            </span>
          )}
          {isGhost && <GhostStartButton filePath={filePath} compact />}
        </div>
      </div>
    )
  }

  // Card LOD — the full unit card: state accent edge, avatar tile,
  // stacked identity, chips for vitals, activity feed, pending section
  const accent = CARD_ACCENT[state] ?? CARD_ACCENT.off
  const totalTokens = cumulativeTokens
  return (
    <div className={`relative ${isGhost ? 'opacity-60' : ''}`} style={{ width: NODE_FIXED_WIDTH }}>
      {handles}
      <div
        className={`relative bg-white dark:bg-neutral-800 border rounded-xl shadow-md overflow-hidden w-full ${
          isGhost ? 'border-dashed' : ''
        } ${ringClass}`}
      >
        {/* State accent edge */}
        <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${accent.bar} ${state === 'active' ? 'animate-pulse' : ''}`} />

        {/* Header — avatar tile + stacked identity + vitals column */}
        <div className="flex items-center gap-2 pl-3 pr-2.5 py-2 select-none">
          <div
            className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-base leading-none ${accent.tile} ${
              isGhost ? 'grayscale' : ''
            }`}
          >
            {icon || handle.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-100 truncate">
                {handle}
              </span>
              <StateDot state={state} />
            </div>
            <div className={`text-[10px] truncate ${status ? 'text-neutral-500 dark:text-neutral-400 italic' : 'text-neutral-300 dark:text-neutral-600'}`}>
              {isGhost ? 'not started' : status || state}
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5 shrink-0">
            {isGhost ? (
              <GhostStartButton filePath={filePath} />
            ) : (
              <>
                {model && (
                  <span className="text-[9px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-700/70 text-neutral-500 dark:text-neutral-400 truncate max-w-[90px]">
                    {model}
                  </span>
                )}
                {(burnPerMin > 0 || totalTokens > 0) && (
                  <span
                    className="text-[9px] px-1.5 py-px rounded-full bg-orange-50 dark:bg-orange-900/30 text-orange-500 dark:text-orange-400 tabular-nums"
                    title={`${formatTokens(totalTokens)} tokens total this session · ${Math.round(burnPerMin)} tokens/min (5-min window)`}
                  >
                    Σ {formatTokens(totalTokens)}{burnPerMin > 0 ? ` · ${formatTokens(burnPerMin)}/m` : ''}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Activity feed — newest at bottom, older lines fade */}
        {activities.length > 0 && (
          <div className="px-1.5 pb-1 pt-0.5 space-y-0.5 border-t border-neutral-100 dark:border-neutral-700/60">
            {activities.map((act, i) => (
              <ActivityLine
                key={act.id}
                activity={act}
                isLast={i === activities.length - 1}
                fade={activities.length - 1 - i}
              />
            ))}
          </div>
        )}

        {/* Pending interaction */}
        {pending && (
          <div className="border-t border-amber-200/70 dark:border-amber-700/40 bg-amber-50/60 dark:bg-amber-900/15">
            <PendingInteractionUI filePath={filePath} pending={pending} />
          </div>
        )}
      </div>
    </div>
  )
})

/** Left-to-right reveal animation for activity lines */
const revealStyle: React.CSSProperties = {
  animation: 'meshRevealLR 0.5s ease-out forwards',
  clipPath: 'inset(0 100% 0 0)'
}

function ActivityLine({ activity, isLast, fade = 0 }: { activity: NodeActivity; isLast: boolean; fade?: number }) {
  const color = getToolColor(activity.toolName)

  let icon: string
  let iconColor: string
  if (activity.type === 'message_sent') {
    icon = '>'
    iconColor = 'text-purple-400'
  } else if (activity.type === 'message_recv') {
    icon = '<'
    iconColor = 'text-purple-400'
  } else if (activity.isError === true) {
    icon = '✗'
    iconColor = 'text-red-500'
  } else if (activity.isError === false) {
    icon = '✓'
    iconColor = 'text-green-500'
  } else {
    // Pending — result not yet received
    icon = '~'
    iconColor = 'text-neutral-400'
  }

  return (
    <div
      className={`flex items-center gap-1 text-[10px] leading-tight px-1.5 py-0.5 rounded ${
        isLast ? 'bg-blue-50/70 dark:bg-blue-900/20' : ''
      }`}
      style={{ ...revealStyle, opacity: Math.max(0.45, 1 - fade * 0.14) }}
    >
      <span className={`font-mono shrink-0 w-3 text-center ${iconColor}`}>
        {icon}
      </span>
      <span className={`font-medium shrink-0 ${color}`}>
        {activity.toolName}
      </span>
      {activity.args && (
        <span className="text-neutral-600 dark:text-neutral-200 truncate">
          {activity.args}
        </span>
      )}
    </div>
  )
}

function PendingInteractionUI({ filePath, pending }: { filePath: string; pending: PendingInteraction }) {
  const [input, setInput] = useState('')
  const foregroundFilePath = useDocumentStore((s) => s.filePath)
  const isForeground = filePath === foregroundFilePath
  const setPendingInteraction = useMeshGraphStore((s) => s.setPendingInteraction)

  const handleSubmit = useCallback(() => {
    if (pending.type === 'ask') {
      if (isForeground) {
        window.adfApi.respondAsk(pending.requestId, input)
      } else {
        window.adfApi.respondBackgroundAgentAsk(filePath, pending.requestId, input)
      }
      setPendingInteraction(filePath, null)
    }
    setInput('')
  }, [pending, input, filePath, isForeground, setPendingInteraction])

  const handleApproval = useCallback((approved: boolean) => {
    if (pending.type === 'approval') {
      if (isForeground) {
        window.adfApi.respondToolApproval(pending.requestId, approved)
      } else {
        window.adfApi.respondBackgroundAgentToolApproval(filePath, pending.requestId, approved)
      }
      setPendingInteraction(filePath, null)
    }
  }, [pending, filePath, isForeground, setPendingInteraction])

  if (pending.type === 'ask') {
    return (
      <div className="px-3 py-2 space-y-1.5">
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400 leading-tight">
          {pending.question ?? 'Agent is asking...'}
        </p>
        <div className="flex gap-1">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="Type response..."
            className="flex-1 px-2 py-1 text-[11px] bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <button
            onClick={handleSubmit}
            className="px-2 py-1 text-[10px] bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Send
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="px-3 py-2 space-y-1.5">
      <p className="text-[10px] text-neutral-500 dark:text-neutral-400 leading-tight">
        Approve <span className="font-medium text-orange-500">{pending.toolName}</span>?
      </p>
      <div className="flex gap-1">
        <button
          onClick={() => handleApproval(true)}
          className="flex-1 px-2 py-1 text-[10px] bg-green-500 text-white rounded hover:bg-green-600"
        >
          Approve
        </button>
        <button
          onClick={() => handleApproval(false)}
          className="flex-1 px-2 py-1 text-[10px] bg-red-500 text-white rounded hover:bg-red-600"
        >
          Deny
        </button>
      </div>
    </div>
  )
}
