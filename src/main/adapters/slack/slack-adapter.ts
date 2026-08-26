import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SocketModeClient, LogLevel } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { markdownToMrkdwn } from './mrkdwn'
import { withSetupGuide } from '../shared/error-hints'
import { resolveOutboundText } from '../form-render'
import { buildGroupMeta, GroupMetaCache } from '../group-meta'
import type { GroupMeta } from '../group-meta'
import { resolveCatchUpConfig } from '../../../shared/types/channel-adapter.types'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  ChatInfoResult,
  ChatParticipant,
  CatchUpConfig
} from '../../../shared/types/channel-adapter.types'

/** Shape of the slice of Slack message events this adapter consumes */
interface SlackMessageEvent {
  type: string
  subtype?: string
  channel: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  team?: string
  files?: Array<{
    id: string
    name?: string
    mimetype?: string
    size?: number
    url_private_download?: string
  }>
}

/**
 * Message shape from conversations.history / conversations.replies — the same
 * fields as a live event, minus `channel`/`channel_type` (history messages
 * never carry them; the backfill injects both before reusing handleMessage),
 * plus thread bookkeeping present only on parents.
 */
interface SlackHistoryMessage extends Omit<SlackMessageEvent, 'channel' | 'channel_type'> {
  latest_reply?: string
  reply_count?: number
}

/** Slice of a users.conversations entry needed to derive event channel_type */
interface SlackConversation {
  id: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
}

/** Filename of the per-channel last-seen-ts store inside ctx.getDataDir() */
const CURSOR_FILE = 'catch-up-cursors.json'

/**
 * Derive the channel_type a live message event would carry from the
 * conversation object (live events use 'group' for private channels).
 */
function conversationChannelType(conv: SlackConversation): string {
  return conv.is_im ? 'im' : conv.is_mpim ? 'mpim' : conv.is_private ? 'group' : 'channel'
}

/** Guidance appended to every missing-scope error — same fix regardless of which call failed. */
const SCOPE_FIX_HINT =
  '(add it under OAuth & Permissions at api.slack.com/apps, reinstall the app, then restart the adapter)'

/**
 * Map a Slack WebAPI error to an actionable message. The SDK's generic
 * "An API error occurred: missing_scope" hides the one thing the user needs:
 * which OAuth scope the bot token lacks. WebAPIPlatformError carries it in
 * `err.data.needed` (with `err.data.provided` listing what the token has).
 */
function describeSlackError(err: unknown): string {
  const platform = err as {
    data?: { error?: string; needed?: string; provided?: string }
  }
  if (platform?.data?.error === 'missing_scope') {
    const needed = platform.data.needed ?? 'unknown'
    const provided = platform.data.provided
    return (
      `Slack rejected the call: missing OAuth scope "${needed}"` +
      (provided ? ` — token has "${provided}"` : '') +
      ` ${SCOPE_FIX_HINT}`
    )
  }
  return String(err instanceof Error ? err.message : err)
}

/**
 * Append the setup-guide link to a message that carries an actionable Slack
 * app-config fix (recognized by the shared scope hint). Applied only at the
 * outermost point where a final message is assembled, so composed messages
 * (e.g. partial-success attachment reports) carry the link exactly once.
 */
function withGuideIfActionable(message: string): string {
  return message.includes(SCOPE_FIX_HINT) ? withSetupGuide('slack', message) : message
}

/**
 * Slack adapter using Socket Mode.
 *
 * Events arrive over an outbound WebSocket (app-level token) — no public
 * endpoint needed, matching the Telegram polling / Discord gateway model.
 * Outbound messages go through the Web API (bot token). Replies thread by
 * default: outbound message_id is the posted `ts`, and inbound thread
 * replies carry `reply_to_message_id = thread_ts`, which resolves the
 * parent to the thread-root outbox row.
 */
