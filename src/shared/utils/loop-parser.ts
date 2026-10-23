import { parseOwnerCommandRow } from './owner-command-row'
/**
 * Loop Parser
 *
 * Reconstructs UI display entries from the loop table.
 * The loop table stores raw LLM conversation data; this utility
 * transforms it into the format needed for UI rendering.
 */

import type { ContentBlock } from '../types/provider.types'
import type { LoopEntry, DisplayEntry, DisplayEntryType } from '../types/adf-v02.types'
import { attachmentsOf, displayAttachment, isFileRefBlock, splitLegacyUploads, type DisplayAttachment } from './file-ref'

/**
 * Detect the inter-loop provenance stamp `[from loop:<name>] ` that
 * `LoopPool.sendToLoop` writes into the delivered row's content.
 *
 * `adf_loop` has no metadata column, so this stamp IS the durable marker for
 * loop-delivered rows — the same bytes are read back on rehydrate as were sent
 * live. It is also model-visible by design (§2.4 provenance), so this parse is
 * PRESENTATION ONLY: the row in the DB and the message in the session keep the
 * stamp; only the chat bubble drops it in favour of a `from loop:<name>` label.
 *
 * The name charset matches LOOP_NAME_PATTERN so an owner message that happens
 * to begin with "[from loop:" free text is very unlikely to be misread.
 */
export function parseLoopSendStamp(text: string): { fromLoop: string; body: string } | null {
  const match = text.match(/^\[from loop:([a-z0-9][a-z0-9_-]{0,31})\] ([\s\S]*)$/)
  return match ? { fromLoop: match[1], body: match[2] } : null
}

/**
 * Durable marker the executor writes into the loop when a turn fails
 * (`AgentExecutor.persistTurnError`). The live `error` event is renderer
 * memory only and was lost the moment the file left the foreground, so a
 * failed turn rehydrated as a silent no-op. This row survives: it is read back
 * as an `error` display entry, and — like every other user-role row — it is
 * model-visible, so the next turn knows the previous one never completed.
 */
export const TURN_ERROR_MARKER = '[Turn error] '

/**
 * Separates a turn error's message from its details (status, body) in the
 * same row. The loop has no metadata column, so the details ride in the text
 * after the message and come back as the error entry's `details`.
 */
export const TURN_ERROR_DETAILS_MARKER = '\n\n[Error details] '

/** The loop text of a failed turn: the marker, the message, then any details. */
export function formatTurnErrorRow(message: string, details?: string): string {
  return `${TURN_ERROR_MARKER}${message}${details ? `${TURN_ERROR_DETAILS_MARKER}${details}` : ''}`
}

/** A persisted turn error's message and details; null for any other text. */
export function parseTurnErrorRow(text: string): { message: string; details?: string } | null {
  if (!text.startsWith(TURN_ERROR_MARKER)) return null
  const body = text.slice(TURN_ERROR_MARKER.length)
  const at = body.lastIndexOf(TURN_ERROR_DETAILS_MARKER)
  if (at < 0) return { message: body }
  return { message: body.slice(0, at), details: body.slice(at + TURN_ERROR_DETAILS_MARKER.length) }
}

export function parseTurnErrorMarker(text: string): string | null {
  return parseTurnErrorRow(text)?.message ?? null
}

/**
 * How every user-role row the runtime writes itself (nudges, recovery and
 * crash notices) begins. The model reads these as input, so they are shown,
 * as System notices, never as the owner's words and never hidden.
 */
export const RUNTIME_NOTICE_PREFIXES = [
  '[System]',
  '[System notice:',
  '[Provider unavailable (',
  '[Provider error (',
  '[Turn error (',
  '[Continue working autonomously',
  '[You have responded ',
  'Context is about to be compacted.',
]

