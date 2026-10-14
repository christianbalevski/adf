import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Options, Query, SDKMessage, SDKUserMessage, SDKRateLimitInfo, SessionStore, HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolProviderFormat } from '../../../shared/types/tool.types'
import type { ContentBlock } from '../../../shared/types/provider.types'
import { logger } from '../../utils/logger'
import { requireClaudeCode, claudeCodeEnv } from './claude-code'
import {
  MCP_SERVER_NAME, claudeToolAlias, fromClaudeToolName, toClaudeToolName, toolAliasMap,
  type ApiBlock, type TranscriptEntry,
} from './transcript'

/**
 * One live Claude Code process running one ADF conversation.
 *
 * ADF stays the agent: Claude Code's built-in tools are all disabled and ADF's
 * tools are exposed through an in-process MCP server whose handlers do not run
 * anything. When the model stops for tool use, the response is handed back to
 * ADF as an ordinary `tool_use` stop. ADF executes the tools with its own
 * permissions and audit trail, and the next createMessage() hands the results
 * back; Claude Code's (possibly sequential) handler calls pick them up and the
 * same request loop continues.
 */

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<Sdk> | null = null
// ESM-only package; loaded lazily so ADF starts without it being touched.
const loadSdk = (): Promise<Sdk> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

export interface SessionConfig {
  model: string
  system: string
  tools: ToolProviderFormat[]
  thinking: NonNullable<Options['thinking']>
  effort?: NonNullable<Options['effort']>
}

export interface TurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}

export interface TurnResult {
  messageId: string
  content: ContentBlock[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: TurnUsage
  rateLimit?: SDKRateLimitInfo
  /** Model input added outside ADF's messages since the last response, verbatim. */
  injections: string[]
}

export interface TurnCallbacks {
  onTextDelta?: (delta: string) => void
  onThinkingDelta?: (delta: string) => void
}

export interface ToolOutcome {
  content: string
  isError?: boolean
  /** Images ADF attached to this result (base64). */
  images?: Array<{ data: string; mimeType: string }>
}

/** Error carrying the status the executor's error classification expects. */
export class ClaudeProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly responseHeaders?: Record<string, string>) {
    super(message)
    this.name = 'ClaudeProviderError'
  }
}

/** Push-driven async iterable feeding user messages into the SDK. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private done = false

  push(item: SDKUserMessage): void {
    if (this.done) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  end(): void {
    this.done = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = null
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => { this.waiter = resolve })
      },
    }
  }
}

type BuiltBlock = { type: string; text: string; id?: string; name?: string; json: string; input?: unknown }

/** Accumulates one API message, from raw stream events or a whole message. */
class MessageBuilder {
  id = ''
  blocks: BuiltBlock[] = []
  stopReason: string | null = null
  usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  thinkingEstimate = 0

  reasoningTokens(): number | undefined {
    const reported = this.usage.reasoning ?? 0
    // Last resort when neither count arrived: ~4 chars per token of the
    // visible (summarized) trace.
    const chars = this.blocks.reduce((n, b) => n + (b.type === 'thinking' ? b.text.length : 0), 0)
    const best = Math.max(reported, this.thinkingEstimate, Math.ceil(chars / 4))
    return best > 0 || this.usage.reasoning !== undefined ? best : undefined
  }

