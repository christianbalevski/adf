// The TUI store: reducer + effects + React bindings.
//
// One store per TUI process. It owns the daemon client and the SSE stream,
// ingests every event exactly once, and exposes `actions` — the only way views
// and commands change anything. Every action that talks to the daemon reports
// its outcome visibly (transcript item or toast); nothing fails silently.

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { randomUUID } from 'node:crypto'
import * as commandRulesNs from '../../../shared/utils/agent-commands'
import { cjs } from '../interop'
import type { AskAnswer } from '../../../shared/utils/ask-form'
const { parseAuthorizeToken } = cjs(commandRulesNs)

/**
 * The oldest client API whose sessions this app reads. Version 2 added turn
 * ids to executor frames and the `turn` frame, which the terminal app does
 * not use (it reads umbilical frames), so a version-1 daemon still gets a
 * session. Studio stays strict (client-stream.ts).
 */
export const TUI_MIN_CLIENT_API_VERSION: number = 1
import type { DaemonClient } from '../api/client'
import type { ConnectionInfo, EventStream, ResumeInfo, StreamGap } from '../api/sse'
import {
  DaemonError,
  SUPPORTED_CLIENT_API_VERSION,
  type ClientFrame,
  MAIN_LOOP,
  type AgentConfig,
  type AgentCreateInput,
  type AgentCreateResult,
  type DaemonEventFrame,
  type IdentityCreateResult,
  type IdentityStatus,
  type SubscriptionProvider,
  type TemplateListResult,
  type DisplayState,
  type LoopCreateInput,
  type LoopCreateResult,
  type LoopDeleteResult,
  type LoopPatch,
  type LoopUpdateResult,
  type TaskAction,
  type TimerInput,
} from '../api/types'
import { initialState, tuiReducer, eventLoop, type TuiAction } from './reducer'
import { localId, unresolvedTasks } from './transcript'
import { clientFrameEffects, TUI_CLIENT_NAME } from './client-stream'
import {
  transcriptKey,
  type FocusZone,
  type ContextItem,
  type Overlay,
  type ToastLevel,
  type TranscriptKey,
  type TuiState,
  type UserItem,
  type WebState,
} from './types'
import { bindsAll, parseLan, parseMeshAgents, parseServer, serverText } from '../web/model'
import { findTracked, isTrackedKey, loadedIdForPath, trackedPath } from './tracked'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm action as destructive. */
  danger?: boolean
}

export interface TuiActions {
  // fleet
  refreshAgents(): Promise<void>
  refreshAgent(agentId: string): Promise<void>
  refreshLoops(agentId: string): Promise<void>
  refreshHil(agentId: string): Promise<void>
  loadConfig(agentId: string): Promise<AgentConfig | undefined>
  startAgent(agentId: string): Promise<void>
  stopAgent(agentId: string): Promise<void>
  /** End a loop's running turn and leave it idle (default: the selected agent + its selected loop). Esc in chat. */
  interrupt(agentId?: string, loop?: string): Promise<void>
  /** Hard abort: the daemon leaves that loop's executor stopped until the agent is reloaded. */
  abort(agentId?: string, loop?: string): Promise<void>
  setDisplayState(agentId: string, state: DisplayState): Promise<void>
  loadAgentFile(filePath: string): Promise<void>
  /** Re-read the tracked folders' agents (GET /tracked-dirs/agents/all) into `state.tracked`. Quiet on failure (the state keeps the error). */
  refreshTracked(): Promise<void>
  /**
   * Load a not-loaded tracked agent (`file:<path>` key), then start it
   * (`start`, default true; false starts it only when it is set to
   * autostart). An unreviewed agent opens its review (the folder dialog)
   * instead. Reports the outcome; returns the loaded agent id, else null.
   */
  startTracked(key: string, options?: { start?: boolean }): Promise<string | null>

  /** Switch to another daemon: health-checks it first, then drops this daemon's agents and transcripts and resubscribes. */
  setDaemonUrl(url: string, token?: string): Promise<boolean>

  // selection / shell
  selectAgent(agentId: string | null): void
  selectLoop(agentId: string, loop: string): void
  setView(view: string): void
  setFocus(focus: FocusZone): void
  pushOverlay(overlay: Omit<Overlay, 'id'> & { id?: string }): string
  popOverlay(id?: string): void
  /** Ask the user; resolves true on confirm. Rendered by the shell's overlay host. */
  confirm(options: ConfirmOptions): Promise<boolean>
  toast(text: string, level?: ToastLevel, ttlMs?: number): void
  dismissToast(id: string): void
  setViewState(view: string, value: unknown): void
  /** Put text in the shell prompt and focus it (e.g. a palette entry for a command that needs args). */
  prefillPrompt(text: string): void
  /** A local notice in (agent, loop)'s transcript: what the owner did to it, shown where it happened. */
  notice(agentId: string, loop: string, text: string, level?: 'info' | 'warn'): void

  // conversation (loop-aware; defaults to the selected agent + loop)
  ensureTranscript(agentId: string, loop: string): Promise<void>
  loadTranscript(agentId: string, loop: string): Promise<void>
  loadOlder(agentId: string, loop: string): Promise<void>
  sendChat(text: string, target?: { agentId?: string; loop?: string }): Promise<boolean>
  /** Run an owner command without starting an agent or creating a model turn. */
  runAgentCommand(agentId: string, loop: string, name: string, rawArgs: string): Promise<void>
  clearLoopHistory(agentId: string, loop: string): Promise<void>
  /** Compact a loop's history now (refused by the daemon mid-turn). */
  compactLoop(agentId: string, loop: string): Promise<boolean>

  // loops
  createLoop(agentId: string, input: LoopCreateInput): Promise<LoopCreateResult | undefined>
  updateLoop(agentId: string, name: string, patch: LoopPatch): Promise<LoopUpdateResult | undefined>
  setLoopEnabled(agentId: string, name: string, enabled: boolean): Promise<void>
  deleteLoop(agentId: string, name: string): Promise<LoopDeleteResult | undefined>
  /** Schedule a loop on a timer (`loop` absent = main). */
  scheduleLoop(agentId: string, input: TimerInput): Promise<number | undefined>

  // HIL
  resolveTask(agentId: string, taskId: string, action: TaskAction, reason?: string): Promise<void>
  /** "Always approve": un-restrict the tool for this agent (persistent) and approve this call. The daemon refuses protection overrides. */
  alwaysApproveTask(agentId: string, taskId: string): Promise<boolean>
  /** Approve every pending gated call (never protection overrides) of the agent, or of one loop. */
  approveAllTasks(agentId: string, loop?: string): Promise<void>
  /** Send an ask's answers, one per question (`null` = skipped). */
  answerAsk(agentId: string, requestId: string, answers: AskAnswer[], loop?: string): Promise<void>
  respondSuspend(agentId: string, resume: boolean): Promise<void>

  /** Re-read `GET /runtime/auth` (ChatGPT / Grok / Claude sign-in) into `state.auth`. Quiet on failure. */
  refreshAuth(): Promise<void>
  /** Sign the daemon out of a subscription provider (toast), then refresh. */
  logoutSubscription(provider: SubscriptionProvider): Promise<boolean>

  /** Re-read the mesh web server + what each agent serves (`GET /network/mesh`) into `state.web`. Quiet on failure. */
  refreshWeb(): Promise<WebState | null>
  /** Start / stop the web server (no confirm here: callers ask before stopping); toasts the resulting state. */
  setWebServer(on: boolean): Promise<boolean>