export function isRuntimeNotice(text: string): boolean {
  return RUNTIME_NOTICE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/**
 * What the loop shows for runtime-written input that is not the owner's words.
 * `adf_loop` has no metadata column, so a row's leading text is its marker:
 *
 * - `runtime`: a notice the model receives (`[System] …`, the autonomous nudges).
 * - `status`: a notice for the owner only, never sent to the model
 *   (`[Context: status]`; `[Context: System]` before the two were split).
 * - `system_prompt` / `dynamic_instructions`: the instructions as last sent.
 * - `provider_context`: input the provider added; `addedBy` names it.
 * - `injected`: `loop_inject` context, with its `injectCategory` and `origin`.
 * - `loop`: a message from another of the agent's loops.
 */
export type InjectedCategory = 'owner_command' | 'runtime' | 'status' | 'system_prompt' | 'dynamic_instructions' | 'provider_context' | 'injected' | 'loop'

/** The categories shown as their own row rather than folded into a step block. */
export function isNoticeCategory(category: unknown): boolean {
  return category === 'owner_command' || category === 'runtime' || category === 'status'
}

/** The `[Context: …]` head of a provider's input, naming the provider. */
export function providerContextCategory(addedBy: string): string {
  return `provider_context | from=${addedBy.replace(/[\]|\n]/g, ' ')}`
}

export function classifyInjectedText(text: string): { content: string; metadata: Record<string, unknown> & { category: InjectedCategory | string } } | null {
  const ownerCommand = parseOwnerCommandRow(text)
  if (ownerCommand) return { content: ownerCommand.body, metadata: { category: 'owner_command', ownerCommand: ownerCommand.header } }
  const context = text.match(/^\[Context: ([^\]]+)\] ?([\s\S]*)$/)
  if (context) {
    const [name, ...fields] = context[1].split(' | ')
    const field = (key: string) => fields.find((f) => f.startsWith(`${key}=`))?.slice(key.length + 1)
    const content = context[2]
    if (fields.includes('loop_inject=v2')) {
      return { content, metadata: { category: 'injected', injectCategory: name, origin: field('origin') ?? 'system:unknown' } }
    }
    if (name === 'System' || name === 'status') return { content, metadata: { category: 'status' } }
    if (name === 'provider_context') {
      const addedBy = field('from')
      return { content, metadata: { category: 'provider_context', ...(addedBy ? { addedBy } : {}) } }
    }
    return { content, metadata: { category: name } }
  }
  const loopSend = parseLoopSendStamp(text)
  if (loopSend) return { content: loopSend.body, metadata: { category: 'loop', fromLoop: loopSend.fromLoop } }
  if (isRuntimeNotice(text)) return { content: text, metadata: { category: 'runtime' } }
  return null
}

/** Extract the first image VFS path from tool result text and return an adf-file:// URL. */
function extractImageUrl(content: string): string | null {
  const match = content.match(/\[image: ([^\s]+) \(/)
  return match ? `adf-file://${match[1]}` : null
}

/**
 * Renderable image URLs of a user message's inline `image_url` blocks (data:
 * or remote). File references are `attachments`, shown as chips.
 */
function collectImageUrls(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b) => b.type === 'image_url' && b.image_url?.url)
    .map((b) => b.image_url!.url)
}

/**
 * The references that follow a tool result belong to it: they are the media
 * the tool read. A deleted image drops the result's preview.
 */
function toolResultAttachments(blocks: ContentBlock[], index: number): DisplayAttachment[] {
  const out: DisplayAttachment[] = []
  for (let i = index + 1; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'tool_result') break
    if (isFileRefBlock(b)) out.push(displayAttachment(b.file_ref))
  }
  return out
}

/** Tool-result metadata for its attachments: the list, and no preview when the image is gone. */
function withToolAttachments(meta: Record<string, unknown>, attachments: DisplayAttachment[]): Record<string, unknown> {
  if (attachments.length === 0) return meta
  const next: Record<string, unknown> = { ...meta, attachments }
  if (attachments.some(a => a.deleted && a.kind === 'image')) delete next.imageUrl
  return next
}

/**
 * What woke the agent, from the text the runtime wrote for it
 * (`AgentExecutor.buildTriggerMessage`). Null for anything else, which is the
 * owner's own words. Used on reload and live, so both name a wake alike.
 */
