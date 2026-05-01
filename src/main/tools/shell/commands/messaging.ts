/**
 * Messaging commands: msg, who, ping
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'

const msgHandler: CommandHandler = {
  name: 'msg',
  summary: 'Send, read, and manage messages',
  helpText: [
    'msg <to> "body"           Send a message',
    'echo "body" | msg <to>    Send with piped body',
    'msg --read [--limit N]    Read inbox messages',
    'msg --list                List message counts',
    'msg --agents              List discoverable agents',
    'msg --update <ids> --status <S>  Update message status',
    'msg --delete <ids>        Delete messages',
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
    // Sub-commands via flags
    if (ctx.flags.read !== undefined) return msgRead(ctx)
    if (ctx.flags.list !== undefined) return msgList(ctx)
    if (ctx.flags.agents !== undefined) return msgListAgents(ctx)
    if (ctx.flags.update !== undefined) return msgUpdate(ctx)
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

    // Reject bare handles — msg_send requires a DID or adapter recipient.
    if (!to.includes(':') && !input.address && !input.parent_id) {
      return err(
        `msg: "${to}" needs a delivery address. Use "msg did:key:... body --address <url>" or "msg type:id body".`
      )
    }

    const result = await ctx.toolRegistry.executeTool('msg_send', input, ctx.workspace)
    if (result.isError) return err(`msg: ${result.content}`)
    return ok(result.content)
  }
}

async function msgRead(ctx: CommandContext): Promise<CommandResult> {
  const input: Record<string, unknown> = { status: ctx.flags.status || 'read' }
  if (ctx.flags.limit) input.limit = parseInt(String(ctx.flags.limit), 10)
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
  if (!status) return err('msg --update: missing --status')

  const idList = ids.split(',').map(id => id.trim())
  const result = await ctx.toolRegistry.executeTool('msg_update', {
    message_ids: idList,
    status
  }, ctx.workspace)
  if (result.isError) return err(`msg --update: ${result.content}`)
  return ok(result.content)
}

async function msgDelete(ctx: CommandContext): Promise<CommandResult> {
  const ids = typeof ctx.flags.delete === 'string' ? ctx.flags.delete : ctx.args[0]
  if (!ids) return err('msg --delete: missing message IDs')

  const idList = ids.split(',').map(id => id.trim())
  const result = await ctx.toolRegistry.executeTool('msg_update', {
    message_ids: idList,
    status: 'delete'
  }, ctx.workspace)
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
