import { createHash } from 'node:crypto'
import type { LLMProvider, CreateMessageOptions } from '../provider.interface'
import type { LLMMessage, LLMResponse, ReasoningEffort } from '../../../shared/types/provider.types'
import type { ProviderType } from '../../../shared/constants/adf-defaults'
import { toProviderError } from '../ai-sdk-provider'
import { logger } from '../../utils/logger'
import { getClaudeAuthManager } from './auth-manager'
import { ClaudeCodeSession, type SessionConfig, type ToolOutcome, type TurnResult } from './session'
import { buildTranscript, fingerprint, hasToolResults, toApiMessage, type ApiBlock } from './transcript'
import type { ClaudeSubscriptionProviderOptions } from './index'

/**
 * LLMProvider backed by the user's Claude plan through Claude Code.
 *
 * Each createMessage() continues a live Claude Code session when ADF's history
 * extends the one that session holds (the common case: the next step of a
 * tool loop, or the next user turn). Otherwise — first call, compaction,
 * edited history, app restart — a new session is started from ADF's history.
 * Sessions are pooled per process, not per provider instance, because hosts
 * rebuild providers freely.
 */

const MAX_SESSIONS = 8
const IDLE_TTL_MS = 10 * 60_000
/** Waiting on ADF (tools, approvals) is not idleness. */
const AWAITING_TTL_MS = 60 * 60_000
/** Sessions never continued (compaction, model_invoke, superseded) go fast. */
const ONE_SHOT_TTL_MS = 60_000

const pool = new Set<ClaudeCodeSession>()
const inUse = new WeakSet<ClaudeCodeSession>()

function ttl(s: ClaudeCodeSession): number {
  if (s.isAwaitingTools) return AWAITING_TTL_MS
  return s.continuations === 0 ? ONE_SHOT_TTL_MS : IDLE_TTL_MS
}

function reap(): void {
  for (const s of pool) {
    if (s.isClosed) pool.delete(s)
    else if (!inUse.has(s) && s.idleForMs > ttl(s)) { s.close(); pool.delete(s) }
  }
}

const reaper = setInterval(reap, 30_000)
reaper.unref?.()

/** End every Claude Code process (shutdown, tests). */
export function closeAllClaudeSessions(): void {
  for (const s of pool) s.close()
  pool.clear()
}
process.once('exit', closeAllClaudeSessions)

function admit(session: ClaudeCodeSession): void {
  pool.add(session)
  if (pool.size <= MAX_SESSIONS) return
  // Evict an idle session before one an agent is mid-way through.
  const victim = [...pool]
    .filter((s) => !inUse.has(s) && s !== session)
    .sort((a, b) => Number(a.isAwaitingTools) - Number(b.isAwaitingTools) || b.idleForMs - a.idleForMs)[0]
  if (victim) { victim.close(); pool.delete(victim) }
}

const EFFORT: Record<ReasoningEffort, NonNullable<SessionConfig['effort']>> = {
  minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
}

/**
 * The agent's max tokens is deliberately not applied: Claude Code sizes each
 * request's output to the model's own maximum, and that cap also covers
 * thinking — a small one (e.g. the old 4096 default) lets a high-effort turn
 * spend it all thinking and end with no reply or tool call.
 */
export function sessionConfig(modelId: string, options: CreateMessageOptions): SessionConfig {
  const r = options.reasoning
  const budget = r?.max_tokens ?? options.thinkingBudget
  const enabled = r?.enabled ?? (r?.effort !== undefined || (budget !== undefined && budget > 0))
  const display = r?.exclude ? 'omitted' as const : 'summarized' as const
  return {
    model: modelId,
    system: options.system,
    tools: options.tools ?? [],
    thinking: !enabled ? { type: 'disabled' }
      : budget ? { type: 'enabled', budgetTokens: budget, display }
        : { type: 'adaptive', display },
    ...(enabled && r?.effort ? { effort: EFFORT[r.effort] } : {}),
  }
}

// System prompt and tool list are stable objects across an agent's calls;
// hash each once.
const hashCache = new WeakMap<object, string>()
function hashOf(value: object | string): string {
  if (typeof value === 'string') return createHash('sha256').update(value).digest('hex')
  let h = hashCache.get(value)
  if (!h) {
    h = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    hashCache.set(value, h)
  }
  return h
}

