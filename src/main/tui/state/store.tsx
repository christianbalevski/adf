// The TUI store: reducer + effects + React bindings.
//
// One store per TUI process. It owns the daemon client and the SSE stream,
// ingests every event exactly once, and exposes `actions` — the only way views
// and commands change anything. Every action that talks to the daemon reports
// its outcome visibly (transcript item or toast); nothing fails silently.

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { DaemonClient } from '../api/client'
import type { EventStream } from '../api/sse'
import {
  DaemonError,
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
import { localId } from './transcript'
import {
  transcriptKey,
  type FocusZone,
  type Overlay,
  type ToastLevel,
  type TuiState,
  type UserItem,
  type WebState,
} from './types'
import { bindsAll, parseLan, parseMeshAgents, parseServer, serverText } from '../web/model'

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
  answerAsk(agentId: string, requestId: string, answer: string, loop?: string): Promise<void>
  respondSuspend(agentId: string, resume: boolean): Promise<void>

  /** Re-read `GET /runtime/auth` (ChatGPT / Grok sign-in) into `state.auth`. Quiet on failure. */
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
  /** Resolve a pending confirm overlay (called by the overlay host). */
  resolveConfirm(id: string, confirmed: boolean): void
}

export interface CreateStoreOptions {
  client: DaemonClient
  initialView?: string
  /** Subscribe to /events. Default true. */
  live?: boolean
  /** Loop rows per history page. Default 100. */
  pageSize?: number
}

const REFRESH_DEBOUNCE_MS = 120
/** After agent load / config events: the daemon starts its web server ~500ms after agents register. */
const WEB_EVENT_DEBOUNCE_MS = 900
const WEB_POLL_MS = 20_000

/** viewState slot the shell prompt watches for `prefillPrompt`. */
export const PROMPT_PREFILL_KEY = 'shell.prompt.prefill'

const CHAT_VIEW_ID = 'chat'

