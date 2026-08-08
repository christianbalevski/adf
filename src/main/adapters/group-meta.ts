import type { ChatParticipant } from '../../shared/types/channel-adapter.types'

/**
 * The `meta.group` convention: descriptive chat context attached by channel
 * adapters to inbound inbox rows (the inbox `meta` column, NOT
 * `source_context` — source_context is the reply-routing bag and gets copied
 * wholesale onto outbound replies).
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
export interface GroupMeta {
  platform: string
  chat_id: string
  chat_type?: string
  title?: string
  description?: string
  participants: ChatParticipant[]
  /** True total when known — may exceed participants.length */
  participant_count?: number
  participants_truncated: boolean
  participants_scope?: 'all' | 'admins' | 'mentions' | 'page'
}

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

/**
 * Tiny TTL cache so busy group chats don't trigger a platform metadata fetch
 * on every inbound message. One instance per adapter; keyed by chat id.
 */
export class GroupMetaCache {
  private entries = new Map<string, { value: GroupMeta; fetchedAt: number }>()

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {}

  get(chatId: string): GroupMeta | null {
    const entry = this.entries.get(chatId)
    if (!entry) return null
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.entries.delete(chatId)
      return null
    }
    return entry.value
  }

  set(chatId: string, value: GroupMeta): void {
    this.entries.set(chatId, { value, fetchedAt: Date.now() })
  }

  clear(): void {
    this.entries.clear()
  }

  /**
   * Fetch-through helper: cached value if fresh, otherwise call fetch and
   * cache the result. A fetch failure returns null and caches nothing —
   * enrichment must never block ingest.
   */
  async getOrFetch(chatId: string, fetch: () => Promise<GroupMeta | null>): Promise<GroupMeta | null> {
    const cached = this.get(chatId)
    if (cached) return cached
    try {
      const fresh = await fetch()
      if (fresh) this.set(chatId, fresh)
      return fresh
    } catch {
      return null
    }
  }
}