function hashConfig(config: SessionConfig): string {
  const { system, tools, ...rest } = config
  return hashOf(`${hashOf(system)}|${hashOf(tools)}|${JSON.stringify(rest)}`)
}

const fingerprintCache = new WeakMap<LLMMessage, string>()
function cachedFingerprint(msg: LLMMessage): string {
  let fp = fingerprintCache.get(msg)
  if (!fp) {
    fp = createHash('sha1').update(fingerprint(msg)).digest('base64')
    fingerprintCache.set(msg, fp)
  }
  return fp
}

/**
 * Tool results keyed by call id, with the images ADF attached after each
 * result, plus any text riding along (mid-batch notices).
 */
function toolOutcomes(msg: LLMMessage): { results: Map<string, ToolOutcome>; text: string[] } {
  const results = new Map<string, ToolOutcome>()
  const text: string[] = []
  let current: ToolOutcome | undefined
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (b.type === 'tool_result' && b.tool_use_id) {
      current = { content: b.content ?? '', isError: b.is_error }
      results.set(b.tool_use_id, current)
    } else if (b.type === 'image_url' && b.image_url) {
      const match = b.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      if (match && current) (current.images ??= []).push({ mimeType: match[1], data: match[2] })
      else text.push(`[image: ${b.image_url.url.slice(0, 200)}]`)
    } else if (b.type === 'input_audio' || b.type === 'video_url') {
      const note = `[${b.type === 'input_audio' ? 'audio' : 'video'} attachment omitted: not supported by Claude]`
      if (current) current.content += `\n${note}`
      else text.push(note)
    } else if (b.type === 'text' && b.text) {
      text.push(b.text)
    }
  }
  return { results, text }
}

function userText(messages: LLMMessage[]): string[] {
  return messages.flatMap((m) => (toApiMessage(m)?.content ?? [])
    .filter((b): b is Extract<ApiBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text))
}

type Plan =
  | { kind: 'tools'; session: ClaudeCodeSession; results: Map<string, ToolOutcome>; extra?: string }
  | { kind: 'user'; session: ClaudeCodeSession; content: ApiBlock[] }

/** Find a pooled session this call's history continues. */
function planContinuation(key: string, messages: LLMMessage[], fps: string[]): Plan | null {
  for (const session of pool) {
    if (session.isClosed || inUse.has(session) || session.configKey !== key) continue
    const known = session.fingerprints
    // A session that never completed a turn holds content ADF doesn't know.
    if (known.length === 0 || known.length >= fps.length || !known.every((fp, i) => fp === fps[i])) continue
    const tail = messages.slice(known.length)

    if (session.isAwaitingTools) {
      // Tool results, optionally followed by user messages that arrived while
      // the tools ran (chat, injections) — those ride along with the batch.
      const [head, ...rest] = tail
      if (head.role !== 'user' || !hasToolResults(head) || rest.some((m) => m.role !== 'user' || hasToolResults(m))) continue
      const { results, text } = toolOutcomes(head)
      if (!session.pendingToolIds.every((id) => results.has(id))) continue
      const extra = [...text, ...userText(rest)].join('\n\n') || undefined
      return { kind: 'tools', session, results, extra }
    }

    if (tail.every((m) => m.role === 'user' && !hasToolResults(m))) {
      const content = tail.flatMap((m) => toApiMessage(m)?.content ?? [])
      if (content.length > 0) return { kind: 'user', session, content }
    }
  }
  return null
}

/** A cold start replaces any session still holding this conversation's past. */
function retireSuperseded(key: string, fps: string[]): void {
  for (const s of pool) {
    if (inUse.has(s) || s.configKey !== key || s.fingerprints.length === 0) continue
    const known = s.fingerprints
    if (known.length <= fps.length && known.every((fp, i) => fp === fps[i])) { s.close(); pool.delete(s) }
  }
}

export class ClaudeSubscriptionProvider implements LLMProvider {
  readonly name: string
  readonly providerId: string
  readonly providerType: ProviderType = 'claude-subscription' as ProviderType
  readonly modelId: string
  private readonly requestDelayMs: number

