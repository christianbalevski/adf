// Typed client for the ADF daemon HTTP API (docs/daemon/http-api.md).
//
// One method per endpoint the TUI uses. Every method rejects with DaemonError
// (status null = daemon unreachable). Nothing here caches or retries: the
// store decides what to refetch, so every state change stays observable.

import * as daemonUrlNs from '../../cli/daemon-url'
import { cjs } from '../interop'
import { EventStream, type EventStreamOptions } from './sse'
import {
  DaemonError,
  MAIN_LOOP,
  type AcceptedTurn,
  type AdfBatchDispatch,
  type AdfEventDispatch,
  type AgentConfig,
  type AgentConfigResult,
  type AgentRef,
  type AgentRuntimeDiagnostics,
  type AgentStatus,
  type AgentSummary,
  type AgentUsage,
  type AgentAdaptersDiagnostics,
  type AgentMcpDiagnostics,
  type AgentTriggersDiagnostics,
  type AgentWsDiagnostics,
  type AskAnswerResult,
  type AskListResult,
  type AutostartReport,
  type CompactResult,
  type AuthDiagnostics,
  type ChatHistory,
  type ContentResult,
  type DisplayState,
  type FileContent,
  type FileListResult,
  type FileProtectionLevel,
  type FileWriteInput,
  type IdentityListResult,
  type InboxResult,
  type InboxStatus,
  type LogsResult,
  type LoopCreateInput,
  type LoopCreateResult,
  type LoopDeleteResult,
  type LoopInfo,
  type LoopListResult,
  type LoopPage,
  type LoopPatch,
  type LoopUpdateResult,
  type McpDiagnostics,
  type AdapterDiagnostics,
  type MetaProtectionLevel,
  type MetaResult,
  type ModelsResult,
  type NetworkDiagnostics,
  type OutboxResult,
  type OutboxStatus,
  type ProviderDiagnostics,
  type ReviewInfo,
  type RuntimeOverview,
  type RuntimeSettingsDiagnostics,
  type SettingsResult,
  type StartAgentResult,
  type InterruptResult,
  type SuccessResult,
  type SuspendResult,
  type TableListResult,
  type TableQueryResult,
  type TaskListResult,
  type TaskResolveInput,
  type TaskResolveResult,
  type TaskResult,
  type TaskStatus,
  type TimerInput,
  type TimerListResult,
  type UmbilicalReplayResult,
  type UsageDiagnostics,
  type AdfLogEntry,
  type AgentCreateInput,
  type AgentCreateResult,
  type IdentityCreateResult,
  type IdentityResult,
  type IdentityStatus,
  type TemplateListResult,
  type SubscriptionAuthStatus,
  type SubscriptionProvider,
} from './types'

export interface DaemonClientOptions {
  /** Daemon base URL. Defaults to `--url` semantics: ADF_DAEMON_URL, then http://127.0.0.1:7385. */
  baseUrl?: string
  /** Bearer token. Defaults to ADF_DAEMON_TOKEN. */
  token?: string
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Per-request timeout for non-streaming calls. Default 15s. */
  timeoutMs?: number
}

const { resolveDaemonToken, resolveDaemonUrl } = cjs(daemonUrlNs)

type Query = Record<string, string | number | boolean | undefined | null>

interface RequestOptions {
  query?: Query
  body?: unknown
  signal?: AbortSignal
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const enc = encodeURIComponent

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

export class DaemonClient {
  readonly baseUrl: string
  private readonly token: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly options: DaemonClientOptions

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = resolveDaemonUrl(options.baseUrl)
    this.token = resolveDaemonToken(options.token)
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.options = options
  }

  /**
   * Same transport (fetch, timeout) against another daemon. The current token
   * is carried over only to the same origin; another origin gets `token`, or
   * ADF_DAEMON_TOKEN, or none — never this daemon's bearer token.
   */
  withBaseUrl(baseUrl: string, token?: string): DaemonClient {
    const carried = sameOrigin(this.baseUrl, resolveDaemonUrl(baseUrl)) ? this.token : undefined
    return new DaemonClient({ ...this.options, baseUrl, token: token ?? carried })
  }