  toContent(aliases: ReadonlyMap<string, string>): ContentBlock[] {
    const out: ContentBlock[] = []
    for (const b of this.blocks) {
      if (b.type === 'thinking' && b.text) out.push({ type: 'thinking', thinking: b.text })
      else if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text })
      else if (b.type === 'tool_use' && b.id && b.name) {
        const name = fromClaudeToolName(b.name, aliases)
        out.push({ type: 'tool_use', id: b.id, name, input: b.input ?? parseToolInput(name, b.json) })
      }
    }
    return out
  }

  toolUseIds(): string[] {
    return this.blocks.filter((b) => b.type === 'tool_use' && b.id).map((b) => b.id!)
  }

  /** A complete (non-streamed) message, e.g. Claude Code's non-streaming fallback. */
  static fromMessage(message: { id: string; content: unknown[]; stop_reason?: string | null; usage?: Partial<RawUsage> }): MessageBuilder {
    const m = new MessageBuilder()
    m.id = message.id
    m.stopReason = message.stop_reason ?? null
    for (const raw of message.content as Array<Record<string, unknown>>) {
      const type = String(raw.type)
      m.blocks.push({
        type,
        text: type === 'text' ? String(raw.text ?? '') : type === 'thinking' ? String(raw.thinking ?? '') : '',
        id: raw.id as string | undefined,
        name: raw.name as string | undefined,
        json: '',
        input: type === 'tool_use' ? raw.input ?? {} : undefined,
      })
    }
    const u = message.usage ?? {}
    m.usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    }
    return m
  }
}

/** Parse streamed tool input; a broken payload is reported, not run as `{}`. */
function parseToolInput(name: string, json: string): unknown {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch (err) {
    const msg = String(err)
    const error = msg.includes('Unterminated') || msg.includes('Unexpected end')
      ? `Tool "${name}" hit token limit. Increase max_tokens or use shorter content.`
      : `Tool "${name}" invalid JSON: ${msg}`
    logger.warn(`[ClaudeSubscription] ${error}`, { category: 'Provider' })
    return { _error: error, _raw_arguments: json.slice(0, 200) + '...' }
  }
}

const SESSION_ROOT = join(tmpdir(), 'adf-claude-code')
const STALE_MS = 24 * 60 * 60_000
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

let swept = false
/**
 * Remove leftovers of sessions a previous run never closed (crash, kill).
 * Only day-old entries: a concurrent Studio/daemon process may own newer ones.
 */
async function sweepStale(): Promise<void> {
  if (swept) return
  swept = true
  for (const [root, match] of [[SESSION_ROOT, () => true], [projectsDir(), (d: string) => d.includes('adf-claude-code-')]] as const) {
    try {
      for (const dir of await readdir(root)) {
        const path = join(root, dir)
        if (match(dir) && Date.now() - (await stat(path)).mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true })
      }
    } catch { /* best effort */ }
  }
}

function contextHook(get: () => string | undefined): Partial<Record<'PostToolBatch', HookCallbackMatcher[]>> {
  return {
    PostToolBatch: [{
      hooks: [async () => {
        const additionalContext = get()
        return additionalContext
          ? { hookSpecificOutput: { hookEventName: 'PostToolBatch' as const, additionalContext } }
          : {}
      }],
    }],
  }
}

function toolsServer(tools: ToolProviderFormat[], onCall: (toolUseId: string) => Promise<CallToolResult>): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: claudeToolAlias(t.name),
      description: t.description,
      inputSchema: { type: 'object', ...t.input_schema } as { type: 'object'; [k: string]: unknown },
      // Never hide ADF tools behind Claude Code's deferred tool search.
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }))
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolUseId = (req.params._meta as Record<string, unknown> | undefined)?.['claudecode/toolUseId']
    if (typeof toolUseId !== 'string') {
      return { content: [{ type: 'text', text: 'Tool call is missing its id; cannot route it to ADF.' }], isError: true }
    }
    return onCall(toolUseId)
  })
  return server
}

function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  return {
    content: [
      { type: 'text', text: outcome.content },
      ...(outcome.images ?? []).map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
    ],
    ...(outcome.isError ? { isError: true } : {}),
  }
}

type State = 'running' | 'awaiting_tools' | 'idle' | 'closed'

