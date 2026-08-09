import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type GuildMember,
  type Message,
  type Interaction,
  type TextBasedChannel
} from 'discord.js'
import { buildGroupMeta, GroupMetaCache } from '../group-meta'
import type { GroupMeta } from '../group-meta'
import { resolveOutboundText } from '../form-render'
import { withSetupGuide } from '../shared/error-hints'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  Attachment,
  ChatInfoResult,
  ChatParticipant
} from '../../../shared/types/channel-adapter.types'

/**
 * Discord adapter using discord.js.
 *
 * Receives messages via the gateway and delivers outbound messages
 * via the REST API. Policy filtering (DM, groups/mention, allowlist) is
 * applied before ingesting inbound messages.
 *
 * Optionally registers a single `/<botname> prompt:<text>` slash command
 * when DISCORD_APPLICATION_ID is provided.
 *
 * ## Setup gotchas (well-documented but easy to miss)
 *
 * 1. **Message Content privileged intent** — must be toggled ON at
 *    https://discord.com/developers/applications/{app_id}/bot. Without it
 *    `message.content` is empty for guild messages that don't mention the bot
 *    (DMs and @mentions are exempt). Saving changes is required.
 *
 * 2. **Partials.Channel** — DM channels are NOT cached by default in
 *    discord.js v14. Without opting into `Partials.Channel`, the client
 *    silently drops `messageCreate` for DMs because the channel isn't in the
 *    cache on first contact. This adapter enables it; `handleMessage` calls
 *    `.fetch()` on partial messages before reading fields.
 *
 * 3. **Bot invite scopes** — the bot must be invited with both `bot` AND
 *    `applications.commands` scopes (the second one is needed for slash
 *    commands). Use Installation or OAuth2 URL Generator in the dev portal.
 *
 * ## Recipient addressing
 *
 * Outbound: `discord:<channel_id>` (channel ID handles both DMs and guild
 * channels). For replies, `sourceMeta.channel_id` from the inbound message
 * is used automatically, so agents can `parent_id`-reply without knowing
 * channel IDs explicitly.
 *
 * ## Credentials
 *
 * - `DISCORD_BOT_TOKEN` (required) — bot token from the Bot page
 * - `DISCORD_APPLICATION_ID` (optional) — Application ID from General Info;
 *   only needed if you want the `/<botname>` slash command registered
 */
