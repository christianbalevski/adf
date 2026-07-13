import { memo, useState, useCallback } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshGraphStore, type NodeActivity, type PendingInteraction } from '../../stores/mesh-graph.store'
import { useDocumentStore } from '../../stores/document.store'
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

/**
 * The agent node is the interactive layer over its hex tile. The tile
 * (FleetTerrainNode) draws identity — icon, name, status, vitals — as SVG
 * that scales continuously, so this node stays invisible except for:
 * - a start button on ghost tiles,
 * - a compact activity panel + pending-input UI that fades in at detail
 *   zoom, sized to sit inside the hex instead of overflowing neighbors.
 * Its footprint spans the hex so marquee selection and edge anchors work.
 */
const NODE_FIXED_WIDTH = 260
const NODE_FIXED_HEIGHT = 280

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

const emptyActivities: NodeActivity[] = []

/** Compact "start this ghost" affordance. */
function GhostStartButton({ filePath }: { filePath: string }) {
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
      className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-full bg-green-500/90 text-white hover:bg-green-500 shadow disabled:opacity-50"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </button>
  )
}

export const MeshGraphNode = memo(function MeshGraphNode({ data }: NodeProps) {
  const nodeData = data as unknown as MeshNodeData
  const { filePath, online } = nodeData
  const isGhost = online === false
  // Detail zoom: the in-hex activity panel appears; below it the tile alone speaks
  const detail = useStore((s) => s.transform[2] >= 0.7)
  const activities = useMeshGraphStore((s) => s.nodeActivities[filePath] ?? emptyActivities)
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])

  const handleStyle = { width: 6, height: 6, background: 'transparent', border: 'none' } as const

  return (
    <div className="relative pointer-events-none" style={{ width: NODE_FIXED_WIDTH, height: NODE_FIXED_HEIGHT }}>
      {/* Full-hex hit area for click/double-click/marquee */}
      <div className="absolute inset-0 pointer-events-auto" />
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} id="left" />
      <Handle type="source" position={Position.Right} style={handleStyle} id="right" />

      {/* Ghost start — below the tile's text block, clear of name/status/meta */}
      {isGhost && (
        <div className="absolute left-0 right-0 flex justify-center" style={{ top: 246 }}>
          <GhostStartButton filePath={filePath} />
        </div>
      )}

      {/* Detail zoom: recent activity, tucked into the lower half of the hex */}
      {detail && !isGhost && activities.length > 0 && (
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[236px] px-1.5 py-1 space-y-0.5 rounded-lg bg-white/85 dark:bg-neutral-900/85 backdrop-blur-[2px] border border-neutral-200/60 dark:border-neutral-700/60 shadow-sm"
          style={{ top: 178, animation: 'meshFadeIn 200ms ease-out' }}
        >
          {activities.slice(-3).map((act, i, arr) => (
            <ActivityLine key={act.id} activity={act} isLast={i === arr.length - 1} fade={arr.length - 1 - i} />
          ))}
        </div>
      )}

      {/* Pending interaction — must be answerable, floats above the feed */}
      {detail && pending && (
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[236px] rounded-lg bg-amber-50/95 dark:bg-neutral-900/95 border border-amber-300 dark:border-amber-600/60 shadow-md pointer-events-auto"
          style={{ bottom: -8, animation: 'meshFadeIn 200ms ease-out' }}
        >
          <PendingInteractionUI filePath={filePath} pending={pending} />
        </div>
      )}
    </div>
  )
})

/** Left-to-right reveal animation for activity lines */
const revealStyle: React.CSSProperties = {
  animation: 'meshRevealLR 0.5s ease-out forwards',
  clipPath: 'inset(0 100% 0 0)'
}

/** Marks + colors for non-tool activity types (llm/turn/state/error) */
export const ACTIVITY_TYPE_MARKS: Record<string, { mark: string; markColor: string; nameColor: string }> = {
  llm: { mark: '◈', markColor: 'text-indigo-400', nameColor: 'text-indigo-500 dark:text-indigo-400' },
  turn: { mark: '⏎', markColor: 'text-emerald-500', nameColor: 'text-neutral-500 dark:text-neutral-400' },
  state: { mark: '→', markColor: 'text-neutral-400', nameColor: 'text-neutral-500 dark:text-neutral-400' },
  error: { mark: '!', markColor: 'text-red-500', nameColor: 'text-red-500 dark:text-red-400' }
}

function ActivityLine({ activity, isLast, fade = 0 }: { activity: NodeActivity; isLast: boolean; fade?: number }) {
  const typeMark = ACTIVITY_TYPE_MARKS[activity.type]
  const color = typeMark?.nameColor ?? getToolColor(activity.toolName)

  let icon: string
  let iconColor: string
  if (typeMark) {
    icon = typeMark.mark
    iconColor = typeMark.markColor
  } else if (activity.type === 'message_sent') {
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
      style={{ ...revealStyle, opacity: Math.max(0.45, 1 - fade * 0.18) }}
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
        <p className="text-[10px] text-neutral-600 dark:text-neutral-300 leading-tight">
          {pending.question ?? 'Agent is asking...'}
        </p>
        <div className="flex gap-1">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="Type response..."
            className="flex-1 px-2 py-1 text-[11px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-600 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
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
      <p className="text-[10px] text-neutral-600 dark:text-neutral-300 leading-tight">
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
