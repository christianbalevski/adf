import type { AgentState, BackgroundAgentEvent, RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'

/**
 * Coalescing buffer for the main→renderer BACKGROUND_AGENT_EVENT broadcast.
 *
 * With ~10 background agents the raw stream is tens of sends/sec, each one a
 * synchronous renderer store update. Only the renderer broadcast is batched
 * here — the manager's own emitter (daemon/umbilical/tap consumers) still sees
 * every event individually.
 */

/** Same window as the executor's text/thinking delta batching. */
export const BATCH_WINDOW_MS = 50

/**
 * Flush the buffer immediately for these — they gate spinners and modals, and
 * they are rare enough that batching buys nothing.
 */
const IMMEDIATE_TYPES: ReadonlySet<string> = new Set([
  'agent_starting', 'agent_started', 'agent_stopping', 'agent_stopped',
  'agent_start_failed', 'ask_request', 'tool_approval_request', 'error'
])

/**
 * Reduce an event to the fields the renderer actually reads. tool_call_result
 * carries up to ~64KB of tool output that no renderer consumer looks at
 * (useMeshGraph reads name + result.isError; useBackgroundAgents drops tool
 * events entirely), and structured-cloning it across IPC is pure cost.
 */
export function stripForRenderer(event: BackgroundAgentEvent): RendererBackgroundAgentEvent {
  if (event.type !== 'tool_call_result') {
    return event as RendererBackgroundAgentEvent
  }
  const payload = event.payload as {
    filePath: string
    name?: string
    id?: string
    result?: { content?: unknown; isError?: unknown }
  }
  const content = payload.result?.content
  return {
    type: 'tool_call_result',
    timestamp: event.timestamp,
    payload: {
      filePath: payload.filePath,
      name: payload.name,
      id: payload.id,
      result: { isError: !!payload.result?.isError },
      resultSize: typeof content === 'string' ? content.length : 0
    }
  }
}

export class BackgroundEventBatcher {
  private buffer: RendererBackgroundAgentEvent[] = []
  /** filePath → the trailing state change in `buffer`, still open to collapse */
  private stateSlots = new Map<string, { index: number; state?: AgentState }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly send: (events: RendererBackgroundAgentEvent[]) => void,
    private readonly windowMs: number = BATCH_WINDOW_MS
  ) {}

  push(event: BackgroundAgentEvent): void {
    const forwarded = stripForRenderer(event)
    const filePath = forwarded.payload.filePath

    // After dispose there is no timer to fire, so late events (a straggling
    // agent_stopped during teardown) go out on their own rather than sit in a
    // buffer nothing will drain.
    if (this.disposed) {
      this.send([forwarded])
      return
    }

    if (forwarded.type === 'agent_state_changed') {
      const state = forwarded.payload.state
      const slot = this.stateSlots.get(filePath)
      if (slot !== undefined && slot.state === state) {
        // Only equal-valued repeats collapse. A distinct value is a turn
        // boundary (active → idle → active) that the renderer feed dedupes on
        // consecutive equality, so folding it away would erase the turn.
        this.buffer[slot.index] = forwarded
      } else {
        this.stateSlots.set(filePath, { index: this.buffer.length, state })
        this.buffer.push(forwarded)
      }
      this.schedule()
      return
    }

    // A discrete event closes the agent's collapse slot, so a later state
    // change lands after it rather than folding into a stale position.
    this.stateSlots.delete(filePath)
    this.buffer.push(forwarded)
    if (IMMEDIATE_TYPES.has(forwarded.type)) this.flush()
    else this.schedule()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return
    const events = this.buffer
    this.buffer = []
    this.stateSlots.clear()
    this.send(events)
  }

  dispose(): void {
    this.flush()
    this.disposed = true
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.windowMs)
    // A pending 50ms batch must never be the reason the process stays alive.
    this.timer.unref?.()
  }
}