export class ClaudeCodeSession {
  /** Fingerprints of the ADF messages this session's conversation contains. */
  readonly fingerprints: string[] = []
  readonly configKey: string
  /** Times this session was continued rather than freshly started. */
  continuations = 0
  private state: State = 'idle'
  private query!: Query
  private input = new InputQueue()
  private builder: MessageBuilder | null = null
  /** Tool calls of the response last handed to ADF. */
  private deliveredToolIds: string[] = []
  /** Handlers Claude Code called, waiting for ADF's result. */
  private parked = new Map<string, (r: CallToolResult) => void>()
  /** ADF results whose handler Claude Code hasn't called yet (it runs tools one by one). */
  private ready = new Map<string, CallToolResult>()
  private streamedIds = new Set<string>()
  private waiter: { resolve: (r: TurnResult) => void; reject: (e: Error) => void; callbacks: TurnCallbacks } | null = null
  private idleWaiters: Array<() => void> = []
  private failure: Error | null = null
  private apiError: string | null = null
  private rateLimit?: SDKRateLimitInfo
  private pendingContext: string | undefined
  private lastCallContext: string | undefined
  private lastUsed = Date.now()
  private injections: string[] = []
  private prefixNoted = false
  private readonly cwd: string
  private readonly aliases: Map<string, string>

  private constructor(readonly config: SessionConfig, configKey: string) {
    this.configKey = configKey
    this.cwd = join(SESSION_ROOT, randomUUID())
    this.aliases = toolAliasMap(config.tools.map((t) => t.name))
  }

