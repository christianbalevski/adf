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
  type Message,
  type Interaction,
  type TextBasedChannel
} from 'discord.js'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterStatus,
  OutboundMessage,
  DeliveryResult,
  InboundMessage,
  Attachment
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
export class DiscordAdapter implements ChannelAdapter {
  private client: Client | null = null
  private ctx: AdapterContext | null = null
  private currentStatus: AdapterStatus = 'disconnected'

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    this.currentStatus = 'connecting'

    const token = ctx.getCredential('DISCORD_BOT_TOKEN')
    if (!token) {
      this.currentStatus = 'error'
      throw new Error('Missing DISCORD_BOT_TOKEN credential')
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

    this.client.once(Events.ClientReady, async (readyClient) => {
      this.currentStatus = 'connected'
      this.ctx?.log('info', `Bot ready: @${readyClient.user.username} (${readyClient.user.id})`)
      if (applicationId) {
        await this.registerSlashCommand(token, applicationId, readyClient.user.username)
      } else {
        this.ctx?.log('info', 'DISCORD_APPLICATION_ID not set — skipping slash command registration')
      }
    })

    this.client.on(Events.Error, (err) => {
      this.ctx?.log('error', `Gateway error: ${err.message}`)
    })

    try {
      await this.client.login(token)
      // currentStatus is bumped to 'connected' inside the ClientReady handler.
      ctx.log('info', 'Discord login dispatched, awaiting ready event…')
    } catch (error) {
      this.currentStatus = 'error'
      throw error
    }
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
  }

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    if (!this.client || this.currentStatus !== 'connected') {
      return { success: false, error: 'Bot not connected' }
    }

    try {
      // sourceMeta wins for replies (carries the original channel_id); otherwise
      // recipientId is the destination channel ID (DMs and guild channels both
      // address by channel id once known to the bot).
      const channelId = (msg.sourceMeta?.channel_id as string | undefined) ?? msg.recipientId
      if (!channelId) {
        return { success: false, error: 'No channel_id resolved from sourceMeta or recipientId' }
      }

      const channel = await this.client.channels.fetch(channelId)
      if (!channel || !this.isSendableChannel(channel)) {
        return { success: false, error: `Channel ${channelId} is not text-sendable` }
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
        }
      }

      // Discord hard cap is 2000 chars per message. Overflow is sent as a .txt
      // attachment with a short pointer message, preserving the full payload.
      const DISCORD_MAX = 2000
      let content = msg.payload ?? ''
      if (content.length > DISCORD_MAX) {
        const overflow = Buffer.from(content, 'utf-8')
        files.push(new AttachmentBuilder(overflow, { name: 'message.txt' }))
        content = content.slice(0, DISCORD_MAX - 1) + '…'
      }

      // Empty payload with no attachments → Discord rejects. Synthesise a marker.
      if (!content && files.length === 0) {
        content = '(empty message)'
      }

      const sent = await (channel as TextBasedChannel & { send: (opts: unknown) => Promise<Message> }).send({
        content: content || undefined,
        files: files.length ? files : undefined,
        ...replyOpts
      })

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
      const errorMsg = String(error instanceof Error ? error.message : error)
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

    for (const att of message.attachments.values()) {
      if (att.size > maxAttachmentSize) {
        this.ctx.log('warn', `Skipping oversized attachment "${att.name}" (${att.size} > ${maxAttachmentSize})`)
        continue
      }
      try {
        const response = await fetch(att.url)
        if (!response.ok) {
          this.ctx.log('warn', `Failed to download attachment "${att.name}": HTTP ${response.status}`)
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
        this.ctx.log('warn', `Failed to download attachment "${att.name}": ${err}`)
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

    const inbound: InboundMessage = {
      sender: message.author.id,
      senderName,
      payload: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      sourceMeta,
      sentAt: message.createdTimestamp
    }

    this.ctx.log('info', `Inbound from ${senderName} (${message.author.id}) in ${isDm ? 'DM' : 'guild'} channel ${message.channel.id}`)
    this.ctx.ingest(inbound)
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
      const msg = err instanceof Error ? err.message : String(err)
      this.ctx?.log('warn', `Slash command registration failed: ${msg}`)
    }
  }

  private isSendableChannel(channel: unknown): channel is TextBasedChannel & { send: Function } {
    return typeof (channel as { send?: unknown })?.send === 'function'
  }
}
