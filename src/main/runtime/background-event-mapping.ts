import type { AdfFileCreatedPayload, AgentState, BackgroundAdfFileCreatedEvent, BackgroundAgentEvent, BackgroundAgentStatusEvent } from '../../shared/types/ipc.types'
import { MAIN_LOOP } from '../adf/derive-loop-config'
import { toDisplayState } from './display-state'

/**
 * Executor/host event → background event mapping for agents without a focused
 * chat panel. Pure: no Electron, no manager state, no I/O. The background agent
 * manager runs it on its own executors' events; daemon mode (design D6) runs it
 * on executor frames arriving over SSE, so both modes feed the renderer the
 * same `BACKGROUND_AGENT_EVENT_BATCH` stream.
 *
 * JSON safety: the mapping reads only `type`, `loop`, `timestamp`,
 * `payload.state`, `payload.delta` and `payload.filePath`, and otherwise copies
 * the payload's own keys with a shallow spread. For a JSON-representable event
 * the output for `event` and for `JSON.parse(JSON.stringify(event))` is
 * identical. What a JSON round trip changes inside the payload (undefined keys
 * dropped, Dates to strings, Maps/Sets/class instances to plain objects,
 * NaN/Infinity to null) passes through unchanged — see
 * `tests/unit/runtime/background-event-mapping.test.ts`.
 */

/**
 * An executor or host event as the mapping reads it: an `AgentExecutionEvent`,
 * or a host-only event such as `adf_file_created`. Every field is JSON-safe.
 */
export interface BackgroundSourceEvent {
  type: string
  payload: unknown
  timestamp: number
  /** Producing loop; absent (or `'main'`) means the host loop. */
  loop?: string
}

/** Per-agent state the mapping folds events into. */
export interface BackgroundMappingState {
  /** Main loop's display state. */
  state: AgentState
  /** Display state of each SIDE loop, keyed by loop name; main is never in here. */
  loopStates: ReadonlyMap<string, AgentState>
  /** Last `activeLoops` count broadcast, so an unchanged count stays quiet. */
  activeLoops: number
  /** Main-loop text since the last tool call or turn end. */
  accumulatedText: string
}

/**
 * `adf_file_created`: its `filePath` is the CREATED file, `agentFilePath` the
 * creating agent (ipc/index.ts refreshes tracked directories from it).
 */
export type AdfFileCreatedEvent = BackgroundAdfFileCreatedEvent

export type BackgroundMappedEvent = BackgroundAgentEvent

/**
 * One step of the mapping: assign `patch` to the agent's state, then emit
 * `event` when present. Steps are applied in order; a synchronous listener of
 * `event` sees every earlier patch and none of the later ones.
 */
export interface BackgroundMappingStep {
  patch: Partial<Omit<BackgroundMappingState, 'loopStates'> & { loopStates: Map<string, AgentState> }>
  event?: BackgroundMappedEvent
}

/** Event types forwarded with the agent's `filePath` spread before their payload. */
const FORWARDED_TYPES: ReadonlySet<string> = new Set([
  'tool_call_start', 'tool_call_result', 'ask_request', 'tool_approval_request',
  'response_metadata', 'error', 'turn_complete',
])

/** How many inner loops are mid-turn. The sidebar's count badge reads this. */
export function countActiveLoops(loopStates: ReadonlyMap<string, AgentState>): number {
  let count = 0
  for (const state of loopStates.values()) if (state === 'active') count++
  return count
}

/**
 * Map one event for the agent at `filePath`. A generator so that each step,
 * including its `now()` timestamp, is computed only after the caller applied
 * and emitted the previous one, exactly as the inline mapping did.
 *
 * Side-loop events never move the agent's display state or its accumulated
 * text: `AgentState` is MAIN's, and a backgrounded agent has no loop tabs to
 * route them to. Side-loop states are tracked apart, in `loopStates`, so the
 * sidebar can still say how many inner loops are mid-turn. Main going off
 * clears them: they stop with the executor pool and never report idle.
 *
 * `current` is read once, before the first step.
 */
export function* mapBackgroundEvent(
  filePath: string,
  event: BackgroundSourceEvent,
  current: Readonly<BackgroundMappingState>,
  now: () => number = Date.now,
): Generator<BackgroundMappingStep, void, void> {
  const loop = event.loop ?? MAIN_LOOP
  yield* foldLoopState(filePath, event, loop, current, now)
  if (loop !== MAIN_LOOP) return

  if (event.type === 'state_changed') {
    const state = toDisplayState((event.payload as { state: string }).state)
    yield {
      patch: { state },
      event: { type: 'agent_state_changed', payload: { filePath, state }, timestamp: now() },
    }
  }
  if (event.type === 'text_delta') {
    yield { patch: { accumulatedText: current.accumulatedText + (event.payload as { delta: string }).delta } }
  }
  if (event.type === 'tool_call_start') yield { patch: { accumulatedText: '' } }
  if (FORWARDED_TYPES.has(event.type)) {
    yield {
      patch: {},
      event: {
        type: event.type as BackgroundAgentStatusEvent['type'],
        payload: { filePath, ...(event.payload as Record<string, unknown>) },
        timestamp: event.timestamp,
      },
    }
  }
  if (event.type === 'adf_file_created') {
    yield {
      patch: {},
      event: {
        type: 'adf_file_created',
        payload: { agentFilePath: filePath, filePath: (event.payload as AdfFileCreatedPayload).filePath },
        timestamp: event.timestamp,
      },
    }
  }
  if (event.type === 'turn_complete') yield { patch: { accumulatedText: '' } }
}

/**
 * Fold a `state_changed` into the side-loop table. A side loop's state is
 * recorded; main's only matters when it goes off with side loops present,
 * which empties the table. Emits `agent_loop_state_changed` when a side loop's
 * own state moved (a queue waiting on that loop has to see its turn end even
 * when the count does not move: one loop busy → idle while another goes idle
 * → busy), then `agent_loops_changed` only when the active count moved.
 */
function* foldLoopState(
  filePath: string,
  event: BackgroundSourceEvent,
  loop: string,
  current: Readonly<BackgroundMappingState>,
  now: () => number,
): Generator<BackgroundMappingStep, void, void> {
  if (event.type !== 'state_changed') return
  const state = toDisplayState((event.payload as { state: string }).state)
  let loopStates: Map<string, AgentState>
  if (loop === MAIN_LOOP) {
    if (state !== 'off' || current.loopStates.size === 0) return
    loopStates = new Map()
  } else {
    const previous = current.loopStates.get(loop)
    loopStates = new Map(current.loopStates).set(loop, state)
    if (previous !== state) {
      yield {
        patch: { loopStates },
        event: { type: 'agent_loop_state_changed', payload: { filePath, loop, state }, timestamp: now() },
      }
    }
  }
  const activeLoops = countActiveLoops(loopStates)
  if (activeLoops === current.activeLoops) {
    yield { patch: { loopStates } }
    return
  }
  yield {
    patch: { loopStates, activeLoops },
    event: { type: 'agent_loops_changed', payload: { filePath, activeLoops }, timestamp: now() },
  }
}

/**
 * Run the mapping against a mutable state record: assign each step's patch to
 * `target`, then hand its event to `emit`.
 */
export function applyBackgroundEvent(
  target: BackgroundMappingState,
  filePath: string,
  event: BackgroundSourceEvent,
  emit: (event: BackgroundMappedEvent) => void,
  now?: () => number,
): void {
  for (const step of mapBackgroundEvent(filePath, event, target, now)) {
    Object.assign(target, step.patch)
    if (step.event) emit(step.event)
  }
}