export class SlackAdapter implements ChannelAdapter {
  private socket: SocketModeClient | null = null
  private web: WebClient | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private selfUserId: string | null = null
  private selfBotId: string | null = null
  private teamId: string | null = null
  private userNameCache = new Map<string, string>()
  private groupMetaCache = new GroupMetaCache()
  /** channel_id → last seen message ts (Slack ts strings, compared numerically) */
  private cursors: Record<string, string> = {}
  private cursorPath: string | null = null
  private cursorWriteWarned = false

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connecting'

    const appToken = ctx.getCredential('SLACK_APP_TOKEN')
    const botToken = ctx.getCredential('SLACK_BOT_TOKEN')
    if (!appToken) {
      this.currentStatus = 'error'
      throw new Error(withSetupGuide('slack', 'Missing SLACK_APP_TOKEN credential (app-level token, xapp-...)'))
    }
    if (!botToken) {
      this.currentStatus = 'error'
      throw new Error(withSetupGuide('slack', 'Missing SLACK_BOT_TOKEN credential (bot token, xoxb-...)'))
    }

    this.web = new WebClient(botToken)

    // Validate the bot token and capture our own identity for echo suppression
    const auth = await this.web.auth.test()
    this.selfUserId = (auth.user_id as string) ?? null
    this.selfBotId = (auth.bot_id as string) ?? null
    this.teamId = (auth.team_id as string) ?? null

    // Cursor store for offline catch-up. Without a host data directory there
    // is nowhere to persist last-seen positions — skip backfill entirely.
    this.cursorWriteWarned = false
    if (ctx.getDataDir) {
      const dataDir = ctx.getDataDir()
      try { mkdirSync(dataDir, { recursive: true }) } catch { /* already exists */ }
      this.cursorPath = join(dataDir, CURSOR_FILE)
    } else {
      this.cursorPath = null
      ctx.log('info', 'Offline catch-up disabled: host provides no adapter data directory')
    }
    this.loadCursors()

