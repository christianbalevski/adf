// Typed client for the ADF daemon HTTP API (docs/daemon/http-api.md), shared
// by the terminal app and Studio main (design D8).
//
// One method per endpoint a client uses. Every method rejects with DaemonError
// (status null = daemon unreachable). Nothing here caches or retries (except
// one retry after a 401 when the credentials say the token changed): callers
// decide what to refetch, so every state change stays observable.
//
// Portable: no Node or DOM imports, only fetch, AbortController, URL and
// timers. Where the token comes from is injected (DaemonCredentials); the
// Node implementation (env, token file, local proof) is cli/daemon-url.ts.

import { EventStream, isRedirect, redirectMessage, type EventStreamOptions, type StreamFrame } from './sse'
import { normalizeRuntime } from './normalize'
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
  type AgentToolsResult,
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
  type TaskAlwaysApproveResult,
  type FolderAgentsList,
  type TrackedAgentsList,
  type TrackedDirsList,
  type TrackDirResult,
  type UntrackDirResult,
  type TaskApproveAllResult,
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
  type AddProviderInput,
  type AddProviderResult,
  type PublicProvider,
  type AdapterInstanceConfig,
  type McpServerConfig,
  type McpRestartResult,
  type CredentialMetaResult,
  type CredentialWriteOptions,
  type DaemonEventFrame,
  type TemplateDetail,
  type TemplateReview,
  type TemplateWriteResult,
} from './types'

/**
 * How a client authenticates to ONE daemon origin. The client calls these
 * only for requests whose URL has that origin, so a token never reaches
 * another host, even when a path would turn the URL into one.
 */
export interface DaemonCredentials {
  /** Bearer token, read before every request and every stream (re)connect. */
  token(): string | undefined
  /**
   * The daemon answered 401: re-read the token's source. True when the
   * token changed, so the request is retried once.
   */
  refresh?(): boolean
  /** Extra headers for a request to `path` (X-ADF-Local-Proof on local-only routes). */
  localProof?(path: string): Record<string, string>
}

export interface DaemonClientOptions {
  /** Daemon base URL. Trailing slashes are dropped. */
  baseUrl: string
  /** Credentials for `baseUrl`'s origin. None: requests carry no token. */
  credentials?: DaemonCredentials
  /**
   * Credentials for the client `withBaseUrl` builds: for another origin, or
   * for any origin with an explicit `token` (so it can add e.g. the local
   * proof). None: another origin carries no token, an explicit token is sent
   * as is (staticCredentials).
   */
  credentialsFor?: (baseUrl: string, token?: string) => DaemonCredentials | undefined
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Per-request timeout for non-streaming calls. Default 15s. */
  timeoutMs?: number
}

/** A fixed bearer token (`--token`, Studio's stored remote token). */
export function staticCredentials(token: string): DaemonCredentials {
  return { token: () => token }
}

export type Query = Record<string, string | number | boolean | undefined | null>

export interface RequestOptions {
  query?: Query
  body?: unknown
  signal?: AbortSignal
  /** This call's timeout; default the client's (package installs, MCP connects need longer). */
  timeoutMs?: number
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const enc = encodeURIComponent

/** `url`'s origin, or null when it does not parse or has an opaque origin (`'null'`: file:, data:, …). */
function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

export class DaemonClient {
  readonly baseUrl: string
  /** The one origin `credentials` are sent to. */
  private readonly origin: string | null
  private readonly credentials: DaemonCredentials | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly options: DaemonClientOptions

  constructor(options: DaemonClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.origin = originOf(this.baseUrl)
    this.credentials = options.credentials
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.options = options
  }

  /**
   * Same transport (fetch, timeout) against another daemon. The current
   * credentials are carried over only to the same origin without a `token`;
   * otherwise the client gets `credentialsFor(baseUrl, token)` (or just
   * `token`), or none — never this daemon's.
   */
  withBaseUrl(baseUrl: string, token?: string): this {
    const next = baseUrl.replace(/\/+$/, '')
    const credentials = token
      ? this.options.credentialsFor?.(next, token) ?? staticCredentials(token)
      : this.origin !== null && originOf(next) === this.origin
        ? this.credentials
        : this.options.credentialsFor?.(next)
    return this.derive({ ...this.options, baseUrl: next, credentials })
  }

  /** Same daemon and credentials, another default timeout for the calls made through it. */
  withTimeout(timeoutMs: number): this {
    return this.derive({ ...this.options, timeoutMs })
  }

  /**
   * A client like this one with other options; `withBaseUrl` and
   * `withTimeout` build through it. A subclass whose constructor takes other
   * options overrides it so the derived client keeps the subclass.
   */
  protected derive(options: DaemonClientOptions): this {
    return new (this.constructor as new (options: DaemonClientOptions) => this)(options)
  }

