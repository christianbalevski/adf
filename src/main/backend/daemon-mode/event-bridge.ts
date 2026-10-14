import { IPC } from '../../../shared/constants/ipc-channels'
import type { DaemonClient, AgentSummary, AgentStatus } from '../../../shared/daemon-client'
import type { AgentExecutionEvent, AgentState, BackgroundAgentEvent, NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { applyBackgroundEvent, type BackgroundMappingState } from '../../runtime/background-event-mapping'
import { toDisplayState } from '../../runtime/display-state'
import type { ClientFrame, ExecutorFrame, HostFrame, PushFrame, PushTopic, StreamGap, TurnFrame } from './client-stream'
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
  /** The renderer lists it as a background agent (an `agent_started` was batched). */
  shownInBackground: boolean
  /** The last main-loop executor state sent on AGENT_EVENT (focused agent). */
  lastForegroundState?: string
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
  /** Upper bound of one AGENT_INVOKE wait. Default TURN_WAIT_TIMEOUT_MS. */
  turnTimeoutMs?: number
  log?: Log
  now?: () => number
}

const LOOP_DISPLAY_LIMIT = 200
/** How many ended turns are remembered for a wait that registers late (the chat POST answers after the turn already ended). */
const ENDED_TURNS_KEPT = 256
/** An AGENT_INVOKE wait never outlives this; the handler then reports it. */
export const TURN_WAIT_TIMEOUT_MS = 30 * 60_000

function initialMapping(state: AgentState): BackgroundMappingState {
  return { state, loopStates: new Map(), activeLoops: 0, accumulatedText: '' }
}

/**
 * How a chat POST's turn ended for AGENT_INVOKE. `completed` / `error`: the
 * turn ended (embedded: the dispatch resolved). `discarded`: a stop dropped it
 * or cut it off. `stopped`: the agent unloaded. `gap`: frames were lost, the
 * end cannot be known. `disconnected`: the daemon did not come back.
 * `timeout`: TURN_WAIT_TIMEOUT_MS passed.
 */
export type TurnOutcome = 'completed' | 'error' | 'discarded' | 'stopped' | 'gap' | 'disconnected' | 'timeout'

type EndOutcome = 'completed' | 'error' | 'discarded'

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
  ended: EndOutcome | null
  timer: ReturnType<typeof setTimeout> | null
  resolve: (outcome: TurnOutcome) => void
}

/** A turn whose end arrived (possibly before anyone waited for it). */
interface EndedTurn {
  agentId: string
  loop: string
  outcome: EndOutcome
  /** The loop's state change after the end arrived too. */
  settled: boolean
}

