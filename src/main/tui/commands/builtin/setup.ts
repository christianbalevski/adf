// Getting started: /welcome, /channels (an agent's Telegram, Discord, Slack,
// email, WhatsApp), /provider (API-key model providers). Dialogs live in
// src/main/tui/setup and are registered by the shell's overlay host.

import type { CommandContext, CommandScope, PaletteAction, SlashCommand } from '../types'
import { openChannels, openMcp, openProviderAdd, openWelcome } from '../../setup/open'
import { CHANNEL_ORDER, channelEntries, configuredChannels, findChannel } from '../../setup/channels'
import { openRuntime } from '../../views/runtime/state'
import type { PublicProvider } from '../../api/types'

const hasAgent = (scope: CommandScope) => !!scope.agentId

const agentLabel = (ctx: CommandScope, agentId: string) => {
  const s = ctx.state().agents[agentId]?.summary
  return s?.handle || s?.name || agentId
}

async function removeChannel(ctx: CommandContext, wanted: string | undefined): Promise<void> {
  if (!ctx.agentId) { ctx.print('Select an agent first', 'warn'); return }
  const entry = findChannel(wanted)
  if (!entry) { ctx.print(`Usage: /channels remove <${CHANNEL_ORDER.join('|')}>`, 'warn'); return }
  const who = agentLabel(ctx, ctx.agentId)
  const configured = configuredChannels((ctx.state().agents[ctx.agentId]?.config ?? await ctx.actions.loadConfig(ctx.agentId)) as never)
  if (!configured.includes(entry.type)) { ctx.print(`${who} has no ${entry.displayName} channel`, 'info'); return }
  const ok = await ctx.actions.confirm({
    title: `Remove ${entry.displayName}`,
    message: `Disconnect ${who} from ${entry.displayName}? Its stored ${entry.displayName} credentials are deleted from the agent.`,
    confirmLabel: 'Remove',
    danger: true,
  })
  if (!ok) return
  const agentId = ctx.agentId
  const result = await ctx.actions.run(`Remove ${entry.displayName}`, c => c.detachAdapter(agentId, entry.type))
  if (!result) return
  ctx.print(`${entry.displayName} removed from ${who}${result.deletedCredentials ? ` (${result.deletedCredentials} credential${result.deletedCredentials === 1 ? '' : 's'} deleted)` : ''}`, 'success')
  void ctx.actions.loadConfig(agentId)
}

export const welcomeCommand: SlashCommand = {
  name: 'welcome',
  description: 'What ADF is, and the getting-started checklist',
  run: ctx => openWelcome(ctx.store),
}

export const channelsCommand: SlashCommand = {
  name: 'channels',
  args: `[add [${CHANNEL_ORDER.join('|')}] | remove <channel>]`,
  description: 'The selected agent’s channels (Telegram, Discord, Slack, email, WhatsApp): state, add, remove',
  complete: partial => {
    const parts = partial.split(/\s+/)
    if (parts.length <= 1) return ['add', 'remove'].filter(v => v.startsWith(partial.trim()))
    const verb = parts[0]
    if (verb !== 'add' && verb !== 'remove') return []
    return channelEntries().map(e => e.type).filter(t => t.startsWith(parts[1] ?? '')).map(t => `${verb} ${t}`)
  },
  run: async ctx => {
    const verb = ctx.args[0]?.toLowerCase()
    if (!verb || verb === 'list') { openChannels(ctx.store, {}); return }
    if (verb === 'add') {
      const wanted = ctx.args[1]
      if (wanted && !findChannel(wanted)) { ctx.print(`No channel "${wanted}". Channels: ${CHANNEL_ORDER.join(', ')}`, 'warn'); return }
      openChannels(ctx.store, wanted ? { channel: findChannel(wanted)!.type } : {})
      return
    }
    if (verb === 'remove' || verb === 'rm') { await removeChannel(ctx, ctx.args[1]); return }
    // `/channels telegram` = add telegram
    if (findChannel(verb)) { openChannels(ctx.store, { channel: findChannel(verb)!.type }); return }
    ctx.print(`Usage: /channels [add [channel] | remove <channel>]`, 'warn')
  },
}

