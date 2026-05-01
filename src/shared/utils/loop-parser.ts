/**
 * Loop Parser
 *
 * Reconstructs UI display entries from the loop table.
 * The loop table stores raw LLM conversation data; this utility
 * transforms it into the format needed for UI rendering.
 */

import type { ContentBlock } from '../types/provider.types'
import type { LoopEntry, DisplayEntry, DisplayEntryType } from '../types/adf-v02.types'

/** Detect context injection entries by their `[Context: <category>]` prefix.
 *  Returns the category string if matched, else null. */
export function isContextEntry(text: string): string | null {
  const match = text.match(/^\[Context: ([^\]]+)\]/)
  return match ? match[1] : null
}

/** Extract the first image VFS path from tool result text and return an adf-file:// URL. */
function extractImageUrl(content: string): string | null {
  const match = content.match(/\[image: ([^\s]+) \(/)
  return match ? `adf-file://${match[1]}` : null
}

/** Detect system trigger messages by their known prefixes. */
function detectTriggerType(text: string): string | null {
  if (text.startsWith('The user has edited the document.')) return 'document_edit'
  if (text.startsWith('You received a message from agent')) return 'message_received'
  if (text.startsWith('A scheduled timer has fired')) return 'schedule'
  if (text.startsWith('[Inbox notification]')) return 'inbox_notification'
  if (text === 'Go.') return 'autonomous_start'
  if (text === 'The user has manually triggered you. Review the document and respond.') return 'manual_invoke'
  if (text.startsWith('[Continue working autonomously')) return 'autonomous_continue'
  // v3 trigger types
  if (text.startsWith('A file has been ')) return 'file_change'
  if (text.startsWith('An outbound message was sent')) return 'outbox'
  if (text.startsWith('A tool call was intercepted')) return 'tool_call'
  if (text.startsWith('A task has completed')) return 'task_complete'
  return null
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
              metadata: { seq: entry.seq, audited }
            })
            continue
          }
          const contextCategory = isContextEntry(block.text)
          if (contextCategory) {
            const content = block.text.replace(/^\[Context: [^\]]+\] /, '')
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'context',
              content,
              timestamp,
              metadata: { seq: entry.seq, category: contextCategory }
            })
            continue
          }
          const triggerType = detectTriggerType(block.text)
          // Skip synthetic autonomous continuation messages — internal bookkeeping only
          if (triggerType === 'autonomous_continue') continue
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: triggerType && triggerType !== 'manual_invoke' ? 'trigger' : 'user',
            content: block.text,
            timestamp,
            metadata: { seq: entry.seq, ...(triggerType ? { triggerType } : {}) }
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
            metadata: {
              seq: entry.seq,
              tool_use_id: block.tool_use_id,
              name: toolName,
              isError: block.is_error,
              ...(imageUrl ? { imageUrl } : {})
            }
          })
        }
      }
    } else if (entry.role === 'assistant') {
      // Assistant messages
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]
        if (block.type === 'text' && block.text) {
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'text',
            content: block.text,
            timestamp,
            metadata: { seq: entry.seq, model: entry.model, tokens: entry.tokens }
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
        } else if (block.type === 'thinking' && block.thinking) {
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'thinking',
            content: block.thinking,
            timestamp,
            metadata: { seq: entry.seq, model: entry.model, tokens: entry.tokens }
          })
        }
      }
    }
  }

  return displayEntries
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
              metadata: { seq: entry.seq, audited }
            })
            continue
          }
          const contextCategory = isContextEntry(block.text)
          if (contextCategory) {
            const content = block.text.replace(/^\[Context: [^\]]+\] /, '')
            displayEntries.push({
              id: `loop-${entry.seq}-${bi}`,
              type: 'context',
              content,
              timestamp,
              metadata: { seq: entry.seq, category: contextCategory }
            })
            continue
          }
          const triggerType = detectTriggerType(block.text)
          if (triggerType === 'autonomous_continue') continue
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: triggerType && triggerType !== 'manual_invoke' ? 'trigger' : 'user',
            content: block.text,
            timestamp,
            metadata: { seq: entry.seq, ...(triggerType ? { triggerType } : {}) }
          })
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          // Find matching tool call and add result to its metadata
          const pending = pendingToolCalls.get(block.tool_use_id)
          const imageUrl = extractImageUrl(block.content ?? '')
          if (pending) {
            pending.entry.metadata = {
              ...pending.entry.metadata,
              result: block.content,
              isError: block.is_error,
              ...(imageUrl ? { imageUrl } : {})
            }
            pendingToolCalls.delete(block.tool_use_id)
          }
          // Also add as separate entry for explicit result display
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'tool_result',
            content: block.content ?? '',
            timestamp,
            metadata: {
              seq: entry.seq,
              tool_use_id: block.tool_use_id,
              isError: block.is_error,
              ...(imageUrl ? { imageUrl } : {})
            }
          })
        }
      }
    } else if (entry.role === 'assistant') {
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]
        if (block.type === 'text' && block.text) {
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'text',
            content: block.text,
            timestamp,
            metadata: { seq: entry.seq, model: entry.model, tokens: entry.tokens }
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
        } else if (block.type === 'thinking' && block.thinking) {
          displayEntries.push({
            id: `loop-${entry.seq}-${bi}`,
            type: 'thinking',
            content: block.thinking,
            timestamp,
            metadata: { seq: entry.seq, model: entry.model, tokens: entry.tokens }
          })
        }
      }
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
