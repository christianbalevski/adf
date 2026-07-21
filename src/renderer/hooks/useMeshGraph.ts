import { useEffect, useRef } from 'react'
import {
  useMeshGraphStore,
  CLEANUP_INTERVAL_MS,
  applyActivity,
  applyResolveActivity,
  applyPendingInteraction,
  applyEdgeAnimation,
  applyPeerAgentPing,
  type MeshGraphState
} from '../stores/mesh-graph.store'
import { useMeshStore } from '../stores/mesh.store'
import { useDocumentStore } from '../stores/document.store'
import type { MeshEvent, AgentExecutionEvent, BackgroundAgentEvent, AgentState } from '../../shared/types/ipc.types'

let activityIdCounter = 0
function nextId(): string {
  return `act-${++activityIdCounter}`
}

// Dev-only escape hatch — lets CDP-driven verification inject graph state
// (edge heat, activities) without a live LLM provider generating traffic.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__meshGraphStore = useMeshGraphStore
  // Fleet store too (starting flags, selection, lens) — same purpose
  void import('../stores/fleet.store').then((m) => {
    ;(window as unknown as Record<string, unknown>).__fleetStore = m.useFleetStore
  })
  // Mesh store (agent roster) — lets verification inject synthetic fleets,
  // e.g. Windows-style backslash paths that no macOS test env can produce
  void import('../stores/mesh.store').then((m) => {
    ;(window as unknown as Record<string, unknown>).__meshStore = m.useMeshStore
  })
}

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Payload of the executor's response_metadata event (post-call or pre-flight estimate) */
interface ResponseMetadataPayload {
  model?: string
  usage?: { input?: number; output?: number }
  estimated?: boolean
}

function llmActivityArgs(payload: ResponseMetadataPayload): string {
  const total = (payload.usage?.input ?? 0) + (payload.usage?.output ?? 0)
  const model = payload.model || 'llm'
  return `${model} · ${formatTok(total)} tok`
}

function errorActivityArgs(payload: Record<string, unknown>): string {
  const msg = typeof payload.error === 'string' ? payload.error : 'unknown error'
  const firstLine = msg.split('\n')[0]
  return firstLine.length > 48 ? firstLine.slice(0, 48) + '…' : firstLine
}

function turnActivityArgs(payload: Record<string, unknown>): string {
  if (payload.interrupted) return 'interrupted'
  if (typeof payload.targetState === 'string') return `done → ${payload.targetState}`
  return 'done'
}

/**
 * The agent's spoken text for this turn — turn_complete carries the final
 * assistant content blocks. Interruptions keep their lifecycle label.
 */
function turnActivity(payload: Record<string, unknown>): { args: string; detail?: string } {
  if (!payload.interrupted && Array.isArray(payload.content)) {
    const raw = (payload.content as { type?: string; text?: string }[])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim()
    if (raw) {
      // One-line version for tickers/tooltips; the bubble gets the raw text
      // with newlines intact so lists and paragraphs keep their shape
      const oneLine = raw.replace(/\s+/g, ' ')
      return {
        args: oneLine.length > 64 ? `“${oneLine.slice(0, 64)}…”` : `“${oneLine}”`,
        detail: oneLine.length > 64 ? raw.slice(0, 600) : undefined
      }
    }
  }
  return { args: turnActivityArgs(payload) }
}

// Per-call working states churn several times per turn — the tool/llm entries
// already tell that story, so only lifecycle transitions make the feed.
const NOISY_STATES = new Set(['thinking', 'tool_use'])

/**
 * Boundary crossings: tool calls that leave the fleet map as station traffic.
 * msg_send to an adapter recipient pulses that adapter's base station;
 * sys_fetch pulses the web gateway.
 */
function stationForToolCall(name: string, input: unknown): string | null {
  if (name === 'sys_fetch') return 'station:web'
  if (name === 'msg_send') {
    const recipient = (input as { recipient?: unknown } | undefined)?.recipient
    if (typeof recipient === 'string') {
      const match = recipient.match(/^(telegram|discord|email|imessage|slack):/)
      if (match) return `station:${match[1]}`
    }
  }
  return null
}

