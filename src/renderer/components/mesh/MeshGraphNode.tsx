import { memo, useState, useCallback } from 'react'
import { Handle, Position } from '@xyflow/react'
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

export const MeshGraphNode = memo(function MeshGraphNode({ data }: NodeProps) {
  const nodeData = data as unknown as MeshNodeData
  const { filePath, handle, state, status, icon, model } = nodeData
  const activities = useMeshGraphStore((s) => s.nodeActivities[filePath] ?? emptyActivities)
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])
  const foregroundFilePath = useDocumentStore((s) => s.filePath)
  const isSelected = filePath === foregroundFilePath

  const handleStyle = { width: 6, height: 6, background: '#94a3b8', border: 'none' } as const

  return (
    <div className="relative" style={{ width: NODE_FIXED_WIDTH }}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} id="left" />
      <Handle type="source" position={Position.Right} style={handleStyle} id="right" />
      <div
        className={`bg-white dark:bg-neutral-800 border rounded-lg shadow-md overflow-hidden w-full ${
          isSelected
            ? 'border-blue-400 dark:border-blue-500 ring-1 ring-blue-400/50'
            : 'border-neutral-200 dark:border-neutral-700'
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-neutral-100 dark:border-neutral-700 select-none">
          {icon && <span className="text-sm leading-none shrink-0">{icon}</span>}
          <StateDot state={state} />
          <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 truncate shrink-0">
            {handle}
          </span>
          {status && (
            <span className="text-[10px] text-neutral-600 dark:text-neutral-300 truncate flex-1 min-w-0">
              {status}
            </span>
          )}
          {!status && <span className="flex-1" />}
          {model && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate max-w-[80px] shrink-0">
              {model}
            </span>
          )}
        </div>

        {/* Activity feed — newest at bottom, sized to content */}
        {activities.length > 0 && (
          <div className="px-1.5 py-1 space-y-0.5">
            {activities.map((act, i) => (
              <ActivityLine key={act.id} activity={act} isLast={i === activities.length - 1} />
            ))}
          </div>
        )}

        {/* Pending interaction */}
        {pending && (
          <div className="border-t border-neutral-100 dark:border-neutral-700">
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

function ActivityLine({ activity, isLast }: { activity: NodeActivity; isLast: boolean }) {
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
      style={revealStyle}
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
