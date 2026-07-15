import { memo, useState, useCallback, useEffect, useRef } from 'react'
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
  /** Public page URL when the agent serves HTTP — antenna badge, click opens */
  servedUrl?: string
}

/**
 * The agent node is the interactive layer over its hex tile. The tile
 * (FleetTerrainNode) draws identity — icon, name, status, vitals — as SVG
 * that scales continuously, so this node stays invisible except for:
 * - a start button on ghost tiles,
 * - a transient say-bubble when the agent replies with text,
 * - the pending-input UI at detail zoom (recent activity lives in the
 *   hover card — the tile shows identity only, never covering the name).
 * Its footprint spans the hex so marquee selection and edge anchors work.
 */
const NODE_FIXED_WIDTH = 260
const NODE_FIXED_HEIGHT = 280

const emptyActivities: NodeActivity[] = []

/** How long a say-bubble hangs over the hex after the agent speaks */
const BUBBLE_MS = 75_000

/**
 * Markdown-lite for bubble text: newlines and list shape survive via
 * pre-wrap; `code` spans get monospace chips; **bold** gets weight. Anything
 * heavier belongs in the loop panel, not a map bubble.
 */
function BubbleText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="px-1 py-px rounded bg-neutral-100 dark:bg-neutral-700 font-mono text-[12px]">
              {part.slice(1, -1)}
            </code>
          )
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>
        }
        return part
      })}
    </span>
  )
}

/**
 * Transient speech bubble — when a turn ends with plain text, the agent's
 * words pop up over its tile, comic-panel style. Driven by the 'turn'
 * activity whose args carry the quoted say-text. While open, the parent
 * React Flow node is lifted above its neighbors so ghost start buttons and
 * other tiles' chrome can't poke through the bubble.
 */
function SayBubble({ activities }: { activities: NodeActivity[] }) {
  const [bubble, setBubble] = useState<{ id: string; text: string } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastSay = activities.findLast((a) => a.type === 'turn' && a.args?.startsWith('“'))

  useEffect(() => {
    if (!lastSay) return
    const age = Date.now() - lastSay.timestamp
    if (age >= BUBBLE_MS) return
    const raw = lastSay.detail ?? lastSay.args!.replace(/^“|”$/g, '')
    const text = raw.length > 550 ? raw.slice(0, 550) + '…' : raw
    setBubble({ id: lastSay.id, text })
    const t = setTimeout(() => setBubble(null), BUBBLE_MS - age)
    return () => clearTimeout(t)
  }, [lastSay?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Lift the whole node above neighbors while the bubble is open
  useEffect(() => {
    const nodeEl = rootRef.current?.closest('.react-flow__node') as HTMLElement | null
    if (!nodeEl) return
    if (bubble) {
      const prev = nodeEl.style.zIndex
      nodeEl.style.zIndex = '1000'
      return () => { nodeEl.style.zIndex = prev }
    }
    return undefined
  }, [bubble])

  if (!bubble) return null
  return (
    <div
      ref={rootRef}
      className="absolute left-1/2 -translate-x-1/2 w-[340px] flex flex-col items-center"
      style={{ bottom: '102%', animation: 'meshFadeIn 250ms ease-out' }}
    >
      <div className="relative px-3.5 py-2.5 rounded-2xl bg-white/95 dark:bg-neutral-800/95 border border-neutral-200 dark:border-neutral-600 shadow-lg text-[14px] leading-snug text-neutral-700 dark:text-neutral-100">
        <BubbleText text={bubble.text} />
        <button
          onClick={(e) => { e.stopPropagation(); setBubble(null) }}
          className="pointer-events-auto absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-600 text-neutral-500 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-500 text-[10px] leading-none shadow"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      <div className="w-2.5 h-2.5 -mt-1.5 rotate-45 bg-white/95 dark:bg-neutral-800/95 border-r border-b border-neutral-200 dark:border-neutral-600" />
    </div>
  )
}

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

      {/* Speech bubble — the agent's latest spoken reply, briefly */}
      {!isGhost && <SayBubble activities={activities} />}

      {/* Serving badge — this hex hosts a website; click opens it */}
      {!isGhost && nodeData.servedUrl && (
        <a
          href={nodeData.servedUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto absolute w-8 h-8 flex items-center justify-center rounded-full bg-white/90 dark:bg-neutral-800/90 border border-sky-300 dark:border-sky-700 shadow text-[15px] hover:scale-110 transition-transform"
          style={{ left: 208, top: 226 }}
          title={`Serving ${nodeData.servedUrl} — click to open`}
        >
          🌐
        </a>
      )}

      {/* Ghost start — below the tile's text block, clear of name/status/meta */}
      {isGhost && (
        <div className="absolute left-0 right-0 flex justify-center" style={{ top: 246 }}>
          <GhostStartButton filePath={filePath} />
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

/** Marks + colors for non-tool activity types (llm/turn/state/error) */
export const ACTIVITY_TYPE_MARKS: Record<string, { mark: string; markColor: string; nameColor: string }> = {
  llm: { mark: '◈', markColor: 'text-indigo-400', nameColor: 'text-indigo-500 dark:text-indigo-400' },
  turn: { mark: '⏎', markColor: 'text-emerald-500', nameColor: 'text-neutral-500 dark:text-neutral-400' },
  state: { mark: '→', markColor: 'text-neutral-400', nameColor: 'text-neutral-500 dark:text-neutral-400' },
  error: { mark: '!', markColor: 'text-red-500', nameColor: 'text-red-500 dark:text-red-400' }
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