  // owner identity + agent creation. Dialogs show these failures inline, so
  // they come back as an Outcome (with the daemon's `code`), not a toast.
  // The seed phrase is returned to the caller of createIdentity only: it never
  // enters state, a toast, a transcript or a log.
  /** Re-read `GET /identity` into `state.identity` (null when the daemon has no identity routes). */
  refreshIdentity(): Promise<IdentityStatus | null>
  createIdentity(passphrase?: string): Promise<Outcome<IdentityCreateResult>>
  restoreIdentity(mnemonic: string, passphrase?: string): Promise<Outcome<IdentityStatus>>
  unlockIdentity(passphrase: string): Promise<Outcome<IdentityStatus>>
  lockIdentity(): Promise<Outcome<IdentityStatus>>
  confirmIdentityBackup(): Promise<Outcome<IdentityStatus>>
  listTemplates(): Promise<Outcome<TemplateListResult>>
  /** Create (and optionally start) an agent; on success it is selected. */
  createAgent(input: AgentCreateInput): Promise<Outcome<AgentCreateResult>>

  /**
   * Run any daemon call with the store's error policy: failures become an
   * error toast (and are returned as undefined), never an unhandled rejection.
   */
  run<T>(label: string, fn: (client: DaemonClient) => Promise<T>): Promise<T | undefined>
}

/** Result of a call whose failure the caller shows itself (dialogs). */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string; status: number | null; body?: unknown }

export interface TuiStore {
  /** The current daemon client (replaced by `actions.setDaemonUrl`). */
  readonly client: DaemonClient
  readonly actions: TuiActions
  getState(): TuiState
  dispatch(action: TuiAction): void
  subscribe(listener: () => void): () => void
  /** Initial snapshot + live events. Resolves once the first agent list attempt settles. */
  start(): Promise<void>
  stop(): void
  /** stop(), then end the client session at the daemon (bounded wait). */
  close(): Promise<void>
  /** How live events arrive: `session` (client session stream), `events` (GET /events), or `none` yet. */
  readonly liveMode: 'session' | 'events' | 'none'
  /** Resolve a pending confirm overlay (called by the overlay host). */
  resolveConfirm(id: string, confirmed: boolean): void
}

export interface CreateStoreOptions {
  client: DaemonClient
  initialView?: string
  /** Subscribe to live events. Default true. */
  live?: boolean
  /**
   * Live events over a client session (GET /client/sessions/:id/events) when
   * the daemon has them; false: always GET /events. Default true.
   */
  clientSessions?: boolean
  /** Version sent when opening the client session (the daemon logs it). Default ADF_VERSION, else 'dev'. */
  clientVersion?: string
  /** Loop rows per history page. Default 100. */
  pageSize?: number
}

const REFRESH_DEBOUNCE_MS = 120
/** After agent load / config events: the daemon starts its web server ~500ms after agents register. */
const WEB_EVENT_DEBOUNCE_MS = 900
/** How long a resumed stream waits for stream.hello before resyncing anyway (older daemon). */
const RESUME_VERDICT_MS = 1500
const WEB_POLL_MS = 20_000
/** Tracked folders' agents: Studio or the file system may add / remove .adf files; no event says so. Cheap (the daemon caches peeks by mtime). */
const TRACKED_POLL_MS = 15_000
/** The overlay kind of the fleet's folder-agents dialog (views/fleet/folders.ts TRACK_OVERLAY). */
const FOLDER_OVERLAY = 'fleet.track'

/** viewState slot the shell prompt watches for `prefillPrompt`. */
export const PROMPT_PREFILL_KEY = 'shell.prompt.prefill'

const CHAT_VIEW_ID = 'chat'