export function detectTriggerType(text: string): string | null {
  if (text.startsWith('The user has edited the document.')) return 'document_edit'
  if (text.startsWith('You received a message from agent')) return 'message_received'
  if (text.startsWith('A scheduled timer has fired')) return 'timer'
  if (text.startsWith('[Inbox notification]')) return 'inbox'
  if (text === 'Go.') return 'autonomous_start'
  if (text === 'The user has manually triggered you. Review the document and respond.') return 'manual_invoke'
  if (text.startsWith('Agent started. Review your mind')) return 'startup'
  if (text.startsWith('A batch of ') && text.includes(' events fired: ')) return 'batch'
  if (text.startsWith('A file has been ')) return 'file_change'
  if (text.startsWith('An outbound message was sent')) return 'outbox'
  // "was intercepted" is the wording before 2026-10.
  if (text.startsWith('A tool call has been intercepted') || text.startsWith('A tool call was intercepted')) return 'tool_call'
  if (text.startsWith('A task has been created.')) return 'task_create'
  if (text.startsWith('A task has completed')) return 'task_complete'
  if (text.startsWith('A log entry has been recorded.')) return 'log_entry'
  if (text.startsWith('An LLM call completed.')) return 'llm_call'
  if (text.startsWith('You have been triggered. Review the current state')) return 'unknown'
  return null
}

/**
 * Summarize preserved reasoning_details for transparency labeling.
 * `encrypted` means the provider returned an opaque/signed block with no
 * human-readable text (round-tripped for tool-call continuity).
 */
function summarizeReasoning(details?: unknown[]): { preserved: boolean; encrypted: boolean } {
  if (!Array.isArray(details) || details.length === 0) return { preserved: false, encrypted: false }
  const encrypted = details.some((d) => (d as { type?: string } | null)?.type === 'reasoning.encrypted')
  return { preserved: true, encrypted }
}

/**
 * Parse loop entries into display entries for UI rendering.
 *
 * Mapping rules:
 * - User role + text content → 'user' entry (or 'trigger' for system triggers)
 * - User role + tool_result block → 'tool_result' entry
 * - Assistant role + text block → 'text' entry
 * - Assistant role + tool_use block → 'tool_call' entry
 * - Assistant role + thinking block → 'thinking' entry
 */
