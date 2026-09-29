// /web on|off (the daemon's mesh web server), /open-site and /copy-site (an
// agent's website) and their palette entries. The logic is web/ops.ts.

import type { CommandContext, CommandScope, PaletteAction, SlashCommand } from '../types'
import { completeAgents, findAgent } from '../../views/fleet/model'
import { serverText, siteOf } from '../../web/model'
import { copySiteUrl, openSite, toggleWebServer } from '../../web/ops'

function targetAgent(ctx: CommandContext): string | null {
  const query = ctx.rest.trim()
  if (!query) return ctx.agentId
  const id = findAgent(ctx.state(), query)
  if (!id) ctx.print(`No loaded agent matches "${query}"`, 'warn')
  return id
}

/** Agents that serve something, for completion. */
function servingAgents(partial: string, scope: CommandScope): string[] {
  const state = scope.state()
  const serving = new Set(state.agentOrder.filter(id => siteOf(state, id)).map(id => state.agents[id]?.summary.handle || state.agents[id]?.summary.name || id))
  return completeAgents(state, partial).filter(name => serving.has(name))
}

export const webCommand: SlashCommand = {
  name: 'web',
  args: '[on|off]',
  description: 'The daemon’s web server that serves agent websites / APIs: status, start (on), stop (off, asks)',
  complete: partial => ['on', 'off'].filter(v => v.startsWith(partial.trim())),
  run: async ctx => {
    const arg = ctx.args[0]?.toLowerCase()
    if (arg === 'on' || arg === 'start') { await toggleWebServer(ctx.store, true); return }
    if (arg === 'off' || arg === 'stop') { await toggleWebServer(ctx.store, false); return }
    if (arg) { ctx.print('Usage: /web [on|off]', 'warn'); return }
    const web = await ctx.actions.refreshWeb()
    const state = ctx.state()
    const sites = state.agentOrder.map(id => siteOf(state, id)).filter(s => !!s)
    const server = web?.server
    ctx.print(`Web server ${serverText(server)} ${'·'} ${sites.length} agent${sites.length === 1 ? '' : 's'} serving${server ? (server.running ? ` ${'·'} /web off stops it` : ` ${'·'} /web on starts it`) : ''}`, server?.running ? 'success' : 'info')
  },
}

export const openSiteCommand: SlashCommand = {
  name: 'open-site',
  aliases: ['site'],
  args: '[agent]',
  description: 'Open an agent’s website in the browser (starts the web server if it is stopped)',
  complete: servingAgents,
  run: async ctx => { await openSite(ctx.store, targetAgent(ctx)) },
}

export const copySiteCommand: SlashCommand = {
  name: 'copy-site',
  args: '[agent]',
  description: 'Copy an agent’s website URL',
  complete: servingAgents,
  run: async ctx => { await copySiteUrl(ctx.store, targetAgent(ctx)) },
}

const serves = (scope: CommandScope) => !!siteOf(scope.state(), scope.agentId)
const running = (scope: CommandScope) => scope.state().web?.server?.running === true

export const webActions: PaletteAction[] = [
  { id: 'web.open', title: 'Open agent website', hint: 'the selected agent’s site in the browser', group: 'Web', shortcut: 'w', keywords: ['site', 'browser', 'url', 'http', 'serve', 'public'], available: serves, run: ctx => openSite(ctx.store, ctx.agentId) },
  { id: 'web.copy', title: 'Copy agent website URL', group: 'Web', shortcut: 'shift+w', keywords: ['site', 'url', 'link', 'clipboard'], available: serves, run: ctx => copySiteUrl(ctx.store, ctx.agentId) },
  { id: 'web.start', title: 'Start web server', hint: 'serves agent websites and APIs', group: 'Web', keywords: ['mesh', 'server', 'http', 'on', 'site'], available: scope => !running(scope), run: async ctx => { await toggleWebServer(ctx.store, true) } },
  { id: 'web.stop', title: 'Stop web server…', hint: 'agent sites, APIs and mesh delivery go offline', group: 'Web', keywords: ['mesh', 'server', 'http', 'off'], available: running, run: async ctx => { await toggleWebServer(ctx.store, false) } },
]
