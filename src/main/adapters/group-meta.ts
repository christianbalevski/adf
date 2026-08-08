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

  constructor(
    private ttlMs: number = DEFAULT_TTL_MS,
    private failureTtlMs: number = DEFAULT_FAILURE_TTL_MS
  ) {}

  private lookup(chatId: string): { value: GroupMeta | null; fetchedAt: number } | null {
    const entry = this.entries.get(chatId)
    if (!entry) return null
    const ttl = entry.value ? this.ttlMs : this.failureTtlMs
    if (Date.now() - entry.fetchedAt > ttl) {
      this.entries.delete(chatId)
      return null
    }
    return entry
  }

  get(chatId: string): GroupMeta | null {
    return this.lookup(chatId)?.value ?? null
  }

  set(chatId: string, value: GroupMeta): void {
    this.entries.set(chatId, { value, fetchedAt: Date.now() })
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
      this.entries.set(chatId, { value: fresh, fetchedAt: Date.now() })
      return fresh
    } catch {
      this.entries.set(chatId, { value: null, fetchedAt: Date.now() })
      return null
    }
  }
}