export function createTuiStore(options: CreateStoreOptions): TuiStore {
  /**
   * This daemon's client. Once a client session is open it names the session
   * on every request (X-ADF-Client-Session), so the daemon records the TUI's
   * writes as `client:tui` and does not echo them back on its stream.
   */
  let client = options.client
  /** The same daemon without the session header: sessions open and end through it, other daemons derive from it. */
  let plain = options.client
  /** `plain` and its session-named copies: a read started through one of them is not stale. */
  let current = new WeakSet<DaemonClient>([client])
  const pageSize = options.pageSize ?? 100
  let state = initialState(client.baseUrl, options.initialView)
  // Explicit selection changes invalidate a pending start's auto-selection;
  // reducer reconciliation from a tracked path to a loaded ID does not.
  let selectionRevision = 0
  const listeners = new Set<() => void>()
  const confirmResolvers = new Map<string, (value: boolean) => void>()
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const debounced = new Map<string, ReturnType<typeof setTimeout>>()
  /** Destructive loop events invalidate reads started before their boundary. */
  const historyGenerations = new Map<TranscriptKey, number>()
  let stream: EventStream<DaemonEventFrame> | EventStream<ClientFrame> | null = null
  /** The open client session (design D5), or null on the /events path. */
  let sessionId: string | null = null
  /** The /events path was taken; said once per store. */
  let fallbackNoticed = false
  /** The daemon was unreachable when the session was first tried: try again once it answers. */
  let sessionRetry = false
  let reopening = false
  /** The focus last confirmed by the daemon (undefined: none sent on this session yet). */
  let focusSent: string | null | undefined
  let focusInFlight = false
  let focusRetryAt = 0
  /** When the last resync started: a resume verdict and its stream.gap trigger one, not two. */
  let lastResyncAt = 0
  let webTick: ReturnType<typeof setInterval> | null = null
  let trackedTick: ReturnType<typeof setInterval> | null = null
  let stopped = false
  /** Set when the daemon was unreachable; the next successful open resyncs. */
  let needsResync = false
  /** Fallback resync for a daemon that never says how a resume went (no stream.hello). */
  let resumeFallback: ReturnType<typeof setTimeout> | null = null

  const getState = () => state
  const dispatch = (action: TuiAction) => {
    const next = tuiReducer(state, action)
    if (next === state) return
    if (action.type === 'select/agent') selectionRevision++
    state = next
    for (const listener of listeners) listener()
    // The session follows the agent whose chat view is open.
    if (sessionId && desiredFocus() !== focusSent) void syncFocus()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const debounce = (key: string, fn: () => void, ms = REFRESH_DEBOUNCE_MS) => {
    const existing = debounced.get(key)
    if (existing) clearTimeout(existing)
    debounced.set(key, setTimeout(() => { debounced.delete(key); if (!stopped) fn() }, ms))
  }

  const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

  const toast = (text: string, level: ToastLevel = 'info', ttlMs = level === 'error' ? 8000 : 4000) => {
    const id = localId('t')
    dispatch({ type: 'toast/add', toast: { id, level, text, at: Date.now(), ttlMs } })
    if (ttlMs > 0) {
      toastTimers.set(id, setTimeout(() => { toastTimers.delete(id); dispatch({ type: 'toast/dismiss', id }) }, ttlMs))
    }
  }

  const run = async <T,>(label: string, fn: (c: DaemonClient) => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn(client)
    } catch (err) {
      if (err instanceof DaemonError && err.unreachable) dispatch({ type: 'daemon/reachable', reachable: false })
      toast(`${label}: ${describe(err)}`, 'error')
      return undefined
    }
  }

  const selectedLoopOf = (agentId: string) => state.selectedLoop[agentId] ?? MAIN_LOOP
  /** Reads started against a daemon we have since switched away from are dropped. */
  const stale = (c: DaemonClient) => !current.has(c)
  /**
   * After a history load: a backgrounded call shown running is settled from
   * its task row once that task is done (its tool.completed may have come
   * while this app was not listening). Still running: it stays so, and its
   * tool.completed settles it. Unreachable: left for the next load.
   */
  const settleBackgroundTasks = (c: DaemonClient, agentId: string, key: TranscriptKey) => {
    for (const { toolUseId, taskId } of unresolvedTasks(state.transcripts[key]?.items ?? [])) {
      c.task(agentId, taskId).then(
        result => { if (!stale(c)) dispatch({ type: 'tool/task', key, toolUseId, task: result.task }) },
        err => { if (!stale(c) && err instanceof DaemonError && err.status === 404) dispatch({ type: 'tool/task', key, toolUseId, task: null }) },
      )
    }
  }
  /** Requests name session `id` from now on (null: none). */
  const useSession = (id: string | null) => {
    client = id ? plain.withClientSession(id) : plain
    current.add(client)
  }

  const actions: TuiActions = {
    async setDaemonUrl(url, token) {
      const next = plain.withBaseUrl(url, token)
      if (next.baseUrl === client.baseUrl && token === undefined) {
        toast(`Already connected to ${next.baseUrl}`, 'info')
        return true
      }
      if (client.hasToken && !next.hasToken) toast(`Not sending this daemon's token to ${next.baseUrl}; use /url <url> --token <token> if it needs one`, 'warn', 6000)
      toast(`Checking ${next.baseUrl}…`, 'info', 2000)
      try {
        await next.health()
      } catch (err) {
        toast(`Not switching: ${next.baseUrl} is not answering (${describe(err)}). Still on ${client.baseUrl}.`, 'error')
        return false
      }
      const previous = client.baseUrl
      stream?.close()
      stream = null
      endSession(client)
      for (const timer of debounced.values()) clearTimeout(timer)
      debounced.clear()
      client = next
      plain = next
      current = new WeakSet([next])
      historyGenerations.clear()
      dispatch({ type: 'daemon/switch', url: next.baseUrl })
      toast(`Switched from ${previous} to ${next.baseUrl} — agents on the old daemon keep running`, 'success', 6000)
      await start()
      return true
    },

    async refreshAgents() {
      const c = client
      try {
        const agents = await c.agents()
        if (stale(c)) return
        dispatch({ type: 'daemon/reachable', reachable: true })
        dispatch({ type: 'agents/loaded', agents })
        await Promise.all(agents.map(agent => actions.refreshAgent(agent.id)))
        const selected = state.selectedAgentId
        if (selected && !isTrackedKey(selected)) await actions.ensureTranscript(selected, selectedLoopOf(selected))
      } catch (err) {
        if (stale(c)) return
        dispatch({ type: 'daemon/reachable', reachable: !(err instanceof DaemonError && err.unreachable) })
        toast(`Agents: ${describe(err)}`, 'error')
      }
    },

    async refreshAgent(agentId) {
      const c = client
      await Promise.all([
        c.status(agentId)
          .then(status => { if (!stale(c)) dispatch({ type: 'agent/status', agentId, status }) })
          .catch(err => { if (!stale(c)) dispatch({ type: 'agent/error', agentId, error: describe(err) }) }),
        actions.refreshLoops(agentId),
        actions.refreshHil(agentId),
        c.config(agentId)
          .then(result => { if (!stale(c)) dispatch({ type: 'agent/config', agentId, config: result.config }) })
          .catch(() => { /* status carries the agent's error state */ }),
      ])
    },

    async refreshLoops(agentId) {
      const c = client
      try {
        const result = await c.loops(agentId)
        if (!stale(c)) dispatch({ type: 'loops/loaded', agentId, loops: result.loops })
      } catch (err) {
        if (!stale(c)) dispatch({ type: 'loops/error', agentId, error: describe(err) })
      }
    },

    async refreshHil(agentId) {
      const c = client
      try {
        const [tasks, asks] = await Promise.all([
          c.tasks(agentId, { status: 'pending_approval' }),
          c.asks(agentId),
        ])
        if (stale(c)) return
        dispatch({ type: 'hil/loaded', agentId, tasks: tasks.tasks, asks: asks.asks })
      } catch {
        // HIL counts are advisory; the agent entry shows its own error state.
      }
    },

    async loadConfig(agentId) {
      const c = client
      const result = await run('Config', cl => cl.config(agentId))
      if (stale(c)) return undefined
      if (result) dispatch({ type: 'agent/config', agentId, config: result.config })
      return result?.config
    },

    async startAgent(agentId) {
      const result = await run('Start', c => c.start(agentId))
      if (result) toast(`Started ${agentLabel(agentId)}${result.startupTriggered ? ' (startup turn running)' : ''}`, 'success')
      await actions.refreshAgent(agentId)
    },

    async stopAgent(agentId) {
      const result = await run('Stop', c => c.stop(agentId))
      if (result) toast(`Stopped ${agentLabel(agentId)}`, 'success')
      await actions.refreshAgents()
    },

    async interrupt(agentId, loop) {
      const id = agentId ?? state.selectedAgentId
      if (!id) return
      const target = loop ?? selectedLoopOf(id)
      const result = await run('Interrupt', c => c.interrupt(id, target))
      if (!result) return
      const key = transcriptKey(id, target)
      dispatch({ type: 'transcript/idle', key })
      if (result.interrupted === false) toast(`Nothing running in ${target}`, 'info', 2500)
      else dispatch({ type: 'transcript/append', key, item: { id: localId(), at: Date.now(), local: true, kind: 'notice', level: 'warn', text: 'Turn interrupted by you — loop is idle' } })
      debounce(`loops:${id}`, () => { void actions.refreshLoops(id) })
    },

    async abort(agentId, loop) {
      const id = agentId ?? state.selectedAgentId
      if (!id) return
      const target = loop ?? selectedLoopOf(id)
      const result = await run('Abort', c => c.abort(id, target))
      if (result) {
        const key = transcriptKey(id, target)
        dispatch({ type: 'transcript/idle', key })
        dispatch({ type: 'transcript/append', key, item: { id: localId(), at: Date.now(), local: true, kind: 'notice', level: 'warn', text: 'Turn aborted by you — loop stopped until the agent is reloaded' } })
      }
    },

    async setDisplayState(agentId, displayState) {
      const result = await run('State', c => c.setState(agentId, displayState))
      if (result) toast(`${agentLabel(agentId)} → ${displayState}`, 'success')
      await actions.refreshAgent(agentId)
    },

    async loadAgentFile(filePath) {
      const ref = await run('Load', c => c.load(filePath))
      if (ref) {
        toast(`Loaded ${ref.config?.name ?? filePath}`, 'success')
        await actions.refreshAgents()
        actions.selectAgent(ref.id)
      }
    },

    async refreshTracked() {
      const c = client
      try {
        const list = await c.trackedAgents()
        if (!stale(c)) dispatch({ type: 'tracked/loaded', list })
      } catch (err) {
        if (stale(c)) return
        // No settings store / an old daemon: no tracked list, nothing to show.
        if (err instanceof DaemonError && (err.status === 404 || err.status === 503)) {
          if (!state.tracked) dispatch({ type: 'tracked/loaded', list: { maxDepth: 0, folders: [] } })
          return
        }
        dispatch({ type: 'tracked/error', error: describe(err) })
      }
    },

    async startTracked(key, options = {}) {
      const entry = findTracked(state, key)
      if (!entry) {
        const loadedId = isTrackedKey(key) ? loadedIdForPath(state, trackedPath(key)) : key
        if (loadedId && state.agents[loadedId]) return loadedId
        toast('That agent is no longer in a tracked folder (r refreshes)', 'warn')
        return null
      }
      const { agent, folder } = entry
      const filePath = agent.filePath
      if (state.tracked?.busy[filePath]) return null
      if (agent.status === 'unreadable') {
        toast(`${agent.name}: ${agent.error ?? 'not a readable .adf'}`, 'error', 6000)
        return null
      }
      if (agent.status === 'password_protected') {
        toast(`${agent.name}: its identity is password-protected. Load it with /load ${filePath} and unlock it`, 'warn', 8000)
        return null
      }
      const review = () => {
        toast(`${agent.name} has not been reviewed on this daemon: review it first`, 'warn', 5000)
        actions.pushOverlay({ kind: FOLDER_OVERLAY, props: { folder, review: filePath } })
        return null
      }
      if (agent.status === 'needs_review') return review()
      const start = options.start ?? true
      const selectionAtStart = selectionRevision
      const c = client
      dispatch({ type: 'tracked/busy', filePath, busy: 'loading' })
      dispatch({ type: 'tracked/file-error', filePath, error: undefined })
      let ref
      try {
        ref = await c.load(filePath, true)
      } catch (err) {
        dispatch({ type: 'tracked/busy', filePath, busy: undefined })
        if (err instanceof DaemonError && err.unreachable) dispatch({ type: 'daemon/reachable', reachable: false })
        if (err instanceof DaemonError && err.status === 403) return review()
        const error = describe(err)
        dispatch({ type: 'tracked/file-error', filePath, error })
        toast(`Load ${agent.name}: ${error}`, 'error', 8000)
        return null
      }
      const name = ref.config?.handle || ref.config?.name || agent.name
      let started = ''
      let level: ToastLevel = 'success'
      if (start || agent.autostart) {
        dispatch({ type: 'tracked/busy', filePath, busy: 'starting' })
        try {
          const result = await c.start(ref.id)
          started = ` and started it${result.startupTriggered ? ' (startup turn running)' : ''}`
        } catch (err) {
          started = ` (start failed: ${describe(err)})`
          level = 'warn'
        }
      }
      dispatch({ type: 'tracked/busy', filePath, busy: undefined })
      if (stale(c)) return null
      const text = `Loaded ${name}${started}`
      toast(text, level, 5000)
      const selectedBefore = state.selectedAgentId
      const wasSelected = selectedBefore === key || selectedBefore === entry.key
      await actions.refreshAgents()
      void actions.refreshTracked()
      // The refresh already maps this file's tracked row to its loaded id. A
      // selection that moved anywhere else while it ran is the owner's: never
      // take it back (it used to, whenever the owner picked a stopped row).
      const current = state.selectedAgentId
      const untouched = current === selectedBefore || current === ref.id
      if (selectionRevision === selectionAtStart && untouched && (wasSelected || !selectedBefore || isTrackedKey(selectedBefore)) && state.agents[ref.id]) actions.selectAgent(ref.id)
      actions.notice(ref.id, MAIN_LOOP, text, level === 'success' ? 'info' : 'warn')
      return ref.id
    },

    selectAgent(agentId) {
      dispatch({ type: 'select/agent', agentId })
      if (isTrackedKey(agentId)) return
      if (agentId) {
        void actions.ensureTranscript(agentId, selectedLoopOf(agentId))
        if (!state.agents[agentId]?.config) void actions.loadConfig(agentId)
      }
    },

    selectLoop(agentId, loop) {
      dispatch({ type: 'select/loop', agentId, loop })
      void actions.ensureTranscript(agentId, loop)
    },

    setView(view) {
      const changed = state.activeView !== view
      dispatch({ type: 'view/set', view })
      // Chat is a conversation: arriving there puts the caret in the composer,
      // so typed text never lands on transcript shortcuts (y approves). Every
      // other view is browsed: arriving there focuses its pane, or arrows and
      // digits would keep going to the composer (history, typed text).
      if (changed) dispatch({ type: 'focus/set', focus: view === CHAT_VIEW_ID ? 'input' : 'main' })
    },

    setFocus(focus) {
      dispatch({ type: 'focus/set', focus })
    },

    pushOverlay(overlay) {
      const id = overlay.id ?? localId('o')
      dispatch({ type: 'overlay/push', overlay: { ...overlay, id } })
      return id
    },

    popOverlay(id) {
      dispatch({ type: 'overlay/pop', id })
    },

    confirm(confirmOptions) {
      return new Promise<boolean>(resolve => {
        const id = localId('confirm')
        confirmResolvers.set(id, resolve)
        dispatch({ type: 'overlay/push', overlay: { id, kind: 'confirm', props: { ...confirmOptions } } })
      })
    },

    toast,

    dismissToast(id) {
      const timer = toastTimers.get(id)
      if (timer) clearTimeout(timer)
      toastTimers.delete(id)
      dispatch({ type: 'toast/dismiss', id })
    },

    setViewState(view, value) {
      dispatch({ type: 'viewState/set', view, value })
    },

    prefillPrompt(text) {
      dispatch({ type: 'viewState/set', view: PROMPT_PREFILL_KEY, value: { text, nonce: localId('p') } })
      dispatch({ type: 'focus/set', focus: 'input' })
    },

    notice(agentId, loop, text, level = 'info') {
      dispatch({ type: 'transcript/append', key: transcriptKey(agentId, loop), item: { id: localId('n'), at: Date.now(), local: true, kind: 'notice', level, text } })
    },

    async ensureTranscript(agentId, loop) {
      if (isTrackedKey(agentId)) return
      const t = state.transcripts[transcriptKey(agentId, loop)]
      if (t?.loaded || t?.loading) return
      await actions.loadTranscript(agentId, loop)
    },

    async loadTranscript(agentId, loop) {
      const key = transcriptKey(agentId, loop)
      const c = client
      const generation = historyGenerations.get(key) ?? 0
      dispatch({ type: 'transcript/loading', key })
      try {
        const page = await c.loopHistory(agentId, { loop, limit: pageSize })
        if (stale(c) || generation !== (historyGenerations.get(key) ?? 0)) return
        dispatch({ type: 'transcript/history', key, entries: page.entries, total: page.total, offset: page.offset, mode: 'replace' })
        settleBackgroundTasks(c, agentId, key)
      } catch (err) {
        if (!stale(c) && generation === (historyGenerations.get(key) ?? 0)) dispatch({ type: 'transcript/error', key, error: describe(err) })
      }
    },

    async loadOlder(agentId, loop) {
      const key = transcriptKey(agentId, loop)
      const t = state.transcripts[key]
      if (!t || t.loading || t.oldestOffset <= 0) return
      const offset = Math.max(0, t.oldestOffset - pageSize)
      const limit = t.oldestOffset - offset
      const c = client
      const generation = historyGenerations.get(key) ?? 0
      dispatch({ type: 'transcript/loading', key })
      try {
        const page = await c.loopHistory(agentId, { loop, limit, offset })
        if (stale(c) || generation !== (historyGenerations.get(key) ?? 0)) return
        dispatch({ type: 'transcript/history', key, entries: page.entries, total: page.total, offset: page.offset, mode: 'prepend' })
        settleBackgroundTasks(c, agentId, key)
      } catch (err) {
        if (!stale(c) && generation === (historyGenerations.get(key) ?? 0)) dispatch({ type: 'transcript/error', key, error: describe(err) })
      }
    },

    async sendChat(text, target = {}) {
      let agentId = target.agentId ?? state.selectedAgentId
      const trimmed = text.trim()
      if (!agentId || !trimmed) return false
      if (isTrackedKey(agentId)) {
        // A stopped agent: start it (the owner is talking to it), then send.
        const name = findTracked(state, agentId)?.agent.name ?? 'the agent'
        toast(`${name} is stopped: starting it to deliver your message`, 'info', 3000)
        const started = await actions.startTracked(agentId)
        if (!started) { toast(`Not sent: ${name} did not start (Ctrl+Up recalls your message)`, 'warn', 6000); return false }
        agentId = started
      }
      const loop = target.loop ?? selectedLoopOf(agentId)
      const key = transcriptKey(agentId, loop)
      const item: UserItem = { id: localId(), at: Date.now(), local: true, kind: 'user', text: trimmed, origin: 'owner', pending: true }
      dispatch({ type: 'transcript/append', key, item })
      try {
        const accepted = await client.chat(agentId, trimmed, loop)
        dispatch({ type: 'transcript/update', key, id: item.id, patch: { accepted: true, ...(accepted?.turnId ? { turnId: accepted.turnId } : {}) } })
        return true
      } catch (err) {
        dispatch({ type: 'transcript/update', key, id: item.id, patch: { pending: false } })
        dispatch({ type: 'transcript/append', key, item: { id: localId(), at: Date.now(), local: true, kind: 'error', text: `Not sent: ${describe(err)}` } })
        return false
      }
    },

    async runAgentCommand(agentId, loop, name, rawArgs) {
      const c = client
      if (isTrackedKey(agentId)) { toast(`Agent is off. Start it, then run /${name} again.`, 'warn'); return }
      // Validate before whitespace normalization can hide a multiline paste.
      if (rawArgs.includes('\n') || rawArgs.includes('\r') || rawArgs.length > 4096) {
        toast(`/${name}: arguments must be one line of at most 4096 characters.`, 'warn')
        return
      }
      const { args, authorize } = parseAuthorizeToken(rawArgs)
      const requestId = randomUUID()
      const key = transcriptKey(agentId, loop)
      const registered = state.agents[agentId]?.config?.commands
      const lambda = Array.isArray(registered) ? registered.find(command => command?.name === name)?.lambda : undefined
      const item: ContextItem = {
        id: `command:${requestId}`, at: Date.now(), local: true, kind: 'context', category: 'owner_command', text: '',
        ownerCommand: { v: 1, id: requestId, command: `/${name}${args ? ` ${args}` : ''}`, lambda: typeof lambda === 'string' ? lambda : '', authorized: authorize, status: 'running', duration_ms: 0 },
      }
      dispatch({ type: 'transcript/owner-command', key, item })
      try {
        const result = await c.runCommand(agentId, name, { args, authorize, loop, requestId })
        if (stale(c) || stopped) return
        dispatch({ type: 'transcript/owner-command', key, item: {
          ...item, seq: result.seq, text: result.result, deferred: result.deferred,
          unrecorded: !result.deferred && result.seq === undefined,
          ownerCommand: { ...item.ownerCommand!, authorized: result.authorized, status: result.status, duration_ms: result.durationMs },
        } })
        const label = `${agentLabel(agentId)} /${name} (${loop})`
        toast(`${label}: ${result.status === 'denied' ? 'permission denied; add !authorize for one authorized run' : result.status}${result.deferred ? ' — recording after the current step' : ''}`, result.status === 'ok' ? 'success' : result.status === 'denied' ? 'warn' : 'error')
      } catch (err) {
        if (stale(c) || stopped) return
        dispatch({ type: 'transcript/remove', key, id: item.id })
        if (err instanceof DaemonError && err.unreachable) dispatch({ type: 'daemon/reachable', reachable: false })
        toast(`/${name}: ${describe(err)}`, 'error')
      }
    },

    async clearLoopHistory(agentId, loop) {
      const result = await run('Clear', c => c.clearChat(agentId, loop))
      if (result) {
        dispatch({ type: 'transcript/reset', key: transcriptKey(agentId, loop) })
        toast(`Cleared ${loop} history`, 'success')
        await actions.refreshLoops(agentId)
      }
    },

    async compactLoop(agentId, loop) {
      const result = await run(`Compact ${loop}`, c => c.compact(agentId, loop))
      if (!result) return false
      toast(`Compacted ${loop} of ${agentLabel(agentId)}`, 'success')
      actions.notice(agentId, loop, 'History compacted by you')
      return true
    },

    async createLoop(agentId, input) {
      const result = await run('Create loop', c => c.createLoop(agentId, input))
      if (result) {
        const excluded = result.excludedTools.length ? ` (not granted yet: ${result.excludedTools.join(', ')})` : ''
        toast(`Loop ${input.name} created${result.kickoff?.woke ? ', running first turn' : ''}${excluded}`, 'success')
        await actions.refreshLoops(agentId)
      }
      return result
    },

    async updateLoop(agentId, name, patch) {
      const result = await run('Update loop', c => c.updateLoop(agentId, name, patch))
      if (result) {
        toast(`Loop ${name} updated: ${result.updated.join(', ')}`, 'success')
        await actions.refreshLoops(agentId)
      }
      return result
    },

    async setLoopEnabled(agentId, name, enabled) {
      const result = await run(enabled ? 'Enable loop' : 'Disable loop', c => c.setLoopEnabled(agentId, name, enabled))
      if (result) {
        toast(`Loop ${name} ${enabled ? 'enabled' : 'disabled'}`, 'success')
        await actions.refreshLoops(agentId)
      }
    },

    async deleteLoop(agentId, name) {
      const result = await run('Delete loop', c => c.deleteLoop(agentId, name))
      if (result) {
        toast(`Loop ${name} deleted — ${result.archivedEntries} entries archived${result.interruptedTurn ? ', running turn stopped' : ''}`, 'success')
        dispatch({ type: 'transcript/reset', key: transcriptKey(agentId, name) })
        if (selectedLoopOf(agentId) === name) dispatch({ type: 'select/loop', agentId, loop: MAIN_LOOP })
        await actions.refreshLoops(agentId)
      }
      return result
    },

    async scheduleLoop(agentId, input) {
      const result = await run('Schedule', c => c.createTimer(agentId, input))
      if (result) toast(`Timer ${result.id} scheduled for ${input.loop ?? MAIN_LOOP}`, 'success')
      return result?.id
    },

    async resolveTask(agentId, taskId, action, reason) {
      const result = await run(action === 'approve' ? 'Approve' : 'Deny', c => c.resolveTask(agentId, taskId, { action, ...(reason ? { reason } : {}) }))
      if (result) toast(`${action === 'approve' ? 'Approved' : action === 'deny' ? (reason ? 'Rejected with feedback' : 'Rejected') : 'Updated'} ${taskId}`, 'success')
      await actions.refreshHil(agentId)
    },

    async alwaysApproveTask(agentId, taskId) {
      const result = await run('Always approve', c => c.alwaysApproveTask(agentId, taskId))
      if (result) toast(`Always approving ${result.tool}: it will not ask again (Inspect › Config › tools to undo)`, 'success', 5000)
      await actions.refreshHil(agentId)
      return !!result
    },

    async approveAllTasks(agentId, loop) {
      const result = await run('Approve all', c => c.approveAllTasks(agentId, loop))
      if (result) {
        const skipped = result.skippedProtection ? ` · ${result.skippedProtection} protection override${result.skippedProtection === 1 ? '' : 's'} still need${result.skippedProtection === 1 ? 's' : ''} you one by one` : ''
        toast(`Approved ${result.approved} call${result.approved === 1 ? '' : 's'}${skipped}`, result.skippedProtection ? 'warn' : 'success', 5000)
      }
      await actions.refreshHil(agentId)
    },

    async answerAsk(agentId, requestId, answers, loop) {
      const result = await run('Answer', c => c.answerAsk(agentId, requestId, answers, loop))
      const sent = answers.every(a => a === null) ? 'Skipped' : answers.length > 1 ? 'Answers sent' : 'Answer sent'
      if (result) toast(result.answered ? sent : 'Ask was no longer pending', result.answered ? 'success' : 'warn')
      await actions.refreshHil(agentId)
    },

    async respondSuspend(agentId, resume) {
      const result = await run('Suspend', c => c.respondSuspend(agentId, resume))
      if (result) toast(resume ? 'Resumed' : 'Shutting down', 'success')
      await actions.refreshAgent(agentId)
    },

    async refreshAuth() {
      const c = client
      try {
        const auth = await c.authStatus()
        if (!stale(c)) dispatch({ type: 'auth/set', auth })
      } catch {
        // Advisory (sign-in hints); /auth shows its own errors.
      }
    },

    async logoutSubscription(provider) {
      const label = ({ chatgpt: 'ChatGPT', grok: 'Grok', claude: 'Claude' } as const)[provider]
      const result = await run(`Sign out of ${label}`, c => c.logoutSubscription(provider))
      if (result) toast(`Signed the daemon out of ${label}`, 'success')
      await actions.refreshAuth()
      return !!result
    },

    async refreshWeb() {
      const c = client
      let server = null as WebState['server']
      let agents: WebState['agents'] = {}
      let error: string | undefined
      try {
        const mesh = await c.meshStatus()
        server = parseServer(mesh.meshServer)
        agents = parseMeshAgents(mesh.agents)
      } catch (err) {
        if (stale(c) || (err instanceof DaemonError && err.unreachable)) return state.web
        error = describe(err)
      }
      if (!server) {
        try { server = parseServer(await c.meshServer()) } catch (err) {
          if (stale(c) || (err instanceof DaemonError && err.unreachable)) return state.web
          error ??= describe(err)
        }
      }
      let lan: string[] = []
      if (server?.running && bindsAll(server.host)) lan = parseLan(await c.lanAddresses().catch(() => null))
      if (stale(c)) return state.web
      const web: WebState = { server, lan, agents, ...(server ? {} : { error }), at: Date.now() }
      dispatch({ type: 'web/set', web })
      return web
    },

    async setWebServer(on) {
      const result = await run(on ? 'Start web server' : 'Stop web server', c => c.meshServerAction(on ? 'start' : 'stop'))
      const web = await actions.refreshWeb()
      if (!result) return false
      const server = web?.server ?? parseServer(result)
      const ok = !!server && server.running === on
      if (on) toast(ok ? `Web server ${serverText(server)} — agent sites are up` : `Web server did not start${typeof result.error === 'string' ? `: ${result.error}` : ''}`, ok ? 'success' : 'error')
      else toast(ok ? 'Web server stopped — agent sites, APIs and mesh delivery are offline' : 'Web server is still running', ok ? 'success' : 'warn')
      return ok
    },

    async refreshIdentity() {
      const c = client
      try {
        const identity = await c.identity()
        if (stale(c)) return state.identity
        dispatch({ type: 'identity/set', identity })
        return identity
      } catch (err) {
        if (stale(c)) return state.identity
        // Unreachable: keep what we knew (the connection dot says offline).
        // 404/503: a daemon without identity routes — show no identity UI.
        if (err instanceof DaemonError && err.unreachable) return state.identity
        dispatch({ type: 'identity/set', identity: null })
        return null
      }
    },

    async createIdentity(passphrase) {
      const result = await attempt(c => c.createIdentity(passphrase))
      if (result.ok) {
        dispatch({ type: 'identity/set', identity: result.value.identity })
        toast('Owner identity created', 'success')
      }
      return result
    },

    async restoreIdentity(mnemonic, passphrase) {
      const result = await attempt(c => c.restoreIdentity(mnemonic, passphrase))
      if (!result.ok) return result
      dispatch({ type: 'identity/set', identity: result.value.identity })
      toast('Owner identity restored', 'success')
      return { ok: true, value: result.value.identity }
    },

    async unlockIdentity(passphrase) {
      const result = await attempt(c => c.unlockIdentity(passphrase))
      if (!result.ok) return result
      dispatch({ type: 'identity/set', identity: result.value.identity })
      toast('Owner identity unlocked', 'success')
      return { ok: true, value: result.value.identity }
    },

    async lockIdentity() {
      const result = await attempt(c => c.lockIdentity())
      if (!result.ok) { toast(`Lock: ${result.error}`, 'error'); return result }
      dispatch({ type: 'identity/set', identity: result.value.identity })
      toast('Owner identity locked', 'success')
      return { ok: true, value: result.value.identity }
    },

    async confirmIdentityBackup() {
      const result = await attempt(c => c.confirmIdentityBackup())
      if (!result.ok) { toast(`Backup: ${result.error}`, 'error'); return result }
      dispatch({ type: 'identity/set', identity: result.value.identity })
      toast('Seed phrase backup confirmed', 'success')
      return { ok: true, value: result.value.identity }
    },

    async listTemplates() {
      return attempt(c => c.templates())
    },

    async createAgent(input) {
      const result = await attempt(c => c.createAgent(input))
      if (!result.ok) return result
      const created = result.value
      toast(`Created ${created.name}${created.started ? ' and started it' : ''}`, 'success')
      await actions.refreshAgents()
      if (state.agents[created.agentId]) actions.selectAgent(created.agentId)
      return result
    },

    run,
  }

  /** A daemon call whose failure the caller shows (identity dialogs): never throws. */
  async function attempt<T>(fn: (c: DaemonClient) => Promise<T>): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await fn(client) }
    } catch (err) {
      if (err instanceof DaemonError) {
        if (err.unreachable) dispatch({ type: 'daemon/reachable', reachable: false })
        const body = err.body as { code?: unknown; identity?: IdentityStatus } | null
        // A 409 identity_not_ready carries the current status: keep it.
        if (body && typeof body === 'object' && body.identity && typeof body.identity === 'object') dispatch({ type: 'identity/set', identity: body.identity })
        return { ok: false, error: err.message, code: body && typeof body.code === 'string' ? body.code : undefined, status: err.status, body: err.body }
      }
      return { ok: false, error: describe(err), status: null }
    }
  }

  function agentLabel(agentId: string): string {
    const agent = state.agents[agentId]
    return agent?.summary.handle ?? agent?.summary.name ?? agentId
  }

  // Frames that arrive in one burst (a busy stream delivers many per read)
  // are applied as one state change: one render instead of one per event,
  // so keys stay responsive while events pour in.
  let pendingFrames: DaemonEventFrame[] = []
  let flushScheduled = false
  const flushFrames = () => {
    flushScheduled = false
    const frames = pendingFrames
    pendingFrames = []
    if (frames.length === 1) dispatch({ type: 'event', frame: frames[0] })
    else if (frames.length > 1) dispatch({ type: 'events', frames })
  }

  function onFrame(frame: DaemonEventFrame) {
    pendingFrames.push(frame)
    if (!flushScheduled) { flushScheduled = true; setImmediate(flushFrames) }
    const { event } = frame
    const agentId = event.agent_id
    switch (event.event_type) {
      case 'agent.loaded':
      case 'agent.unloaded':
        debounce('agents', () => { void actions.refreshAgents().then(() => actions.refreshTracked()) }, 250)
        // The daemon (re)starts / rebinds its web server as agents register.
        debounce('web', () => { void actions.refreshWeb() }, WEB_EVENT_DEBOUNCE_MS)
        return
    }
    if (event.event_type.startsWith('mesh.')) debounce('web', () => { void actions.refreshWeb() }, WEB_EVENT_DEBOUNCE_MS)
    if (!agentId || !state.agents[agentId]) return
    const loop = eventLoop(event)
    const key = transcriptKey(agentId, loop)
    switch (event.event_type) {
      case 'context.injected':
        // Legacy /events and unfocused sessions carry provenance only. Read
        // the durable record; no model turn is needed for this notification.
        if (event.payload?.category === 'owner_command') debounce(`t:${key}`, () => { void actions.loadTranscript(agentId, loop) })
        break
      case 'loop.cleared':
      case 'loop.compacted':
        historyGenerations.set(key, (historyGenerations.get(key) ?? 0) + 1)
        // Even an initial history request can be in flight when it is wiped.
        // Its response is discarded, so arrange a replacement read as well.
        if (state.transcripts[key]) debounce(`t:${key}`, () => { void actions.loadTranscript(agentId, loop) })
        // fall through: refresh loop/status snapshots as after a turn.
      case 'turn.completed':
        if (event.event_type === 'turn.completed' && state.transcripts[key]?.loaded) debounce(`t:${key}`, () => { void actions.loadTranscript(agentId, loop) })
        debounce(`loops:${agentId}`, () => { void actions.refreshLoops(agentId) })
        debounce(`status:${agentId}`, () => {
          const c = client
          void c.status(agentId).then(status => { if (!stale(c)) dispatch({ type: 'agent/status', agentId, status }) }).catch(() => {})
        })
        break
      case 'config.changed': {
        const keys = Array.isArray(event.payload?.changed_keys) ? event.payload.changed_keys as string[] : []
        if (keys.length === 0 || keys.includes('loops')) debounce(`loops:${agentId}`, () => { void actions.refreshLoops(agentId) })
        if (state.agents[agentId]?.config) debounce(`config:${agentId}`, () => { void actions.loadConfig(agentId) })
        if (keys.length === 0 || keys.includes('serving') || keys.includes('messaging')) debounce('web', () => { void actions.refreshWeb() }, WEB_EVENT_DEBOUNCE_MS)
        break
      }
      case 'tool.completed':
        // An agent setting its status line (adf_meta `status`) shows in chat and the fleet.
        if (typeof event.payload?.name === 'string' && /^sys_(set|delete)_meta$/.test(event.payload.name)) debounce('web', () => { void actions.refreshWeb() }, 300)
        break
      case 'llm.failed':
      case 'agent.error':
        // A failed call may be an expired or missing subscription sign-in.
        debounce('auth', () => { void actions.refreshAuth() }, 500)
        break
      case 'hil.requested':
      case 'hil.resolved':
      case 'ask.requested':
      case 'ask.resolved':
        debounce(`hil:${agentId}`, () => { void actions.refreshHil(agentId) }, 300)
        break
    }
  }

  async function start() {
    stopped = false
    try {
      await client.health()
      dispatch({ type: 'daemon/reachable', reachable: true })
    } catch {
      dispatch({ type: 'daemon/reachable', reachable: false })
    }
    // The stream opens while the snapshots load: frames that arrive first apply on top of the snapshot.
    let opening: Promise<void> = Promise.resolve()
    if (options.live !== false) {
      opening = openStream()
      // Studio or the CLI may start / stop the web server: no event says so.
      if (webTick) clearInterval(webTick)
      webTick = setInterval(() => { if (!stopped) void actions.refreshWeb() }, WEB_POLL_MS)
      if (trackedTick) clearInterval(trackedTick)
      trackedTick = setInterval(() => { if (!stopped && state.daemonReachable !== false) void actions.refreshTracked() }, TRACKED_POLL_MS)
    }
    await Promise.all([opening, actions.refreshIdentity(), actions.refreshAuth(), actions.refreshAgents(), actions.refreshWeb()])
    await actions.refreshTracked()
  }

  function onStreamState(info: ConnectionInfo) {
    dispatch({ type: 'connection', info })
    if (info.state === 'reconnecting') {
      needsResync = true
      if (info.error) dispatch({ type: 'daemon/reachable', reachable: false })
      // The session is gone (it expired while we were away, or the daemon restarted): open a new one.
      if (sessionId && info.error?.startsWith('HTTP 404')) void reopenSession()
    }
    if (info.state === 'open' && sessionRetry && !sessionId) {
      // The daemon answers now: move from /events onto a client session.
      sessionRetry = false
      void reopenSession()
      return
    }
    if (info.state === 'open' && info.resumed) {
      // Wait for the daemon's verdict (onResume): an exact resume needs no reload.
      needsResync = false
      if (resumeFallback) clearTimeout(resumeFallback)
      resumeFallback = setTimeout(() => {
        resumeFallback = null
        toast('Reconnected to daemon — resyncing', 'info', 2500)
        void resync()
      }, RESUME_VERDICT_MS)
    } else if (info.state === 'open' && needsResync) {
      needsResync = false
      toast('Connected to daemon', 'info', 2500)
      void resync()
    }
  }

  function onStreamResume(info: ResumeInfo) {
    if (resumeFallback) { clearTimeout(resumeFallback); resumeFallback = null }
    if (info.exact) {
      // Every missed event was replayed into the transcripts: refresh the
      // snapshots that are not evented, skip reloading every transcript.
      toast('Reconnected to daemon — no events missed', 'info', 2500)
      void Promise.all([actions.refreshIdentity(), actions.refreshAuth(), actions.refreshAgents(), actions.refreshWeb()])
      return
    }
    toast(info.reason === 'epoch_changed' ? 'The daemon restarted — reloading' : 'Events were missed while disconnected — reloading', 'warn', 4000)
    void resync()
  }

  /** The session stream dropped frames (a slow read, or a long disconnect): reload what they would have changed. */
  function onStreamGap(gap: StreamGap) {
    if (Date.now() - lastResyncAt < RESUME_VERDICT_MS) return // the resume verdict already reloaded
    toast(`${gap.dropped ? `${gap.dropped} live event${gap.dropped === 1 ? ' was' : 's were'}` : 'Live events were'} dropped — reloading`, 'warn', 4000)
    void resync()
  }

  function onClientFrame(frame: ClientFrame) {
    const effects = clientFrameEffects(frame)
    for (const envelope of effects.frames) onFrame(envelope)
    if (effects.ownerCommand) {
      flushFrames()
      const { agentId, loop, item } = effects.ownerCommand
      dispatch({ type: 'transcript/owner-command', key: transcriptKey(agentId, loop), item })
    }
    if (effects.toolResult) {
      // After the tool.completed already queued for this call.
      flushFrames()
      const { agentId, loop, toolUseId, result, isError } = effects.toolResult
      dispatch({ type: 'tool/result', key: transcriptKey(agentId, loop), toolUseId, result, isError })
    }
    if (effects.notice) toast(effects.notice.text, effects.notice.level, effects.notice.level === 'warn' ? 10_000 : 4000)
    if (effects.reload) {
      const { agentId, loop } = effects.reload
      const key = transcriptKey(agentId, loop)
      if (state.transcripts[key]?.loaded) debounce(`t:${key}`, () => { void actions.loadTranscript(agentId, loop) })
    }
  }

  /** Taking the /events path: log why, once. */
  function noticeFallback(reason: string) {
    if (fallbackNoticed) return
    fallbackNoticed = true
    // In the activity log, not a toast: an older daemon is a normal setup, and the screen is unchanged.
    dispatch({ type: 'activity/note', kind: 'client.fallback', text: `Live events over /events: ${reason}. Token streaming follows each agent's umbilical.stream_deltas.` })
  }

  /**
   * A client session on this daemon, or null for the /events path: the
   * daemon's client API version must be one this app reads (from
   * TUI_MIN_CLIENT_API_VERSION up to SUPPORTED_CLIENT_API_VERSION), and the
   * daemon must have the routes.
   */
  async function openSession(c: DaemonClient): Promise<string | null> {
    try {
      const info = await c.version()
      const version = info.clientApiVersion
      if (typeof version !== 'number' || version < TUI_MIN_CLIENT_API_VERSION || version > SUPPORTED_CLIENT_API_VERSION) {
        noticeFallback(`the daemon speaks client API ${version}, this app ${TUI_MIN_CLIENT_API_VERSION}-${SUPPORTED_CLIENT_API_VERSION}`)
        return null
      }
    } catch (err) {
      if (err instanceof DaemonError && err.unreachable) {
        sessionRetry = true
        return null
      }
      noticeFallback(err instanceof DaemonError && err.status === 404 ? 'the daemon has no client sessions (an older version)' : `GET /version failed (${describe(err)})`)
      return null
    }
    try {
      const created = await c.createClientSession({ client: TUI_CLIENT_NAME, version: options.clientVersion ?? process.env.ADF_VERSION ?? 'dev', umbilical: true })
      return created.sessionId
    } catch (err) {
      if (err instanceof DaemonError && err.unreachable) {
        sessionRetry = true
        return null
      }
      noticeFallback(err instanceof DaemonError && err.status === 404 ? 'the daemon has no client sessions (an older version)' : `opening a client session failed (${describe(err)})`)
      return null
    }
  }

  async function openStream() {
    const c = plain
    const id = options.clientSessions === false ? null : await openSession(c)
    if (stale(c) || stopped) {
      if (id) void c.endClientSession(id).catch(() => {})
      return
    }
    sessionId = id
    useSession(id)
    focusSent = undefined
    if (id) {
      stream = c.clientSessionEvents(id, { onEvent: onClientFrame, onState: onStreamState, onResume: onStreamResume, onGap: onStreamGap }).start()
      void syncFocus()
    } else {
      stream = c.events({ onEvent: onFrame, onState: onStreamState, onResume: onStreamResume }).start()
    }
  }

  /** Replace the stream with one on a new client session (the old one is gone, or there was none yet), then reload. */
  async function reopenSession() {
    if (reopening || stopped) return
    reopening = true
    try {
      const hadSession = sessionId !== null
      stream?.close()
      stream = null
      sessionId = null
      useSession(null)
      await openStream()
      if (stopped) return
      if (hadSession) toast('The daemon no longer had this app\'s client session — reopened, reloading', 'warn', 4000)
      await resync()
    } finally {
      reopening = false
    }
  }

  /** The agent whose chat view is open: the session's focus (its tokens stream here). */
  function desiredFocus(): string | null {
    const id = state.selectedAgentId
    return state.activeView === CHAT_VIEW_ID && id && !isTrackedKey(id) ? id : null
  }

  async function syncFocus() {
    if (!sessionId || focusInFlight || Date.now() < focusRetryAt) return
    const want = desiredFocus()
    if (want === focusSent) return
    const id = sessionId
    const c = client
    focusInFlight = true
    try {
      await c.setClientSessionFocus(id, want)
      if (sessionId === id) focusSent = want
    } catch {
      // Retried on the next state change; the stream's own state shows a lost daemon.
      focusRetryAt = Date.now() + 2000
    } finally {
      focusInFlight = false
    }
    if (sessionId === id && desiredFocus() !== focusSent) void syncFocus()
  }

  /** End the client session at the daemon (its 60 s expiry would end it too). */
  function endSession(c: DaemonClient): Promise<void> {
    const id = sessionId
    sessionId = null
    if (c === client) useSession(null)
    focusSent = undefined
    if (!id) return Promise.resolve()
    return c.endClientSession(id).then(() => {}, () => {})
  }

  async function resync() {
    lastResyncAt = Date.now()
    await Promise.all([actions.refreshIdentity(), actions.refreshAuth(), actions.refreshAgents(), actions.refreshWeb()])
    void actions.refreshTracked()
    for (const key of Object.keys(state.transcripts)) {
      const at = key.indexOf('\u0000')
      const agentId = key.slice(0, at)
      if (state.agents[agentId] && state.transcripts[key].loaded) void actions.loadTranscript(agentId, key.slice(at + 1))
    }
  }

  function stop(): Promise<void> {
    stopped = true
    stream?.close()
    stream = null
    const ended = endSession(client)
    if (resumeFallback) { clearTimeout(resumeFallback); resumeFallback = null }
    if (webTick) { clearInterval(webTick); webTick = null }
    if (trackedTick) { clearInterval(trackedTick); trackedTick = null }
    pendingFrames = []
    for (const timer of toastTimers.values()) clearTimeout(timer)
    for (const timer of debounced.values()) clearTimeout(timer)
    toastTimers.clear()
    debounced.clear()
    for (const resolve of confirmResolvers.values()) resolve(false)
    confirmResolvers.clear()
    return ended
  }

  async function close(): Promise<void> {
    const ended = stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })])
    if (timer) clearTimeout(timer)
  }

  function resolveConfirm(id: string, confirmed: boolean) {
    const resolve = confirmResolvers.get(id)
    confirmResolvers.delete(id)
    dispatch({ type: 'overlay/pop', id })
    resolve?.(confirmed)
  }

  return {
    get client() { return client },
    actions,
    getState,
    dispatch,
    subscribe,
    start,
    stop: () => { void stop() },
    close,
    get liveMode() { return sessionId ? 'session' as const : stream ? 'events' as const : 'none' as const },
    resolveConfirm,
  }
}

// --- React bindings -------------------------------------------------------------

const StoreContext = createContext<TuiStore | null>(null)

export function StoreProvider({ store, children }: { store: TuiStore; children?: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): TuiStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside <StoreProvider>')
  return store
}

export function useActions(): TuiActions {
  return useStore().actions
}

export function useClient(): DaemonClient {
  return useStore().client
}

/**
 * Subscribe to a slice of state. Re-renders only when the selected value
 * changes under `isEqual` (default Object.is; pass `shallowEqual` for
 * selectors that build arrays/objects).
 */
export function useTuiSelector<T>(selector: (state: TuiState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useStore()
  const cache = useRef<{ state: TuiState; selector: (state: TuiState) => T; value: T } | null>(null)
  const getSnapshot = () => {
    const current = store.getState()
    const cached = cache.current
    if (cached && cached.state === current && cached.selector === selector) return cached.value
    const value = selector(current)
    if (cached && isEqual(cached.value, value)) {
      cache.current = { state: current, selector, value: cached.value }
      return cached.value
    }
    cache.current = { state: current, selector, value }
    return value
  }
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}
