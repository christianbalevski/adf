import type { AdfWorkspace } from '../adf/adf-workspace'
import type { LLMMessage, ContentBlock } from '../../shared/types/provider.types'
import type { LoopTokenUsage } from '../../shared/types/adf-v02.types'

export class AgentSession {
  private messages: LLMMessage[] = []
  private workspace: AdfWorkspace
  private sessionId: string

  // Buffered messages waiting to be flushed to the loop table.
  // Flushing is deferred to turn_complete to avoid synchronous DB writes
  // in the hot tool-loop path.
  private pendingLoopWrites: { role: 'user' | 'assistant'; content: ContentBlock[]; model?: string; tokens?: LoopTokenUsage; createdAt: number }[] = []

  constructor(workspace: AdfWorkspace) {
    this.workspace = workspace
    this.sessionId = `session-${Date.now()}`
  }

  getMessages(): LLMMessage[] {
    return this.messages
  }

  addMessage(msg: LLMMessage, meta?: { model?: string; tokens?: LoopTokenUsage }): void {
    const now = Date.now()
    msg.created_at = now
    this.messages.push(msg)

    // Buffer the write — don't hit SQLite until flushToLoop() is called
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text' as const, text: msg.content }]
    // Strip multimodal blocks — they're ephemeral (for current context only), not persisted
    const persistContent = content.filter(b => b.type !== 'image_url' && b.type !== 'input_audio' && b.type !== 'video_url')
    this.pendingLoopWrites.push({
      role: msg.role as 'user' | 'assistant',
      content: persistContent,
      model: meta?.model,
      tokens: meta?.tokens,
      createdAt: now
    })
  }

  /**
   * Flush all buffered messages to the loop table in one batch.
   * Called on turn_complete and before file close.
   */
  flushToLoop(): void {
    if (this.pendingLoopWrites.length === 0) return
    // Wrap all inserts in a single transaction to avoid per-INSERT fsync
    this.workspace.transaction(() => {
      for (const entry of this.pendingLoopWrites) {
        this.workspace.appendToLoop(entry.role, entry.content, entry.model, entry.tokens, entry.createdAt)
      }
    })
    this.pendingLoopWrites = []
  }

  /** Append a context entry to the loop and message history.
   *  Stored as a regular user-role message with a [Context: <category>] prefix. */
  appendContextEntry(category: string, content: string): void {
    const now = Date.now()
    const block: ContentBlock = { type: 'text', text: `[Context: ${category}] ${content}` }
    this.messages.push({ role: 'user', content: [block], created_at: now })
    this.pendingLoopWrites.push({
      role: 'user',
      content: [block],
      createdAt: now
    })
  }

  getWorkspace(): AdfWorkspace {
    return this.workspace
  }

  getSessionId(): string {
    return this.sessionId
  }

  /** Bulk-replace message history (for restoring from persisted chat).
   *  Repairs orphaned tool blocks so the API doesn't reject:
   *  - Orphaned tool_result at the start (missing preceding tool_use)
   *  - Orphaned tool_use at the end (missing following tool_result) */
  restoreMessages(messages: LLMMessage[]): void {
    this.messages = [...messages]
    this.repairOrphanedToolResult()
    this.repairOrphanedToolUse()
  }