  /**
   * Start Claude Code. `history` (ADF messages already converted to a
   * transcript) seeds the conversation via a resumed session.
   */
  static async start(config: SessionConfig, configKey: string, history: (sessionId: string, cwd: string) => TranscriptEntry[]): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(config, configKey)
    await session.launch(history)
    return session
  }

  private async launch(history: (sessionId: string, cwd: string) => TranscriptEntry[]): Promise<void> {
    const [{ query }, install] = await Promise.all([loadSdk(), requireClaudeCode()])
    void sweepStale()
    await mkdir(this.cwd, { recursive: true })

    const sessionId = randomUUID()
    const entries = history(sessionId, this.cwd)
    // Claude Code mirrors its transcript here. ADF keeps its own history; the
    // mirror is read only for the context Claude Code adds on its own, so the
    // loop can show it. load() serves the seed for --resume.
    const store: SessionStore = {
      append: async (_key, batch) => { this.collectInjections(batch) },
      load: async () => (entries.length > 0 ? entries : null),
    }

    const env = claudeCodeEnv({
      // ADF manages context (compaction, tool-output limits) itself.
      DISABLE_AUTO_COMPACT: '1',
      MAX_MCP_OUTPUT_TOKENS: '1000000',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      // Tool calls wait on ADF (approvals, long tools); never time them out.
      MCP_TOOL_TIMEOUT: '100000000',
      // Keep Claude Code's own additions to the model input to the minimum:
      // no token countdown, no CLAUDE.md files, no auto-memory, no skills.
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',    })

    const mcp = toolsServer(this.config.tools, (id) => this.onToolCall(id))
    this.query = query({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: install.path,
        model: this.config.model,
        systemPrompt: this.config.system,
        tools: [],
        mcpServers: { [MCP_SERVER_NAME]: { type: 'sdk', name: MCP_SERVER_NAME, instance: mcp } },
        // Claude Code only relays calls; ADF applies its own permissions when
        // it executes them.
        allowedTools: this.config.tools.map((t) => toClaudeToolName(t.name)),
        hooks: contextHook(() => this.takeContext()),
        settingSources: [],
        strictMcpConfig: true,
        skills: [],
        plugins: [],
        includePartialMessages: true,
        verbatimPrompts: true,
        thinking: this.config.thinking,
        ...(this.config.effort ? { effort: this.config.effort } : {}),
        // ADF's loop is the record. The mirror needs Claude Code's local
        // transcript; cleanup() removes it when the session ends.
        sessionStore: store,
        sessionStoreFlush: 'eager',
        ...(entries.length > 0 ? { resume: sessionId } : {}),
        cwd: this.cwd,
        env,
        stderr: (data) => logger.debug(`[ClaudeCode] ${data.trim()}`, { category: 'Provider' }),
      },
    })
    void this.pump()
  }

  // --- context Claude Code adds ---------------------------------------------

  /**
   * Record model input Claude Code adds itself (environment, model, account
   * email, date; the system prompt prefix), verbatim, for the loop. The
   * attachments carrying ADF's own content are skipped (see below).
   */
  private collectInjections(batch: Array<Record<string, unknown>>): void {
    for (const e of batch) {
      if (e.type !== 'attachment') continue
      const attachment = e.attachment as { type?: string; cliPrefix?: string } | undefined
      if (attachment?.type === 'prompt_snapshot') {
        if (attachment.cliPrefix && !this.prefixNoted) {
          this.prefixNoted = true
          this.injections.push(`Claude Code system prompt prefix: ${attachment.cliPrefix}`)
        }
        continue
      }
      // ADF's own content, already in the loop: dynamic instructions (hook
      // context) and user messages folded into a running turn.
      if (attachment?.type === 'hook_additional_context' || attachment?.type === 'queued_command') continue
      const rendered = (e.rendered as Array<{ content?: unknown }> | undefined)
        ?.map((r) => (typeof r.content === 'string' ? r.content : ''))
        .filter(Boolean)
        .join('\n')
      if (rendered) this.injections.push(rendered)
    }
  }

  /** Note input ADF itself had to add (e.g. the cold-start "Continue."). */
  noteInjection(text: string): void {
    this.injections.push(text)
  }

  // --- tool bridge -----------------------------------------------------------

  private onToolCall(toolUseId: string): Promise<CallToolResult> {
    const result = this.ready.get(toolUseId)
    if (result) {
      this.ready.delete(toolUseId)
      return Promise.resolve(result)
    }
    if (this.state === 'closed') {
      return Promise.resolve({ content: [{ type: 'text', text: 'Cancelled.' }], isError: true })
    }
    return new Promise((resolve) => { this.parked.set(toolUseId, resolve) })
  }

  /** Tool calls ADF must answer before this session can continue. */
  get pendingToolIds(): string[] {
    return this.deliveredToolIds
  }

  get isIdle(): boolean { return this.state === 'idle' }
  get isAwaitingTools(): boolean { return this.state === 'awaiting_tools' }
  get isClosed(): boolean { return this.state === 'closed' }
  get idleForMs(): number { return Date.now() - this.lastUsed }

  /**
   * Per-call instructions (ADF's dynamic instructions). The other providers
   * send them as a trailing message on every call; a live session keeps what
   * it was sent, so they are delivered when they differ from the previous
   * call's — including when they return after a call without them.
   */
  private setContext(context: string | undefined): void {
    const fresh = context && context !== this.lastCallContext ? context : undefined
    this.lastCallContext = context
    const parts = [this.pendingContext, fresh].filter(Boolean)
    this.pendingContext = parts.length > 0 ? parts.join('\n\n') : undefined
  }

  private takeContext(): string | undefined {
    const ctx = this.pendingContext
    this.pendingContext = undefined
    return ctx
  }

  // --- driving a turn --------------------------------------------------------

  /** Start the next model request with a new user message. */
  async sendUser(content: ApiBlock[], context: string | undefined, callbacks: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult> {
    if (this.state === 'running') await new Promise<void>((r) => this.idleWaiters.push(r))
    if (this.state !== 'idle') throw this.failure ?? new ClaudeProviderError('Claude Code session is not ready.')
    this.setContext(context)
    const ctx = this.takeContext()
    const blocks = ctx ? [...content, { type: 'text' as const, text: ctx }] : content
    this.state = 'running'
    const wait = this.awaitTurn(callbacks, signal)
    this.input.push({ type: 'user', message: { role: 'user', content: blocks as never }, parent_tool_use_id: null })
    return wait
  }

  /**
   * Hand ADF's tool results back. `extra` is text that arrived alongside them
   * (mid-batch user messages, notices); it reaches the model with the batch.
   */
  sendToolResults(results: Map<string, ToolOutcome>, context: string | undefined, extra: string | undefined, callbacks: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult> {
    if (this.state !== 'awaiting_tools') throw new ClaudeProviderError('Claude Code session is not waiting for tool results.')
    this.setContext(context)
    this.state = 'running'
    const wait = this.awaitTurn(callbacks, signal)
    this.deliveredToolIds = []
    // Messages that arrived while the tools ran go in as a real user message,
    // which Claude Code folds into the turn right after this tool batch.
    if (extra) {
      this.input.push({ type: 'user', message: { role: 'user', content: extra }, parent_tool_use_id: null, priority: 'next' })
    }
    for (const [id, outcome] of results) {
      const result = toCallToolResult(outcome)
      const resolve = this.parked.get(id)
      if (resolve) {
        this.parked.delete(id)
        resolve(result)
      } else {
        this.ready.set(id, result)
      }
    }
    return wait
  }

  private awaitTurn(callbacks: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult> {
    if (this.failure) return Promise.reject(this.failure)
    this.lastUsed = Date.now()
    return new Promise<TurnResult>((resolve, reject) => {
      const onAbort = () => {
        this.close()
        reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
      }
      const done = () => signal?.removeEventListener('abort', onAbort)
      this.waiter = {
        callbacks,
        resolve: (r) => { done(); resolve(r) },
        reject: (e) => { done(); reject(e) },
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // --- event pump ------------------------------------------------------------

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) this.handle(msg)
      this.fail(new ClaudeProviderError('Claude Code exited unexpectedly.', 500))
    } catch (err) {
      this.fail(new ClaudeProviderError(`Claude Code failed: ${err instanceof Error ? err.message : String(err)}`, 500))
    }
    void this.cleanup()
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'stream_event':
        if (msg.parent_tool_use_id === null) this.handleStreamEvent(msg.event as unknown as StreamEvent)
        return
      case 'assistant': {
        if (msg.parent_tool_use_id !== null) return
        // Claude Code reports API failures (auth, limits, overload) as a
        // synthetic assistant message carrying `error`.
        if (msg.error) {
          const text = (msg.message.content as Array<{ type: string; text?: string }>)
            .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
            .join(' ')
            .trim()
          this.apiError = `${msg.error}: ${text || 'request failed'}`
          return
        }
        // A response that never streamed (Claude Code's non-streaming
        // fallback) arrives only as a whole message.
        const message = msg.message as unknown as { id: string; content: unknown[]; stop_reason?: string | null; usage?: Partial<RawUsage> }
        if (message.stop_reason && !this.streamedIds.has(message.id) && this.builder?.id !== message.id) {
          this.complete(MessageBuilder.fromMessage(message))
        }
        return
      }
      case 'system':
        // The API's usage.thinking_tokens undercounts summarized thinking
        // (often 0); Claude Code's running estimate tracks the real length.
        if (msg.subtype === 'thinking_tokens' && this.builder) {
          this.builder.thinkingEstimate = Math.max(this.builder.thinkingEstimate, msg.estimated_tokens)
        }
        return
      case 'rate_limit_event':
        this.rateLimit = msg.rate_limit_info
        return
      case 'result': {
        const errorText = msg.subtype === 'success' ? (msg.is_error ? msg.result : null) : msg.errors.join('; ')
        const failure = errorText || this.apiError
          ? this.toError(this.apiError ?? errorText ?? 'Claude request failed')
          : this.waiter
            // The turn ended without a response ADF could take.
            ? new ClaudeProviderError('Claude Code ended the turn without a response.', 500)
            : null
        this.apiError = null
        if (failure) {
          // Claude Code has already recorded the failed turn; a retry on this
          // session would repeat the prompt. Start over from ADF's history.
          this.fail(failure)
          return
        }
        this.state = 'idle'
        for (const w of this.idleWaiters.splice(0)) w()
        return
      }
      default:
        return
    }
  }

  private handleStreamEvent(e: StreamEvent): void {
    const cb = this.waiter?.callbacks
    switch (e.type) {
      case 'message_start': {
        this.builder = new MessageBuilder()
        this.builder.id = e.message.id
        const u = e.message.usage ?? {}
        this.builder.usage.input = u.input_tokens ?? 0
        this.builder.usage.cacheRead = u.cache_read_input_tokens ?? 0
        this.builder.usage.cacheWrite = u.cache_creation_input_tokens ?? 0
        return
      }
      case 'content_block_start': {
        const b = e.content_block
        if (!this.builder) return
        this.builder.blocks[e.index] = {
          type: b.type,
          text: b.type === 'text' ? b.text ?? '' : b.type === 'thinking' ? b.thinking ?? '' : '',
          id: b.id,
          name: b.name,
          json: '',
        }
        return
      }
      case 'content_block_delta': {
        const block = this.builder?.blocks[e.index]
        if (!block) return
        const d = e.delta
        if (d.type === 'text_delta' && d.text) {
          block.text += d.text
          cb?.onTextDelta?.(d.text)
        } else if (d.type === 'thinking_delta' && d.thinking) {
          block.text += d.thinking
          cb?.onThinkingDelta?.(d.thinking)
        } else if (d.type === 'input_json_delta' && d.partial_json) {
          block.json += d.partial_json
        }
        return
      }
      case 'message_delta':
        if (!this.builder) return
        if (e.delta?.stop_reason) this.builder.stopReason = e.delta.stop_reason
        if (e.usage) {
          if (typeof e.usage.output_tokens === 'number') this.builder.usage.output = e.usage.output_tokens
          const thinking = e.usage.output_tokens_details?.thinking_tokens
          if (typeof thinking === 'number') this.builder.usage.reasoning = thinking
          if (typeof e.usage.input_tokens === 'number') this.builder.usage.input = e.usage.input_tokens
          if (typeof e.usage.cache_read_input_tokens === 'number') this.builder.usage.cacheRead = e.usage.cache_read_input_tokens
          if (typeof e.usage.cache_creation_input_tokens === 'number') this.builder.usage.cacheWrite = e.usage.cache_creation_input_tokens
        }
        return
      case 'message_stop':
        if (!this.builder) return
        this.streamedIds.add(this.builder.id)
        this.complete(this.builder)
        this.builder = null
        return
      default:
        return
    }
  }

  /**
   * Hand a completed model response to the waiting createMessage(). Tool-use
   * responses are delivered at once: Claude Code may call the tool handlers
   * one at a time, so waiting for every call first would deadlock.
   */
  private complete(msg: MessageBuilder): void {
    const w = this.waiter
    if (!w) return
    this.waiter = null
    this.lastUsed = Date.now()

    const toolIds = msg.toolUseIds()
    const stop = msg.stopReason
    const isToolUse = stop === 'tool_use' && toolIds.length > 0
    if (isToolUse) {
      this.state = 'awaiting_tools'
      this.deliveredToolIds = toolIds
      this.ready.clear()
    }
    w.resolve({
      messageId: msg.id,
      content: msg.toContent(this.aliases),
      stopReason: isToolUse ? 'tool_use'
        : stop === 'max_tokens' || stop === 'model_context_window_exceeded' ? 'max_tokens'
          : stop === 'stop_sequence' ? 'stop_sequence' : 'end_turn',
      usage: { ...msg.usage, reasoning: msg.reasoningTokens() },
      ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}),
      injections: this.injections.splice(0),
    })
    // A truncated or refused response makes Claude Code act on its own
    // (continue, retry, fall back); the session can no longer mirror ADF.
    if (stop === 'max_tokens' || stop === 'model_context_window_exceeded' || stop === 'refusal') this.close()
  }

  private toError(raw: string): ClaudeProviderError {
    const [kind] = raw.split(':', 1)
    const detail = raw.slice(kind.length + 1).trim() || raw
    switch (kind) {
      case 'authentication_failed':
      case 'oauth_org_not_allowed':
      case 'cloud_credential_error':
        return new ClaudeProviderError(`Claude sign-in is not valid (${detail}). Sign in with Claude again.`, 401)
      case 'account_on_hold':
      case 'verification_required':
        return new ClaudeProviderError(`Claude account needs attention (${detail}). Check your account at claude.ai, then sign in with Claude again.`, 403)
      case 'billing_error':
        return new ClaudeProviderError(`Claude plan billing problem: ${detail}`, 402)
      case 'rate_limit': {
        const resetsAt = this.rateLimit?.status === 'rejected' ? this.rateLimit.resetsAt : undefined
        const retryAfter = resetsAt && resetsAt * 1000 > Date.now() ? Math.round(resetsAt - Date.now() / 1000) : undefined
        return new ClaudeProviderError(`Claude plan usage limit reached: ${detail}`, 429, retryAfter ? { 'retry-after': String(retryAfter) } : undefined)
      }
      case 'overloaded':
        return new ClaudeProviderError(`Claude is overloaded: ${detail}`, 529)
      case 'server_error':
        return new ClaudeProviderError(`Claude server error: ${detail}`, 500)
      case 'invalid_request':
      case 'model_not_found':
      case 'max_output_tokens':
        return new ClaudeProviderError(`Claude rejected the request: ${detail}`, 400)
      default:
        return new ClaudeProviderError(raw, 500)
    }
  }

  private fail(err: Error): void {
    if (this.state === 'closed') return
    this.failure = err
    this.close()
  }

  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.failure ??= new ClaudeProviderError('Claude Code session closed.')
    for (const resolve of this.parked.values()) {
      resolve({ content: [{ type: 'text', text: 'Cancelled.' }], isError: true })
    }
    this.parked.clear()
    this.ready.clear()
    this.input.end()
    try { this.query?.close() } catch { /* already gone */ }
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.reject(this.failure)
    }
    for (const w of this.idleWaiters.splice(0)) w()
  }

  /** Runs after the Claude Code process has exited (end of pump). */
  private async cleanup(): Promise<void> {
    try { await rm(this.cwd, { recursive: true, force: true }) } catch { /* best effort */ }
    // Claude Code keys its project folder by the sanitized cwd, which ends in
    // this session's unique directory name.
    const tag = basename(this.cwd)
    try {
      for (const dir of await readdir(projectsDir())) {
        if (dir.endsWith(tag)) await rm(join(projectsDir(), dir), { recursive: true, force: true })
      }
    } catch { /* best effort */ }
  }
}