function getDisplayArgs(input: unknown): string | undefined {
  if (!input) return undefined
  try {
    const obj = input as Record<string, unknown>
    if (typeof obj._reason === 'string' && obj._reason) return obj._reason
    const str = typeof input === 'string' ? input : JSON.stringify(input)
    return str.length > 40 ? str.slice(0, 40) + '...' : str
  } catch {
    return undefined
  }
}

/**
 * Subscribes to all 3 event streams (MESH_EVENT, AGENT_EVENT, BACKGROUND_AGENT_EVENT)
 * and feeds the mesh graph store. Also manages animation cleanup timer and
 * forwards state changes to the mesh store so node state dots stay accurate.
 */
export function useMeshGraph() {
  const store = useMeshGraphStore
  const meshStore = useMeshStore
  const cleanupRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const unsubscribers: (() => void)[] = []

    // rAF-batched flush: IPC delivers 15–40 events/sec with 10 chatty agents
    // (hundreds at 100), and applying each one as its own set() re-rendered
    // the whole canvas per event. Buffer arrivals and fold each frame's
    // worth into at most one set() per store, preserving arrival order.
    type BufferedEvent =
      // filePath is captured at arrival — the foreground document (agent
      // events) can change between arrival and flush
      | { kind: 'mesh'; event: MeshEvent }
      | { kind: 'agent'; event: AgentExecutionEvent; filePath: string }
      | { kind: 'bg'; event: BackgroundAgentEvent; filePath: string }

    let buffer: BufferedEvent[] = []
    let rafId = 0

    const flush = (): void => {
      rafId = 0
      if (buffer.length === 0) return
      const events = buffer
      buffer = []

      // Fold events over a draft: each reducer sees the previous events'
      // results, so per-event semantics are identical to individual set()s —
      // only the intermediate (never-displayed) commits disappear.
      const draft: MeshGraphState = { ...store.getState() }
      const graphChanges: Partial<MeshGraphState> = {}
      const apply = (partial: Partial<MeshGraphState> | null): void => {
        if (!partial) return
        Object.assign(draft, partial)
        Object.assign(graphChanges, partial)
      }
      // Roster state flips coalesce last-wins per agent — intermediate
      // values inside a single frame were never rendered anyway
      const stateFlips: Record<string, AgentState> = {}

      const processMesh = (event: MeshEvent): void => {
        if (event.type === 'message_routed') {
          const payload = event.payload as {
            filePath: string
            toFilePaths?: string[]
            to?: string[]
            channel?: string
            toPeerAgent?: { runtimeId: string; id: string }
          }
          const from = payload.filePath
          const toFPs = payload.toFilePaths ?? []
          if (toFPs.length > 0) {
            apply(applyEdgeAnimation(draft, from, toFPs, payload.channel))
          }
          // Cross-runtime last hop: the edge lands on the peer station; light
          // the specific recipient tile inside it.
          if (payload.toPeerAgent) {
            apply(applyPeerAgentPing(draft, payload.toPeerAgent.runtimeId, payload.toPeerAgent.id))
          }
          // Add "message_sent" activity to sender (stations aren't agents —
          // inbound adapter traffic draws the edge but logs no activity)
          if (!from.startsWith('station:')) {
            apply(applyActivity(draft, from, {
              id: nextId(),
              toolName: 'msg_send',
              args: payload.channel ? `#${payload.channel}` : undefined,
              timestamp: Date.now(),
              type: 'message_sent'
            }))
          }
        }
      }

      const processAgent = (event: AgentExecutionEvent, foregroundFilePath: string): void => {
        // Forward state changes to mesh store so graph node dots update.
        // This channel carries RAW executor states — 'active' never appears
        // here (only the 5s poll derives it via toDisplayState). Noisy
        // per-call flips (thinking/tool_use) churn several times a second
        // and are never displayed verbatim, but DROPPING them left the
        // roster on its last lifecycle value ('idle') for the whole turn:
        // map them to their display state 'active' instead. Coalescing
        // (last-wins per frame) still applies, and a flip to the value
        // already displayed bails identity-stably in the store.
        if (event.type === 'state_changed') {
          const state = (event.payload as { state?: AgentState }).state
          if (!state) return
          if (NOISY_STATES.has(state)) {
            stateFlips[foregroundFilePath] = 'active'
            return
          }
          stateFlips[foregroundFilePath] = state
          apply(applyActivity(draft, foregroundFilePath, {
            id: nextId(),
            toolName: 'state',
            args: `→ ${state}`,
            timestamp: event.timestamp,
            type: 'state'
          }))
          return
        }

        const payload = event.payload as Record<string, unknown>

        switch (event.type) {
          case 'tool_call_start': {
            apply(applyActivity(draft, foregroundFilePath, {
              id: nextId(),
              toolName: (payload.name as string) ?? 'unknown',
              args: getDisplayArgs(payload.input),
              timestamp: event.timestamp,
              type: 'tool_start'
            }))
            const station = stationForToolCall((payload.name as string) ?? '', payload.input)
            if (station) apply(applyEdgeAnimation(draft, foregroundFilePath, [station]))
            break
          }
          case 'tool_call_result': {
            const result = payload.result as { isError?: boolean } | undefined
            apply(applyResolveActivity(draft, foregroundFilePath, (payload.name as string) ?? 'unknown', !!result?.isError))
            break
          }
          case 'ask_request':
            apply(applyPendingInteraction(draft, foregroundFilePath, {
              type: 'ask',
              requestId: payload.requestId as string,
              question: payload.question as string
            }))
            break
          case 'tool_approval_request':
            apply(applyPendingInteraction(draft, foregroundFilePath, {
              type: 'approval',
              requestId: payload.requestId as string,
              toolName: payload.name as string,
              input: payload.input
            }))
            break
          case 'ask_response':
          case 'tool_approval_resolved':
            apply(applyPendingInteraction(draft, foregroundFilePath, null))
            break
          case 'inter_agent_message':
            apply(applyActivity(draft, foregroundFilePath, {
              id: nextId(),
              toolName: 'msg_recv',
              args: getDisplayArgs(payload.from),
              timestamp: event.timestamp,
              type: 'message_recv'
            }))
            break
          case 'response_metadata':
            // Pre-flight estimates fire before every call — only surface real usage
            if (!(payload as ResponseMetadataPayload).estimated) {
              apply(applyActivity(draft, foregroundFilePath, {
                id: nextId(),
                toolName: 'llm',
                args: llmActivityArgs(payload as ResponseMetadataPayload),
                timestamp: event.timestamp,
                type: 'llm'
              }))
            }
            break
          case 'turn_complete': {
            const turn = turnActivity(payload)
            apply(applyActivity(draft, foregroundFilePath, {
              id: nextId(),
              toolName: 'turn',
              args: turn.args,
              detail: turn.detail,
              timestamp: event.timestamp,
              type: 'turn'
            }))
            break
          }
          case 'error':
            apply(applyActivity(draft, foregroundFilePath, {
              id: nextId(),
              toolName: 'error',
              args: errorActivityArgs(payload),
              timestamp: event.timestamp,
              type: 'error',
              isError: true
            }))
            break
        }
      }

      const processBg = (event: BackgroundAgentEvent, filePath: string): void => {
        // Forward state changes to mesh store so graph node dots update.
        // Background events already carry DISPLAY states (the manager maps
        // raw executor churn through toDisplayState before emitting), so
        // thinking/tool_use can never appear here — forward every flip
        // as-is, and every one is worth a feed entry (consecutive repeats
        // dedup in-store).
        if (event.type === 'agent_state_changed') {
          const state = (event.payload as { state?: AgentState }).state
          if (state) {
            stateFlips[filePath] = state
            apply(applyActivity(draft, filePath, {
              id: nextId(),
              toolName: 'state',
              args: `→ ${state}`,
              timestamp: event.timestamp,
              type: 'state'
            }))
          }
          return
        }

        const payload = event.payload as Record<string, unknown>

        switch (event.type) {
          case 'tool_call_start': {
            apply(applyActivity(draft, filePath, {
              id: nextId(),
              toolName: (payload.name as string) ?? 'unknown',
              args: getDisplayArgs(payload.input),
              timestamp: event.timestamp,
              type: 'tool_start'
            }))
            const station = stationForToolCall((payload.name as string) ?? '', payload.input)
            if (station) apply(applyEdgeAnimation(draft, filePath, [station]))
            break
          }
          case 'tool_call_result': {
            const result = payload.result as { isError?: boolean } | undefined
            apply(applyResolveActivity(draft, filePath, (payload.name as string) ?? 'unknown', !!result?.isError))
            break
          }
          case 'ask_request':
            apply(applyPendingInteraction(draft, filePath, {
              type: 'ask',
              requestId: payload.requestId as string,
              question: payload.question as string
            }))
            break
          case 'tool_approval_request':
            apply(applyPendingInteraction(draft, filePath, {
              type: 'approval',
              requestId: payload.requestId as string,
              toolName: payload.name as string,
              input: payload.input
            }))
            break
          case 'response_metadata':
            // Pre-flight estimates fire before every call — only surface real usage
            if (!(payload as ResponseMetadataPayload).estimated) {
              apply(applyActivity(draft, filePath, {
                id: nextId(),
                toolName: 'llm',
                args: llmActivityArgs(payload as ResponseMetadataPayload),
                timestamp: event.timestamp,
                type: 'llm'
              }))
            }
            break
          case 'turn_complete': {
            const turn = turnActivity(payload)
            apply(applyActivity(draft, filePath, {
              id: nextId(),
              toolName: 'turn',
              args: turn.args,
              detail: turn.detail,
              timestamp: event.timestamp,
              type: 'turn'
            }))
            break
          }
          case 'error':
            apply(applyActivity(draft, filePath, {
              id: nextId(),
              toolName: 'error',
              args: errorActivityArgs(payload),
              timestamp: event.timestamp,
              type: 'error',
              isError: true
            }))
            break
        }
      }

      for (const buffered of events) {
        if (buffered.kind === 'mesh') processMesh(buffered.event)
        else if (buffered.kind === 'agent') processAgent(buffered.event, buffered.filePath)
        else processBg(buffered.event, buffered.filePath)
      }

      if (Object.keys(graphChanges).length > 0) store.setState(graphChanges)
      if (Object.keys(stateFlips).length > 0) meshStore.getState().updateAgentStates(stateFlips)
    }

    // rAF stalls while the window is hidden — cap the buffer so a minimized
    // session flushes periodically instead of accumulating unboundedly
    const MAX_BUFFER = 2000

    const enqueue = (buffered: BufferedEvent): void => {
      buffer.push(buffered)
      if (buffer.length >= MAX_BUFFER) {
        if (rafId) cancelAnimationFrame(rafId)
        flush()
        return
      }
      if (!rafId) rafId = requestAnimationFrame(flush)
    }

    // 1. MESH_EVENT — message routing and agent lifecycle
    if (window.adfApi?.onMeshEvent) {
      unsubscribers.push(
        window.adfApi.onMeshEvent((event: MeshEvent) => enqueue({ kind: 'mesh', event }))
      )
    }

    // 2. AGENT_EVENT — foreground agent tool calls, ask/approval, state changes
    if (window.adfApi?.onAgentEvent) {
      unsubscribers.push(
        window.adfApi.onAgentEvent((event: AgentExecutionEvent) => {
          const foregroundFilePath = useDocumentStore.getState().filePath
          if (!foregroundFilePath) return
          enqueue({ kind: 'agent', event, filePath: foregroundFilePath })
        })
      )
    }

    // 3. BACKGROUND_AGENT_EVENT — background agent tool calls, ask/approval, state changes
    if (window.adfApi?.onBackgroundAgentEvent) {
      unsubscribers.push(
        window.adfApi.onBackgroundAgentEvent((event: BackgroundAgentEvent) => {
          const filePath = event.payload.filePath
          if (!filePath) return
          enqueue({ kind: 'bg', event, filePath })
        })
      )
    }

    // Timer for animation cleanup only
    cleanupRef.current = setInterval(() => {
      store.getState().cleanupAnimations()
    }, CLEANUP_INTERVAL_MS)

    return () => {
      unsubscribers.forEach((unsub) => unsub())
      // Drain synchronously — a pending frame's events must not be lost
      // when the map unmounts before its rAF fires
      if (rafId) {
        cancelAnimationFrame(rafId)
        flush()
      }
      if (cleanupRef.current) {
        clearInterval(cleanupRef.current)
        cleanupRef.current = null
      }
    }
  }, [])
}
