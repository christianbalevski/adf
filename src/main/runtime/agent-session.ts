import type { AdfWorkspace } from '../adf/adf-workspace'
import type { LLMMessage, ContentBlock } from '../../shared/types/provider.types'
import type { LoopTokenUsage } from '../../shared/types/adf-v02.types'

/** A code-authored context message that is waiting for a safe model boundary. */
export interface QueuedContextInjection {
  role: 'user'
  text: string
  category: string
  origin: string
  key?: string
}

export class AgentSession {
  private messages: LLMMessage[] = []
  private workspace: AdfWorkspace
  private sessionId: string

  // Retry buffer for loop writes whose immediate write-through INSERT failed
  // (DB busy/closed). Normally empty: addMessage/appendContextEntry persist
  // synchronously (WAL + synchronous=NORMAL makes this sub-ms), so flushToLoop
  // is a cheap safety net that only re-attempts failed inserts.
  private pendingLoopWrites: { role: 'user' | 'assistant'; content: ContentBlock[]; model?: string; tokens?: LoopTokenUsage; createdAt: number }[] = []

  // Context injections arrive from code while a model/tool turn may be in
  // progress. They must never be inserted between an assistant tool_use and
  // its user tool_result, so the executor drains this queue only immediately
  // before a model request.
  private pendingContextInjections: QueuedContextInjection[] = []

  constructor(workspace: AdfWorkspace) {
    this.workspace = workspace
    this.sessionId = `session-${Date.now()}`
  }

  getMessages(): LLMMessage[] {
    return this.messages
  }

  addMessage(msg: LLMMessage, meta?: { model?: string; tokens?: LoopTokenUsage }, opts?: { skipLoop?: boolean }): void {
    const now = Date.now()
    msg.created_at = now
    this.messages.push(msg)

    // Callers that already persisted this exact content to the loop (e.g. an
    // owner message appended at delivery time) skip the buffered write —
    // the message is in context AND in the loop, just not twice.
    if (opts?.skipLoop) return

    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text' as const, text: msg.content }]
    // Strip multimodal blocks — they're ephemeral (for current context only), not persisted
    const persistContent = content.filter(b => b.type !== 'image_url' && b.type !== 'input_audio' && b.type !== 'video_url')
    this.persistLoopEntry({
      role: msg.role as 'user' | 'assistant',
      content: persistContent,
      model: meta?.model,
      tokens: meta?.tokens,
      createdAt: now
    })
  }

  /** Write a loop entry through to SQLite immediately so it is durable the
   *  moment it exists (no buffered-turn durability window). On INSERT failure
   *  (DB busy/closed) fall back to buffering so flushToLoop retries later —
   *  a write error must never crash the turn or lose the entry silently. */
  private persistLoopEntry(entry: { role: 'user' | 'assistant'; content: ContentBlock[]; model?: string; tokens?: LoopTokenUsage; createdAt: number }): void {
    // If earlier entries are already queued behind a failed insert, queue this
    // one too — writing it now would leapfrog the failed entry in seq order,
    // and a retried row landing at the tail puts tool_result before its
    // tool_use on restore (provider 400 → destructive strip). The next
    // successful flush drains everything in original order.
    if (this.pendingLoopWrites.length > 0) {
      this.pendingLoopWrites.push(entry)
      return
    }
    try {
      this.workspace.appendToLoop(entry.role, entry.content, entry.model, entry.tokens, entry.createdAt)
    } catch (error) {
      console.error('[AgentSession] Immediate loop write failed — buffering for retry:', error)
      this.pendingLoopWrites.push(entry)
    }
  }

  /**
   * Retry-flush entries whose immediate write-through insert failed.
   * Normally a no-op (the buffer only holds failed inserts). Still called on
   * per-step boundaries, turn_complete, and every shutdown path so a transient
   * DB error can't silently drop an entry.
   */
  flushToLoop(): void {
    if (this.pendingLoopWrites.length === 0) return
    // Wrap all inserts in a single transaction to avoid per-INSERT fsync.
    // On failure keep the buffer for a later retry — bare call sites
    // (executor finally, sweepIdleAgents) must never receive a throw.
    try {
      this.workspace.transaction(() => {
        for (const entry of this.pendingLoopWrites) {
          this.workspace.appendToLoop(entry.role, entry.content, entry.model, entry.tokens, entry.createdAt)
        }
      })
    } catch (error) {
      console.error('[AgentSession] Loop retry-flush failed — keeping buffer for later retry:', error)
      return
    }
    this.pendingLoopWrites = []
  }

  /** Append a context entry to the loop ONLY — not to the LLM message history.
   *  Stored as a user-role loop entry with a [Context: <category>] prefix for
   *  UI/SQL visibility ("No Secrets"). The model already receives this content
   *  through the request itself (system prompt via the `system` param, dynamic
   *  instructions as a per-call trailing user message), so including it in
   *  `messages` would send it twice — a ~30k+ token duplication per request
   *  when large files are injected into the system prompt. */
  appendContextEntry(category: string, content: string): void {
    const block: ContentBlock = { type: 'text', text: `[Context: ${category}] ${content}` }
    this.persistLoopEntry({
      role: 'user',
      content: [block],
      createdAt: Date.now()
    })
  }