async function providerList(ctx: CommandScope): Promise<PublicProvider[]> {
  const d = await ctx.actions.run('Providers', c => c.providers())
  return ((d?.providers ?? []) as unknown as PublicProvider[])
}

export const providerCommand: SlashCommand = {
  name: 'provider',
  args: '[add [preset] | list | remove <id>]',
  description: 'Model providers: add one with an API key (stored in the daemon’s secret store), list, remove. Subscriptions: /login',
  complete: partial => {
    const parts = partial.split(/\s+/)
    if (parts.length <= 1) return ['add', 'list', 'remove'].filter(v => v.startsWith(partial.trim()))
    return []
  },
  run: async ctx => {
    const verb = ctx.args[0]?.toLowerCase()
    if (!verb || verb === 'add' || verb === 'new') { openProviderAdd(ctx.store, ctx.args[1] ? { preset: ctx.args[1] } : {}); return }
    if (verb === 'list' || verb === 'ls') { openRuntime(ctx.actions, ctx.state(), { tab: 'providers' }); return }
    if (verb === 'remove' || verb === 'rm') {
      const wanted = ctx.args.slice(1).join(' ').trim()
      if (!wanted) { ctx.print('Usage: /provider remove <id|name>', 'warn'); return }
      const providers = await providerList(ctx)
      const target = providers.find(p => p.id === wanted) ?? providers.find(p => p.name?.toLowerCase() === wanted.toLowerCase())
      if (!target) { ctx.print(`No provider "${wanted}". /provider list shows them.`, 'warn'); return }
      const ok = await ctx.actions.confirm({
        title: `Remove ${target.name}`,
        message: `Remove the provider ${target.name} (${target.id}) from the daemon${target.hasApiKey ? ' and delete its stored key' : ''}? Agents that use it stop working until they get another model (/model).`,
        confirmLabel: 'Remove',
        danger: true,
      })
      if (!ok) return
      const result = await ctx.actions.run('Remove provider', c => c.removeProvider(target.id))
      if (!result) return
      ctx.print(`Removed ${target.name}`, 'success')
      void ctx.actions.refreshAuth()
      return
    }
    ctx.print('Usage: /provider [add | list | remove <id>]', 'warn')
  },
}

