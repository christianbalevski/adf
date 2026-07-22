import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import type { NodeProps, ReactFlowState } from '@xyflow/react'
import { useMeshGraphStore, type NodeActivity, type PendingInteraction } from '../../stores/mesh-graph.store'
import { useDocumentStore } from '../../stores/document.store'
import { useFleetStore } from '../../stores/fleet.store'
import { ApprovalControls } from '../agent/ApprovalControls'
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
  /** Far offscreen (MeshGraphView's overscan visibility pass) — render a
   *  hollow fixed-size shell instead of the full content */
  culled?: boolean
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
 * Cap on the say bubble's text block — a long reply scrolls in place
 * instead of towering over the map. Keep the total bubble (this + padding
 * + tail) under MeshGraphView's CULL_SCREEN_OVERFLOW_PX (350) overscan
 * margin, which budgets for bubble overflow above the tile.
 */
const BUBBLE_MAX_TEXT_H = 280

/**
 * Zoom LOD — both thresholds are BOOLEAN subscriptions on the React Flow
 * store (module-level selectors below), so a tile re-renders when a line is
 * crossed, never per zoom frame. A blocked agent must be answerable from
 * well outside detail zoom, so the approval card leads; the say bubble's
 * 14px text is sub-legible below its line, and skipping it keeps far-zoom
 * tiles (and their per-event activity subscriptions) quiet.
 */
const PENDING_CARD_MIN_ZOOM = 0.45
const BUBBLE_MIN_ZOOM = 0.35
const pendingCardVisibleSelector = (s: ReactFlowState): boolean => s.transform[2] >= PENDING_CARD_MIN_ZOOM
const bubbleVisibleSelector = (s: ReactFlowState): boolean => s.transform[2] >= BUBBLE_MIN_ZOOM

/**
 * Entrance-animation gate. Node content REMOUNTS whenever a tile crosses
 * back inside the overscan margin (the culled flip swaps the hollow shell
 * for the full node) or across the bubble LOD line — a one-shot mount
 * animation would replay at the screen edge on every pass. Keyed by content
 * (bubble/approval id), an entrance plays only within a short window of its
 * first appearance; later remounts render settled. Module-level so the
 * memory survives the remount; render-time Map writes are idempotent
 * (StrictMode's double render lands inside the window and still animates).
 */
const entranceShownAt = new Map<string, number>()
function entranceAnimation(key: string, css: string): string | undefined {
  const first = entranceShownAt.get(key)
  if (first === undefined) {
    if (entranceShownAt.size > 2000) entranceShownAt.clear()
    entranceShownAt.set(key, Date.now())
    return css
  }
  return Date.now() - first < 500 ? css : undefined
}

/** Bubbles the user explicitly closed — a culling remount (or a zoom-out/in
 *  across the bubble LOD line) must not resurrect them. */
const dismissedBubbles = new Set<string>()

/**
 * Markdown-lite for bubble text: newlines and list shape survive via
 * pre-wrap; `code` spans get monospace chips; **bold** gets weight. Anything
 * heavier belongs in the loop panel, not a map bubble.
 */
export function BubbleText({ text }: { text: string }) {
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
  // Overflow detection — only a bubble whose text actually scrolls takes
  // pointer events (see the scroll container below); short bubbles keep
  // the full click-through contract.
  const [scrollable, setScrollable] = useState(false)
  const textRef = useRef<HTMLDivElement | null>(null)
  const lastSay = activities.findLast((a) => a.type === 'turn' && a.args?.startsWith('“'))

  useEffect(() => {
    if (!lastSay || dismissedBubbles.has(lastSay.id)) return
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
      // 20 beats neighbor tiles' chrome but stays BELOW the cursor-hex
      // overlay (z-25) — the tile highlight must remain visible while the
      // pointer crosses an open bubble
      nodeEl.style.zIndex = '20'
      return () => { nodeEl.style.zIndex = prev }
    }
    return undefined
  }, [bubble])

  useEffect(() => {
    const el = textRef.current
    setScrollable(el ? el.scrollHeight > el.clientHeight + 1 : false)
  }, [bubble?.id])

  if (!bubble) return null
  return (
    <div
      ref={rootRef}
      className="fleet-say-bubble absolute left-1/2 -translate-x-1/2 w-[340px] flex flex-col items-center"
      style={{ bottom: '102%', animation: entranceAnimation(`say:${bubble.id}`, 'meshFadeIn 250ms ease-out') }}
    >
      {/* pointer-events-none: for up to 75s the bubble covers tiles to the
          north — clicks and drags must reach them (it used to be a dead
          zone). Hover suppression under the bubble is handled geometrically
          in the view (rect check against .fleet-say-bubble), not by
          swallowing events. Only the dismiss ✕ stays interactive. */}
      <div className="pointer-events-none relative px-3.5 py-2.5 rounded-2xl bg-white/95 dark:bg-neutral-800/95 border border-neutral-200 dark:border-neutral-600 shadow-lg text-[14px] leading-snug text-neutral-700 dark:text-neutral-100">
        {/* Long replies cap at BUBBLE_MAX_TEXT_H and scroll in place.
            `nowheel` is React Flow's own opt-out (noWheelClassName): the
            pane's pan/zoom wheel handlers drop events targeting it, so a
            wheel here scrolls the text instead of panning the map, and
            overscroll-behavior stops the chain at either boundary. The
            scroll area takes pointer events ONLY while it overflows —
            otherwise the bubble stays click-through per the note below. */}
        <div
          ref={textRef}
          className={scrollable ? 'nowheel pointer-events-auto overflow-y-auto' : 'overflow-y-auto'}
          style={{ maxHeight: BUBBLE_MAX_TEXT_H, overscrollBehavior: 'contain' }}
        >
          <BubbleText text={bubble.text} />
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); dismissedBubbles.add(bubble.id); setBubble(null) }}
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

