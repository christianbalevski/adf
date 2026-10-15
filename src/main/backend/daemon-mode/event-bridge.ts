import { IPC } from '../../../shared/constants/ipc-channels'
import type { DaemonClient, AgentSummary, AgentStatus } from '../../../shared/daemon-client'
import type { AgentExecutionEvent, AgentState, BackgroundAgentEvent, NotificationsSnapshot } from '../../../shared/types/ipc.types'
import { applyBackgroundEvent, type BackgroundMappingState } from '../../runtime/background-event-mapping'
import { toDisplayState } from '../../runtime/display-state'
import { turnEndOf, type ClientFrame, type ExecutorFrame, type HostFrame, type PushFrame, type PushTopic, type StreamGap, type TurnFrame } from './client-stream'
import { dirname } from 'node:path'
import { pathKey, samePath, type DaemonModeSession } from './session'

/**
 * Client-stream frames → IPC pushes (design D6, §7).
 *
 * - The focused agent (the open file's): `executor` frames go to AGENT_EVENT
 *   unchanged. A frame the daemon reduced (`stripped`: sent before the
 *   session's focus reached the daemon) is never shown there; the renderer
 *   reads the file's state after FILE_OPEN. `host` trigger and startup
 *   failures are not repeated: RuntimeService emitted the `error` executor
 *   event already (W1-A, D5.1).
 * - Every other agent: `executor` and `host` frames go through the pure
 *   background mapping shared with the background agent manager
 *   (background-event-mapping.ts, W1-F) into `BackgroundEventBatcher`, i.e.
 *   BACKGROUND_AGENT_EVENT_BATCH exactly as embedded batches it.
 * - `push` frames go to the channel PUSH_TOPICS names, or run its action
 *   (`adf_file_created`: embedded's notifyAdfFileCreated; `daemon_orphan_hold`:
 *   a notice).
 * - `stream.gap`: frames were lost, so the bridge resyncs: `chat_updated`
 *   (full uiLog) for the focused agent, DOC_AGENT_CONFIG_CHANGED,
 *   TRACKED_DIRS_CHANGED, a fresh approvals snapshot, and one batch with
 *   `agent_started` + `agent_state_changed` for every running agent. A loop
 *   still mid-turn gets its `chat_updated` when the turn's state change
 *   arrives, so the chat ends as embedded shows it.
 *
 * Mapping state is kept for the focused agent as well (its events are folded
 * in without being emitted), so the batch is right the moment focus moves.
 */