  constructor(opts: ClaudeSubscriptionProviderOptions) {
    this.name = opts.displayName
    this.providerId = opts.providerId
    this.modelId = opts.modelId
    this.requestDelayMs = opts.requestDelayMs ?? 0
    if (opts.extraParams && Object.keys(opts.extraParams).length > 0) {
      logger.warn(`[ClaudeSubscription] Custom request params are not supported through Claude Code and are ignored: ${Object.keys(opts.extraParams).join(', ')}`, { category: 'Provider' })
    }
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    if (this.requestDelayMs > 0) await new Promise((r) => setTimeout(r, this.requestDelayMs))
    reap()
    const config = sessionConfig(this.modelId, options)
    const key = hashConfig(config)
    const fps = options.messages.map(cachedFingerprint)
    const callbacks = { onTextDelta: options.onTextDelta, onThinkingDelta: options.onThinkingDelta }

    const plan = planContinuation(key, options.messages, fps)
    let session: ClaudeCodeSession | undefined
    let turn: Promise<TurnResult>
    try {
      if (plan) {
        session = plan.session
        inUse.add(session)
        session.continuations++
        turn = plan.kind === 'tools'
          ? session.sendToolResults(plan.results, options.dynamicInstructions, plan.extra, callbacks, options.signal)
          : session.sendUser(plan.content, options.dynamicInstructions, callbacks, options.signal)
      } else {
        retireSuperseded(key, fps)
        const { history, prompt } = splitForColdStart(options.messages)
        session = await ClaudeCodeSession.start(config, key, (sessionId, cwd) => buildTranscript(history, sessionId, cwd, this.modelId))
        inUse.add(session)
        admit(session)
        if (prompt === CONTINUE_PROMPT) {
          session.noteInjection(`Prompt "${CONTINUE_TEXT}" sent to resume the conversation in a new Claude Code session.`)
        }
        turn = session.sendUser(prompt, options.dynamicInstructions, callbacks, options.signal)
      }
      logger.debug(`[ClaudeSubscription] createMessage: model=${this.modelId} ${plan ? `continue(${plan.kind})` : 'new session'} tools=${config.tools.length}`, { category: 'Provider' })

      const result = await turn
      session.fingerprints.splice(0, session.fingerprints.length, ...fps, cachedFingerprint({ role: 'assistant', content: result.content }))
      return this.toResponse(result)
    } catch (err) {
      throw toProviderError(err)
    } finally {
      if (session) inUse.delete(session)
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    const status = await getClaudeAuthManager().getAuthStatus()
    if (status.authenticated) return { valid: true }
    if (!status.installed) return { valid: false, error: `Claude Code is not installed (${status.installUrl}). Sign in with Claude after installing it.` }
    return { valid: false, error: status.flowError ?? 'Not signed in to Claude. Sign in with Claude.' }
  }

  private toResponse(r: TurnResult): LLMResponse {
    return {
      id: r.messageId,
      content: r.content,
      stop_reason: r.stopReason,
      usage: {
        input_tokens: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite,
        output_tokens: r.usage.output,
      },
      providerMetadata: {
        adf: {
          cacheReadTokens: r.usage.cacheRead,
          cacheWriteTokens: r.usage.cacheWrite,
          ...(r.usage.reasoning !== undefined ? { reasoningTokens: r.usage.reasoning } : {}),
          ...(r.injections.length > 0 ? { contextInjections: r.injections } : {}),
        },
        ...(r.rateLimit ? { claude: { rateLimit: r.rateLimit } } : {}),
      },
    }
  }
}

/**
 * History to seed a new session with, and the message that starts its first
 * request. A trailing tool-result message (restart mid tool loop) goes into
 * the history; the model is then asked to continue.
 */
export function splitForColdStart(messages: LLMMessage[]): { history: LLMMessage[]; prompt: ApiBlock[] } {
  const last = messages[messages.length - 1]
  if (last && last.role === 'user' && !hasToolResults(last)) {
    const prompt = toApiMessage(last)?.content
    if (prompt && prompt.length > 0) return { history: messages.slice(0, -1), prompt }
  }
  return { history: messages, prompt: CONTINUE_PROMPT }
}

const CONTINUE_TEXT = 'Continue.'
const CONTINUE_PROMPT: ApiBlock[] = [{ type: 'text', text: CONTINUE_TEXT }]