  /**
   * Queue code-authored user context for the next safe model boundary.
   *
   * The caller has already persisted the exact text to adf_loop.  Keeping
   * persistence outside this method makes audit durable immediately, while
   * `drainContextInjections` can safely add it to the active session later.
   * A key coalesces pending state: the last value wins until delivery, but all
   * versions remain in the loop audit trail.
   */
  queueContextInjection(injection: QueuedContextInjection): void {
    if (injection.key) {
      const priorIndex = this.pendingContextInjections.findIndex(entry => entry.key === injection.key)
      if (priorIndex >= 0) this.pendingContextInjections.splice(priorIndex, 1)
    }
    this.pendingContextInjections.push(injection)
  }

  /**
   * Move queued context into the actual provider message history. Call only at
   * a model boundary after the preceding tool batch has its complete results.
   *
   * Entries skip loop persistence because `loop_inject` writes them atomically
   * at enqueue time.  A copied array invalidates provider conversion caches.
   */
  drainContextInjections(): QueuedContextInjection[] {
    if (this.pendingContextInjections.length === 0) return []
    const pending = this.pendingContextInjections.splice(0)
    for (const injection of pending) {
      this.addMessage(
        { role: 'user', content: [{ type: 'text', text: injection.text }] },
        undefined,
        { skipLoop: true }
      )
    }
    this.messages = this.messages.slice()
    return pending
  }

  getWorkspace(): AdfWorkspace {
    return this.workspace
  }

  getSessionId(): string {
    return this.sessionId
  }

  /** Bulk-replace message history (for restoring from persisted chat).
   *  Drops [Context: …] loop entries that are UI/SQL-only. Versioned
   *  keyed loop_inject entries are queued again so mutable code-authored state
   *  survives a restart without replaying unkeyed one-shot notices.
   *  Repairs orphaned tool blocks so the API doesn't reject:
   *  - Orphaned tool_result at the start (missing preceding tool_use)
   *  - Orphaned tool_use at the end (missing following tool_result) */
  restoreMessages(messages: LLMMessage[]): void {
    this.messages = []
    this.pendingContextInjections = []
    for (const message of messages) {
      const injection = parseContextInjection(message)
      if (injection) {
        this.queueContextInjection(injection)
      } else if (!isContextEntry(message)) {
        this.messages.push(message)
      }
    }
    this.repairOrphanedToolResult()
    this.repairOrphanedToolUse()
  }

  /** Scan ALL messages for tool_use blocks without matching tool_result
   *  (and vice versa) and strip them. This handles orphans in the middle of
   *  history (e.g. from pruning, compaction, or copying an .adf file
   *  mid-execution), not just at the head/tail. */
  private repairOrphanedToolUse(): void {
    if (this.messages.length === 0) return

    // Strip tool blocks with missing/empty ids first — the orphan scans below
    // all guard on truthy ids, so an empty-id block would survive them and be
    // replayed to the API as call_id: "" (rejected with 400 on every request).
    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue
      const kept = msg.content.filter(
        (b) => !((b.type === 'tool_use' && !b.id) || (b.type === 'tool_result' && !b.tool_use_id))
      )
      if (kept.length !== msg.content.length) {
        msg.content = kept.length > 0
          ? kept
          : [{ type: 'text' as const, text: '[Tool block removed — missing tool call id]' }]
      }
    }

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

  /** Repair orphaned tool blocks on the live session mid-run (pre-send guard).
   *  Same repairs as restoreMessages, but for histories corrupted after
   *  restore — e.g. an external session reset landing mid-turn, which leaves
   *  the in-flight turn's tool_results without their assistant tool_use.
   *  Replaces the array reference so the provider's conversion cache (keyed
   *  by array identity) rebuilds instead of serving the pre-repair prefix. */
  repairToolPairing(): void {
    this.repairOrphanedToolResult()
    this.repairOrphanedToolUse()
    this.messages = this.messages.slice()
  }

  reset(): void {
    this.messages = []
    this.pendingLoopWrites = []
    this.pendingContextInjections = []
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

    let anyChanged = false
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
        anyChanged = true
      }
    }

    // Replace the array reference so the provider's conversion cache (keyed
    // by array identity) rebuilds. Without this the cached CoreMessages keep
    // the pre-strip base64 media: the request still ships it (defeating the
    // heap protection) while the token pre-flight measures the stripped
    // session and under-counts what is actually sent.
    if (anyChanged) {
      this.messages = this.messages.slice()
    }
  }

}

/** A loop entry written by appendContextEntry — UI/SQL-only, never sent to the LLM. */
function isContextEntry(msg: LLMMessage): boolean {
  if (typeof msg.content === 'string') return msg.content.startsWith('[Context: ')
  if (!Array.isArray(msg.content)) return false
  const first = msg.content[0]
  return first?.type === 'text' && typeof first.text === 'string' && first.text.startsWith('[Context: ')
}

/** Parse only keyed state entries written by the v2 loop_inject wire format.
 * Unkeyed entries are one-shot notices: they are auditable but intentionally
 * never replayed on every process restart. */
function parseContextInjection(msg: LLMMessage): QueuedContextInjection | null {
  if (msg.role !== 'user') return null
  const text = typeof msg.content === 'string'
    ? msg.content
    : (Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0]?.type === 'text'
      ? msg.content[0].text
      : undefined)
  if (typeof text !== 'string') return null

  const match = text.match(/^\[Context: ([a-z][a-z0-9_.-]{0,63}) \| loop_inject=v2 \| origin=([a-zA-Z0-9_.:/-]{1,128})(?: \| key=([a-zA-Z0-9_.:-]{1,128}))?\] ([\s\S]*)$/)
  if (!match) return null
  const [, category, origin, key] = match
  if (!key) return null
  return {
    role: 'user',
    text,
    category,
    origin,
    key,
  }
}