export function createTuiStore(options: CreateStoreOptions): TuiStore {
  let client = options.client
  const pageSize = options.pageSize ?? 100
  let state = initialState(client.baseUrl, options.initialView)
  const listeners = new Set<() => void>()
  const confirmResolvers = new Map<string, (value: boolean) => void>()
  const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const debounced = new Map<string, ReturnType<typeof setTimeout>>()
  let stream: EventStream | null = null
  let webTick: ReturnType<typeof setInterval> | null = null
  let stopped = false
  /** Set when the daemon was unreachable; the next successful open resyncs. */
  let needsResync = false

  const getState = () => state
  const dispatch = (action: TuiAction) => {
    const next = tuiReducer(state, action)
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
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
  const stale = (c: DaemonClient) => c !== client

  const actions: TuiActions = {
    async setDaemonUrl(url, token) {
      const next = client.withBaseUrl(url, token)
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
      for (const timer of debounced.values()) clearTimeout(timer)
      debounced.clear()
      client = next
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
        if (selected) await actions.ensureTranscript(selected, selectedLoopOf(selected))
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

    selectAgent(agentId) {
      dispatch({ type: 'select/agent', agentId })
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
      const t = state.transcripts[transcriptKey(agentId, loop)]
      if (t?.loaded || t?.loading) return
      await actions.loadTranscript(agentId, loop)
    },

    async loadTranscript(agentId, loop) {
      const key = transcriptKey(agentId, loop)
      const c = client
      dispatch({ type: 'transcript/loading', key })
      try {
        const page = await c.loopHistory(agentId, { loop, limit: pageSize })
        if (!stale(c)) dispatch({ type: 'transcript/history', key, entries: page.entries, total: page.total, offset: page.offset, mode: 'replace' })
      } catch (err) {
        if (!stale(c)) dispatch({ type: 'transcript/error', key, error: describe(err) })
      }
    },

    async loadOlder(agentId, loop) {
      const key = transcriptKey(agentId, loop)
      const t = state.transcripts[key]
      if (!t || t.loading || t.oldestOffset <= 0) return
      const offset = Math.max(0, t.oldestOffset - pageSize)
      const limit = t.oldestOffset - offset
      const c = client
      dispatch({ type: 'transcript/loading', key })
      try {
        const page = await c.loopHistory(agentId, { loop, limit, offset })
        if (!stale(c)) dispatch({ type: 'transcript/history', key, entries: page.entries, total: page.total, offset: page.offset, mode: 'prepend' })
      } catch (err) {
        if (!stale(c)) dispatch({ type: 'transcript/error', key, error: describe(err) })
      }
    },

    async sendChat(text, target = {}) {
      const agentId = target.agentId ?? state.selectedAgentId
      const trimmed = text.trim()
      if (!agentId || !trimmed) return false
      const loop = target.loop ?? selectedLoopOf(agentId)
      const key = transcriptKey(agentId, loop)
      const item: UserItem = { id: localId(), at: Date.now(), local: true, kind: 'user', text: trimmed, origin: 'owner', pending: true }
      dispatch({ type: 'transcript/append', key, item })
      try {
        await client.chat(agentId, trimmed, loop)
        dispatch({ type: 'transcript/update', key, id: item.id, patch: { accepted: true } })
        return true
      } catch (err) {
        dispatch({ type: 'transcript/update', key, id: item.id, patch: { pending: false } })
        dispatch({ type: 'transcript/append', key, item: { id: localId(), at: Date.now(), local: true, kind: 'error', text: `Not sent: ${describe(err)}` } })
        return false
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
      if (result) toast(`${action === 'approve' ? 'Approved' : action === 'deny' ? 'Denied' : 'Updated'} ${taskId}`, 'success')
      await actions.refreshHil(agentId)
    },

    async answerAsk(agentId, requestId, answer, loop) {
      const result = await run('Answer', c => c.answerAsk(agentId, requestId, answer, loop))
      if (result) toast(result.answered ? 'Answer sent' : 'Ask was no longer pending', result.answered ? 'success' : 'warn')
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
      const label = provider === 'chatgpt' ? 'ChatGPT' : 'Grok'
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
        debounce('agents', () => { void actions.refreshAgents() }, 250)
        // The daemon (re)starts / rebinds its web server as agents register.
        debounce('web', () => { void actions.refreshWeb() }, WEB_EVENT_DEBOUNCE_MS)
        return
    }
    if (event.event_type.startsWith('mesh.')) debounce('web', () => { void actions.refreshWeb() }, WEB_EVENT_DEBOUNCE_MS)
    if (!agentId || !state.agents[agentId]) return
    const loop = eventLoop(event)
    const key = transcriptKey(agentId, loop)
    switch (event.event_type) {
      case 'turn.completed':
      case 'loop.cleared':
      case 'loop.compacted':
        if (state.transcripts[key]?.loaded) debounce(`t:${key}`, () => { void actions.loadTranscript(agentId, loop) })
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
    if (options.live !== false) {
      stream = client.events({
        onEvent: onFrame,
        onState: info => {
          dispatch({ type: 'connection', info })
          if (info.state === 'reconnecting') {
            needsResync = true
            if (info.error) dispatch({ type: 'daemon/reachable', reachable: false })
          }
          if (info.state === 'open' && (info.resumed || needsResync)) {
            needsResync = false
            toast(info.resumed ? 'Reconnected to daemon — resyncing' : 'Connected to daemon', 'info', 2500)
            void resync()
          }
        },
      }).start()
      // Studio or the CLI may start / stop the web server: no event says so.
      if (webTick) clearInterval(webTick)
      webTick = setInterval(() => { if (!stopped) void actions.refreshWeb() }, WEB_POLL_MS)
    }
    await Promise.all([actions.refreshIdentity(), actions.refreshAuth(), actions.refreshAgents(), actions.refreshWeb()])
  }

  async function resync() {
    await Promise.all([actions.refreshIdentity(), actions.refreshAuth(), actions.refreshAgents(), actions.refreshWeb()])
    for (const key of Object.keys(state.transcripts)) {
      const at = key.indexOf('\u0000')
      const agentId = key.slice(0, at)
      if (state.agents[agentId] && state.transcripts[key].loaded) void actions.loadTranscript(agentId, key.slice(at + 1))
    }
  }

  function stop() {
    stopped = true
    stream?.close()
    stream = null
    if (webTick) { clearInterval(webTick); webTick = null }
    pendingFrames = []
    for (const timer of toastTimers.values()) clearTimeout(timer)
    for (const timer of debounced.values()) clearTimeout(timer)
    toastTimers.clear()
    debounced.clear()
    for (const resolve of confirmResolvers.values()) resolve(false)
    confirmResolvers.clear()
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
    stop,
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