const serverNames = (scope: CommandScope): string[] => {
  const config = scope.agentId ? scope.state().agents[scope.agentId]?.config : undefined
  return (config?.mcp?.servers ?? []).map(s => s.name)
}

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  args: '[add [catalog-name | npm:pkg | python:pkg | https://url] | remove <name> | restart <name> | logs <name>]',
  description: 'The selected agent’s MCP servers: state, add (catalog, npm, Python, remote URL), restart, credentials, tools, logs, remove',
  complete: (partial, scope) => {
    const parts = partial.split(/\s+/)
    if (parts.length <= 1) return ['add', 'remove', 'restart', 'logs'].filter(v => v.startsWith(partial.trim()))
    if (['remove', 'restart', 'logs'].includes(parts[0])) return serverNames(scope).filter(n => n.startsWith(parts[1] ?? '')).map(n => `${parts[0]} ${n}`)
    return []
  },
  run: async ctx => {
    const verb = ctx.args[0]?.toLowerCase()
    if (!verb || verb === 'list') { openMcp(ctx.store, {}); return }
    if (verb === 'add' || verb === 'install') { openMcp(ctx.store, { add: ctx.args.slice(1).join(' ') }); return }
    const name = ctx.args[1]
    if (['remove', 'rm', 'restart', 'logs', 'log'].includes(verb)) {
      if (!name) { ctx.print(`Usage: /mcp ${verb} <server>`, 'warn'); return }
      if (ctx.agentId && ctx.state().agents[ctx.agentId]?.config && !serverNames(ctx).includes(name)) { ctx.print(`No MCP server "${name}" on this agent. /mcp lists them.`, 'warn'); return }
      if (verb === 'logs' || verb === 'log') { openMcp(ctx.store, { server: name, view: 'logs' }); return }
      const agentId = ctx.agentId
      if (!agentId) { ctx.print('Select an agent first', 'warn'); return }
      if (verb === 'restart') {
        ctx.print(`Connecting ${name}…`, 'info')
        const result = await ctx.actions.run(`Restart ${name}`, c => c.restartMcpServer(agentId, name))
        if (!result) return
        ctx.print(result.success ? `${name} connected: ${result.toolsDiscovered} tools (${result.location ?? ''})` : `${name}: ${result.error ?? 'no tools found'} · /mcp logs ${name}`, result.success ? 'success' : 'error')
        return
      }
      const ok = await ctx.actions.confirm({ title: `Remove ${name}`, message: `Remove ${name} from ${agentLabel(ctx, agentId)}? Its tools go away and its stored credentials are deleted from the agent.`, confirmLabel: 'Remove', danger: true })
      if (!ok) return
      const server = ctx.state().agents[agentId]?.config?.mcp?.servers?.find(s => s.name === name)
      const ns = server?.npm_package ?? server?.pypi_package ?? name
      const result = await ctx.actions.run(`Remove ${name}`, c => c.detachMcpServer(agentId, name, ns))
      if (!result) return
      ctx.print(`${name} removed`, 'success')
      void ctx.actions.loadConfig(agentId)
      return
    }
    // `/mcp github` = add github
    openMcp(ctx.store, { add: ctx.rest.trim() })
  },
}

export const setupActions: PaletteAction[] = [
  { id: 'shell.mcp', title: 'MCP servers of this agent', hint: 'add, restart, credentials, tools, logs', group: 'Actions', keywords: ['mcp', 'tools', 'server', 'install', 'plugin', 'integration'], available: hasAgent, run: ctx => openMcp(ctx.store, {}) },
  { id: 'shell.mcp.add', title: 'Add an MCP server', hint: 'catalog, npm, Python or a URL', group: 'Actions', keywords: ['mcp', 'install', 'server', 'tools', 'github', 'npm', 'uvx'], available: hasAgent, run: ctx => openMcp(ctx.store, { add: '' }) },
  { id: 'shell.welcome', title: 'Welcome & getting started', group: 'Actions', keywords: ['welcome', 'start', 'onboarding', 'checklist', 'intro', 'tour'], run: ctx => openWelcome(ctx.store) },
  { id: 'shell.channels', title: 'Channels of this agent', hint: 'Telegram, Discord, Slack, email, WhatsApp', group: 'Actions', keywords: ['channels', 'connect', 'telegram', 'discord', 'slack', 'email', 'whatsapp', 'messaging', 'adapter', 'bot'], available: hasAgent, run: ctx => openChannels(ctx.store, {}) },
  ...channelEntries().map((e): PaletteAction => ({
    id: `shell.channels.add.${e.type}`,
    title: `Add ${e.displayName} channel`,
    hint: e.tagline,
    group: 'Actions',
    keywords: ['channel', 'connect', e.type, 'messaging', 'bot'],
    available: hasAgent,
    run: ctx => openChannels(ctx.store, { channel: e.type }),
  })),
  { id: 'shell.provider.add', title: 'Connect a model provider', hint: 'API key: Anthropic, OpenAI, OpenRouter, Gemini, …', group: 'Actions', keywords: ['provider', 'model', 'api key', 'llm', 'openrouter', 'anthropic', 'openai', 'gemini', 'ollama', 'lm studio'], run: ctx => openProviderAdd(ctx.store) },
]
