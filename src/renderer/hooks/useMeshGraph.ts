import { useEffect, useRef } from 'react'
import { useMeshGraphStore, CLEANUP_INTERVAL_MS } from '../stores/mesh-graph.store'
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
    const text = (payload.content as { type?: string; text?: string }[])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) {
      return {
        args: text.length > 64 ? `“${text.slice(0, 64)}…”` : `“${text}”`,
        detail: text.length > 64 ? text.slice(0, 400) : undefined
      }
    }
  }
  return { args: turnActivityArgs(payload) }
}

// Per-call working states churn several times per turn — the tool/llm entries
// already tell that story, so only lifecycle transitions make the feed.
const NOISY_STATES = new Set(['thinking', 'tool_use'])

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

    // 1. MESH_EVENT — message routing and agent lifecycle
    if (window.adfApi?.onMeshEvent) {
      const unsub = window.adfApi.onMeshEvent((event: MeshEvent) => {
        const s = store.getState()
        if (event.type === 'message_routed') {
          const payload = event.payload as { filePath: string; toFilePaths?: string[]; to?: string[]; channel?: string }
          const from = payload.filePath
          const toFPs = payload.toFilePaths ?? []
          if (toFPs.length > 0) {
            s.triggerEdgeAnimation(from, toFPs, payload.channel)
          }
          // Add "message_sent" activity to sender
          s.addActivity(from, {
            id: nextId(),
            toolName: 'msg_send',
            args: payload.channel ? `#${payload.channel}` : undefined,
            timestamp: Date.now(),
            type: 'message_sent'
          })
        }
      })
      unsubscribers.push(unsub)
    }

    // 2. AGENT_EVENT — foreground agent tool calls, ask/approval, state changes
    if (window.adfApi?.onAgentEvent) {
      const unsub = window.adfApi.onAgentEvent((event: AgentExecutionEvent) => {
        const foregroundFilePath = useDocumentStore.getState().filePath
        if (!foregroundFilePath) return

        // Forward state changes to mesh store so graph node dots update
        if (event.type === 'state_changed') {
          const state = (event.payload as { state?: AgentState }).state
          if (state) {
            meshStore.getState().updateAgentState(foregroundFilePath, state)
            if (!NOISY_STATES.has(state)) {
              store.getState().addActivity(foregroundFilePath, {
                id: nextId(),
                toolName: 'state',
                args: `→ ${state}`,
                timestamp: event.timestamp,
                type: 'state'
              })
            }
          }
          return
        }

        const s = store.getState()
        const payload = event.payload as Record<string, unknown>

        switch (event.type) {
          case 'tool_call_start':
            s.addActivity(foregroundFilePath, {
              id: nextId(),
              toolName: (payload.name as string) ?? 'unknown',
              args: getDisplayArgs(payload.input),
              timestamp: event.timestamp,
              type: 'tool_start'
            })
            break
          case 'tool_call_result': {
            const result = payload.result as { isError?: boolean } | undefined
            s.resolveActivity(foregroundFilePath, (payload.name as string) ?? 'unknown', !!result?.isError)
            break
          }
          case 'ask_request':
            s.setPendingInteraction(foregroundFilePath, {
              type: 'ask',
              requestId: payload.requestId as string,
              question: payload.question as string
            })
            break
          case 'tool_approval_request':
            s.setPendingInteraction(foregroundFilePath, {
              type: 'approval',
              requestId: payload.requestId as string,
              toolName: payload.name as string,
              input: payload.input
            })
            break
          case 'ask_response':
          case 'tool_approval_resolved':
            s.setPendingInteraction(foregroundFilePath, null)
            break
          case 'inter_agent_message':
            s.addActivity(foregroundFilePath, {
              id: nextId(),
              toolName: 'msg_recv',
              args: getDisplayArgs(payload.from),
              timestamp: event.timestamp,
              type: 'message_recv'
            })
            break
          case 'response_metadata':
            // Pre-flight estimates fire before every call — only surface real usage
            if (!(payload as ResponseMetadataPayload).estimated) {
              s.addActivity(foregroundFilePath, {
                id: nextId(),
                toolName: 'llm',
                args: llmActivityArgs(payload as ResponseMetadataPayload),
                timestamp: event.timestamp,
                type: 'llm'
              })
            }
            break
          case 'turn_complete': {
            const turn = turnActivity(payload)
            s.addActivity(foregroundFilePath, {
              id: nextId(),
              toolName: 'turn',
              args: turn.args,
              detail: turn.detail,
              timestamp: event.timestamp,
              type: 'turn'
            })
            break
          }
          case 'error':
            s.addActivity(foregroundFilePath, {
              id: nextId(),
              toolName: 'error',
              args: errorActivityArgs(payload),
              timestamp: event.timestamp,
              type: 'error',
              isError: true
            })
            break
        }
      })
      unsubscribers.push(unsub)
    }

    // 3. BACKGROUND_AGENT_EVENT — background agent tool calls, ask/approval, state changes
    if (window.adfApi?.onBackgroundAgentEvent) {
      const unsub = window.adfApi.onBackgroundAgentEvent((event: BackgroundAgentEvent) => {
        const filePath = event.payload.filePath
        if (!filePath) return

        // Forward state changes to mesh store so graph node dots update.
        // Background events carry display states (active/idle/hibernate/…) —
        // the raw thinking/tool_use churn never reaches this channel, so all
        // of them are worth a feed entry (consecutive repeats dedup in-store).
        if (event.type === 'agent_state_changed') {
          const state = (event.payload as { state?: AgentState }).state
          if (state) {
            meshStore.getState().updateAgentState(filePath, state)
            store.getState().addActivity(filePath, {
              id: nextId(),
              toolName: 'state',
              args: `→ ${state}`,
              timestamp: event.timestamp,
              type: 'state'
            })
          }
          return
        }

        const s = store.getState()
        const payload = event.payload as Record<string, unknown>

        switch (event.type) {
          case 'tool_call_start':
            s.addActivity(filePath, {
              id: nextId(),
              toolName: (payload.name as string) ?? 'unknown',
              args: getDisplayArgs(payload.input),
              timestamp: event.timestamp,
              type: 'tool_start'
            })
            break
          case 'tool_call_result': {
            const result = payload.result as { isError?: boolean } | undefined
            s.resolveActivity(filePath, (payload.name as string) ?? 'unknown', !!result?.isError)
            break
          }
          case 'ask_request':
            s.setPendingInteraction(filePath, {
              type: 'ask',
              requestId: payload.requestId as string,
              question: payload.question as string
            })
            break
          case 'tool_approval_request':
            s.setPendingInteraction(filePath, {
              type: 'approval',
              requestId: payload.requestId as string,
              toolName: payload.name as string,
              input: payload.input
            })
            break
          case 'response_metadata':
            // Pre-flight estimates fire before every call — only surface real usage
            if (!(payload as ResponseMetadataPayload).estimated) {
              s.addActivity(filePath, {
                id: nextId(),
                toolName: 'llm',
                args: llmActivityArgs(payload as ResponseMetadataPayload),
                timestamp: event.timestamp,
                type: 'llm'
              })
            }
            break
          case 'turn_complete': {
            const turn = turnActivity(payload)
            s.addActivity(filePath, {
              id: nextId(),
              toolName: 'turn',
              args: turn.args,
              detail: turn.detail,
              timestamp: event.timestamp,
              type: 'turn'
            })
            break
          }
          case 'error':
            s.addActivity(filePath, {
              id: nextId(),
              toolName: 'error',
              args: errorActivityArgs(payload),
              timestamp: event.timestamp,
              type: 'error',
              isError: true
            })
            break
        }
      })
      unsubscribers.push(unsub)
    }

    // Timer for animation cleanup only
    cleanupRef.current = setInterval(() => {
      store.getState().cleanupAnimations()
    }, CLEANUP_INTERVAL_MS)

    return () => {
      unsubscribers.forEach((unsub) => unsub())
      if (cleanupRef.current) {
        clearInterval(cleanupRef.current)
        cleanupRef.current = null
      }
    }
  }, [])
}