  /** Whether requests carry a bearer token. */
  get hasToken(): boolean {
    return !!this.credentials?.token()
  }

  // --- transport ------------------------------------------------------------

  url(path: string, query?: Query): string {
    const qs = query ? buildQuery(query) : ''
    return `${this.baseUrl}${path}${qs}`
  }

  /** Headers for a request to `baseUrl` itself. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.headersFor(this.baseUrl, extra)
  }

  /**
   * Headers for a request to `url`: the bearer token (and `localProof` for
   * `path`) only when `url` has the credentials' origin. A path that turns
   * the URL into another host (`@host`, a full URL) gets no credentials.
   */
  private headersFor(url: string, extra: Record<string, string> = {}, path?: string): Record<string, string> {
    const own = this.ownsUrl(url)
    const token = own ? this.credentials?.token() : undefined
    return {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(own && path !== undefined ? this.credentials?.localProof?.(path) ?? {} : {}),
      ...extra,
    }
  }

  private ownsUrl(url: string): boolean {
    return this.origin !== null && originOf(url) === this.origin
  }

  async request<T>(method: Method, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const url = this.url(path, options.query)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        // Proxy-mode daemons (ADF_DAEMON_BEHIND_PROXY) need this machine's proof on local-only routes.
        headers: this.headersFor(url, options.body !== undefined ? { 'Content-Type': 'application/json' } : {}, path),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        // Never followed: a 302 would forward the token / local proof, a 307 the body.
        redirect: 'manual',
      })
    } catch (err) {
      const reason = controller.signal.aborted && !options.signal?.aborted ? `timed out after ${timeoutMs}ms` : errorMessage(err)
      throw new DaemonError(`Cannot reach daemon at ${this.baseUrl}: ${reason}`, null)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (isRedirect(response)) {
      void response.body?.cancel().catch(() => {})
      throw new DaemonError(redirectMessage(this.baseUrl, response), response.status)
    }
    const text = await response.text()
    let body: unknown = null
    if (text.trim()) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (!response.ok) {
      if (response.status === 401 && !retried && this.ownsUrl(url) && this.credentials?.refresh?.()) return this.request<T>(method, path, options, true)
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

  /**
   * Live events (SSE) with auto-reconnect: `GET /events` (umbilical frames)
   * unless `path` names another stream. Call `.start()` on the result.
   */
  events<F extends StreamFrame = DaemonEventFrame>(options: Omit<EventStreamOptions<F>, 'baseUrl' | 'headers' | 'fetch'>): EventStream<F> {
    // A function: a reconnect sends the current token (refreshed after a 401), and only to this origin.
    return new EventStream<F>({ ...options, baseUrl: this.baseUrl, headers: url => this.headersFor(url, { Accept: 'text/event-stream' }), fetch: this.fetchImpl })
  }

  // --- daemon ---------------------------------------------------------------

  health(): Promise<{ ok: boolean }> {
    return this.get('/health')
  }

  /** GET /runtime, normalized: a partial or older daemon's response has every section the views read. */
  async runtime(): Promise<RuntimeOverview> {
    return normalizeRuntime(await this.get<unknown>('/runtime'))
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

  /** Add an API-key provider. The key goes to the daemon secret store; the reply never carries it. */
  addProvider(input: AddProviderInput): Promise<AddProviderResult> {
    return this.post('/runtime/providers', input)
  }

  removeProvider(id: string): Promise<{ removed: string; providers: PublicProvider[] }> {
    return this.del(`/runtime/providers/${enc(id)}`)
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

  // --- subscription provider sign-in (ChatGPT, Grok, Claude) ----------------
  // Sign-in flows themselves (browser, callback server, polling) live in
  // cli/auth-flow.ts over `request`; these are the plain reads and sign-out.

  subscriptionStatus(provider: SubscriptionProvider): Promise<SubscriptionAuthStatus> {
    return this.get(`/auth/${provider}/status`)
  }

  logoutSubscription(provider: SubscriptionProvider): Promise<SuccessResult> {
    return this.post(`/auth/${provider}/logout`)
  }

  /** Hand the code Claude's sign-in page shows to the daemon's waiting Claude Code. */
  submitClaudeCode(code: string): Promise<SuccessResult> {
    return this.post('/auth/claude/code', { code })
  }

  /** Stop a running Claude sign-in on the daemon host. */
  cancelClaudeAuth(): Promise<SuccessResult> {
    return this.post('/auth/claude/cancel')
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

  /** Approve ▸ Always approve: un-restricts the pending request's tool on the
   *  host config, then approves it. DaemonError status 409 when the request is
   *  a protection override / one-shot approval / locked declaration. */
  alwaysApproveTask(agentId: string, taskId: string): Promise<TaskAlwaysApproveResult> {
    return this.post(`/agents/${enc(agentId)}/tasks/${enc(taskId)}/always-approve`, {})
  }

  /** Approve every pending gated approval (all loops, or just `loop`); protection overrides are skipped. */
  approveAllTasks(agentId: string, loop?: string): Promise<TaskApproveAllResult> {
    return this.post(`/agents/${enc(agentId)}/tasks/approve-all`, loop ? { loop } : {})
  }

  // --- tracked agent folders (Studio's tracked directories) -----------------

  trackedDirs(): Promise<TrackedDirsList> {
    return this.get('/tracked-dirs')
  }

  /** Track an absolute folder now and autostart its agents (review gate applies). 409 when already tracked. */
  trackDir(path: string): Promise<TrackDirResult> {
    return this.post('/tracked-dirs', { path })
  }

  /** Stop tracking (files are never deleted). `unload` also unloads the agents loaded from under it. */
  untrackDir(path: string, options: { unload?: boolean } = {}): Promise<UntrackDirResult> {
    return this.del('/tracked-dirs', { path, unload: options.unload })
  }

  /** The agents in one tracked folder and where each stands (loaded, needs review, not autostart, stopped + load error). */
  folderAgents(path: string): Promise<FolderAgentsList> {
    return this.get('/tracked-dirs/agents', { path })
  }

  /**
   * Every tracked folder with its agents (GET /tracked-dirs/agents/all). On a
   * daemon without that route: GET /tracked-dirs, then each folder's agents.
   */
  async trackedAgents(): Promise<TrackedAgentsList> {
    try {
      return await this.get<TrackedAgentsList>('/tracked-dirs/agents/all')
    } catch (err) {
      if (!(err instanceof DaemonError) || err.status !== 404) throw err
    }
    const list = await this.trackedDirs()
    const folders = await Promise.all(list.directories.map(async entry => {
      const agents = entry.exists ? await this.folderAgents(entry.path).then(r => r.agents, () => []) : []
      return { ...entry, agents }
    }))
    return { maxDepth: list.maxDepth, folders }
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

  // --- MCP servers (per agent) ------------------------------------------------

  /** Add a server to the agent config (it connects on start, or with restartMcpServer now). */
  attachMcpServer(agentId: string, server: McpServerConfig): Promise<{ agentId: string; serverName: string; success: true; alreadyAttached: boolean }> {
    return this.post(`/agents/${enc(agentId)}/mcp/servers`, { server })
  }

  /** Remove it and delete its stored credentials (`mcp:<namespace>:*`; the package, else the server name). */
  detachMcpServer(agentId: string, serverName: string, credentialNamespace?: string): Promise<{ agentId: string; serverName: string; success: true; deletedCredentials: number }> {
    return this.request('DELETE', `/agents/${enc(agentId)}/mcp/servers/${enc(serverName)}`, { query: { credentialNamespace } })
  }

  /** (Re)connect one server of a running agent now; the outcome carries tools found or the error. */
  restartMcpServer(agentId: string, serverName: string): Promise<McpRestartResult> {
    return this.request('POST', `/agents/${enc(agentId)}/mcp/servers/${enc(serverName)}/restart`, { timeoutMs: 180_000 })
  }

  /** Store one env value for an MCP server in the agent's identity store (`mcp:<namespace>:<key>`, sealed). */
  setMcpCredential(agentId: string, namespace: string, envKey: string, value: string, opts: CredentialWriteOptions = {}): Promise<{ success: true; replaced?: boolean }> {
    return this.put(`/agents/${enc(agentId)}/mcp/credentials`, { npmPackage: namespace, envKey, value, ...(opts.replace ? { replace: true } : {}) })
  }

  /** What is stored for an MCP server's env keys: metadata only, never values. */
  mcpCredentials(agentId: string, namespace: string): Promise<CredentialMetaResult> {
    return this.get(`/agents/${enc(agentId)}/mcp/credentials`, { npmPackage: namespace })
  }

  /** Install an MCP server package on the daemon host (npm or Python). Synchronous: can take a minute. */
  installMcpPackage(kind: 'npm' | 'python', pkg: string): Promise<{ success: true; installed: unknown }> {
    return this.request('POST', `/admin/mcp/packages/${kind}`, { body: { package: pkg }, timeoutMs: 600_000 })
  }

  // --- messaging adapters (per agent) -----------------------------------------

  /** Store one adapter credential in the agent's identity keystore (sealed under the owner identity). */
  setAdapterCredential(agentId: string, adapterType: string, envKey: string, value: string, opts: CredentialWriteOptions = {}): Promise<{ agentId: string; adapterType: string; envKey: string; success: true; replaced?: boolean }> {
    return this.put(`/agents/${enc(agentId)}/adapters/credentials`, { adapterType, envKey, value, ...(opts.replace ? { replace: true } : {}) })
  }

  /** What is stored for a channel's credentials: metadata only, never values. */
  adapterCredentials(agentId: string, adapterType: string): Promise<CredentialMetaResult> {
    return this.get(`/agents/${enc(agentId)}/adapters/credentials`, { adapterType })
  }

  /** Enable an adapter in the agent config; a running agent starts it. */
  attachAdapter(agentId: string, adapterType: string, config: AdapterInstanceConfig): Promise<{ agentId: string; adapterType: string; success: true; alreadyAttached: boolean }> {
    return this.post(`/agents/${enc(agentId)}/adapters`, { adapterType, config })
  }

  /** Remove the adapter from the config and delete its stored credentials. */
  detachAdapter(agentId: string, adapterType: string): Promise<{ agentId: string; adapterType: string; success: true; deletedCredentials: number }> {
    return this.del(`/agents/${enc(agentId)}/adapters/${enc(adapterType)}`)
  }

  agentWs(agentId: string): Promise<AgentWsDiagnostics> {
    return this.get(`/agents/${enc(agentId)}/runtime/ws`)
  }

  // --- agent templates (/templates; the list is `templates()`) — owner: src/main/tui/templates ---

  /** Summary + contents (config, seed files, extra files) + whether it is the default. */
  templateDetail(id: string): Promise<TemplateDetail> {
    return this.get(`/templates/${enc(id)}`)
  }

  /** Blank, or a duplicate of `fromId`. 201 `{ id, template }`. */
  createTemplate(input: { name: string; fromId?: string }): Promise<TemplateWriteResult> {
    return this.post('/templates', input)
  }

  /** Rename and/or notes (`''` clears one). A rename moves the file: use the returned id. */
  updateTemplate(id: string, patch: { name?: string; description?: string; warning?: string }): Promise<TemplateWriteResult> {
    return this.patch(`/templates/${enc(id)}`, patch)
  }

  /** Moves the file to the daemon's templates-trash folder (never a hard delete). */
  deleteTemplate(id: string): Promise<{ deleted: true; id: string; trashFolder: string; defaultId: string }> {
    return this.del(`/templates/${enc(id)}`)
  }

  setDefaultTemplate(id: string): Promise<{ defaultId: string }> {
    return this.post(`/templates/${enc(id)}/default`)
  }

  /** Shipped templates only: back to the shipped version. */
  resetTemplate(id: string): Promise<TemplateWriteResult> {
    return this.post(`/templates/${enc(id)}/reset`)
  }

  templateReview(id: string): Promise<TemplateReview> {
    return this.get(`/templates/${enc(id)}/review`)
  }

  /** Claims the file under this owner. 400 password_required / 403 wrong_password / 409 identity_not_ready. */
  acceptTemplateReview(id: string, password?: string): Promise<TemplateWriteResult & { reviewed: true }> {
    return this.post(`/templates/${enc(id)}/review/accept`, password ? { password } : {})
  }

  putTemplateConfig(id: string, config: AgentConfig): Promise<{ id: string; success: true }> {
    return this.put(`/templates/${enc(id)}/config`, { config })
  }

  putTemplateFile(id: string, path: string, content: string): Promise<{ id: string; path: string; success: true }> {
    return this.put(`/templates/${enc(id)}/files`, { path, content })
  }

  removeTemplateFile(id: string, path: string): Promise<{ id: string; path: string; success: true }> {
    return this.del(`/templates/${enc(id)}/files`, { path })
  }

  // --- agent tool catalog (Inspect › Settings, /tools) -----------------------

  /** Built-in + MCP + declared tools with declared state and descriptions (read-only; write via putConfig). */
  agentTools(agentId: string): Promise<AgentToolsResult> {
    return this.get(`/agents/${enc(agentId)}/tools`)
  }

  // --- context usage (/context) ------------------------------------------------

  /** One loop's context breakdown: categories (biggest `items` per category), compact threshold, total. */
  agentContext(agentId: string, loop?: string, items?: number): Promise<import('./types').AgentContextResult> {
    return this.get(`/agents/${enc(agentId)}/context`, { loop: loop && loop !== MAIN_LOOP ? loop : undefined, items })
  }

  // --- agent vitals (/vitals) ------------------------------------------------

  /** Header facts plus Reach/Access/Autonomy/Experience. `force` skips the daemon's cache. */
  agentVitals(agentId: string, force = false): Promise<import('./types').AgentVitals> {
    return this.get(`/agents/${enc(agentId)}/vitals`, { force: force ? 1 : undefined })
  }

  /** Next wakes, 14 days of turns and cost, and what the file holds (mind, skills, tables). `force` skips the daemon's cache. */
  agentActivity(agentId: string, force = false): Promise<import('./types').AgentActivity> {
    return this.get(`/agents/${enc(agentId)}/activity`, { force: force ? 1 : undefined })
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
