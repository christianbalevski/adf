import { createHash, randomUUID } from 'node:crypto'
import type { ContentBlock, LLMMessage } from '../../../shared/types/provider.types'
import { messageTextPrefix } from '../ai-sdk-provider'

/**
 * Conversion between ADF's provider-neutral messages and what Claude Code
 * consumes: Anthropic Messages content blocks (for live input) and Claude Code
 * session transcript entries (to resume a conversation ADF already holds).
 */

/** In-process MCP server name; Claude Code exposes its tools as `mcp__adf__<name>`. */
export const MCP_SERVER_NAME = 'adf'
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** The Messages API caps tool names at 64 characters. */
const MAX_TOOL_NAME = 64

/**
 * MCP-side name for an ADF tool. Names that would exceed the API limit once
 * prefixed get a deterministic shortened form (same input, same alias), so
 * history replays and live sessions agree.
 */
export function claudeToolAlias(name: string): string {
  if (MCP_PREFIX.length + name.length <= MAX_TOOL_NAME) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME - MCP_PREFIX.length - 9)}_${hash}`
}

export const toClaudeToolName = (name: string): string => `${MCP_PREFIX}${claudeToolAlias(name)}`

/** Map a Claude-side tool name back to the ADF tool name. */
export function fromClaudeToolName(name: string, aliases?: ReadonlyMap<string, string>): string {
  const bare = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
  return aliases?.get(bare) ?? bare
}

/** alias → ADF name, for the tools of one session. */
export function toolAliasMap(names: string[]): Map<string, string> {
  return new Map(names.map((n) => [claudeToolAlias(n), n]))
}

/** Anthropic Messages API content block (the subset ADF produces). */
export type ApiBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface ApiMessage {
  role: 'user' | 'assistant'
  content: ApiBlock[]
}

function mediaBlock(block: ContentBlock): ApiBlock | null {
  if (block.type === 'image_url' && block.image_url) {
    const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
    if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
    return { type: 'text', text: `[image: ${block.image_url.url}]` }
  }
  // Claude has no audio/video input; say so instead of dropping silently.
  if (block.type === 'input_audio') return { type: 'text', text: '[audio attachment omitted: not supported by Claude]' }
  if (block.type === 'video_url') return { type: 'text', text: '[video attachment omitted: not supported by Claude]' }
  return null
}

/** One ADF message as Anthropic content blocks. Thinking is not replayed. */
export function toApiMessage(msg: LLMMessage): ApiMessage | null {
  const prefix = messageTextPrefix(msg)
  if (typeof msg.content === 'string') {
    const text = prefix ? `${prefix} ${msg.content}` : msg.content
    return text ? { role: msg.role, content: [{ type: 'text', text }] } : null
  }
  if (!Array.isArray(msg.content)) return null

  const content: ApiBlock[] = []
  if (msg.role === 'assistant') {
    for (const b of msg.content) {
      if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text })
      else if (b.type === 'tool_use' && b.id && b.name) {
        content.push({ type: 'tool_use', id: b.id, name: toClaudeToolName(b.name), input: b.input ?? {} })
      }
    }
  } else {
    // tool_result blocks must lead a user message (Messages API rule).
    for (const b of msg.content) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content ?? '', ...(b.is_error ? { is_error: true } : {}) })
      }
    }
    let prefixPending = !!prefix && content.length === 0
    for (const b of msg.content) {
      if (b.type === 'text' && b.text) {
        content.push({ type: 'text', text: prefixPending ? `${prefix} ${b.text}` : b.text })
        prefixPending = false
      } else {
        const media = mediaBlock(b)
        if (media) content.push(media)
      }
    }
  }
  return content.length > 0 ? { role: msg.role, content } : null
}

/**
 * Identity of a message for matching a live Claude Code session against the
 * history ADF sends: text, tool-call ids and media, ignoring thinking and
 * metadata (timestamps/seq) that ADF may attach after the fact.
 */
export function fingerprint(msg: LLMMessage): string {
  if (typeof msg.content === 'string') return `${msg.role}|t:${msg.content.trim()}`
  const parts = (Array.isArray(msg.content) ? msg.content : []).flatMap((b) => {
    switch (b.type) {
      case 'text': return b.text?.trim() ? [`t:${b.text.trim()}`] : []
      case 'tool_use': return [`u:${b.id}`]
      case 'tool_result': return [`r:${b.tool_use_id}`]
      case 'thinking': return []
      default: return [b.type]
    }
  })
  return `${msg.role}|${parts.join('\u0000')}`
}

export function hasToolResults(msg: LLMMessage): boolean {
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result')
}

/** Minimal Claude Code transcript entry for a user/assistant message. */
export interface TranscriptEntry {
  type: 'user' | 'assistant'
  uuid: string
  parentUuid: string | null
  isSidechain: false
  userType: 'external'
  sessionId: string
  cwd: string
  timestamp: string
  message: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Build a Claude Code session transcript from ADF history so a fresh Claude
 * Code process resumes the conversation with real tool calls and results,
 * not a text summary.
 */
export function buildTranscript(messages: LLMMessage[], sessionId: string, cwd: string, model: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let parentUuid: string | null = null
  for (const msg of messages) {
    const api = toApiMessage(msg)
    if (!api) continue
    const uuid = randomUUID()
    const timestamp = new Date(msg.created_at ?? Date.now()).toISOString()
    const message: Record<string, unknown> = api.role === 'assistant'
      ? {
          id: `msg_adf_${uuid.replace(/-/g, '')}`,
          type: 'message',
          role: 'assistant',
          model,
          content: api.content,
          stop_reason: api.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      : { role: 'user', content: api.content }
    entries.push({ type: api.role, uuid, parentUuid, isSidechain: false, userType: 'external', sessionId, cwd, timestamp, message })
    parentUuid = uuid
  }
  return entries
}