/** Compact "start this ghost" affordance — becomes a spinner while the
 *  agent boots (until the poll reports it online, or the 30s timeout). */
function GhostStartButton({ filePath }: { filePath: string }) {
  const booting = useFleetStore((s) => !!s.starting[filePath])
  const markStarting = useFleetStore((s) => s.markStarting)
  const onStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (booting) return
    markStarting([filePath])
    window.adfApi.startBackgroundAgent(filePath).catch(() => { /* 30s timeout re-arms */ })
  }, [filePath, booting, markStarting])

  if (booting) {
    return (
      <div
        title="Starting up…"
        className="w-7 h-7 flex items-center justify-center rounded-full bg-teal-500/90 text-white shadow"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-spin">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
      </div>
    )
  }

  return (
    <button
      onClick={onStart}
      title="Start agent"
      // Muted at rest — dozens of these dot the map on ghost tiles, and a
      // solid green disc reads as an "online" status light from orbit. The
      // start-me green only shows itself under the cursor.
      className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-full bg-white/70 dark:bg-neutral-800/70 border border-neutral-300/70 dark:border-neutral-600/70 text-neutral-400 dark:text-neutral-400 shadow-sm transition-colors hover:bg-green-500 hover:border-green-500 hover:text-white dark:hover:bg-green-500 dark:hover:border-green-500 dark:hover:text-white"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </button>
  )
}

const handleStyle = { width: 6, height: 6, background: 'transparent', border: 'none' } as const

/** The four invisible edge anchors — rendered by the full node AND the
 *  culled shell, so React Flow's handle bounds stay warm for trace
 *  endpoints while a tile is offscreen. */
function NodeHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} id="left" />
      <Handle type="source" position={Position.Right} style={handleStyle} id="right" />
    </>
  )
}

export const MeshGraphNode = memo(function MeshGraphNode(props: NodeProps) {
  // Overscan culling (MeshGraphView's visibility pass): far offscreen the
  // tile renders as a hollow shell with the same fixed footprint — RF
  // internals, edge anchors and minimap dots stay exact — and none of the
  // interactive/bubble content or its per-agent store subscriptions.
  if ((props.data as unknown as MeshNodeData).culled) {
    return (
      <div className="relative pointer-events-none" style={{ width: NODE_FIXED_WIDTH, height: NODE_FIXED_HEIGHT }}>
        <NodeHandles />
      </div>
    )
  }
  return <MeshGraphNodeFull {...props} />
})