  /** Scan ALL messages for tool_use blocks without matching tool_result
   *  (and vice versa) and strip them. This handles orphans in the middle of
   *  history (e.g. from pruning, compaction, or copying an .adf file
   *  mid-execution), not just at the head/tail. */
  private repairOrphanedToolUse(): void {
    if (this.messages.length === 0) return

    // Collect all tool_result IDs and tool_use IDs across the entire history
    const toolResultIds = new Set<string>()
    const toolUseIds = new Set<string>()
    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id)
        } else if (block.type === 'tool_use' && block.id) {
          toolUseIds.add(block.id)
        }
      }
    }

    // For the last assistant message with orphaned tool_use, add synthetic results
    // (preserves context for the next LLM turn)
    const last = this.messages[this.messages.length - 1]
    if (last.role === 'assistant' && Array.isArray(last.content)) {
      const orphanedTail = last.content.filter(
        (b): b is ContentBlock & { type: 'tool_use'; id: string } =>
          b.type === 'tool_use' && !!b.id && !toolResultIds.has(b.id)
      )
      if (orphanedTail.length > 0) {
        const syntheticResults: ContentBlock[] = orphanedTail.map((block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: '[System: This tool call was interrupted by an application restart and never completed.]',
          is_error: true
        }))
        this.messages.push({ role: 'user', content: syntheticResults })
        // Add these to the set so the middle-scan below doesn't also strip them
        for (const block of orphanedTail) toolResultIds.add(block.id)
      }
    }

    // Strip orphaned tool_use blocks from assistant messages in the middle of history
    for (const msg of this.messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      const hasOrphan = msg.content.some(
        b => b.type === 'tool_use' && b.id && !toolResultIds.has(b.id)
      )
      if (!hasOrphan) continue

      msg.content = msg.content.filter(
        b => !(b.type === 'tool_use' && b.id && !toolResultIds.has(b.id))
      )
      // If all content was stripped, replace with placeholder text
      if (msg.content.length === 0) {
        msg.content = [{ type: 'text' as const, text: '[Tool call removed — no matching result in history]' }]
      }
    }

    // Strip orphaned tool_result blocks from user messages (reverse of above)
    for (const msg of this.messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      const hasOrphan = msg.content.some(
        b => b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id)
      )
      if (!hasOrphan) continue

      msg.content = msg.content.filter(
        b => !(b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id))
      )
      if (msg.content.length === 0) {
        msg.content = [{ type: 'text' as const, text: '[Tool result removed — no matching call in history]' }]
      }
    }
  }

  /** Strip orphaned tool_result blocks from the start of message history.
   *  These occur when the loop table's first entry is a user message with
   *  tool_result blocks whose corresponding assistant tool_use was deleted
   *  (e.g. by compaction or partial loop clearing). */
  private repairOrphanedToolResult(): void {
    while (this.messages.length > 0) {
      const first = this.messages[0]

      // If first message is assistant, remove it (API requires starting with user)
      if (first.role === 'assistant') {
        this.messages.shift()
        continue
      }

      // If first message is user with tool_result blocks, strip them
      if (first.role === 'user' && Array.isArray(first.content)) {
        const hasToolResult = first.content.some(b => b.type === 'tool_result')
        if (hasToolResult) {
          const cleaned = first.content.filter(b => b.type !== 'tool_result')
          if (cleaned.length === 0) {
            this.messages.shift()
            continue
          }
          first.content = cleaned
        }
      }

      break
    }
  }

  reset(): void {
    this.messages = []
    this.pendingLoopWrites = []
  }

  /**
   * Replace base64 media blocks (image_url, input_audio, video_url) in older
   * messages with lightweight placeholders.  Media is only useful for the LLM
   * in the most recent turns; keeping it in every prior message causes heap
   * growth proportional to session length (the OOM that crashes Electron at ~3 GB).
   *
   * @param keepRecentMessages Number of trailing messages whose media to preserve.
   *   Default 4 ≈ 2 LLM turns (assistant + user-tool-results each).
   */
  stripOldMedia(keepRecentMessages = 4): void {
    const cutoff = this.messages.length - keepRecentMessages
    if (cutoff <= 0) return

    for (let i = 0; i < cutoff; i++) {
      const msg = this.messages[i]
      if (!Array.isArray(msg.content)) continue

      let changed = false
      const cleaned: ContentBlock[] = []
      for (const block of msg.content) {
        if (block.type === 'image_url' || block.type === 'input_audio' || block.type === 'video_url') {
          changed = true
          // Don't add a placeholder — the tool_result text already describes the file
        } else {
          cleaned.push(block)
        }
      }
      if (changed) {
        msg.content = cleaned
      }
    }
  }

  /** Trim old messages to stay within context limits */
  compact(maxMessages: number): void {
    if (this.messages.length > maxMessages) {
      this.messages = this.messages.slice(-maxMessages)
      this.repairOrphanedToolResult()
      this.repairOrphanedToolUse()
    }
  }

  /**
   * Prune message history to keep only the most recent `maxMessages` messages.
   * Preserves message pairs so we never leave a dangling tool_result without
   * its corresponding assistant message, or an assistant tool_use without
   * its user tool_result response.
   *
   * @param maxMessages Maximum number of messages to keep. 0 or undefined = no limit.
   */
  pruneHistory(maxMessages: number | undefined): void {
    if (!maxMessages || maxMessages <= 0) return
    if (this.messages.length <= maxMessages) return

    // Always keep at least the last maxMessages. But adjust the cut point
    // to avoid splitting a tool_use/tool_result pair.
    let cutIndex = this.messages.length - maxMessages

    // Walk forward from the cut point to find a clean boundary.
    // A clean boundary is where the message at cutIndex is a 'user' role
    // and is NOT a tool_result continuation.
    while (cutIndex < this.messages.length - 2) {
      const msg = this.messages[cutIndex]
      if (msg.role === 'user') {
        // Check if this is a tool_result message
        if (Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result')) {
          cutIndex++
          continue
        }
        break // Clean boundary found
      }
      cutIndex++
    }

    if (cutIndex > 0 && cutIndex < this.messages.length) {
      this.messages = this.messages.slice(cutIndex)
      // Repair any orphaned tool blocks created by the cut
      this.repairOrphanedToolResult()
      this.repairOrphanedToolUse()
    }
  }
}