/** Raw Anthropic stream event (the fields the session reads). */
type StreamEvent =
  | { type: 'message_start'; message: { id: string; usage?: Partial<RawUsage> } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; text?: string; thinking?: string; id?: string; name?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string | null }; usage?: Partial<RawUsage> & { output_tokens_details?: { thinking_tokens?: number } } }
  | { type: 'message_stop' }
  | { type: 'ping' }

interface RawUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const MODELS_TTL_MS = 10 * 60_000
let modelsCache: { at: number; models: Promise<string[]> } | null = null

/** Models the signed-in plan offers, per Claude Code. Cached; one probe in flight. */
export function listSupportedModels(): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models
  const models = fetchSupportedModels()
  modelsCache = { at: Date.now(), models }
  models.catch(() => { if (modelsCache?.models === models) modelsCache = null })
  return models
}

async function fetchSupportedModels(): Promise<string[]> {
  const [{ query }, install] = await Promise.all([loadSdk(), requireClaudeCode()])
  const input = new InputQueue()
  const cwd = join(SESSION_ROOT, randomUUID())
  await mkdir(cwd, { recursive: true })
  const q = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: install.path,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      plugins: [],
      persistSession: false,
      cwd,
      env: claudeCodeEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }),
    },
  })
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Claude Code did not list models in time.')), 30_000)),
    ])
    return [...new Set(models.map((m) => m.resolvedModel ?? m.value).filter((id) => id.startsWith('claude-')))]
  } finally {
    input.end()
    q.close()
    setTimeout(() => { void rm(cwd, { recursive: true, force: true }).catch(() => {}) }, 2_000)
  }
}

/** Drop cached model lists (sign-in changed). */
export function invalidateSupportedModels(): void {
  modelsCache = null
}
