/**
 * Messaging commands: msg, who, ping
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'

const msgHandler: CommandHandler = {
  name: 'msg',
  summary: 'Send, read, and manage messages',
  helpText: [
    'msg <to> "body"           Send a message (to = did:key:…, type:id, or a local handle)',
    'echo "body" | msg <to>    Send with piped body',
    'msg --read [--status S] [--limit N]  Read inbox (default: unread; also read|archived)',
    'msg --list                List message counts',
    'msg --agents              List discoverable agents',
    'msg --update <ids> --status <read|archived|delete>  Update message status',
    'msg --archive <ids>       Archive messages',
    'msg --delete <ids>        Delete messages (archives first, then deletes)',
    '',
    'Heredoc:',
    '  msg <to> <<TAG',
    '  subject: Report ready',
    '  attach: data/report.md',
    '  ---',
    '  Here is the body text.',
    '  TAG',
    '',
    'Flags: --address, --attach, --subject, --thread, --parent',
  ].join('\n'),
  category: 'messaging',
  resolvedTools: ['msg_send'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // A -h/--help anywhere (e.g. `msg --read -h`) shows help — never executes a
    // subcommand. (The executor only catches -h as the FIRST arg, so without
    // this `msg --read -h` was misread as a read.)
    if (ctx.flags.h !== undefined || ctx.flags.help !== undefined) return ok(msgHandler.helpText)

    // Sub-commands via flags
    if (ctx.flags.read !== undefined) return msgRead(ctx)
    if (ctx.flags.list !== undefined) return msgList(ctx)
    if (ctx.flags.agents !== undefined) return msgListAgents(ctx)
    if (ctx.flags.update !== undefined) return msgUpdate(ctx)
    if (ctx.flags.archive !== undefined) return msgArchive(ctx)
    if (ctx.flags.delete !== undefined) return msgDelete(ctx)

    // Send: msg <to> "body" or piped body
    if (ctx.args.length === 0) return err('msg: missing recipient')

    const to = ctx.args[0]
    let body = ctx.args.slice(1).join(' ')

    // Check for piped stdin as body
    if (!body && ctx.stdin) {
      body = ctx.stdin
    }

    if (!body) return err('msg: missing message body')

    // Parse heredoc-style headers if body contains ---
    let subject = ctx.flags.subject as string | undefined
    let attachments: string[] | undefined
    const attachFlag = ctx.flags.attach

    if (typeof attachFlag === 'string') {
      attachments = [attachFlag]
    } else if (Array.isArray(attachFlag)) {
      attachments = attachFlag
    }

    if (body.includes('---')) {
      const parts = body.split('---')
      const headerLines = parts[0].split('\n')
      const bodyPart = parts.slice(1).join('---').trim()

      for (const line of headerLines) {
        const trimmed = line.trim()
        if (trimmed.toLowerCase().startsWith('subject:')) {
          subject = trimmed.slice(8).trim()
        } else if (trimmed.toLowerCase().startsWith('attach:')) {
          if (!attachments) attachments = []
          attachments.push(trimmed.slice(7).trim())
        }
      }
      body = bodyPart
    }

    const input: Record<string, unknown> = {
      recipient: to,
      content: body,
    }
    if (subject) input.subject = subject
    if (attachments?.length) input.attachments = attachments
    if (ctx.flags.address) input.address = ctx.flags.address
    if (ctx.flags.thread) input.thread_id = ctx.flags.thread
    if (ctx.flags.parent) input.parent_id = ctx.flags.parent

    // Bare handles (no ':') are allowed through: msg_send resolves a locally-
    // registered agent handle to its address, and returns a clear error if it
    // can't. (The shell used to reject these outright, blocking a capability
    // msg_send actually has.)
    const result = await ctx.toolRegistry.executeTool('msg_send', input, ctx.workspace)
    if (result.isError) return err(`msg: ${result.content}`)
    return ok(result.content)
  }
}

const MSG_READ_STATUSES = ['unread', 'read', 'archived']
const MSG_UPDATE_STATUSES = ['read', 'archived', 'delete']

async function msgRead(ctx: CommandContext): Promise<CommandResult> {
  // Default to UNREAD — the new messages the agent hasn't seen. (Defaulting to
  // 'read' showed already-read history and skipped msg_read's unread→read
  // auto-mark, so inbox notifications kept re-firing.)
  const status = typeof ctx.flags.status === 'string' ? ctx.flags.status : 'unread'
  if (!MSG_READ_STATUSES.includes(status)) {
    return err(`msg --read: invalid --status "${status}". Valid: ${MSG_READ_STATUSES.join(', ')}.`)
  }
  // Conservative default limit so a stray/misparsed `msg --read` can't dump the
  // entire inbox into context (the tool itself defaults to all).
  const limit = ctx.flags.limit ? parseInt(String(ctx.flags.limit), 10) : 50
  const input: Record<string, unknown> = { status, limit }
  const result = await ctx.toolRegistry.executeTool('msg_read', input, ctx.workspace)
  if (result.isError) return err(`msg --read: ${result.content}`)
  return ok(result.content)
}

async function msgList(ctx: CommandContext): Promise<CommandResult> {
  const result = await ctx.toolRegistry.executeTool('msg_list', {}, ctx.workspace)
  if (result.isError) return err(`msg --list: ${result.content}`)
  return ok(result.content)
}

async function msgListAgents(ctx: CommandContext): Promise<CommandResult> {
  const result = await ctx.toolRegistry.executeTool('agent_discover', {}, ctx.workspace)
  if (result.isError) return err(`msg --agents: ${result.content}`)
  return ok(result.content)
}

async function msgUpdate(ctx: CommandContext): Promise<CommandResult> {
  const ids = typeof ctx.flags.update === 'string' ? ctx.flags.update : ctx.args[0]
  if (!ids) return err('msg --update: missing message IDs')
  const status = ctx.flags.status as string
  if (!status) return err(`msg --update: missing --status (${MSG_UPDATE_STATUSES.join(', ')})`)
  if (!MSG_UPDATE_STATUSES.includes(status)) {
    return err(`msg --update: invalid --status "${status}". Valid: ${MSG_UPDATE_STATUSES.join(', ')}.`)
  }

  const idList = ids.split(',').map(id => id.trim())
  const result = await ctx.toolRegistry.executeTool('msg_update', { message_ids: idList, status }, ctx.workspace)
  if (result.isError) return err(`msg --update: ${result.content}`)
  return ok(result.content)
}

async function msgArchive(ctx: CommandContext): Promise<CommandResult> {
  const ids = typeof ctx.flags.archive === 'string' ? ctx.flags.archive : ctx.args[0]
  if (!ids) return err('msg --archive: missing message IDs')
  const idList = ids.split(',').map(id => id.trim())
  const result = await ctx.toolRegistry.executeTool('msg_update', { message_ids: idList, status: 'archived' }, ctx.workspace)
  if (result.isError) return err(`msg --archive: ${result.content}`)
  return ok(result.content)
}

async function msgDelete(ctx: CommandContext): Promise<CommandResult> {
  const ids = typeof ctx.flags.delete === 'string' ? ctx.flags.delete : ctx.args[0]
  if (!ids) return err('msg --delete: missing message IDs')

  const idList = ids.split(',').map(id => id.trim())
  // msg_update's 'delete' only removes ALREADY-archived messages, so `msg
  // --delete <id>` on a fresh message would error. Archive first, then delete,
  // so the command means what it says: remove these messages regardless of state.
  const archived = await ctx.toolRegistry.executeTool('msg_update', { message_ids: idList, status: 'archived' }, ctx.workspace)
  if (archived.isError) return err(`msg --delete (archive step): ${archived.content}`)
  const result = await ctx.toolRegistry.executeTool('msg_update', { message_ids: idList, status: 'delete' }, ctx.workspace)
  if (result.isError) return err(`msg --delete: ${result.content}`)
  return ok(result.content)
}

const whoHandler: CommandHandler = {
  name: 'who',
  summary: 'List discoverable agents',
  helpText: 'who                  List discoverable agents (alias for msg --agents)',
  category: 'messaging',
  resolvedTools: ['agent_discover'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const result = await ctx.toolRegistry.executeTool('agent_discover', {}, ctx.workspace)
    if (result.isError) return err(`who: ${result.content}`)
    return ok(result.content)
  }
}

const pingHandler: CommandHandler = {
  name: 'ping',
  summary: 'Check agent reachability',
  helpText: 'ping <recipient>     Check if an agent is reachable (by handle or DID)',
  category: 'messaging',
  resolvedTools: ['agent_discover'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('ping: missing recipient')
    const target = ctx.args[0]

    const agents = await ctx.toolRegistry.executeTool('agent_discover', {}, ctx.workspace)
    if (!agents.isError) {
      try {
        const parsed = JSON.parse(agents.content)
        const cards = Array.isArray(parsed) ? parsed : []
        const match = cards.find((c: any) => c.handle === target || c.did === target)
        if (match) return ok(`${target}: reachable`)
      } catch { /* not parseable, fall through */ }
    }

    return ok(`${target}: not found`)
  }
}

export const messagingHandlers: CommandHandler[] = [msgHandler, whoHandler, pingHandler]