    // The SDK's default logger prints every ping/pong hiccup to the console
    // at WARN. Route real errors into the adapter log and drop the rest —
    // reconnection is handled (and reported) via the lifecycle events below.
    this.socket = new SocketModeClient({
      appToken,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...msgs: unknown[]) =>
          this.ctx?.log('error', `Socket Mode: ${msgs.map(String).join(' ')}`),
        setLevel: () => {},
        getLevel: () => LogLevel.ERROR,
        setName: () => {}
      }
    })

    this.socket.on('connected', () => {
      this.currentStatus = 'connected'
      this.ctx?.log('info', `Socket Mode connected (bot ${this.selfUserId} in team ${this.teamId})`)
    })
    this.socket.on('reconnecting', () => {
      // Transient drop with auto-reconnect in progress — an operational flake,
      // not an error state. Log only on the first attempt after a drop.
      if (this.currentStatus === 'connected') {
        this.ctx?.log('info', 'Socket Mode connection lost — reconnecting')
      }
      if (this.currentStatus !== 'disconnected') {
        this.currentStatus = 'connecting'
      }
    })
    this.socket.on('disconnected', () => {
      // The SDK emits this only terminally (explicit disconnect, or reconnect
      // disabled/exhausted) — only report if we didn't stop deliberately
      if (this.currentStatus !== 'disconnected') {
        this.currentStatus = 'error'
        this.ctx?.log('warn', 'Socket Mode disconnected')
      }
    })

    this.socket.on('slack_event', async ({ ack, body }) => {
      // Ack immediately — unacked envelopes are redelivered by Slack
      try { await ack() } catch { /* ignore */ }
      try {
        const event = (body as { event?: SlackMessageEvent })?.event
        if (!event || event.type !== 'message') return
        await this.handleMessage(event)
      } catch (err) {
        this.ctx?.log('warn', `Inbound handling failed: ${err instanceof Error ? err.message : err}`)
      }
    })

    await this.socket.start()
    this.currentStatus = 'connected'
    ctx.log('info', `Slack adapter started as ${(auth.user as string) ?? this.selfUserId}`)

    // Slack keeps no offline queue for a disconnected socket-mode app — pull
    // what we missed. Runs after the socket is up (never blocks startup) and
    // any failure is logged, not fatal.
    void this.runCatchUp().catch((err) => {
      this.ctx?.log('warn', withGuideIfActionable(`Catch-up failed: ${describeSlackError(err)}`))
    })
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    if (this.socket) {
      try { await this.socket.disconnect() } catch { /* ignore */ }
      this.socket = null
    }
    this.web = null
    this.ctx = null
    this.userNameCache.clear()
    this.groupMetaCache.clear()
    this.cursors = {}
    this.cursorPath = null
  }

  private async handleMessage(event: SlackMessageEvent): Promise<void> {
    if (!this.ctx || !this.web) return

    // Track the newest ts we've observed per channel — including messages the
    // policy below drops — so catch-up never re-fetches ground already covered.
    if (event.channel && event.ts) this.advanceCursor(event.channel, event.ts)

    // Skip our own messages, other bots, and non-content subtypes
    // (message_changed, message_deleted, channel_join, ...)
    if (event.bot_id || (event.user && event.user === this.selfUserId)) return
    if (event.subtype && event.subtype !== 'file_share') return
    if (!event.user) return

    const config = this.ctx.getConfig()
    const policy = config.policy ?? {}
    const isDm = event.channel_type === 'im'

    if (isDm) {
      const dmPolicy = policy.dm ?? 'all'
      if (dmPolicy === 'none') return
      if (dmPolicy === 'allowlist') {
        const allowFrom = policy.allow_from ?? []
        if (!allowFrom.includes(event.user)) return
      }
    } else {
      const groupPolicy = policy.groups ?? 'all'
      if (groupPolicy === 'none') return
      if (groupPolicy === 'mention') {
        const isMentioned = this.selfUserId ? (event.text ?? '').includes(`<@${this.selfUserId}>`) : false
        const isThreadReplyToUs = await this.isReplyToOwnThread(event)
        if (!isMentioned && !isThreadReplyToUs) return
      }
    }

    const senderName = await this.resolveUserName(event.user)
    let text = event.text ?? ''
    // Strip our own mention token from the visible text
    if (this.selfUserId) {
      text = text.replace(new RegExp(`<@${this.selfUserId}>`, 'g'), '').trim()
    }

    // Attachments: download shared files with the bot token
    const attachments: InboundMessage['attachments'] = []
    const maxAttachmentSize = config.limits?.max_attachment_size ?? 10_000_000
    const botToken = this.ctx.getCredential('SLACK_BOT_TOKEN')
    for (const file of event.files ?? []) {
      if (!file.url_private_download) continue
      if (file.size && file.size > maxAttachmentSize) {
        this.ctx.log('warn', `Skipping oversized file "${file.name}" (${file.size} bytes)`)
        continue
      }
      try {
        const response = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${botToken}` }
        })
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} from url_private_download — the bot token may lack the "files:read" OAuth scope ${SCOPE_FIX_HINT}`
          )
        }
        // Slack serves an HTML login page (HTTP 200) instead of an error when
        // the token can't read files — don't store that as the attachment.
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('text/html') && !(file.mimetype ?? '').includes('html')) {
          throw new Error(
            `got an HTML login page instead of file content — the bot token may lack the "files:read" OAuth scope ${SCOPE_FIX_HINT}`
          )
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        const filename = file.name ?? `file_${file.id}`
        const importPath = `imported/slack/${filename}`
        this.ctx.writeAttachment(importPath, buffer, file.mimetype)
        attachments.push({
          path: importPath,
          filename,
          mimeType: file.mimetype ?? 'application/octet-stream',
          size: buffer.length
        })
      } catch (err) {
        this.ctx.log(
          'warn',
          withGuideIfActionable(`Failed to download file "${file.name}": ${err instanceof Error ? err.message : err}`)
        )
      }
    }

    if (!text && attachments.length === 0) return

    const sourceMeta: Record<string, unknown> = {
      chat_id: event.channel,
      channel_type: event.channel_type,
      team_id: event.team ?? this.teamId,
      message_id: event.ts,
      username: senderName
    }
    if (event.thread_ts) {
      sourceMeta.thread_ts = event.thread_ts
      // A thread reply's parent resolves to the thread-root message we sent
      if (event.thread_ts !== event.ts) {
        sourceMeta.reply_to_message_id = event.thread_ts
      }
    }

    // Group context (meta.group) for non-DM channels — cached, never blocks ingest
    let meta: Record<string, unknown> | undefined
    if (!isDm) {
      const group = await this.groupMetaCache.getOrFetch(event.channel, () => this.fetchGroupMeta(event.channel))
      if (group) meta = { group }
    }

    const inbound: InboundMessage = {
      sender: event.user,
      senderName,
      // Stable per-message id so the host dedups a backfilled message that
      // already arrived live (ts is unique per channel, not per workspace)
      messageId: `${event.channel}:${event.ts}`,
      payload: text || '[File]',
      attachments: attachments.length > 0 ? attachments : undefined,
      sourceMeta,
      meta,
      originalMessage: JSON.stringify(event),
      sentAt: Math.round(parseFloat(event.ts) * 1000) || undefined
    }

    this.ctx.log('info', `Inbound from ${senderName} (${event.user}) in ${event.channel_type ?? 'channel'} ${event.channel}`)
    this.ctx.ingest(inbound)
  }

  // ---------------------------------------------------------------------------
  // Offline catch-up: cursor store + history backfill
  // ---------------------------------------------------------------------------

  private loadCursors(): void {
    this.cursors = {}
    if (!this.cursorPath) return
    try {
      const raw = JSON.parse(readFileSync(this.cursorPath, 'utf8')) as Record<string, unknown>
      for (const [channel, ts] of Object.entries(raw)) {
        if (typeof ts === 'string') this.cursors[channel] = ts
      }
    } catch { /* missing or corrupt file — start with no cursors */ }
  }

  private saveCursors(): void {
    if (!this.cursorPath) return
    try {
      writeFileSync(this.cursorPath, JSON.stringify(this.cursors))
    } catch (err) {
      // A broken data dir would otherwise warn on every message — say it once
      if (!this.cursorWriteWarned) {
        this.cursorWriteWarned = true
        this.ctx?.log('warn', `Failed to persist catch-up cursors: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  /** Slack ts strings are decimal seconds — compare numerically, store verbatim. */
  private advanceCursor(channel: string, ts: string): void {
    const prev = this.cursors[channel]
    if (prev !== undefined && parseFloat(ts) <= parseFloat(prev)) return
    this.cursors[channel] = ts
    this.saveCursors()
  }

  /**
   * Pull messages missed while disconnected. Policy: backfill ONLY channels
   * already present in the cursor file — a never-seen conversation has no
   * last-seen position, and pulling max_age_hours of history for every channel
   * the bot sits in would flood a fresh install with stale backlog. Channels
   * enter the cursor file on their first live message. users.conversations is
   * used to confirm the bot still has access (and to derive channel_type).
   */
  private async runCatchUp(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.web) return
    if (!this.cursorPath) return // no data dir — already logged in start()
    const cfg = resolveCatchUpConfig(ctx.getConfig().config)
    if (!cfg.enabled) return
    const known = Object.keys(this.cursors)
    if (known.length === 0) return

    // Hold trigger notifications so a long drain wakes the agent once at the end
    ctx.beginCatchUp?.()
    try {
      const accessible = await this.listMemberConversations()
      for (const channelId of known) {
        const conv = accessible.get(channelId)
        if (!conv) continue // left the channel / access revoked — nothing to pull
        try {
          await this.backfillChannel(channelId, conversationChannelType(conv), cfg)
        } catch (err) {
          ctx.log('warn', withGuideIfActionable(`Catch-up skipped for ${channelId}: ${describeSlackError(err)}`))
        }
      }
    } catch (err) {
      // Typically a missing channels:read/groups:read/im:read/mpim:read scope —
      // report the fix and stay connected; live events are unaffected.
      ctx.log('warn', withGuideIfActionable(`Catch-up failed: ${describeSlackError(err)}`))
    } finally {
      ctx.endCatchUp?.()
    }
  }

  /** All conversations the bot is a member of, across all four types (paginated). */
  private async listMemberConversations(): Promise<Map<string, SlackConversation>> {
    const out = new Map<string, SlackConversation>()
    let cursor: string | undefined
    do {
      const page = await this.web!.users.conversations({
        types: 'public_channel,private_channel,mpim,im',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {})
      })
      for (const conv of (page.channels ?? []) as SlackConversation[]) {
        if (conv.id) out.set(conv.id, conv)
      }
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    return out
  }

  /**
   * Replay one channel's history since its cursor through handleMessage.
   * WebClient retries 429s itself (history is Tier 3, ~50/min for internal
   * apps) — no extra throttling here; max_messages bounds the damage.
   */
  private async backfillChannel(
    channelId: string,
    channelType: string,
    cfg: Required<CatchUpConfig>
  ): Promise<void> {
    const ctx = this.ctx!
    const floor = Date.now() / 1000 - cfg.max_age_hours * 3600
    const oldest = Math.max(parseFloat(this.cursors[channelId]), floor).toFixed(6)

    // Page history (newest-first) until exhausted or the per-channel cap
    const parents: SlackHistoryMessage[] = []
    let cursor: string | undefined
    let capped = false
    do {
      const page = await this.web!.conversations.history({
        channel: channelId,
        oldest,
        inclusive: false,
        limit: Math.min(cfg.max_messages, 200),
        ...(cursor ? { cursor } : {})
      })
      parents.push(...((page.messages ?? []) as SlackHistoryMessage[]))
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor && parents.length < cfg.max_messages)
    if (cursor || parents.length > cfg.max_messages) {
      capped = true
      parents.length = Math.min(parents.length, cfg.max_messages) // newest-first: keep the newest
    }

    // Replay in send order; the cap budget spans parents + thread replies
    parents.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    let budget = cfg.max_messages
    for (const msg of parents) {
      if (budget <= 0) { capped = true; break }
      budget--
      await this.handleMessage({ ...msg, channel: channelId, channel_type: channelType })
      // History carries only thread parents — replies live behind
      // conversations.replies. Parents older than `oldest` never surface in
      // history, so replies to threads outside the window are not recovered.
      if (msg.latest_reply && parseFloat(msg.latest_reply) > parseFloat(oldest)) {
        budget = await this.backfillReplies(channelId, channelType, msg.ts, oldest, budget)
      }
    }

    if (capped) {
      ctx.log('warn', `Catch-up for ${channelId} capped at ${cfg.max_messages} messages — older backlog skipped`)
    }
  }

  /** Replay thread replies newer than `oldest`; returns the remaining budget. */
  private async backfillReplies(
    channelId: string,
    channelType: string,
    parentTs: string,
    oldest: string,
    budget: number
  ): Promise<number> {
    let cursor: string | undefined
    do {
      const page = await this.web!.conversations.replies({
        channel: channelId,
        ts: parentTs,
        oldest,
        inclusive: false,
        limit: 200,
        ...(cursor ? { cursor } : {})
      })
      // The parent rides along in every replies page — drop it and anything
      // at or before the cursor, then replay oldest-first
      const replies = ((page.messages ?? []) as SlackHistoryMessage[])
        .filter((m) => m.ts !== parentTs && parseFloat(m.ts) > parseFloat(oldest))
        .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
      for (const reply of replies) {
        if (budget <= 0) return 0
        budget--
        await this.handleMessage({ ...reply, channel: channelId, channel_type: channelType })
      }
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor && budget > 0)
    return budget
  }

  /** True when the event is a reply in a thread whose root message we posted. */
  private async isReplyToOwnThread(event: SlackMessageEvent): Promise<boolean> {
    if (!this.web || !event.thread_ts || event.thread_ts === event.ts) return false
    try {
      const replies = await this.web.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 1
      })
      const root = replies.messages?.[0] as { user?: string; bot_id?: string } | undefined
      return !!root && (root.user === this.selfUserId || (!!this.selfBotId && root.bot_id === this.selfBotId))
    } catch {
      return false
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId)
    if (cached) return cached
    try {
      const result = await this.web!.users.info({ user: userId })
      const profile = result.user as { real_name?: string; name?: string } | undefined
      const name = profile?.real_name || profile?.name || userId
      this.userNameCache.set(userId, name)
      return name
    } catch {
      return userId
    }
  }

  /** conversations.info mapped to the shared chat_type/title/description
   * shape — shared by fetchGroupMeta and getChatInfo. */
  private async fetchChannelCore(channelId: string): Promise<{
    isIm: boolean
    user?: string
    numMembers?: number
    chatType: string
    title?: string
    description?: string
  } | null> {
    const info = await this.web!.conversations.info({ channel: channelId })
    const channel = info.channel as {
      name?: string
      num_members?: number
      user?: string
      topic?: { value?: string }
      purpose?: { value?: string }
      is_im?: boolean
      is_mpim?: boolean
      is_private?: boolean
    } | undefined
    if (!channel) return null
    return {
      isIm: !!channel.is_im,
      user: channel.user,
      numMembers: channel.num_members,
      chatType: channel.is_im ? 'im' : channel.is_mpim ? 'mpim' : channel.is_private ? 'private_channel' : 'channel',
      title: channel.name ? `#${channel.name}` : undefined,
      description: channel.purpose?.value || channel.topic?.value || undefined
    }
  }

  private async fetchGroupMeta(channelId: string): Promise<GroupMeta | null> {
    if (!this.web) return null
    const core = await this.fetchChannelCore(channelId)
    if (!core) return null

    let participants: ChatParticipant[] = []
    try {
      const members = await this.web.conversations.members({ channel: channelId, limit: 20 })
      participants = await Promise.all(
        (members.members ?? []).map(async (id) => ({ id, name: await this.resolveUserName(id) }))
      )
    } catch { /* roster is best-effort — bot may lack scope */ }

    return buildGroupMeta({
      platform: 'slack',
      chatId: channelId,
      chatType: core.chatType,
      title: core.title,
      description: core.description,
      participants,
      participantCount: core.numMembers,
      participantsScope: 'page'
    })
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.web || this.currentStatus !== 'connected') {
      return { success: false, error: 'Slack adapter not connected' }
    }

    try {
      let channel = (msg.sourceMeta?.chat_id as string) ?? msg.recipientId

      // Sending to a bare user id — open (or reuse) the DM conversation
      if (/^U[A-Z0-9]{8,}$/.test(channel)) {
        const opened = await this.web.conversations.open({ users: channel })
        const dm = opened.channel as { id?: string } | undefined
        if (!dm?.id) return { success: false, error: `Could not open DM with user ${channel}` }
        channel = dm.id
      }

      // Reply threading: prefer the thread the parent lives in, else thread
      // under the parent message itself (config.reply_in_thread, default true)
      const replyInThread = (this.ctx?.getConfig().config?.reply_in_thread as boolean | undefined) ?? true
      const parentThreadTs = msg.sourceMeta?.thread_ts as string | undefined
      const parentTs = msg.sourceMeta?.message_id as string | undefined
      const threadTs = parentThreadTs ?? (replyInThread ? parentTs : undefined)

      let lastTs: string | undefined

      // Typed form content: no native Block Kit rendering yet — degrade to the
      // shared plain-text questionnaire (answers come back as thread replies).
      // HTML content converts to readable text (Slack speaks mrkdwn, not HTML).
      const { text, isHtml } = resolveOutboundText(msg)

      if (text || !msg.attachments?.length) {
        const result = await this.web.chat.postMessage({
          channel,
          text: isHtml ? text : markdownToMrkdwn(text),
          ...(threadTs ? { thread_ts: threadTs } : {})
        })
        lastTs = result.ts as string | undefined
        this.ctx?.log('info', `Sent text to ${channel}: ts=${lastTs}`)
      }

      // Upload attachments individually so one failure (typically a missing
      // files:write scope) neither aborts the remaining uploads nor masks the
      // fact that the text message above already went out.
      const attachmentFailures: string[] = []
      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          if (!att.data) continue
          try {
            const upload = await this.web.filesUploadV2({
              channel_id: channel,
              file: att.data,
              filename: att.filename,
              ...(threadTs ? { thread_ts: threadTs } : {})
            })
            if (upload.ok === false) {
              throw new Error(String((upload as { error?: string }).error ?? 'upload returned ok=false'))
            }
            this.ctx?.log('info', `Uploaded "${att.filename}" to ${channel}: ok=${upload.ok}`)
          } catch (err) {
            const reason = describeSlackError(err)
            this.ctx?.log('error', withGuideIfActionable(`Attachment upload failed for "${att.filename}": ${reason}`))
            attachmentFailures.push(`"${att.filename}": ${reason}`)
          }
        }
      }

      const sourceMeta = {
        chat_id: channel,
        message_id: lastTs,
        ...(threadTs ? { thread_ts: threadTs } : {})
      }

      if (attachmentFailures.length > 0) {
        const detail = attachmentFailures.join('; ')
        // Partial success: tell the agent what DID go out so it doesn't
        // re-send the text while chasing the attachment failure.
        const error = withGuideIfActionable(
          lastTs
            ? `Text message was delivered to ${channel} (ts=${lastTs}), but ${attachmentFailures.length} attachment(s) failed to upload — ${detail}`
            : `Attachment upload to ${channel} failed — ${detail}`
        )
        return { success: false, error, ...(lastTs ? { sourceMeta } : {}) }
      }

      return { success: true, sourceMeta }
    } catch (error) {
      const errorMsg = withGuideIfActionable(describeSlackError(error))
      this.ctx?.log('error', `Send failed: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  canDeliver(id: string): boolean {
    if (this.currentStatus !== 'connected') return false
    // Channel (C/G), DM channel (D), or user (U) ids
    return /^[CDGU][A-Z0-9]{8,}$/.test(id)
  }

  status(): AdapterStatus {
    return this.currentStatus
  }

  async getChatInfo(chatId: string, opts?: { limit?: number }): Promise<ChatInfoResult> {
    if (!this.web || this.currentStatus !== 'connected') {
      return { supported: false, reason: 'Slack adapter not connected' }
    }
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100)
    try {
      const core = await this.fetchChannelCore(chatId)
      if (!core) return { supported: false, reason: `Channel ${chatId} not found` }

      const participants: ChatParticipant[] = []
      let total: number | undefined = core.numMembers
      if (core.isIm && core.user) {
        participants.push({ id: core.user, name: await this.resolveUserName(core.user) })
        total = 2
      } else {
        let cursor: string | undefined
        while (participants.length < limit) {
          const page = await this.web.conversations.members({
            channel: chatId,
            limit: Math.min(limit - participants.length, 100),
            ...(cursor ? { cursor } : {})
          })
          for (const id of page.members ?? []) {
            if (participants.length >= limit) break
            participants.push({ id, name: await this.resolveUserName(id) })
          }
          cursor = page.response_metadata?.next_cursor || undefined
          if (!cursor) break
        }
      }

      return {
        supported: true,
        info: {
          platform: 'slack',
          chat_id: chatId,
          chat_type: core.chatType,
          title: core.title,
          description: core.description,
          participant_count: total,
          participants,
          participants_truncated: total != null && participants.length < total,
          participants_scope: 'page',
          fetched_at: Date.now()
        }
      }
    } catch (error) {
      return { supported: false, reason: withGuideIfActionable(describeSlackError(error)) }
    }
  }
}