export interface PushTopicRoute {
  /** The push channel; null for topics that feed no channel (see `action` / `none`). */
  channel: string | null
  /** APPROVALS_CHANGED goes to every window (ipc/index.ts:1822); everything else to the first. */
  allWindows?: boolean
  /** Sent only when the push is about the open file (embedded guards on currentFilePath). */
  openFileOnly?: boolean
  /** Sent on AGENT_EVENT for the focused agent, as an executor event of the topic's name (inter_agent_message, §7). */
  focusedAgentEvent?: boolean
  /** Bridge actions instead of a channel. */
  action?: 'adf_file_created' | 'notice' | 'rekey'
  /** No Studio push and no action: why. */
  none?: string
  /** The channel carries no payload in embedded Studio (TEMPLATES_CHANGED): the frame's `{}` is not passed on. */
  noPayload?: boolean
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
  templates: { channel: IPC.TEMPLATES_CHANGED, noPayload: true },
  file_renamed: { channel: IPC.FILE_RENAMED },
  config_changed: { channel: IPC.DOC_AGENT_CONFIG_CHANGED, openFileOnly: true },
  workspace_data: { channel: IPC.WORKSPACE_DATA_CHANGED, openFileOnly: true },
  approvals: { channel: IPC.APPROVALS_CHANGED, allWindows: true },
  mesh: { channel: IPC.MESH_EVENT },
  inter_agent_message: { channel: IPC.AGENT_EVENT, focusedAgentEvent: true },
  compute_phase: { channel: IPC.COMPUTE_CONTAINER_PHASE },
  browser_session: { channel: IPC.COMPUTE_BROWSER_SESSION },
  adf_file_created: { channel: null, action: 'adf_file_created' },
  daemon_orphan_hold: { channel: null, action: 'notice' },
  agent_path_changed: { channel: null, action: 'rekey' },
  autostart: { channel: null, none: 'the tracked-folder watcher\'s autostart; embedded Studio pushes nothing for it' },
  autostart_overflow: { channel: null, none: 'logged by the daemon; embedded Studio pushes nothing for it' },
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
  /** A daemon notice for the user (`daemon_orphan_hold`). */
  onNotice?: (text: string) => void
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

function turnKey(agentId: string, turnId: string): string {
  return `${agentId}\0${turnId}`
}

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
  /**
   * Frames were lost after the wait started (`stream.gap`): the end may be
   * among them, so the loop leaving its busy state also settles the wait.
   */
  lenient?: boolean
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

/** AGENT_EVENTs of one file held while its AGENT_START request is in flight. */
interface ForegroundHold {
  filePath: string
  events: Array<{ agentId: string; event: unknown }>
}

export class EventBridge {
  private readonly agents = new Map<string, BridgeAgent>()
  private readonly waiters = new Set<TurnWaiter>()
  /** Insertion-ordered ring of ended turns, oldest first, keyed by turnKey(agentId, turnId). */
  private readonly ended = new Map<string, EndedTurn>()
  /** Agents whose events the client no longer wants (it is stopping them, embedded detaches its host first). */
  private readonly detached = new Set<string>()
  private focus: string | null = null
  /** AGENT_EVENTs held back per file while its start request is in flight (see holdForeground). */
  private readonly holds = new Set<ForegroundHold>()
  /** Focused loops that were mid-turn at a resync: `agentId\0loop` → refresh the chat when the turn settles. */
  private readonly refreshAfterTurn = new Set<string>()
  private strippedForegroundLogged = false
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
   * The renderer lists `agentId` as a background agent from an answer it
   * pulled (BACKGROUND_AGENT_STATUS), not from an `agent_started` batch: its
   * later stop and state changes reach the renderer as background events.
   */
  markListedInBackground(agentId: string): void {
    const agent = this.agents.get(agentId)
    if (agent) agent.shownInBackground = true
  }

