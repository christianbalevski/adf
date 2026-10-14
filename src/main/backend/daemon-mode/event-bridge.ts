import { IPC } from '../../../shared/constants/ipc-channels'
import type { DaemonClient, AgentSummary, AgentStatus } from '../../../shared/daemon-client'
import type { AgentExecutionEvent, AgentState, BackgroundAgentEvent, NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { applyBackgroundEvent, type BackgroundMappingState } from '../../runtime/background-event-mapping'
import { toDisplayState } from '../../runtime/display-state'
import type { ClientFrame, ExecutorFrame, HostFrame, PushFrame, PushTopic, StreamGap } from './client-stream'
import type { DaemonModeSession } from './session'

/**
 * Client-stream frames → IPC pushes (design D6, §7).
 *
 * - The focused agent (the open file's): `executor` frames go to AGENT_EVENT
 *   unchanged; `host` trigger and startup-dispatch failures become a
 *   synthetic `error` on AGENT_EVENT, as the foreground host bindings send
 *   them in embedded mode.
 * - Every other agent: `executor` and `host` frames go through the pure
 *   background mapping shared with the background agent manager
 *   (background-event-mapping.ts, W1-F) into `BackgroundEventBatcher`, i.e.
 *   BACKGROUND_AGENT_EVENT_BATCH exactly as embedded batches it.
 * - `push` frames go to the channel PUSH_TOPICS names.
 * - `stream.gap`: frames were lost, so the bridge resyncs: `chat_updated`
 *   (full uiLog) for the focused agent, DOC_AGENT_CONFIG_CHANGED,
 *   TRACKED_DIRS_CHANGED, a fresh approvals snapshot, and one batch with
 *   `agent_started` + `agent_state_changed` for every running agent.
 *
 * Mapping state is kept for the focused agent as well (its events are folded
 * in without being emitted), so the batch is right the moment focus moves.
 */

export interface PushTopicRoute {
  channel: string
  /** APPROVALS_CHANGED goes to every window (ipc/index.ts:1822); everything else to the first. */
  allWindows?: boolean
  /** Sent only when the push is about the open file (embedded guards on currentFilePath). */
  openFileOnly?: boolean
  /** Sent on AGENT_EVENT for the focused agent (inter_agent_message, §7). */
  focusedAgentEvent?: boolean
}

/** Every push topic and the channel it feeds. The payload is the channel's own (client-stream.ts). */
export const PUSH_TOPICS: Readonly<Record<PushTopic, PushTopicRoute>> = {
  inbox: { channel: IPC.INBOX_UPDATED, openFileOnly: true },
  adapter_status: { channel: IPC.ADAPTER_STATUS_CHANGED, openFileOnly: true },
  mcp_status: { channel: IPC.MCP_SERVER_STATUS_CHANGED, openFileOnly: true },
  mcp_install: { channel: IPC.MCP_INSTALL_PROGRESS },
  adapter_install: { channel: IPC.ADAPTER_INSTALL_PROGRESS },
  sandbox_install: { channel: IPC.SANDBOX_INSTALL_PROGRESS },
  tracked_dirs: { channel: IPC.TRACKED_DIRS_CHANGED },
  templates: { channel: IPC.TEMPLATES_CHANGED },
  file_renamed: { channel: IPC.FILE_RENAMED },
  config_changed: { channel: IPC.DOC_AGENT_CONFIG_CHANGED, openFileOnly: true },
  workspace_data: { channel: IPC.WORKSPACE_DATA_CHANGED, openFileOnly: true },
  approvals: { channel: IPC.APPROVALS_CHANGED, allWindows: true },
  mesh: { channel: IPC.MESH_EVENT },
  inter_agent_message: { channel: IPC.AGENT_EVENT, focusedAgentEvent: true },
  compute_phase: { channel: IPC.COMPUTE_CONTAINER_PHASE },
  browser_session: { channel: IPC.COMPUTE_BROWSER_SESSION },
}

/** The channels fed by executor and host frames rather than a push topic. */
export const FRAME_CHANNELS = [IPC.AGENT_EVENT, IPC.BACKGROUND_AGENT_EVENT_BATCH] as const

export interface BridgeOutput {
  /** webContents.send on the first window (embedded getMainWindow()); dropped when there is none. */
  send(channel: string, ...args: unknown[]): void
  /** webContents.send on every window. */
  sendAll(channel: string, ...args: unknown[]): void
}

export interface BatcherLike {
  push(event: BackgroundAgentEvent): void
  flush(): void
}

/** One agent the bridge has seen running. */
export interface BridgeAgent {
  agentId: string
  filePath: string
  handle?: string
  /** Display state, as the background mapping folds it. */
  mapping: BackgroundMappingState
}

type Log = Pick<Console, 'log' | 'warn'>

export interface EventBridgeDeps {
  session: DaemonModeSession
  output: BridgeOutput
  batcher: BatcherLike
  /** The daemon client, for resync reads. */
  client: () => DaemonClient | null
  /** Every approvals snapshot (stream push or resync): native notifier, menu bar. */
  onApprovals?: (snapshot: NotificationsSnapshot) => void
  /** An agent started, stopped or changed state (menu bar tooltip). */
  onAgentsChanged?: () => void
  /** A file was renamed on disk (the session re-keys it). */
  onFileRenamed?: (oldPath: string, newPath: string) => void
  log?: Log
  now?: () => number
}

const LOOP_DISPLAY_LIMIT = 200

function initialMapping(state: AgentState): BackgroundMappingState {
  return { state, loopStates: new Map(), activeLoops: 0, accumulatedText: '' }
}

/**
 * A turn a chat POST started. AGENT_INVOKE awaits it, as embedded awaits the
 * dispatch: that resolves once the turn ended and the executor left its busy
 * state, i.e. after `turn_complete` (or `error`) and the state change that
 * follows it on the same loop.
 */
interface TurnWaiter {
  agentId: string
  turnId: string
  loop: string
  /** Set once the turn's end arrived; the next state change of the loop settles it. */
  ended: 'completed' | 'error' | null
  resolve: (outcome: TurnOutcome) => void
}

export type TurnOutcome = 'completed' | 'error' | 'stopped' | 'gap'

export class EventBridge {
  private readonly agents = new Map<string, BridgeAgent>()
  private readonly waiters = new Set<TurnWaiter>()
  private readonly log: Log
  private readonly now: () => number
  private resyncing: Promise<void> | null = null

  constructor(private readonly deps: EventBridgeDeps) {
    this.log = deps.log ?? console
    this.now = deps.now ?? Date.now
  }

  /** Agents the bridge knows are running, with their display state (menu bar). */
  runningAgents(): readonly BridgeAgent[] {
    return [...this.agents.values()]
  }

  /** The file of a running agent, when the bridge has seen it. */
  filePathOf(agentId: string): string | null {
    return this.agents.get(agentId)?.filePath ?? null
  }

  /** Learn the running agents without pushing anything (start of the session). */
  seed(statuses: ReadonlyArray<Pick<AgentStatus, 'id' | 'filePath' | 'handle' | 'runtimeState'>>): void {
    for (const s of statuses) {
      if (!s.filePath) continue
      const existing = this.agents.get(s.id)
      const state = toDisplayState(String(s.runtimeState))
      if (existing) existing.mapping.state = state
      else this.agents.set(s.id, { agentId: s.id, filePath: s.filePath, handle: s.handle, mapping: initialMapping(state) })
    }
  }

  handleFrame(frame: ClientFrame): void {
    try {
      if (frame.kind === 'executor') this.onExecutor(frame)
      else if (frame.kind === 'host') this.onHost(frame)
      else this.onPush(frame)
    } catch (err) {
      this.log.warn(`[Backend] Event bridge could not map a ${frame.kind} frame:`, err)
    }
  }

  /** Resolves when the turn `turnId` of `agentId` ends, the agent stops, or the stream loses frames. */
  waitForTurn(agentId: string, turnId: string, loop = 'main'): Promise<TurnOutcome> {
    return new Promise((resolve) => {
      const waiter: TurnWaiter = { agentId, turnId, loop, ended: null, resolve: (outcome) => { this.waiters.delete(waiter); resolve(outcome) } }
      this.waiters.add(waiter)
    })
  }

  handleGap(gap: StreamGap): Promise<void> {
    this.log.warn(`[Backend] The client event stream lost frames (${gap.reason}); resyncing`)
    for (const w of [...this.waiters]) w.resolve('gap')
    return this.resync()
  }

  /** D6 resync. Each step is independent; a failed step is logged and the rest still run. */
  resync(): Promise<void> {
    this.resyncing ??= this.runResync().finally(() => { this.resyncing = null })
    return this.resyncing
  }

  dispose(): void {
    for (const w of [...this.waiters]) w.resolve('stopped')
    this.deps.batcher.flush()
  }

  // --- frames --------------------------------------------------------------

  private agentFor(agentId: string, filePath: string | null): BridgeAgent | null {
    const known = this.agents.get(agentId)
    if (known) {
      if (filePath && known.filePath !== filePath) known.filePath = filePath
      return known
    }
    if (!filePath) return null
    const agent: BridgeAgent = { agentId, filePath, mapping: initialMapping('idle') }
    this.agents.set(agentId, agent)
    return agent
  }

  private onExecutor(frame: ExecutorFrame): void {
    const agent = this.agentFor(frame.agentId, frame.filePath)
    const filePath = agent?.filePath ?? frame.filePath
    const focused = this.deps.session.isFocused(frame.agentId, filePath)
    const event = frame.event
    if (focused) this.deps.output.send(IPC.AGENT_EVENT, event)
    if (agent) {
      const before = agent.mapping.state
      applyBackgroundEvent(agent.mapping, agent.filePath, event, focused ? () => {} : (e) => this.deps.batcher.push(e), this.now)
      if (agent.mapping.state !== before) this.deps.onAgentsChanged?.()
    } else {
      this.log.warn(`[Backend] Executor event ${event.type} for agent ${frame.agentId} with no known file; not shown`)
    }
    this.settleWaiters(frame)
  }

  private settleWaiters(frame: ExecutorFrame): void {
    const { event } = frame
    const loop = event.loop ?? 'main'
    for (const w of [...this.waiters]) {
      if (w.agentId !== frame.agentId || w.loop !== loop) continue
      if (w.ended && event.type === 'state_changed') w.resolve(w.ended)
      else if (frame.turnId === w.turnId && (event.type === 'turn_complete' || event.type === 'error')) {
        w.ended = event.type === 'turn_complete' ? 'completed' : 'error'
      }
    }
  }

  private onHost(frame: HostFrame): void {
    const agent = this.agentFor(frame.agentId, frame.filePath)
    const filePath = agent?.filePath ?? frame.filePath
    if (!filePath) {
      this.log.warn(`[Backend] Host event ${frame.type} for agent ${frame.agentId} with no known file; not shown`)
      return
    }
    const focused = this.deps.session.isFocused(frame.agentId, filePath)

    if (frame.type === 'trigger_error' || frame.type === 'startup_dispatch_failed') {
      // Embedded: the foreground host sends these as `error` on AGENT_EVENT
      // (ipc/index.ts:3729, 4834, 4997); a background agent's land in its
      // display state through the executor's own state change.
      if (focused) {
        const event: AgentExecutionEvent = { type: 'error', payload: { ...frame.payload }, timestamp: frame.timestamp }
        this.deps.output.send(IPC.AGENT_EVENT, event)
      }
      return
    }

    if (frame.type === 'agent_started' && agent) {
      if (typeof frame.payload.handle === 'string') agent.handle = frame.payload.handle
      if (typeof frame.payload.state === 'string') agent.mapping.state = frame.payload.state as AgentState
    }
    if (frame.type === 'agent_stopped' || frame.type === 'agent_start_failed') {
      this.agents.delete(frame.agentId)
      for (const w of [...this.waiters]) if (w.agentId === frame.agentId) w.resolve('stopped')
    }
    this.deps.onAgentsChanged?.()
    // The open agent's lifecycle is the foreground's: embedded never batches it.
    if (focused) return
    if (frame.type === 'agent_state_changed') {
      if (agent && typeof frame.payload.state === 'string') agent.mapping.state = frame.payload.state as AgentState
    }
    if (frame.type === 'agent_loops_changed' && agent && typeof frame.payload.activeLoops === 'number') {
      agent.mapping.activeLoops = frame.payload.activeLoops
    }
    this.deps.batcher.push({
      type: frame.type,
      payload: { filePath, ...frame.payload },
      timestamp: frame.timestamp,
    } as BackgroundAgentEvent)
  }

  private onPush(frame: PushFrame): void {
    const route = PUSH_TOPICS[frame.topic]
    if (!route) {
      this.log.warn(`[Backend] Unknown push topic ${String(frame.topic)}; not shown`)
      return
    }
    if (route.focusedAgentEvent) {
      if (this.deps.session.isFocused(frame.agentId ?? null, frame.filePath ?? null)) this.deps.output.send(route.channel, frame.payload)
      return
    }
    if (route.openFileOnly && !this.deps.session.isFocused(frame.agentId ?? null, frame.filePath ?? null)) return
    if (frame.topic === 'file_renamed') {
      const p = frame.payload as { oldPath?: unknown; newPath?: unknown }
      if (typeof p?.oldPath === 'string' && typeof p.newPath === 'string') {
        this.deps.onFileRenamed?.(p.oldPath, p.newPath)
        for (const agent of this.agents.values()) if (agent.filePath === p.oldPath) agent.filePath = p.newPath
      }
    }
    if (frame.topic === 'approvals') this.deps.onApprovals?.(frame.payload as NotificationsSnapshot)
    const args = frame.payload === undefined ? [] : [frame.payload]
    if (route.allWindows) this.deps.output.sendAll(route.channel, ...args)
    else this.deps.output.send(route.channel, ...args)
  }

  // --- resync --------------------------------------------------------------

  private async runResync(): Promise<void> {
    const client = this.deps.client()
    if (!client) return
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      try { await run() } catch (err) {
        this.log.warn(`[Backend] Resync step "${name}" failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await step('running agents', async () => {
      const summaries = await client.request<AgentSummary[]>('GET', '/agents')
      const statuses = (await Promise.all(summaries.map((s) =>
        client.request<AgentStatus>('GET', `/agents/${encodeURIComponent(s.id)}/status`).catch(() => null))))
        .filter((s): s is AgentStatus => !!s && !!s.filePath)
      const live = new Set(statuses.map((s) => s.id))
      for (const id of [...this.agents.keys()]) if (!live.has(id)) this.agents.delete(id)
      this.seed(statuses)
      const ts = this.now()
      for (const s of statuses) {
        if (this.deps.session.isFocused(s.id, s.filePath)) continue
        const state = toDisplayState(String(s.runtimeState))
        const handle = s.handle ?? undefined
        this.deps.batcher.push({ type: 'agent_started', payload: { filePath: s.filePath!, state, ...(handle ? { handle } : {}) }, timestamp: ts })
        this.deps.batcher.push({ type: 'agent_state_changed', payload: { filePath: s.filePath!, state }, timestamp: ts })
      }
      this.deps.batcher.flush()
      this.deps.onAgentsChanged?.()
    })

    const focusedId = this.deps.session.agentId
    const focusedPath = this.deps.session.filePath
    if (focusedId && focusedPath) {
      await step('focused chat', async () => {
        const chat = await client.request<{ chatHistory: { uiLog: unknown[] } | null }>('GET', `/agents/${encodeURIComponent(focusedId)}/chat`, { query: { limit: LOOP_DISPLAY_LIMIT } })
        this.deps.output.send(IPC.AGENT_EVENT, { type: 'chat_updated', payload: { uiLog: chat.chatHistory?.uiLog ?? [] }, timestamp: this.now() })
      })
      await step('focused config', async () => {
        const { config } = await client.request<{ config: unknown }>('GET', `/agents/${encodeURIComponent(focusedId)}/config`)
        this.deps.output.send(IPC.DOC_AGENT_CONFIG_CHANGED, { filePath: focusedPath, config })
      })
    } else if (focusedPath) {
      this.log.warn('[Backend] Resync: the open file is not running in the daemon; its chat and config refresh when open documents land (W2-A)')
    }

    await step('tracked directories', async () => {
      const { directories } = await client.request<{ directories: Array<string | { path: string }> }>('GET', '/tracked-dirs')
      for (const dir of directories ?? []) {
        const dirPath = typeof dir === 'string' ? dir : dir.path
        if (dirPath) this.deps.output.send(IPC.TRACKED_DIRS_CHANGED, { dirPath })
      }
    })

    await step('approvals', async () => {
      const snapshot = await client.request<NotificationsSnapshot>('GET', '/approvals')
      this.deps.onApprovals?.(snapshot)
      this.deps.output.sendAll(IPC.APPROVALS_CHANGED, snapshot)
    })
  }
}