export function parseLoopToDisplay(entries: LoopEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = []
  // Track tool_use_id -> tool_name for matching results
  const toolIdToName = new Map<string, string>()

  for (const entry of entries) {
    const blocks = entry.content_json
    const timestamp = entry.created_at || 0

    if (entry.role === 'user') {
      // User messages
      const imagePreviewUrls = collectImageUrls(blocks)
      const isToolRow = blocks.some(b => b.type === 'tool_result')
      const attachments = isToolRow ? [] : attachmentsOf(blocks)
      const firstEntryOfRow = displayEntries.length
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]
        if (block.type === 'text' && block.text) {
          // Compaction summary entries
          if (block.text.startsWith('[Loop Compacted')) {
            const audited = block.text.startsWith('[Loop Compacted, audited]')
            const content = block.text
              .replace('[Loop Compacted, audited] ', '')
              .replace('[Loop Compacted] ', '')
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'compaction',
              content,
              timestamp,
              // model/tokens carry the compaction LLM call's usage
              metadata: { seq: entry.seq, audited, model: entry.model, tokens: entry.tokens }
            })
            continue
          }
          const turnError = parseTurnErrorRow(block.text)
          if (turnError !== null) {
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'error',
              content: turnError.message,
              timestamp,
              metadata: turnError.details ? { seq: entry.seq, details: turnError.details } : { seq: entry.seq }
            })
            continue
          }
          const injected = classifyInjectedText(block.text)
          if (injected) {
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'context',
              content: injected.content,
              timestamp,
              metadata: { seq: entry.seq, ...injected.metadata }
            })
            continue
          }
          const triggerType = detectTriggerType(block.text)
          // Rows from before attachments were parts: their upload lines are chips too.
          const legacy = triggerType ? { text: block.text, attachments: [] } : splitLegacyUploads(block.text)
          const shown = [...attachments, ...legacy.attachments]
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: triggerType && triggerType !== 'manual_invoke' ? 'trigger' : 'user',
            content: legacy.text,
            timestamp,
            metadata: {
              seq: entry.seq,
              ...(triggerType ? { triggerType } : {}),
              ...(!triggerType && imagePreviewUrls.length > 0 ? { imagePreviewUrls } : {}),
              ...(!triggerType && shown.length > 0 ? { attachments: shown } : {})
            }
          })
        } else if (block.type === 'tool_result') {
          // Look up the tool name from the corresponding tool_use
          const toolName = toolIdToName.get(block.tool_use_id ?? '') ?? 'unknown'
          const imageUrl = extractImageUrl(block.content ?? '')
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'tool_result',
            content: block.content ?? '',
            timestamp,
            metadata: withToolAttachments({
              seq: entry.seq,
              tool_use_id: block.tool_use_id,
              name: toolName,
              isError: block.is_error,
              ...(imageUrl ? { imageUrl } : {})
            }, toolResultAttachments(blocks, bi))
          })
        }
      }
      // A message of attachments alone still shows them.
      pushAttachmentOnlyEntry(displayEntries, firstEntryOfRow, entry, attachments, imagePreviewUrls)
    } else if (entry.role === 'assistant') {
      // Assistant messages. `entry.tokens` is the whole call's usage, so it is
      // stamped on ONE display entry — the row's last displayed block — not on
      // every block (a thinking row wearing the full output count read as if
      // that were the thinking size). Thinking blocks get the exact reasoning
      // count separately when the provider reported one.
      const firstEntryOfRow = displayEntries.length
      const reasoningTokens = typeof entry.tokens?.reasoning === 'number' ? entry.tokens.reasoning : undefined
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]
        if (block.type === 'text' && block.text && block.text.trim()) {
          // Skip whitespace-only assistant text (some models emit a " " filler
          // block between reasoning and a tool call) — it renders as an empty bubble.
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'text',
            content: block.text,
            timestamp,
            metadata: { seq: entry.seq, model: entry.model, ...(block.interrupted ? { interrupted: true } : {}) }
          })
        } else if (block.type === 'tool_use') {
          // Track tool_use_id -> name for result matching
          if (block.id && block.name) {
            toolIdToName.set(block.id, block.name)
          }
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'tool_call',
            content: formatToolCall(block),
            timestamp,
            metadata: {
              seq: entry.seq,
              tool_id: block.id,
              name: block.name,
              input: block.input
            }
          })
        } else if (block.type === 'thinking' && (block.thinking || (Array.isArray(block.reasoning_details) && block.reasoning_details.length > 0))) {
          const { preserved, encrypted } = summarizeReasoning(block.reasoning_details)
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'thinking',
            content: block.thinking ?? '',
            timestamp,
            metadata: {
              seq: entry.seq,
              ...(block.interrupted ? { interrupted: true } : {}),
              model: entry.model,
              ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
              ...(preserved ? { preservedReasoning: true } : {}),
              ...(encrypted ? { encryptedReasoning: true } : {})
            }
          })
        }
      }
      stampRowTokens(displayEntries, firstEntryOfRow, entry.tokens)
    }
  }

  return displayEntries
}

/** A user row of attachments and no text: one user entry showing them. */
function pushAttachmentOnlyEntry(
  displayEntries: DisplayEntry[],
  firstEntryOfRow: number,
  entry: LoopEntry,
  attachments: DisplayAttachment[],
  imagePreviewUrls: string[],
): void {
  if (attachments.length === 0 || displayEntries.length > firstEntryOfRow) return
  displayEntries.push({
    id: `loop-${entry.seq}-attachments`,
    type: 'user',
    content: '',
    timestamp: entry.created_at || 0,
    metadata: { seq: entry.seq, attachments, ...(imagePreviewUrls.length > 0 ? { imagePreviewUrls } : {}) }
  })
}