/** Attachment name/size pairs collected at send time so 40005 errors can name the likely culprit. */
interface SentFileInfo {
  name: string
  size?: number
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Map a discord.js failure to an actionable message. These strings flow
 * verbatim into the agent's tool result — the agent reads them to walk the
 * user through the fix, so each one states what happened, the likely cause,
 * and the concrete fix steps. Callers append the setup-guide link via
 * `withSetupGuide('discord', ...)`.
 *
 * discord.js error shapes: DiscordAPIError carries a numeric `.code` (50013,
 * 10003, ...) plus HTTP `.status`; client/gateway errors are Error subclasses
 * with a string `.code` ('TokenInvalid', 'DisallowedIntents') and a
 * human-readable message; REST rate limits surface as RateLimitError.
 */
export function describeDiscordError(err: unknown, attachments?: SentFileInfo[]): string {
  const e = err as { code?: number | string; status?: number; name?: string }
  const message = String(err instanceof Error ? err.message : err)
  const code = e?.code

  if (code === 'TokenInvalid' || /invalid token was provided/i.test(message)) {
    return (
      'Discord rejected the bot token (TokenInvalid) — the DISCORD_BOT_TOKEN credential is wrong, ' +
      'was reset, or was pasted with extra characters. Fix: open the Discord Developer Portal ' +
      '(discord.com/developers/applications), select the application, open the Bot page and press ' +
      '"Reset Token" — the new token is shown only once, so copy it immediately — then update ' +
      'DISCORD_BOT_TOKEN in Settings > Channel Adapters > Discord and restart the adapter.'
    )
  }

  if (code === 'DisallowedIntents' || /used disallowed intents/i.test(message)) {
    return (
      'Discord refused the gateway connection ("Used disallowed intents") — the bot requests a ' +
      'privileged intent that is not enabled for this application. Fix: in the Discord Developer ' +
      'Portal open the application > Bot page > Privileged Gateway Intents, enable MESSAGE CONTENT ' +
      'INTENT (and SERVER MEMBERS INTENT if member fetching is configured), press Save Changes, ' +
      'then restart the adapter.'
    )
  }

  switch (code) {
    case 50013:
      return (
        'Discord API error 50013 (Missing Permissions) — the bot lacks the channel permissions it ' +
        'needs, typically View Channels, Send Messages, and/or Attach Files. Fix: re-invite the bot ' +
        'with those permissions, or grant them to the bot\'s role in Server Settings > Roles or in ' +
        'the channel\'s permission overrides.'
      )
    case 50007:
      return (
        'Discord API error 50007 (Cannot send messages to this user) — the recipient\'s privacy ' +
        'settings block DMs from this bot, or the bot no longer shares a server with them. Fix: ask ' +
        'the recipient to allow direct messages from server members in their privacy settings for a ' +
        'mutual server, or message them in a server channel instead.'
      )
    case 50001:
      return (
        'Discord API error 50001 (Missing Access) — the bot is not in that server or cannot see ' +
        'that channel. Fix: invite the bot to the server (OAuth2 URL Generator with the "bot" ' +
        'scope) or grant it access to the channel.'
      )
    case 10003:
      return (
        'Discord API error 10003 (Unknown Channel) — the channel id does not exist or is not ' +
        'visible to the bot, so it is most likely wrong. Fix: verify the id (enable Developer Mode ' +
        'in Discord under Settings > Advanced, then right-click the channel > Copy Channel ID) and ' +
        'address the message as discord:<channel_id>.'
      )
    case 40005: {
      let detail = ''
      if (attachments?.length) {
        const listed = attachments
          .map((a) => (a.size != null ? `"${a.name}" (${formatMb(a.size)})` : `"${a.name}"`))
          .join(', ')
        const largest = attachments.reduce((max, a) =>
          (a.size ?? 0) > (max.size ?? 0) ? a : max
        )
        detail =
          ` Attachments attempted: ${listed}` +
          (attachments.length > 1 && largest.size != null
            ? ` — "${largest.name}" is the largest and most likely over the limit.`
            : '.')
      }
      return (
        'Discord API error 40005 (Request entity too large) — an attachment exceeds this server\'s ' +
        'upload limit (8-25 MB depending on the server\'s boost level).' + detail +
        ' Fix: compress or split the file, share a download link instead, or boost the server to ' +
        'raise its upload limit.'
      )
    }
  }

  if (e?.name === 'RateLimitError' || e?.status === 429 || /rate.?limit/i.test(message)) {
    return (
      `Discord is rate limiting the bot (${message}). This is temporary — wait a minute and retry; ` +
      'if it persists, reduce how often the agent sends messages to this channel.'
    )
  }

  return message
}

export class DiscordAdapter implements ChannelAdapter {
  private client: Client | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'
  private groupMetaCache = new GroupMetaCache()

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connecting'