export class EventBridge {
  private readonly agents = new Map<string, BridgeAgent>()
  private readonly waiters = new Set<TurnWaiter>()
  /** Insertion-ordered ring of ended turns, oldest first. */
  private readonly ended = new Map<string, EndedTurn>()
  /** Agents whose events the client no longer wants (it is stopping them, embedded detaches its host first). */
  private readonly detached = new Set<string>()
  private focus: string | null = null
  /** AGENT_EVENTs held back while a start request is in flight (see holdForeground). */
  private heldForeground: unknown[] | null = null
  private readonly log: Log
  private readonly now: () => number
  private resyncing: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: EventBridgeDeps) {
    this.log = deps.log ?? console
    this.now = deps.now ?? Date.now
    this.focus = deps.session.agentId
    deps.session.onFocusChange((agentId) => this.focusChanged(agentId))
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
      else this.agents.set(s.id, { agentId: s.id, filePath: s.filePath, handle: s.handle, mapping: initialMapping(state), shownInBackground: false })
    }
  }

  /**
   * One `agent_started` per running agent the renderer does not list yet
   * (not the open one). Until BACKGROUND_AGENT_STATUS has its daemon-mode
   * handler (W3-A) this is how a fresh renderer learns what already runs.
   */
  announceRunning(): void {
    const ts = this.now()
    let any = false
    for (const agent of this.agents.values()) {
      if (agent.shownInBackground || this.deps.session.isFocused(agent.agentId, agent.filePath)) continue
      this.showInBackground(agent, ts)
      any = true
    }
    if (any) this.deps.batcher.flush()
  }

  handleFrame(frame: ClientFrame): void {
    try {
      if (frame.kind === 'executor') this.onExecutor(frame)
      else if (frame.kind === 'host') this.onHost(frame)
      else if (frame.kind === 'turn') this.onTurn(frame)
      else this.onPush(frame)
    } catch (err) {
      this.log.warn(`[Backend] Event bridge could not map a ${frame.kind} frame:`, err)
    }
  }

  /**
   * Resolves when the turn `turnId` of `agentId` has run: its end and the
   * loop's next state change arrived. A turn that already ended before the
   * wait registered (the chat POST answers after a fast turn) is found in the
   * ring of ended turns. Also resolves when the agent stops, the stream loses
   * frames, the daemon does not come back (`failTurns`), or after
   * `turnTimeoutMs`.
   */
  waitForTurn(agentId: string, turnId: string, loop = 'main'): Promise<TurnOutcome> {
    const known = this.ended.get(turnId)
    if (known?.settled || known?.outcome === 'discarded') return Promise.resolve(known.outcome)
    return new Promise((resolve) => {
      const waiter: TurnWaiter = {
        agentId, turnId, loop, ended: known?.outcome ?? null, timer: null,
        resolve: (outcome) => {
          if (waiter.timer) clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          resolve(outcome)
        },
      }
      waiter.timer = setTimeout(() => waiter.resolve('timeout'), this.deps.turnTimeoutMs ?? TURN_WAIT_TIMEOUT_MS)
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  /** End every open wait (the connector failed, or the daemon stayed away past the grace period). */
  failTurns(outcome: Extract<TurnOutcome, 'disconnected' | 'stopped'>): void {
    for (const w of [...this.waiters]) w.resolve(outcome)
  }

  /**
   * The client is stopping `agentId` (AGENT_STOP): embedded detaches the
   * foreground host before it disposes the agent, so the renderer sees none
   * of the teardown's events. Undone by `attach` when the stop failed, and
   * cleared when the agent unloads.
   */
  detach(agentId: string): void {
    this.detached.add(agentId)
  }

  attach(agentId: string): void {
    this.detached.delete(agentId)
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
    // Quitting is not a file switch: the session's release must not move agents to the background list.
    this.disposed = true
    for (const w of [...this.waiters]) w.resolve('stopped')
    this.deps.batcher.flush()
  }

  /**
   * AGENT_START: embedded answers the start before the startup turn's first
   * event reaches the renderer (the turn is dispatched after the reply); the
   * daemon's events can arrive before its HTTP reply. The open agent's
   * AGENT_EVENTs are held until `releaseForeground` and then sent in order.
   */
  holdForeground(): void {
    this.heldForeground ??= []
  }

  releaseForeground(): void {
    const held = this.heldForeground
    this.heldForeground = null
    for (const event of held ?? []) this.deps.output.send(IPC.AGENT_EVENT, event)
  }

  private sendForeground(event: unknown): void {
    if (this.heldForeground) this.heldForeground.push(event)
    else this.deps.output.send(IPC.AGENT_EVENT, event)
  }

  // --- focus ---------------------------------------------------------------

  /**
   * The open file changed. Embedded moves the agent that loses the window to
   * the background manager (`agent_started` with its state) and takes the
   * one that gains it out (`agent_stopped`). Pending batches flush first, so
   * the gaining agent's background events never arrive after its live
   * AGENT_EVENTs.
   */
  private focusChanged(next: string | null): void {
    const prev = this.focus
    this.focus = next
    if (prev === next || this.disposed) return
    const lost = prev ? this.agents.get(prev) : undefined
    const gained = next ? this.agents.get(next) : undefined
    if (!lost && !gained?.shownInBackground) return
    this.deps.batcher.flush()
    const ts = this.now()
    if (lost) this.showInBackground(lost, ts)
    if (gained?.shownInBackground) {
      gained.shownInBackground = false
      gained.lastForegroundState = undefined
      this.deps.batcher.push({ type: 'agent_stopped', payload: { filePath: gained.filePath }, timestamp: ts })
    }
    this.deps.batcher.flush()
    this.deps.onAgentsChanged?.()
  }

  private showInBackground(agent: BridgeAgent, ts: number): void {
    agent.shownInBackground = true
    const handle = agent.handle
    this.deps.batcher.push({ type: 'agent_started', payload: { filePath: agent.filePath, state: agent.mapping.state, ...(handle ? { handle } : {}) }, timestamp: ts })
  }

  // --- frames --------------------------------------------------------------

  private agentFor(agentId: string, filePath: string | null): BridgeAgent | null {
    const known = this.agents.get(agentId)
    if (known) {
      if (filePath && known.filePath !== filePath) known.filePath = filePath
      return known
    }
    if (!filePath) return null
    const agent: BridgeAgent = { agentId, filePath, mapping: initialMapping('idle'), shownInBackground: false }
    this.agents.set(agentId, agent)
    return agent
  }

  private onExecutor(frame: ExecutorFrame): void {
    this.trackTurns(frame)
    if (this.detached.has(frame.agentId)) return
    const agent = this.agentFor(frame.agentId, frame.filePath)
    const filePath = agent?.filePath ?? frame.filePath
    const focused = this.deps.session.isFocused(frame.agentId, filePath)
    const event = frame.event
    if (focused) {
      this.sendForeground(event)
      if (agent && event.type === 'state_changed' && (event.loop ?? 'main') === 'main') {
        agent.lastForegroundState = String((event.payload as { state?: unknown })?.state)
      }
    }
    if (agent) {
      const before = agent.mapping.state
      applyBackgroundEvent(agent.mapping, agent.filePath, event, focused ? () => {} : (e) => this.pushBackground(agent, e), this.now)
      if (agent.mapping.state !== before) this.deps.onAgentsChanged?.()
    } else {
      this.log.warn(`[Backend] Executor event ${event.type} for agent ${frame.agentId} with no known file; not shown`)
    }
  }

  /** Background events of an agent the renderer lists only once it was announced. */
  private pushBackground(agent: BridgeAgent, event: BackgroundAgentEvent): void {
    if (event.type === 'agent_started') agent.shownInBackground = true
    this.deps.batcher.push(event)
  }

  /** Turn ends (with the chats they absorbed) and the state change that settles them. */
  private trackTurns(frame: ExecutorFrame): void {
    const { event } = frame
    const loop = event.loop ?? 'main'
    if (event.type === 'turn_complete' || event.type === 'error') {
      const outcome: EndOutcome = event.type === 'turn_complete' ? 'completed' : 'error'
      for (const id of [...(frame.turnId ? [frame.turnId] : []), ...(frame.absorbedTurnIds ?? [])]) this.markEnded(id, frame.agentId, loop, outcome)
      return
    }
    if (event.type !== 'state_changed') return
    for (const turn of this.ended.values()) {
      if (turn.agentId === frame.agentId && turn.loop === loop) turn.settled = true
    }
    for (const w of [...this.waiters]) {
      if (w.agentId === frame.agentId && w.loop === loop && w.ended) w.resolve(w.ended)
    }
  }

  private markEnded(turnId: string, agentId: string, loop: string, outcome: EndOutcome): void {
    this.ended.delete(turnId)
    this.ended.set(turnId, { agentId, loop, outcome, settled: outcome === 'discarded' })
    while (this.ended.size > ENDED_TURNS_KEPT) this.ended.delete(this.ended.keys().next().value!)
    for (const w of [...this.waiters]) {
      if (w.turnId !== turnId) continue
      if (outcome === 'discarded') w.resolve('discarded')
      else w.ended = outcome
    }
  }

  private onTurn(frame: TurnFrame): void {
    for (const id of [...frame.turnIds, ...frame.unansweredTurnIds]) this.markEnded(id, frame.agentId, 'main', 'discarded')
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
      if (focused && !this.detached.has(frame.agentId)) {
        const event: AgentExecutionEvent = { type: 'error', payload: { ...frame.payload }, timestamp: frame.timestamp }
        this.sendForeground(event)
      }
      return
    }

    if (frame.type === 'agent_started' && agent) {
      if (typeof frame.payload.handle === 'string') agent.handle = frame.payload.handle
      if (typeof frame.payload.state === 'string') agent.mapping.state = frame.payload.state as AgentState
      // The open file's agent was started elsewhere (CLI, another client):
      // the session learns its id, so its contents and events follow.
      if (focused) this.deps.session.noteAgent(filePath, frame.agentId)
    }
    const stopped = frame.type === 'agent_stopped' || frame.type === 'agent_start_failed'
    if (stopped) {
      const wasDetached = this.detached.delete(frame.agentId)
      this.agents.delete(frame.agentId)
      for (const w of [...this.waiters]) if (w.agentId === frame.agentId) w.resolve('stopped')
      if (focused && agent && !wasDetached) this.foregroundStopped(agent, frame.timestamp)
    }
    this.deps.onAgentsChanged?.()
    if (focused) return
    if (frame.type === 'agent_state_changed') {
      if (agent && typeof frame.payload.state === 'string') agent.mapping.state = frame.payload.state as AgentState
    }
    if (frame.type === 'agent_loops_changed' && agent && typeof frame.payload.activeLoops === 'number') {
      agent.mapping.activeLoops = frame.payload.activeLoops
    }
    if (frame.type === 'agent_started' && agent) agent.shownInBackground = true
    if (stopped && agent && !agent.shownInBackground && frame.type === 'agent_stopped') return
    this.deps.batcher.push({
      type: frame.type,
      payload: { filePath, ...frame.payload },
      timestamp: frame.timestamp,
    } as BackgroundAgentEvent)
  }

  /**
   * The open file's agent went away without this client stopping it (the CLI,
   * an `off`, a crash, or a resync that no longer finds it): the renderer's
   * chat panel learns it as the executor's own `stopped`, once.
   */
  private foregroundStopped(agent: BridgeAgent, timestamp: number): void {
    if (agent.lastForegroundState === 'stopped') return
    agent.lastForegroundState = 'stopped'
    this.sendForeground({ type: 'state_changed', payload: { state: 'stopped' }, timestamp })
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
      const ts = this.now()
      // Agents that died during the gap: the renderer still lists them.
      for (const [id, agent] of [...this.agents]) {
        if (live.has(id)) continue
        this.agents.delete(id)
        this.detached.delete(id)
        for (const w of [...this.waiters]) if (w.agentId === id) w.resolve('stopped')
        if (this.deps.session.isFocused(id, agent.filePath)) this.foregroundStopped(agent, ts)
        else if (agent.shownInBackground) this.deps.batcher.push({ type: 'agent_stopped', payload: { filePath: agent.filePath }, timestamp: ts })
      }
      this.seed(statuses)
      for (const s of statuses) {
        if (this.deps.session.isFocused(s.id, s.filePath)) continue
        const agent = this.agents.get(s.id)!
        agent.shownInBackground = true
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
    if (focusedId && focusedPath && this.agents.has(focusedId)) {
      await step('focused chat', async () => {
        const agent = this.agents.get(focusedId)
        const { loops } = await client.request<{ loops: Array<{ name: string }> }>('GET', `/agents/${encodeURIComponent(focusedId)}/loops`)
          .catch(() => ({ loops: [{ name: 'main' }] }))
        for (const { name } of loops) {
          // A turn still streaming repaints itself; a chat_updated now would
          // replace the live entries (embedded skips it the same way).
          const busy = name === 'main' ? agent?.mapping.state === 'active' : agent?.mapping.loopStates.get(name) === 'active'
          if (busy) continue
          const chat = await client.request<{ chatHistory: { uiLog: unknown[]; earlierCount?: number } | null }>(
            'GET', `/agents/${encodeURIComponent(focusedId)}/chat`, { query: { limit: LOOP_DISPLAY_LIMIT, ...(name === 'main' ? {} : { loop: name }) } })
          this.deps.output.send(IPC.AGENT_EVENT, {
            type: 'chat_updated',
            payload: { uiLog: chat.chatHistory?.uiLog ?? [], earlierCount: chat.chatHistory?.earlierCount ?? 0 },
            timestamp: this.now(),
            ...(name === 'main' ? {} : { loop: name }),
          })
        }
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