/**
 * Put a row's whole-call usage on its last displayed block (and nowhere
 * else). No-op when the row produced no display entry or carries no usage.
 */
function stampRowTokens(displayEntries: DisplayEntry[], firstEntryOfRow: number, tokens: LoopEntry['tokens']): void {
  if (!tokens || displayEntries.length <= firstEntryOfRow) return
  const last = displayEntries[displayEntries.length - 1]
  last.metadata = { ...last.metadata, tokens }
}

/**
 * Format a tool call block for display.
 */
function formatToolCall(block: ContentBlock): string {
  const name = block.name ?? 'unknown'
  const input = block.input

  if (!input || typeof input !== 'object') {
    return `${name}()`
  }

  // Format input as a readable summary
  try {
    const inputStr = JSON.stringify(input, null, 2)
    if (inputStr.length > 200) {
      return `${name}(${inputStr.substring(0, 200)}...)`
    }
    return `${name}(${inputStr})`
  } catch {
    return `${name}(...)`
  }
}

/**
 * Find tool results that match a tool call by tool_use_id.
 */
export function findToolResult(
  entries: LoopEntry[],
  toolUseId: string
): ContentBlock | null {
  for (const entry of entries) {
    if (entry.role === 'user') {
      for (const block of entry.content_json) {
        if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
          return block
        }
      }
    }
  }
  return null
}

/**
 * Pair tool calls with their results for display.
 * Returns entries with tool_call and tool_result paired together.
 */