    const token = ctx.getCredential('DISCORD_BOT_TOKEN')
    if (!token) {
      this.currentStatus = 'error'
      throw new Error(withSetupGuide('discord',
        'Missing DISCORD_BOT_TOKEN credential — the adapter cannot log in without a bot token. ' +
        'Fix: create an application at discord.com/developers/applications, open its Bot page, ' +
        'copy the bot token, and add it as DISCORD_BOT_TOKEN in Settings > Channel Adapters > Discord.'))
    }
    const applicationId = ctx.getCredential('DISCORD_APPLICATION_ID')

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      // DM channels are not cached by default in discord.js v14 — without
      // Partials.Channel the client silently drops messageCreate events for
      // DMs. Partials.Message lets us receive uncached message events too
      // (e.g. very old messages a user replies to).
      partials: [Partials.Channel, Partials.Message]
    })

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        await this.handleMessage(message)
      } catch (err) {
        this.ctx?.log('warn', `messageCreate handler failed: ${err instanceof Error ? err.message : err}`)
      }
    })

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await this.handleInteraction(interaction)
      } catch (err) {
        this.ctx?.log('warn', `interactionCreate handler failed: ${err instanceof Error ? err.message : err}`)
      }
    })

    const client = this.client

    this.client.once(Events.ClientReady, async (readyClient) => {
      if (this.client !== client) return // stale — adapter was stopped/restarted
      this.currentStatus = 'connected'
      this.ctx?.log('info', `Bot ready: @${readyClient.user.username} (${readyClient.user.id})`)
      if (applicationId) {
        await this.registerSlashCommand(token, applicationId, readyClient.user.username)
      } else {
        this.ctx?.log('info', 'DISCORD_APPLICATION_ID not set — skipping slash command registration')
      }
    })

    this.client.on(Events.Error, (err) => {
      this.ctx?.log('error', `Gateway error: ${withSetupGuide('discord', describeDiscordError(err))}`)
    })

    try {
      // Use the local ref — stop() during a hung login nulls this.client
      // (and destroys it, which rejects this login promise).
      await client.login(token)
      // currentStatus is bumped to 'connected' inside the ClientReady handler.
      ctx.log('info', 'Discord login dispatched, awaiting ready event…')
    } catch (error) {
      // If stop() destroyed the client mid-login, stay 'disconnected' and keep
      // the raw error — the failure is expected and nobody needs fix steps.
      if (this.wasStopped()) throw error
      this.currentStatus = 'error'
      // Re-throw enriched: this message lands in the adapter status/logs and
      // ultimately in the agent's context, so it must carry the fix steps
      // (bad token, disallowed intents, ...) plus the setup-guide link.
      const described = withSetupGuide('discord', describeDiscordError(error))
      ctx.log('error', `Discord login failed: ${described}`)
      throw new Error(described)
    }
  }

  /** True when stop() ran (possibly while start() was awaiting network I/O). */
  private wasStopped(): boolean {
    return this.currentStatus === 'disconnected'
  }

  async stop(): Promise<void> {
    this.currentStatus = 'disconnected'
    if (this.client) {
      try {
        await this.client.destroy()
      } catch { /* ignore */ }
      this.client = null
    }
    this.ctx = null
    this.groupMetaCache.clear()
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.client || this.currentStatus !== 'connected') {
      return {
        success: false,
        error: withSetupGuide('discord',
          `Discord bot is not connected (adapter status: ${this.currentStatus}) — nothing was delivered. ` +
          'Fix: open Settings > Channel Adapters > Discord, check the adapter logs for the startup ' +
          'error, and restart the adapter.')
      }
    }

    // Name/size pairs for every file we attempt to send — hoisted out of the
    // try so the catch can name the likely culprit on 40005 (entity too large).
    const fileInfos: SentFileInfo[] = []

    try {
      // sourceMeta wins for replies (carries the original channel_id); otherwise
      // recipientId is the destination channel ID (DMs and guild channels both
      // address by channel id once known to the bot).
      const channelId = (msg.sourceMeta?.channel_id as string | undefined) ?? msg.recipientId
      if (!channelId) {
        return {
          success: false,
          error: withSetupGuide('discord',
            'No Discord channel id resolved from sourceMeta or recipientId — nothing was delivered. ' +
            'Fix: address the message as discord:<channel_id> (enable Developer Mode in Discord under ' +
            'Settings > Advanced, then right-click the channel > Copy Channel ID), or reply to an ' +
            'inbound message so the channel id is carried in sourceMeta.')
        }
      }

      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !this.isSendableChannel(channel)) {
        return {
          success: false,
          error: withSetupGuide('discord',
            `Discord channel ${channelId} is not a text-sendable channel — nothing was delivered. ` +
            'It may be a voice, category, or forum channel, or one the bot cannot post in. ' +
            'Fix: use the id of a text channel or DM the bot has access to.')
        }
      }

      const replyMessageId = msg.sourceMeta?.message_id as string | number | undefined
      const replyOpts = replyMessageId
        ? { reply: { messageReference: String(replyMessageId), failIfNotExists: false } }
        : {}

      // Build attachment payloads
      const files: AttachmentBuilder[] = []
      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          if (!att.data) continue
          files.push(new AttachmentBuilder(att.data, { name: att.filename }))
          fileInfos.push({ name: att.filename, size: att.data.length })
        }
      }

      // Typed content: forms degrade to the shared plain-text questionnaire
      // (native components are a follow-up), HTML converts to readable text
      // (Discord speaks markdown, not HTML — isHtml is irrelevant here).
      const { text: payload } = resolveOutboundText(msg)

      // Discord hard cap is 2000 chars per message. Overflow is sent as a .txt
      // attachment with a short pointer message, preserving the full payload.
      const DISCORD_MAX = 2000
      let content = payload
      if (content.length > DISCORD_MAX) {
        const overflow = Buffer.from(content, 'utf-8')
        files.push(new AttachmentBuilder(overflow, { name: 'message.txt' }))
        fileInfos.push({ name: 'message.txt', size: overflow.length })
        content = content.slice(0, DISCORD_MAX - 1) + '…'
      }

      // Empty payload with no attachments → Discord rejects. Synthesise a marker.
      if (!content && files.length === 0) {
        content = '(empty message)'
      }

      const sendable = channel as TextBasedChannel & { send: (opts: unknown) => Promise<Message> }

      let sent: Message
      try {
        sent = await sendable.send({
          content: content || undefined,
          files: files.length ? files : undefined,
          ...replyOpts
        })
      } catch (sendErr) {
        // Discord delivers text and files as ONE message, so a file-level
        // rejection (typically 40005 entity too large) takes the text down
        // with it. Retry without files so the text still reaches the channel,
        // then report the attachment failure as a partial success — with
        // sourceMeta for the delivered text so the agent doesn't re-send it.
        if (files.length > 0 && content) {
          const reason = describeDiscordError(sendErr, fileInfos)
          try {
            const fallback = await sendable.send({ content, ...replyOpts })
            const failedNames = fileInfos.map((f) => `"${f.name}"`).join(', ')
            const error = withSetupGuide('discord',
              `Text message was delivered to channel ${channelId} (message_id=${fallback.id}), but ` +
              `${fileInfos.length} attachment(s) failed to send (${failedNames}) — ${reason} ` +
              'Do not re-send the text; only the attachment(s) need attention.')
            this.ctx?.log('error', error)
            return {
              success: false,
              error,
              sourceMeta: {
                channel_id: channelId,
                message_id: fallback.id,
                guild_id: fallback.guildId ?? null
              }
            }
          } catch (retryErr) {
            this.ctx?.log('warn',
              `Text-only retry also failed: ${describeDiscordError(retryErr)}`)
          }
        }
        throw sendErr
      }

      this.ctx?.log('info', `Sent to channel ${channelId}: message_id=${sent.id}`)

      return {
        success: true,
        sourceMeta: {
          channel_id: channelId,
          message_id: sent.id,
          guild_id: sent.guildId ?? null
        }
      }
    } catch (error) {
      const errorMsg = withSetupGuide('discord', describeDiscordError(error, fileInfos))
      this.ctx?.log('error', `Send failed: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  canDeliver(_id: string): boolean {
    return this.currentStatus === 'connected'
  }

  status(): AdapterStatus {
    return this.currentStatus
  }

  // --- Internals ---

  private async handleMessage(message: Message): Promise<void> {
    if (!this.ctx || !this.client?.user) return

    // Partial messages arrive when the channel wasn't cached (most commonly
    // DMs on first contact, since Partials.Channel is enabled). Fetch to
    // hydrate before we read any fields.
    if (message.partial) {
      try {
        message = await message.fetch()
      } catch (err) {
        this.ctx.log('warn', `Failed to hydrate partial message: ${err instanceof Error ? err.message : err}`)
        return
      }
    }

    // Drop our own messages and other bots (mirrors Telegram's behaviour of
    // only ingesting human-authored content).
    if (message.author.id === this.client.user.id) return
    if (message.author.bot) return

    const config = this.ctx.getConfig()
    const policy = config.policy ?? {}
    const isDm = message.channel.type === ChannelType.DM
    const isGuild = !isDm && message.guildId != null

    if (isDm) {
      const dmPolicy = policy.dm ?? 'all'
      if (dmPolicy === 'none') return
      if (dmPolicy === 'allowlist') {
        const allowFrom = policy.allow_from ?? []
        if (!allowFrom.includes(message.author.id)) return
      }
    }

    if (isGuild) {
      const groupPolicy = policy.groups ?? 'all'
      if (groupPolicy === 'none') return
      if (groupPolicy === 'mention') {
        const mentionedMe = message.mentions.users.has(this.client.user.id)
        const repliedToMe = message.mentions.repliedUser?.id === this.client.user.id
        if (!mentionedMe && !repliedToMe) return
      }
    }

    const senderName = message.author.globalName ?? message.author.username
    let text = message.content ?? ''

    // Attachments
    const attachments: Attachment[] = []
    const limits = config.limits ?? {}
    const maxAttachmentSize = limits.max_attachment_size ?? 10_000_000 // 10MB default

    // Download failures never drop the message — the text is always ingested,
    // with a warn log carrying the hint the agent needs to explain the gap.
    for (const att of message.attachments.values()) {
      if (att.size > maxAttachmentSize) {
        this.ctx.log('warn',
          `Skipping oversized attachment "${att.name}" (${att.size} bytes > limit ${maxAttachmentSize}); ` +
          'the message was ingested without it. Raise limits.max_attachment_size in the adapter ' +
          'config to accept larger files.')
        continue
      }
      try {
        const response = await fetch(att.url)
        if (!response.ok) {
          this.ctx.log('warn',
            `Failed to download attachment "${att.name}" from the Discord CDN: HTTP ${response.status}. ` +
            'The message was ingested without it. Discord CDN links expire after a while — ask the ' +
            'sender to re-send the file if it is still needed.')
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        const filename = att.name ?? `attachment_${att.id}`
        const importPath = `imported/discord/${filename}`
        const mimeType = att.contentType ?? 'application/octet-stream'
        this.ctx.writeAttachment(importPath, buffer, mimeType)
        attachments.push({
          path: importPath,
          filename,
          mimeType,
          size: buffer.length
        })
      } catch (err) {
        this.ctx.log('warn',
          `Failed to download attachment "${att.name}": ${err instanceof Error ? err.message : err}. ` +
          'The message was ingested without it. Check that this machine can reach ' +
          'cdn.discordapp.com, and ask the sender to re-send the file if it is still needed.')
      }
    }

    // Skip bodyless + attachmentless messages (e.g. stickers, polls)
    if (!text && attachments.length === 0) return

    // Provide a placeholder body when only attachments are present so the
    // agent's context window still flags the inbound event.
    if (!text && attachments.length > 0) text = '[Attachment]'

    const sourceMeta: Record<string, unknown> = {
      channel_id: message.channel.id,
      guild_id: message.guildId ?? null,
      message_id: message.id,
      channel_type: isDm ? 'dm' : 'guild',
      username: message.author.username
    }

    // Capture reply target so ChannelAdapterManager can resolve parent_id
    // to an outbox row when the user is replying to one of our messages.
    if (message.reference?.messageId) {
      sourceMeta.reply_to_message_id = message.reference.messageId
    }

    // Group context (meta.group) for guild messages — cached, never blocks
    // ingest. Default roster is who's mentioned in this message; the full
    // member list needs the privileged GuildMembers intent (config.fetch_members).
    let meta: Record<string, unknown> | undefined
    if (isGuild) {
      const group = await this.groupMetaCache.getOrFetch(message.channel.id, () => this.fetchGroupMeta(message))
      if (group) meta = { group }
    }

    let originalMessage: string | undefined
    try {
      originalMessage = JSON.stringify(typeof message.toJSON === 'function' ? message.toJSON() : message)
    } catch { /* circular structures — skip raw capture */ }

    const inbound: InboundMessage = {
      sender: message.author.id,
      senderName,
      payload: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      sourceMeta,
      meta,
      originalMessage,
      sentAt: message.createdTimestamp
    }

    this.ctx.log('info', `Inbound from ${senderName} (${message.author.id}) in ${isDm ? 'DM' : 'guild'} channel ${message.channel.id}`)
    this.ctx.ingest(inbound)
  }

  /** Guild-member → participant mapping shared by fetchGroupMeta and getChatInfo */
  private mapGuildMember(m: GuildMember): ChatParticipant {
    return { id: m.user.id, name: m.displayName ?? m.user.username }
  }

  private async fetchGroupMeta(message: Message): Promise<GroupMeta | null> {
    const guild = message.guild
    if (!guild) return null
    const channelName = 'name' in message.channel ? message.channel.name : undefined

    const fetchMembers = (this.ctx?.getConfig().config?.fetch_members as boolean | undefined) ?? false
    let participants: ChatParticipant[]
    let scope: GroupMeta['participants_scope']
    if (fetchMembers) {
      // Requires the privileged GuildMembers intent (dev portal + config opt-in)
      const members = await guild.members.fetch({ limit: 20 })
      participants = members.map((m) => this.mapGuildMember(m))
      scope = 'page'
    } else {
      const mentioned: ChatParticipant[] = message.mentions.users.map((u) => ({
        id: u.id,
        name: u.globalName ?? u.username
      }))
      const author = { id: message.author.id, name: message.author.globalName ?? message.author.username }
      participants = [author, ...mentioned.filter((p) => p.id !== author.id)]
      scope = 'mentions'
    }

    return buildGroupMeta({
      platform: 'discord',
      chatId: message.channel.id,
      chatType: 'guild',
      title: channelName ? `#${channelName}` : undefined,
      description: guild.name,
      participants,
      participantCount: guild.memberCount ?? guild.approximateMemberCount ?? undefined,
      participantsScope: scope
    })
  }

  async getChatInfo(chatId: string, opts?: { limit?: number }): Promise<ChatInfoResult> {
    if (!this.client || this.currentStatus !== 'connected') {
      return { supported: false, reason: 'Discord bot not connected' }
    }
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100)
    try {
      const channel = await this.client.channels.fetch(chatId)
      if (!channel) return { supported: false, reason: `Channel ${chatId} not found` }

      if (channel.type === ChannelType.DM) {
        const dm = channel as import('discord.js').DMChannel
        const peer = dm.recipient
        return {
          supported: true,
          info: {
            platform: 'discord',
            chat_id: chatId,
            chat_type: 'dm',
            participant_count: 2,
            participants: peer ? [{ id: peer.id, name: peer.globalName ?? peer.username }] : [],
            participants_truncated: false,
            participants_scope: 'all',
            fetched_at: Date.now()
          }
        }
      }

      const guildChannel = channel as import('discord.js').GuildChannel
      const guild = guildChannel.guild
      let participants: ChatParticipant[] = []
      let scope: GroupMeta['participants_scope'] = 'mentions'
      try {
        // Works only with the privileged GuildMembers intent enabled; falls
        // back to cached members (usually just active ones) otherwise.
        const members = await guild.members.fetch({ limit })
        participants = members.map((m) => this.mapGuildMember(m))
        scope = 'page'
      } catch {
        participants = guild.members.cache.map((m) => this.mapGuildMember(m)).slice(0, limit)
        scope = 'page'
      }

      const total = guild.memberCount ?? guild.approximateMemberCount ?? undefined
      return {
        supported: true,
        info: {
          platform: 'discord',
          chat_id: chatId,
          chat_type: 'guild',
          title: 'name' in guildChannel ? `#${guildChannel.name}` : undefined,
          description: guild.name,
          participant_count: total,
          participants,
          participants_truncated: total != null && participants.length < total,
          participants_scope: scope,
          fetched_at: Date.now()
        }
      }
    } catch (error) {
      return { supported: false, reason: String(error instanceof Error ? error.message : error) }
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!this.ctx || !this.client?.user) return
    if (!interaction.isChatInputCommand()) return
    if (!interaction.channelId) return

    // Acknowledge within Discord's 3-second window. The agent's full reply
    // arrives later via the normal outbox path (sent as a regular channel
    // message, not as a follow-up to the interaction).
    try {
      await interaction.reply({
        content: 'Received — see channel for response.',
        flags: MessageFlags.Ephemeral
      })
    } catch (err) {
      this.ctx.log('warn', `Slash command ack failed: ${err instanceof Error ? err.message : err}`)
    }

    const prompt = interaction.options.getString('prompt') ?? ''
    if (!prompt) return

    const config = this.ctx.getConfig()
    const policy = config.policy ?? {}
    const isDm = !interaction.inGuild()
    if (isDm) {
      const dmPolicy = policy.dm ?? 'all'
      if (dmPolicy === 'none') return
      if (dmPolicy === 'allowlist') {
        const allowFrom = policy.allow_from ?? []
        if (!allowFrom.includes(interaction.user.id)) return
      }
    }
    // Slash commands in guild channels are always intentional invocations —
    // bypass the `groups: 'mention'` filter (the slash command itself is the mention).

    const sourceMeta: Record<string, unknown> = {
      channel_id: interaction.channelId,
      guild_id: interaction.guildId ?? null,
      channel_type: isDm ? 'dm' : 'guild',
      username: interaction.user.username,
      interaction: true
    }

    const inbound: InboundMessage = {
      sender: interaction.user.id,
      senderName: interaction.user.globalName ?? interaction.user.username,
      payload: prompt,
      sourceMeta,
      sentAt: interaction.createdTimestamp
    }

    this.ctx.log('info', `Inbound slash command from ${interaction.user.username} in ${isDm ? 'DM' : 'guild'} channel ${interaction.channelId}`)
    this.ctx.ingest(inbound)
  }

  private async registerSlashCommand(token: string, applicationId: string, botUsername: string): Promise<void> {
    // Discord slash command names must be 1–32 chars, lowercase, [a-z0-9_-] only.
    const sanitized = botUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'agent'

    const command = new SlashCommandBuilder()
      .setName(sanitized)
      .setDescription(`Send a prompt to the ${botUsername} agent`)
      .addStringOption((opt) =>
        opt.setName('prompt').setDescription('Prompt for the agent').setRequired(true)
      )

    const rest = new REST({ version: '10' }).setToken(token)
    try {
      await rest.put(Routes.applicationCommands(applicationId), {
        body: [command.toJSON()]
      })
      this.ctx?.log('info', `Slash command /${sanitized} registered (global propagation can take up to an hour)`)
    } catch (err) {
      // 50001 here has a different meaning than in send(): registration talks
      // to the application, not a channel — so the fix is about the app id and
      // invite scopes, not channel access.
      const code = (err as { code?: number | string })?.code
      const described = code === 50001
        ? 'Discord API error 50001 (Missing Access) during slash command registration — ' +
          'DISCORD_APPLICATION_ID does not match the application the bot token belongs to, or the ' +
          'bot was invited without the applications.commands scope. Fix: verify the Application ID ' +
          'on the General Information page of the Developer Portal, and re-invite the bot with both ' +
          'the "bot" and "applications.commands" scopes.'
        : describeDiscordError(err)
      this.ctx?.log('warn', withSetupGuide('discord',
        `Slash command registration failed — ${described} The adapter keeps running; regular ` +
        'messages still work without the slash command.'))
    }
  }

  private isSendableChannel(channel: unknown): channel is TextBasedChannel & { send: Function } {
    return typeof (channel as { send?: unknown })?.send === 'function'
  }
}