function MeshGraphNodeFull({ data }: NodeProps) {
  const nodeData = data as unknown as MeshNodeData
  const { filePath, online } = nodeData
  const isGhost = online === false
  const pendingCardVisible = useStore(pendingCardVisibleSelector)
  const bubbleVisible = useStore(bubbleVisibleSelector)
  // Activities feed only the say bubble — below the bubble LOD line (or on
  // a ghost) skip the subscription entirely, so far-zoom tiles never
  // re-render on fleet-wide activity churn.
  const activities = useMeshGraphStore((s) =>
    !isGhost && bubbleVisible ? s.nodeActivities[filePath] ?? emptyActivities : emptyActivities
  )
  const pending = useMeshGraphStore((s) => s.pendingInteractions[filePath])

  return (
    <div className="relative pointer-events-none" style={{ width: NODE_FIXED_WIDTH, height: NODE_FIXED_HEIGHT }}>
      {/* Hex-shaped hit area for click/double-click/marquee/drag — clipped
          to the tile's actual hexagon (circumradius 163 on the 260×280 box,
          center 130,140) so the box's open-water corners fall through to
          the pane instead of stealing marquee starts. The grab cursor is
          the only always-on affordance that tiles are movable (native
          title tooltips never render in this window). */}
      <div
        className="absolute inset-0 pointer-events-auto cursor-grab active:cursor-grabbing"
        style={{ clipPath: 'polygon(293px 140px, 211.5px 281.2px, 48.5px 281.2px, -33px 140px, 48.5px -1.2px, 211.5px -1.2px)' }}
      />
      <NodeHandles />

      {/* Speech bubble — the agent's latest spoken reply, briefly. Skipped
          below the bubble LOD line, where its text is sub-legible anyway. */}
      {!isGhost && bubbleVisible && <SayBubble activities={activities} />}

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

      {/* Pending interaction — must be answerable, floats above the feed.
          Clicking the card's dead space (not its buttons/inputs) opens the
          full-context modal — the tile itself stays plain-selectable. */}
      {pendingCardVisible && pending && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-20 w-[236px] rounded-lg bg-amber-50 dark:bg-neutral-900 border border-amber-300 dark:border-amber-600/60 shadow-md pointer-events-auto cursor-pointer"
          style={{ bottom: -8, animation: entranceAnimation(`hil:${filePath}|${pending.requestId}`, 'meshFadeIn 200ms ease-out') }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, textarea, input')) return
            e.stopPropagation()
            useFleetStore.getState().setHilModal(filePath)
          }}
        >
          <PendingInteractionUI filePath={filePath} pending={pending} />
        </div>
      )}
    </div>
  )
}

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

  const handleApproval = useCallback((approved: boolean, feedback?: string) => {
    if (pending.type === 'approval') {
      if (isForeground) {
        window.adfApi.respondToolApproval(pending.requestId, approved, feedback)
      } else {
        window.adfApi.respondBackgroundAgentToolApproval(filePath, pending.requestId, approved, feedback)
      }
      setPendingInteraction(filePath, null)
    }
  }, [pending, filePath, isForeground, setPendingInteraction])

  // "Always approve" — drop the HIL gate on this tool, then approve. Foreground
  // reuses the doc config IPCs; background goes through the manager helper.
  const handleAlwaysApprove = useCallback(async (toolName: string) => {
    if (pending.type !== 'approval') return
    if (isForeground) {
      const cfg = await window.adfApi.getAgentConfig()
      if (cfg) {
        const tools = cfg.tools ? [...cfg.tools] : []
        const idx = tools.findIndex((t) => t.name === toolName)
        if (idx >= 0) tools[idx] = { ...tools[idx], enabled: true, restricted: false }
        else tools.push({ name: toolName, enabled: true, visible: true, restricted: false })
        await window.adfApi.setAgentConfig({ ...cfg, tools })
      }
      window.adfApi.respondToolApproval(pending.requestId, true)
    } else {
      window.adfApi.alwaysApproveBackgroundAgentTool(filePath, pending.requestId, toolName)
    }
    setPendingInteraction(filePath, null)
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

  // Quick read: the agent's stated reason (_reason). The full call — complete
  // arguments at readable size — lives in the FleetApprovalModal; a tile can't
  // carry enough context to evaluate a serious call.
  const inp = pending.input && typeof pending.input === 'object' ? (pending.input as Record<string, unknown>) : undefined
  const reason = inp && typeof inp._reason === 'string' ? inp._reason : undefined
  const setHilModal = useFleetStore((s) => s.setHilModal)

  return (
    <div className="px-3 py-2 space-y-1.5">
      <p className="text-[10px] text-neutral-600 dark:text-neutral-300 leading-tight">
        Approve <span className="font-medium text-orange-500">{pending.toolName}</span>?
      </p>
      {reason && (
        <p className="text-[10px] italic text-neutral-500 dark:text-neutral-400 leading-tight" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          “{reason}”
        </p>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); setHilModal(filePath) }}
        className="block w-full text-center text-[10px] text-blue-500 dark:text-blue-400 hover:underline"
      >
        view full context
      </button>
      <div className="flex justify-center">
        <ApprovalControls
          compact
          toolName={pending.toolName ?? 'tool'}
          onApprove={() => handleApproval(true)}
          onAlwaysApprove={() => void handleAlwaysApprove(pending.toolName ?? 'tool')}
          onReject={(feedback) => handleApproval(false, feedback)}
        />
      </div>
    </div>
  )
}