  handleFrame(frame: ClientFrame): void {
    try {
      if (frame.kind === 'executor') {
        // The executor frame first, then the turn end it carries (D5): the order the umbilical turn end had.
        try { this.onExecutor(frame) } finally {
          const end = turnEndOf(frame)
          if (end) this.onTurn(end)
        }
      }
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
    const known = this.ended.get(turnKey(agentId, turnId))
    if (known && (known.settled || known.outcome === 'discarded' || !this.loopBusy(agentId, known.loop))) return Promise.resolve(known.outcome)
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

  /**
   * A chat Studio sent did not run (AGENT_INVOKE failed: not delivered,
   * refused, the daemon went away before its turn ended). The renderer
   * already shows the message and its spinner and reads no AGENT_INVOKE
   * answer, so the chat gets what embedded's executor sends on a failed
   * turn: an `error` event, then `state_changed` idle, routed as the
   * daemon's own events (open file: AGENT_EVENT; else the background list).
   */
  reportChatFailure(target: { agentId: string | null; filePath: string }, loop: string | undefined, error: string): void {
    const timestamp = this.now()
    const onLoop = loop && loop !== 'main' ? { loop } : {}
    this.log.warn(`[Backend] The chat to ${target.filePath}${loop && loop !== 'main' ? ` (${loop})` : ''} did not run: ${error}`)
    const events = [
      { type: 'error', payload: { error }, timestamp, ...onLoop },
      { type: 'state_changed', payload: { state: 'idle' }, timestamp, ...onLoop },
    ] as AgentExecutionEvent[]
    for (const event of events) {
      if (target.agentId && this.agents.has(target.agentId)) {
        this.onExecutor({ kind: 'executor', agentId: target.agentId, filePath: target.filePath, event })
      } else if (this.deps.session.isFocused(target.agentId ?? '', target.filePath)) {
        // Not running in the daemon (any more): only the open file's chat shows it.
        this.sendForeground(target.agentId ?? '', target.filePath, event)
      }
    }
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
    this.log.warn(`[Backend] The client event stream lost frames (${gap.reason}${gap.dropped !== undefined ? `, ${gap.dropped} dropped` : ''}); resyncing`)
    // A wait whose end was among the lost frames settles when its loop is not busy (resync reads it, or the next state change says so).
    for (const w of this.waiters) w.lenient = true
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
   * daemon's events can arrive before its HTTP reply. AGENT_EVENTs of the
   * agent at `filePath` are held until the returned release runs, then sent
   * in order. Only that file's events wait: another file opened meanwhile
   * streams as usual. Held events of a file that lost the focus are dropped
   * (its background view comes from the mapping, which saw every event); the
   * release sends only the events of the file focused then.
   */
  holdForeground(filePath: string): () => void {
    for (const h of this.holds) if (samePath(h.filePath, filePath)) return () => {}
    const hold: ForegroundHold = { filePath, events: [] }
    this.holds.add(hold)
    return () => {
      if (!this.holds.delete(hold)) return
      if (this.disposed) return
      this.dropUnfocused(hold)
      for (const { event } of hold.events) this.deps.output.send(IPC.AGENT_EVENT, event)
    }
  }

  private sendForeground(agentId: string, filePath: string | null, event: unknown): void {
    for (const hold of this.holds) {
      if (!samePath(hold.filePath, filePath)) continue
      hold.events.push({ agentId, event })
      return
    }
    this.deps.output.send(IPC.AGENT_EVENT, event)
  }

  /** Held events whose file is no longer the focused one never reach AGENT_EVENT. */
  private dropUnfocused(hold: ForegroundHold): void {
    const before = hold.events.length
    hold.events = hold.events.filter((h) => this.deps.session.isFocused(h.agentId, hold.filePath))
    const dropped = before - hold.events.length
    if (dropped > 0) this.log.log(`[Backend] ${dropped} live event(s) of ${hold.filePath} not shown: the file lost the window before its start answered; it is listed in the background`)
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
    if (this.disposed) return
    for (const hold of this.holds) this.dropUnfocused(hold)
    if (prev === next) return
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
    if (event.type === 'adf_file_created') {
      const created = (event.payload as { filePath?: unknown })?.filePath
      if (typeof created === 'string') void this.adfFileCreated(created)
    }
    if (focused && frame.stripped) {
      // Reduced for an unfocused session: the daemon had not applied the focus yet.
      if (!this.strippedForegroundLogged) {
        this.strippedForegroundLogged = true
        this.log.log(`[Backend] A reduced ${event.type} event of the open file arrived before the daemon applied the focus; not shown (the file's state is read after it opens)`)
      }
    } else if (focused) {
      this.sendForeground(frame.agentId, filePath, event)
      if (agent && event.type === 'state_changed' && (event.loop ?? 'main') === 'main') {
        agent.lastForegroundState = String((event.payload as { state?: unknown })?.state)
      }
      if (event.type === 'state_changed') this.maybeRefreshAfterTurn(frame.agentId, event)
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

  /** The state change that settles ended turns (their ends arrive as `turn` frames). */
  private trackTurns(frame: ExecutorFrame): void {
    const { event } = frame
    if (event.type !== 'state_changed') return
    const loop = event.loop ?? 'main'
    const busy = toDisplayState(String((event.payload as { state?: unknown })?.state)) === 'active'
    for (const turn of this.ended.values()) {
      if (turn.agentId === frame.agentId && turn.loop === loop) turn.settled = true
    }
    for (const w of [...this.waiters]) {
      if (w.agentId !== frame.agentId || w.loop !== loop) continue
      if (w.ended) w.resolve(w.ended)
      else if (w.lenient && !busy) w.resolve('gap')
    }
  }

  /** A focused loop that was mid-turn at the last resync left its busy state: its chat as the daemon has it now. */
  private maybeRefreshAfterTurn(agentId: string, event: AgentExecutionEvent): void {
    const loop = event.loop ?? 'main'
    const key = `${agentId}\0${loop}`
    if (!this.refreshAfterTurn.has(key)) return
    if (toDisplayState(String((event.payload as { state?: unknown })?.state)) === 'active') return
    this.refreshAfterTurn.delete(key)
    const client = this.deps.client()
    if (!client) return
    void this.sendChatUpdated(client, agentId, loop).catch((err) => {
      this.log.warn(`[Backend] Could not refresh the chat after the turn: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private async sendChatUpdated(client: DaemonClient, agentId: string, loop: string): Promise<void> {
    const chat = await client.request<{ chatHistory: { uiLog: unknown[]; earlierCount?: number } | null }>(
      'GET', `/agents/${encodeURIComponent(agentId)}/chat`, { query: { limit: LOOP_DISPLAY_LIMIT, ...(loop === 'main' ? {} : { loop }) } })
    if (!this.deps.session.isFocused(agentId, null)) return
    this.deps.output.send(IPC.AGENT_EVENT, {
      type: 'chat_updated',
      payload: { uiLog: chat.chatHistory?.uiLog ?? [], earlierCount: chat.chatHistory?.earlierCount ?? 0 },
      timestamp: this.now(),
      ...(loop === 'main' ? {} : { loop }),
    })
  }

  /**
   * Embedded's notifyAdfFileCreated: the tracked directory that covers the
   * new file is rescanned; a file outside every tracked directory has its
   * folder tracked (the daemon owns the list, POST /tracked-dirs).
   */
  private async adfFileCreated(filePath: string): Promise<void> {
    const client = this.deps.client()
    if (!client) return
    try {
      const dirPath = dirname(filePath)
      const { directories } = await client.request<{ directories: Array<string | { path: string }> }>('GET', '/tracked-dirs')
      const roots = (directories ?? []).map((d) => (typeof d === 'string' ? d : d.path)).filter((d): d is string => !!d)
      const within = (parent: string, child: string): boolean => {
        const p = pathKey(parent)
        const c = pathKey(child)
        return c === p || c.startsWith(p.endsWith('/') || p.endsWith('\\') ? p : `${p}${p.includes('\\') ? '\\' : '/'}`)
      }
      const parent = roots.find((root) => within(root, dirPath))
      if (parent) {
        this.deps.output.send(IPC.TRACKED_DIRS_CHANGED, { dirPath: parent })
        return
      }
      await client.request('POST', '/tracked-dirs', { body: { path: dirPath } })
      this.log.log(`[Backend] Tracking ${dirPath}: an agent created ${filePath} there`)
      this.deps.output.send(IPC.TRACKED_DIRS_CHANGED, { dirPath })
    } catch (err) {
      this.log.warn(`[Backend] Could not refresh the tracked folders for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * A turn ended. Normally the loop is still busy and its next state change
   * settles the wait; when the end arrives with the loop already idle (the
   * executor's give-up recovery sets idle before it emits `error`), no state
   * change follows, so it settles now.
   */
  private markEnded(turnId: string, agentId: string, loop: string, outcome: EndOutcome): void {
    const key = turnKey(agentId, turnId)
    const settled = outcome === 'discarded' || !this.loopBusy(agentId, loop)
    this.ended.delete(key)
    this.ended.set(key, { agentId, loop, outcome, settled })
    while (this.ended.size > ENDED_TURNS_KEPT) this.ended.delete(this.ended.keys().next().value!)
    for (const w of [...this.waiters]) {
      if (w.turnId !== turnId || w.agentId !== agentId) continue
      if (settled) w.resolve(outcome)
      else w.ended = outcome
    }
  }

  /** The loop's current display state (the background mapping folds every agent's state changes) is busy. */
  private loopBusy(agentId: string, loop: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    const state = loop === 'main' ? agent.mapping.state : agent.mapping.loopStates.get(loop)
    return state === 'active'
  }

  private onTurn(frame: TurnFrame): void {
    if (frame.outcome === 'discarded') {
      for (const id of [...frame.turnIds, ...frame.unansweredTurnIds]) this.markEnded(id, frame.agentId, 'main', 'discarded')
      return
    }
    for (const id of frame.turnIds) this.markEnded(id, frame.agentId, frame.loop ?? 'main', frame.outcome)
  }

  private onHost(frame: HostFrame): void {
    // RuntimeService emitted the `error` executor event for these already
    // (W1-A); embedded shows that one error, so nothing is added (D5.1).
    if (frame.type === 'trigger_error' || frame.type === 'startup_failed') return
    const agent = frame.agentId ? this.agentFor(frame.agentId, frame.filePath) : null
    const filePath = agent?.filePath ?? frame.filePath
    if (!filePath) {
      this.log.warn(`[Backend] Host event ${frame.type} for agent ${frame.agentId} with no known file; not shown`)
      return
    }
    const focused = this.deps.session.isFocused(frame.agentId, filePath)

    if (frame.type === 'agent_started' && agent) {
      if (typeof frame.payload.handle === 'string') agent.handle = frame.payload.handle
      if (typeof frame.payload.state === 'string') agent.mapping.state = frame.payload.state as AgentState
      // The open file's agent was started elsewhere (CLI, another client):
      // the session learns its id, so its contents and events follow.
      if (focused && frame.agentId) this.deps.session.noteAgent(filePath, frame.agentId)
    }
    const stopped = frame.type === 'agent_stopped' || frame.type === 'agent_start_failed'
    if (stopped && frame.agentId) {
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
    this.sendForeground(agent.agentId, agent.filePath, { type: 'state_changed', payload: { state: 'stopped' }, timestamp })
  }

  private onPush(frame: PushFrame): void {
    const route = PUSH_TOPICS[frame.topic]
    if (!route) {
      this.log.warn(`[Backend] Unknown push topic ${String(frame.topic)}; not shown`)
      return
    }
    if (route.action === 'adf_file_created') {
      const created = (frame.payload as { filePath?: unknown })?.filePath
      if (typeof created === 'string') void this.adfFileCreated(created)
      return
    }
    if (route.action === 'notice') {
      const p = frame.payload as { holding?: unknown; reason?: unknown; sessions?: unknown }
      const clients = typeof p?.sessions === 'number' ? `${p.sessions} other client${p.sessions === 1 ? ' is' : 's are'}` : 'other clients are'
      const text = p?.holding === true
        ? `The ADF daemon keeps running while ${clients} connected, and stops when the last one closes.${typeof p.reason === 'string' ? ` (${p.reason})` : ''}`
        : `The ADF daemon no longer stops when the other clients close.${typeof p?.reason === 'string' ? ` (${p.reason})` : ''}`
      this.log.log(`[Backend] ${text}`)
      if (p?.holding === true) this.deps.onNotice?.(text)
      return
    }
    if (route.action === 'rekey') {
      const p = frame.payload as { oldFilePath?: unknown; filePath?: unknown }
      if (typeof p?.oldFilePath === 'string' && typeof p.filePath === 'string') {
        this.deps.onFileRenamed?.(p.oldFilePath, p.filePath)
        for (const agent of this.agents.values()) if (samePath(agent.filePath, p.oldFilePath)) agent.filePath = p.filePath
      }
      return
    }
    if (!route.channel) return
    if (route.focusedAgentEvent) {
      // Embedded: the open file's agent only, as an executor event (meshManager 'foreground_incoming').
      if (frame.stripped || !this.deps.session.isFocused(frame.agentId ?? null, frame.filePath ?? null)) return
      this.deps.output.send(route.channel, { type: frame.topic, payload: frame.payload, timestamp: this.now() })
      return
    }
    if (route.openFileOnly && !this.deps.session.isFocused(frame.agentId ?? null, frame.filePath ?? null)) return
    if (route.openFileOnly && frame.stripped) return
    if (frame.topic === 'file_renamed') {
      const p = frame.payload as { oldPath?: unknown; newPath?: unknown }
      if (typeof p?.oldPath === 'string' && typeof p.newPath === 'string') {
        this.deps.onFileRenamed?.(p.oldPath, p.newPath)
        for (const agent of this.agents.values()) if (agent.filePath === p.oldPath) agent.filePath = p.newPath
      }
    }
    if (frame.topic === 'approvals') this.deps.onApprovals?.(frame.payload as NotificationsSnapshot)
    const args = frame.payload === undefined || route.noPayload ? [] : [frame.payload]
    if (route.allWindows) this.deps.output.sendAll(route.channel, ...args)
    else this.deps.output.send(route.channel, ...args)
    this.settlePushWaits(frame)
  }

  /**
   * Resolves true once a push of `topic` whose payload `match`es has reached
   * the window, false after `timeoutMs`. A handler whose embedded twin sends
   * the push before it answers (a rename applied at stop, a relocate on
   * review accept) registers before its request and awaits it before
   * answering, so the renderer sees the same order. Register first: the push
   * can arrive before the HTTP answer.
   */
  awaitPush(topic: PushTopic, match: (payload: unknown) => boolean, timeoutMs = 5_000): { done: Promise<boolean>; cancel(): void } {
    let settle!: (seen: boolean) => void
    const done = new Promise<boolean>((resolve) => { settle = resolve })
    const wait = { topic, match, settle: (seen: boolean) => { clearTimeout(timer); this.pushWaits.delete(wait); settle(seen) } }
    const timer = setTimeout(() => wait.settle(false), timeoutMs)
    timer.unref?.()
    this.pushWaits.add(wait)
    return { done, cancel: () => wait.settle(false) }
  }

  private readonly pushWaits = new Set<{ topic: PushTopic; match: (payload: unknown) => boolean; settle: (seen: boolean) => void }>()

  private settlePushWaits(frame: PushFrame): void {
    for (const wait of [...this.pushWaits]) {
      if (wait.topic !== frame.topic) continue
      let hit = false
      try { hit = wait.match(frame.payload) } catch { hit = false }
      if (hit) wait.settle(true)
    }
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
      // Waits whose end may have been lost: settled now when their loop is not busy.
      for (const w of [...this.waiters]) {
        if (!w.lenient) continue
        const status = statuses.find((s) => s.id === w.agentId)
        if (!status) w.resolve('stopped')
        else if (w.loop === 'main' && toDisplayState(String(status.runtimeState)) !== 'active') w.resolve('gap')
      }
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
          // Its frames were lost, though: refresh once the turn settles.
          const busy = name === 'main' ? agent?.mapping.state === 'active' : agent?.mapping.loopStates.get(name) === 'active'
          if (busy) {
            this.refreshAfterTurn.add(`${focusedId}\0${name}`)
            continue
          }
          await this.sendChatUpdated(client, focusedId, name)
        }
      })
      await step('focused config', async () => {
        const { config, revision } = await client.request<{ config: unknown; revision?: number }>('GET', `/agents/${encodeURIComponent(focusedId)}/config`)
        // W3-F: the revision the config panel saves over from now on (a resync names no writer).
        this.deps.output.send(IPC.DOC_AGENT_CONFIG_CHANGED, { filePath: focusedPath, config, ...(revision !== undefined ? { revision } : {}) })
      })
    } else if (focusedPath) {
      this.log.warn('[Backend] Resync: the open file has no agent id in the daemon; its chat and config are read when it opens again')
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