  /** Whether requests carry a bearer token. */
  get hasToken(): boolean {
    return !!this.token
  }

  // --- transport ------------------------------------------------------------

  url(path: string, query?: Query): string {
    const qs = query ? buildQuery(query) : ''
    return `${this.baseUrl}${path}${qs}`
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    }
  }

  async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs)
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let response: Response
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method,
        headers: this.headers(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      const reason = controller.signal.aborted && !options.signal?.aborted ? `timed out after ${this.timeoutMs}ms` : errorMessage(err)
      throw new DaemonError(`Cannot reach daemon at ${this.baseUrl}: ${reason}`, null)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const text = await response.text()
    let body: unknown = null
    if (text.trim()) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (!response.ok) {
      const message = isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status} ${response.statusText}`
      throw new DaemonError(message, response.status, body)
    }
    return body as T
  }

  private get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query })
  }

  private post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('POST', path, { body, query })
  }

  private put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('PUT', path, { body, query })
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body })
  }

  private del<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, { query })
  }

  /** Live umbilical events (SSE) with auto-reconnect. Call `.start()` on the result. */
  events(options: Omit<EventStreamOptions, 'baseUrl' | 'headers' | 'fetch'>): EventStream {
    return new EventStream({ ...options, baseUrl: this.baseUrl, headers: this.headers({ Accept: 'text/event-stream' }), fetch: this.fetchImpl })
  }

  // --- daemon ---------------------------------------------------------------

  health(): Promise<{ ok: boolean }> {
    return this.get('/health')
  }

  runtime(): Promise<RuntimeOverview> {
    return this.get('/runtime')
  }

  providers(): Promise<ProviderDiagnostics> {
    return this.get('/runtime/providers')
  }

  authStatus(): Promise<AuthDiagnostics> {
    return this.get('/runtime/auth')
  }

  runtimeSettings(): Promise<RuntimeSettingsDiagnostics> {
    return this.get('/runtime/settings')
  }

  runtimeMcp(): Promise<McpDiagnostics> {
    return this.get('/runtime/mcp')
  }

  runtimeAdapters(): Promise<AdapterDiagnostics> {
    return this.get('/runtime/adapters')
  }

  network(): Promise<NetworkDiagnostics> {
    return this.get('/runtime/network')
  }

  usage(): Promise<UsageDiagnostics> {
    return this.get('/runtime/usage')
  }

  models(provider: string, agentId?: string): Promise<ModelsResult> {
    return this.get('/runtime/models', { provider, agentId })
  }

  settings(): Promise<SettingsResult> {
    return this.get('/settings')
  }

  setting(key: string): Promise<{ key: string; value: unknown }> {
    return this.get(`/settings/${enc(key)}`)
  }

  putSetting(key: string, value: unknown): Promise<{ key: string; value: unknown }> {
    return this.put(`/settings/${enc(key)}`, { value })
  }

  // --- compute (containers) and the mesh --------------------------------------
  // Shapes are the daemon services' own; the Runtime view renders them as trees.

  computeStatus(): Promise<Record<string, unknown>> {
    return this.get('/compute/status')
  }

  computeContainers(): Promise<{ containers: Array<Record<string, unknown>> }> {
    return this.get('/compute/containers')
  }

  meshStatus(): Promise<Record<string, unknown>> {
    return this.get('/network/mesh')
  }

  setMesh(enabled: boolean): Promise<Record<string, unknown>> {
    return this.post(`/network/mesh/${enabled ? 'enable' : 'disable'}`)
  }

  meshServer(): Promise<Record<string, unknown>> {
    return this.get('/network/server')
  }

  meshServerAction(action: 'start' | 'stop' | 'restart'): Promise<Record<string, unknown>> {
    return this.post(`/network/server/${action}`)
  }

  /** `{ addresses: { hostname, addresses: [{ iface, address, family }] } }` (web/model `parseLan`). */
  lanAddresses(): Promise<Record<string, unknown>> {
    return this.get('/network/mesh/lan-addresses')
  }

  // --- subscription provider sign-in (ChatGPT, Grok) ------------------------
  // Sign-in flows themselves (browser, callback server, polling) live in
  // cli/auth-flow.ts over `request`; these are the plain reads and sign-out.

  subscriptionStatus(provider: SubscriptionProvider): Promise<SubscriptionAuthStatus> {
    return this.get(`/auth/${provider}/status`)
  }

  logoutSubscription(provider: SubscriptionProvider): Promise<SuccessResult> {
    return this.post(`/auth/${provider}/logout`)
  }

  // --- owner identity + agent creation --------------------------------------
  // create / restore / unlock answer loopback callers only (403 loopback_only).
  // Nothing here logs or keeps a request or response body.

  identity(): Promise<IdentityStatus> {
    return this.get('/identity')
  }

  /** 201 with the 12 words, returned this once. `passphrase` only for file storage. */
  createIdentity(passphrase?: string): Promise<IdentityCreateResult> {
    return this.post('/identity/create', passphrase ? { passphrase } : {})
  }

  restoreIdentity(mnemonic: string, passphrase?: string): Promise<IdentityResult> {
    return this.post('/identity/restore', { mnemonic, ...(passphrase ? { passphrase } : {}) })
  }

  unlockIdentity(passphrase: string): Promise<IdentityResult> {
    return this.post('/identity/unlock', { passphrase })
  }

  lockIdentity(): Promise<IdentityResult> {
    return this.post('/identity/lock')
  }

  confirmIdentityBackup(): Promise<IdentityResult> {
    return this.post('/identity/confirm-backup')
  }

  templates(): Promise<TemplateListResult> {
    return this.get('/templates')
  }

  /** Studio's "new agent", headless. 409 identity_not_ready / name_taken, 422 template_*. */
  createAgent(input: AgentCreateInput = {}): Promise<AgentCreateResult> {
    return this.post('/agents/create', input)
  }

  // --- agents ---------------------------------------------------------------

  agents(): Promise<AgentSummary[]> {
    return this.get('/agents')
  }

  agent(agentId: string): Promise<AgentRef> {
    return this.get(`/agents/${enc(agentId)}`)
  }

  status(agentId: string): Promise<AgentStatus> {
    return this.get(`/agents/${enc(agentId)}/status`)
  }

  agentUsage(agentId: string): Promise<AgentUsage> {
    return this.get(`/agents/${enc(agentId)}/usage`)
  }

  /** Load an .adf file from disk. Direct loads bypass review unless `requireReview`. */
  load(filePath: string, requireReview = false): Promise<AgentRef> {
    return this.post('/agents/load', { filePath, requireReview })
  }

  review(filePath: string): Promise<ReviewInfo> {
    return this.get('/agents/review', { filePath })
  }

  acceptReview(filePath: string): Promise<ReviewInfo> {
    return this.post('/agents/review/accept', { filePath })
  }

  start(agentId: string): Promise<StartAgentResult> {
    return this.post(`/agents/${enc(agentId)}/start`)
  }

  stop(agentId: string): Promise<SuccessResult> {
    return this.post(`/agents/${enc(agentId)}/stop`)
  }

  unload(agentId: string): Promise<SuccessResult> {
    return this.post(`/agents/${enc(agentId)}/unload`)
  }

  /**
   * End one loop's running turn (default main) and leave it idle; the agent
   * keeps accepting chats, triggers and timers. What Esc does.
   */
  interrupt(agentId: string, loop?: string): Promise<InterruptResult> {
    return this.post(`/agents/${enc(agentId)}/interrupt`, undefined, loop && loop !== MAIN_LOOP ? { loop } : undefined)
  }

  /**
   * Hard abort of one loop's turn (default main): the daemon leaves that
   * executor stopped until the agent is reloaded. Prefer `interrupt`.
   */
  abort(agentId: string, loop?: string): Promise<SuccessResult> {
    return this.post(`/agents/${enc(agentId)}/abort`, undefined, loop && loop !== MAIN_LOOP ? { loop } : undefined)
  }

  /** Scan directories and start every reviewed agent configured for autostart. */
  autostart(trackedDirs: string[], maxDepth?: number): Promise<AutostartReport> {
    return this.post('/agents/autostart', { trackedDirs, ...(maxDepth !== undefined ? { maxDepth } : {}) })
  }

  /** Compact one loop's history now. 409 while that loop is mid-turn. */
  compact(agentId: string, loop?: string): Promise<CompactResult> {
    return this.post(`/agents/${enc(agentId)}/compact`, undefined, loop && loop !== MAIN_LOOP ? { loop } : undefined)
  }

  setState(agentId: string, state: DisplayState): Promise<{ agentId: string; success: true; state: DisplayState }> {
    return this.post(`/agents/${enc(agentId)}/state`, { state })
  }

  // --- conversation (loop-aware; absent loop = main) --------------------------

  /** Owner chat into a loop. Unknown loop: 404, disabled loop: 409 — before any turn is queued. */
  chat(agentId: string, text: string, loop?: string): Promise<AcceptedTurn> {
    return this.post(`/agents/${enc(agentId)}/chat`, { text, ...(loop && loop !== MAIN_LOOP ? { loop } : {}) })
  }

  chatHistory(agentId: string, options: { loop?: string; limit?: number } = {}): Promise<ChatHistory> {
    return this.get(`/agents/${enc(agentId)}/chat`, { loop: options.loop, limit: options.limit })
  }

  clearChat(agentId: string, loop?: string): Promise<{ agentId: string; loop: string; success: true }> {
    return this.del(`/agents/${enc(agentId)}/chat`, { loop })
  }

  /** Raw persisted loop rows. Default page is the newest `limit` (50) rows. */
  loopHistory(agentId: string, options: { loop?: string; limit?: number; offset?: number } = {}): Promise<LoopPage> {
    return this.get(`/agents/${enc(agentId)}/loop`, { loop: options.loop, limit: options.limit, offset: options.offset })
  }

  trigger(agentId: string, dispatch: AdfEventDispatch | AdfBatchDispatch | Record<string, unknown>): Promise<AcceptedTurn> {
    return this.post(`/agents/${enc(agentId)}/trigger`, dispatch)
  }

  // --- loops ----------------------------------------------------------------

  loops(agentId: string): Promise<LoopListResult> {
    return this.get(`/agents/${enc(agentId)}/loops`)
  }

  loop(agentId: string, name: string): Promise<{ agentId: string; loop: LoopInfo }> {
    return this.get(`/agents/${enc(agentId)}/loops/${enc(name)}`)
  }

  createLoop(agentId: string, input: LoopCreateInput): Promise<LoopCreateResult> {
    return this.post(`/agents/${enc(agentId)}/loops`, input)
  }

  updateLoop(agentId: string, name: string, patch: LoopPatch): Promise<LoopUpdateResult> {
    return this.patch(`/agents/${enc(agentId)}/loops/${enc(name)}`, patch)
  }

  setLoopEnabled(agentId: string, name: string, enabled: boolean): Promise<LoopUpdateResult> {
    return this.updateLoop(agentId, name, { enabled })
  }

  /** Stops the loop, archives its stream to adf_audit, then removes it. */
  deleteLoop(agentId: string, name: string): Promise<LoopDeleteResult> {
    return this.del(`/agents/${enc(agentId)}/loops/${enc(name)}`)
  }

  // --- config / document / mind ---------------------------------------------

  config(agentId: string): Promise<AgentConfigResult> {
    return this.get(`/agents/${enc(agentId)}/config`)
  }

  putConfig(agentId: string, config: AgentConfig): Promise<AgentConfigResult & { success: true }> {
    return this.put(`/agents/${enc(agentId)}/config`, config)
  }

  document(agentId: string): Promise<ContentResult> {
    return this.get(`/agents/${enc(agentId)}/document`)
  }

  putDocument(agentId: string, content: string): Promise<SuccessResult> {
    return this.put(`/agents/${enc(agentId)}/document`, { content })
  }

  mind(agentId: string): Promise<ContentResult> {
    return this.get(`/agents/${enc(agentId)}/mind`)
  }

  putMind(agentId: string, content: string): Promise<SuccessResult> {
    return this.put(`/agents/${enc(agentId)}/mind`, { content })
  }

  // --- files ----------------------------------------------------------------

  files(agentId: string): Promise<FileListResult> {
    return this.get(`/agents/${enc(agentId)}/files`)
  }

  file(agentId: string, path: string): Promise<FileContent> {
    return this.get(`/agents/${enc(agentId)}/files/content`, { path })
  }

  writeFile(agentId: string, path: string, input: FileWriteInput): Promise<SuccessResult> {
    return this.put(`/agents/${enc(agentId)}/files/content`, input, { path })
  }

  deleteFile(agentId: string, path: string): Promise<SuccessResult> {
    return this.del(`/agents/${enc(agentId)}/files/content`, { path })
  }

  renameFile(agentId: string, oldPath: string, newPath: string): Promise<SuccessResult> {
    return this.post(`/agents/${enc(agentId)}/files/rename`, { oldPath, newPath })
  }

  renameFolder(agentId: string, oldPrefix: string, newPrefix: string): Promise<SuccessResult & { count: number }> {
    return this.post(`/agents/${enc(agentId)}/files/rename-folder`, { oldPrefix, newPrefix })
  }

  setFileProtection(agentId: string, path: string, protection: FileProtectionLevel): Promise<SuccessResult> {
    return this.patch(`/agents/${enc(agentId)}/files/protection`, { path, protection })
  }

  setFileAuthorized(agentId: string, path: string, authorized: boolean): Promise<SuccessResult> {
    return this.patch(`/agents/${enc(agentId)}/files/authorized`, { path, authorized })
  }

  // --- mesh messaging -------------------------------------------------------

  inbox(agentId: string, status?: InboxStatus): Promise<InboxResult> {
    return this.get(`/agents/${enc(agentId)}/inbox`, { status })
  }

  clearInbox(agentId: string): Promise<SuccessResult & { deleted: number }> {
    return this.del(`/agents/${enc(agentId)}/inbox`)
  }

  outbox(agentId: string, status?: OutboxStatus): Promise<OutboxResult> {
    return this.get(`/agents/${enc(agentId)}/outbox`, { status })
  }

  // --- timers (a timer's `loop` is how an inner loop runs on a schedule) -----

  timers(agentId: string): Promise<TimerListResult> {
    return this.get(`/agents/${enc(agentId)}/timers`)
  }

  createTimer(agentId: string, input: TimerInput): Promise<SuccessResult & { id: number }> {
    return this.post(`/agents/${enc(agentId)}/timers`, input)
  }

  /** `loop` present moves the timer to that loop (daemons before loop-aware timers ignore it). */
  updateTimer(agentId: string, timerId: number, input: TimerInput): Promise<SuccessResult> {
    return this.put(`/agents/${enc(agentId)}/timers/${timerId}`, input)
  }

  deleteTimer(agentId: string, timerId: number): Promise<SuccessResult> {
    return this.del(`/agents/${enc(agentId)}/timers/${timerId}`)
  }

  // --- meta / identity (metadata only; secret values are never listed) ------

  meta(agentId: string): Promise<MetaResult> {
    return this.get(`/agents/${enc(agentId)}/meta`)
  }

  setMeta(agentId: string, key: string, value: string, protection?: MetaProtectionLevel): Promise<SuccessResult> {
    return this.put(`/agents/${enc(agentId)}/meta/${enc(key)}`, { value, ...(protection ? { protection } : {}) })
  }

  deleteMeta(agentId: string, key: string): Promise<SuccessResult> {
    return this.del(`/agents/${enc(agentId)}/meta/${enc(key)}`)
  }

  identities(agentId: string): Promise<IdentityListResult> {
    return this.get(`/agents/${enc(agentId)}/identities`)
  }

  // --- logs / tables / umbilical replay -------------------------------------

  logs(agentId: string, options: { limit?: number; origin?: string; event?: string } = {}): Promise<LogsResult> {
    return this.get(`/agents/${enc(agentId)}/logs`, options)
  }

  logsAfter(agentId: string, afterId: number): Promise<{ agentId: string; logs: AdfLogEntry[] }> {
    return this.get(`/agents/${enc(agentId)}/logs/after`, { afterId })
  }

  tables(agentId: string): Promise<TableListResult> {
    return this.get(`/agents/${enc(agentId)}/tables`)
  }

  table(agentId: string, table: string, options: { limit?: number; offset?: number } = {}): Promise<TableQueryResult> {
    return this.get(`/agents/${enc(agentId)}/tables/${enc(table)}`, options)
  }

  umbilicalReplay(agentId: string, options: { sinceSeq?: number; limit?: number } = {}): Promise<UmbilicalReplayResult> {
    return this.get(`/agents/${enc(agentId)}/umbilical/events`, { since_seq: options.sinceSeq, limit: options.limit })
  }

  // --- HIL: tasks (approvals), asks, suspend --------------------------------

  tasks(agentId: string, options: { status?: TaskStatus; limit?: number } = {}): Promise<TaskListResult> {
    return this.get(`/agents/${enc(agentId)}/tasks`, options)
  }

  task(agentId: string, taskId: string): Promise<TaskResult> {
    return this.get(`/agents/${enc(agentId)}/tasks/${enc(taskId)}`)
  }

  resolveTask(agentId: string, taskId: string, input: TaskResolveInput): Promise<TaskResolveResult> {
    return this.post(`/agents/${enc(agentId)}/tasks/${enc(taskId)}/resolve`, input)
  }

  asks(agentId: string): Promise<AskListResult> {
    return this.get(`/agents/${enc(agentId)}/asks`)
  }

  /** `loop` picks the asking loop when request ids repeat across loops. */
  answerAsk(agentId: string, requestId: string, answer: string, loop?: string): Promise<AskAnswerResult> {
    return this.post(`/agents/${enc(agentId)}/asks/${enc(requestId)}/respond`, { answer, ...(loop ? { loop } : {}) })
  }

  respondSuspend(agentId: string, resume: boolean): Promise<SuspendResult> {
    return this.post(`/agents/${enc(agentId)}/suspend/respond`, { resume })
  }

  // --- per-agent runtime diagnostics ----------------------------------------

  agentRuntime(agentId: string): Promise<AgentRuntimeDiagnostics> {
    return this.get(`/agents/${enc(agentId)}/runtime`)
  }

  agentTriggers(agentId: string): Promise<AgentTriggersDiagnostics> {
    return this.get(`/agents/${enc(agentId)}/runtime/triggers`)
  }

  agentMcp(agentId: string): Promise<AgentMcpDiagnostics> {
    return this.get(`/agents/${enc(agentId)}/runtime/mcp`)
  }

  agentAdapters(agentId: string): Promise<AgentAdaptersDiagnostics> {
    return this.get(`/agents/${enc(agentId)}/runtime/adapters`)
  }

  agentWs(agentId: string): Promise<AgentWsDiagnostics> {
    return this.get(`/agents/${enc(agentId)}/runtime/ws`)
  }
}

function buildQuery(query: Query): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return err.message
  }
  return String(err)
}