export function parseLoopWithToolPairs(entries: LoopEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = []
  const pendingToolCalls = new Map<string, { entry: DisplayEntry; seq: number }>()

  for (const entry of entries) {
    const blocks = entry.content_json
    const timestamp = entry.created_at || 0

    if (entry.role === 'user') {
      const imagePreviewUrls = collectImageUrls(blocks)
      const isToolRow = blocks.some(b => b.type === 'tool_result')
      const attachments = isToolRow ? [] : attachmentsOf(blocks)
      const firstEntryOfRow = displayEntries.length
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]
        if (block.type === 'text' && block.text) {
          // Compaction summary entries
          if (block.text.startsWith('[Loop Compacted')) {
            const audited = block.text.startsWith('[Loop Compacted, audited]')
            const content = block.text
              .replace('[Loop Compacted, audited] ', '')
              .replace('[Loop Compacted] ', '')
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'compaction',
              content,
              timestamp,
              // model/tokens carry the compaction LLM call's usage
              metadata: { seq: entry.seq, audited, model: entry.model, tokens: entry.tokens }
            })
            continue
          }
          const turnError = parseTurnErrorRow(block.text)
          if (turnError !== null) {
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'error',
              content: turnError.message,
              timestamp,
              metadata: turnError.details ? { seq: entry.seq, details: turnError.details } : { seq: entry.seq }
            })
            continue
          }
          const injected = classifyInjectedText(block.text)
          if (injected) {
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'context',
              content: injected.content,
              timestamp,
              metadata: { seq: entry.seq, ...injected.metadata }
            })
            continue
          }
          const triggerType = detectTriggerType(block.text)
          // Rows from before attachments were parts: their upload lines are chips too.
          const legacy = triggerType ? { text: block.text, attachments: [] } : splitLegacyUploads(block.text)
          const shown = [...attachments, ...legacy.attachments]
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: triggerType && triggerType !== 'manual_invoke' ? 'trigger' : 'user',
            content: legacy.text,
            timestamp,
            metadata: {
              seq: entry.seq,
              ...(triggerType ? { triggerType } : {}),
              ...(!triggerType && imagePreviewUrls.length > 0 ? { imagePreviewUrls } : {}),
              ...(!triggerType && shown.length > 0 ? { attachments: shown } : {})
            }
          })
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          // Find matching tool call and add result to its metadata
          const pending = pendingToolCalls.get(block.tool_use_id)
          const imageUrl = extractImageUrl(block.content ?? '')
          const resultAttachments = toolResultAttachments(blocks, bi)
          if (pending) {
            pending.entry.metadata = withToolAttachments({
              ...pending.entry.metadata,
              result: block.content,
              isError: block.is_error,
              ...(imageUrl ? { imageUrl } : {})
            }, resultAttachments)
            pendingToolCalls.delete(block.tool_use_id)
          }
          // Also add as separate entry for explicit result display
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'tool_result',
            content: block.content ?? '',
            timestamp,
            metadata: withToolAttachments({
              seq: entry.seq,
              tool_use_id: block.tool_use_id,
              isError: block.is_error,
              ...(imageUrl ? { imageUrl } : {})
            }, resultAttachments)
          })
        }
      }
      pushAttachmentOnlyEntry(displayEntries, firstEntryOfRow, entry, attachments, imagePreviewUrls)
    } else if (entry.role === 'assistant') {
      // Same token placement as parseLoopToDisplay: whole-call usage on the
      // row's last block only, exact reasoning count on thinking blocks.
      const firstEntryOfRow = displayEntries.length
      const reasoningTokens = typeof entry.tokens?.reasoning === 'number' ? entry.tokens.reasoning : undefined
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]
        if (block.type === 'text' && block.text && block.text.trim()) {
          // Skip whitespace-only assistant text (some models emit a " " filler
          // block between reasoning and a tool call) — it renders as an empty bubble.
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'text',
            content: block.text,
            timestamp,
            metadata: { seq: entry.seq, model: entry.model, ...(block.interrupted ? { interrupted: true } : {}) }
          })
        } else if (block.type === 'tool_use' && block.id) {
          const toolEntry: DisplayEntry = {
            id: `loop-${entry.seq}-${bi}`,
            type: 'tool_call',
            content: formatToolCall(block),
            timestamp,
            metadata: {
              seq: entry.seq,
              tool_id: block.id,
              name: block.name,
              input: block.input
            }
          }
          displayEntries.push(toolEntry)
          pendingToolCalls.set(block.id, { entry: toolEntry, seq: entry.seq })
        } else if (block.type === 'thinking' && (block.thinking || (Array.isArray(block.reasoning_details) && block.reasoning_details.length > 0))) {
          const { preserved, encrypted } = summarizeReasoning(block.reasoning_details)
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'thinking',
            content: block.thinking ?? '',
            timestamp,
            metadata: {
              seq: entry.seq,
              ...(block.interrupted ? { interrupted: true } : {}),
              model: entry.model,
              ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
              ...(preserved ? { preservedReasoning: true } : {}),
              ...(encrypted ? { encryptedReasoning: true } : {})
            }
          })
        }
      }
      stampRowTokens(displayEntries, firstEntryOfRow, entry.tokens)
    }
  }

  return displayEntries
}

/**
 * Get a summary of the loop for status display.
 */
export function getLoopSummary(entries: LoopEntry[]): {
  totalMessages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  thinkingBlocks: number
} {
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let thinkingBlocks = 0

  for (const entry of entries) {
    if (entry.role === 'user') {
      // Count user text messages (not tool results)
      if (entry.content_json.some((b) => b.type === 'text')) {
        userMessages++
      }
    } else if (entry.role === 'assistant') {
      // Count assistant responses
      if (entry.content_json.some((b) => b.type === 'text')) {
        assistantMessages++
      }
      // Count tool calls
      toolCalls += entry.content_json.filter((b) => b.type === 'tool_use').length
      // Count thinking blocks
      thinkingBlocks += entry.content_json.filter((b) => b.type === 'thinking').length
    }
  }

  return {
    totalMessages: entries.length,
    userMessages,
    assistantMessages,
    toolCalls,
    thinkingBlocks
  }
}

/**
 * Convert display entries back to LLM messages format.
 * Used when restoring session from loop.
 */
export function loopToLLMMessages(
  entries: LoopEntry[]
): Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> {
  return entries.map((entry) => ({
    role: entry.role,
    content: entry.content_json
  }))
}
