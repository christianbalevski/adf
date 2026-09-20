import type { ChatParticipant, GroupMeta } from '../../shared/types/channel-adapter.types'

/**
 * The `meta.group` convention: descriptive chat context attached by channel
 * adapters to inbound inbox rows (the inbox `meta` column, NOT
 * `source_context` — source_context is the reply-routing bag and gets copied
 * wholesale onto outbound replies).
 *
 * The GroupMeta shape itself lives in the shared channel-adapter.types
 * (ChatInfo extends it); it is re-exported here for adapter convenience.
 *
 * Participant lists are capped at MAX_GROUP_PARTICIPANTS at the producer:
 * msg_read returns whole rows and the tool-result limiter truncates entire
 * results, so an unbounded roster here would nuke the agent's inbox reads.
 *
 * `participants_scope` tells the agent what the list actually represents —
 * platforms differ in what they can enumerate:
 *   - 'all'      full membership (WhatsApp groups, email to/cc)
 *   - 'admins'   admins only (Telegram — the Bot API cannot list members)
 *   - 'mentions' only users mentioned in this message (Discord default)
 *   - 'page'     the first page of a paginated roster (Slack)
 */
export type { GroupMeta }

export const MAX_GROUP_PARTICIPANTS = 20

export function buildGroupMeta(input: {
  platform: string
  chatId: string
  chatType?: string
  title?: string
  description?: string
  participants?: ChatParticipant[]
  participantCount?: number
  participantsScope?: GroupMeta['participants_scope']
}): GroupMeta {
  const all = input.participants ?? []
  const capped = all.slice(0, MAX_GROUP_PARTICIPANTS)
  const totalKnown = input.participantCount ?? all.length
  return {
    platform: input.platform,
    chat_id: input.chatId,
    chat_type: input.chatType,
    title: input.title,
    description: input.description,
    participants: capped,
    participant_count: totalKnown,
    participants_truncated: capped.length < totalKnown,
    participants_scope: input.participantsScope
  }
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_FAILURE_TTL_MS = 60 * 1000

/**
 * Tiny TTL cache so busy group chats don't trigger a platform metadata fetch
 * on every inbound message. One instance per adapter; keyed by chat id.
 * Failures are negative-cached (shorter TTL) so a chat whose metadata fetch
 * consistently fails — e.g. a missing scope — doesn't re-issue a doomed
 * platform API call on every single inbound message.
 */
export class GroupMetaCache {
  private entries = new Map<string, { value: GroupMeta | null; fetchedAt: number }>()
  /** Entry count past which an insert of a NEW key sweeps expired entries first. */
  private static readonly SWEEP_THRESHOLD = 64

  constructor(
    private ttlMs: number = DEFAULT_TTL_MS,
    private failureTtlMs: number = DEFAULT_FAILURE_TTL_MS
  ) {}

  private expired(entry: { value: GroupMeta | null; fetchedAt: number }, now: number): boolean {
    return now - entry.fetchedAt > (entry.value ? this.ttlMs : this.failureTtlMs)
  }

  private lookup(chatId: string): { value: GroupMeta | null; fetchedAt: number } | null {
    const entry = this.entries.get(chatId)
    if (!entry) return null
    if (this.expired(entry, Date.now())) {
      this.entries.delete(chatId)
      return null
    }
    return entry
  }

  /**
   * Store an entry, opportunistically dropping expired ones first. Without
   * this a chat that is never looked up again keeps its entry forever — a
   * long-lived adapter would accumulate one per chat it ever saw. Sweeping
   * only when a NEW key pushes the map past the threshold keeps the common
   * refresh-in-place path O(1) and needs no timer.
   */
  private store(chatId: string, value: GroupMeta | null): void {
    const now = Date.now()
    if (this.entries.size >= GroupMetaCache.SWEEP_THRESHOLD && !this.entries.has(chatId)) {
      for (const [key, entry] of this.entries) {
        if (this.expired(entry, now)) this.entries.delete(key)
      }
    }
    this.entries.set(chatId, { value, fetchedAt: now })
  }

  get(chatId: string): GroupMeta | null {
    return this.lookup(chatId)?.value ?? null
  }

  set(chatId: string, value: GroupMeta): void {
    this.store(chatId, value)
  }

  clear(): void {
    this.entries.clear()
  }

  /**
   * Fetch-through helper: cached value if fresh, otherwise call fetch and
   * cache the result. A fetch failure (throw or null) returns null and is
   * negative-cached with the shorter failure TTL, so repeated failures back
   * off instead of retrying per message — enrichment must never drop the
   * message.
   */
  async getOrFetch(chatId: string, fetch: () => Promise<GroupMeta | null>): Promise<GroupMeta | null> {
    const cached = this.lookup(chatId)
    if (cached) return cached.value
    try {
      const fresh = await fetch()
      this.store(chatId, fresh)
      return fresh
    } catch {
      this.store(chatId, null)
      return null
    }
  }
}
