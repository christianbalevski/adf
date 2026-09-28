// Fleet slash commands and palette actions. `/interrupt` belongs to chat (the
// selected loop); the fleet's is `/agents interrupt <agent> [loop]`, the `a`
// key on the dashboard and the palette. The hard abort (loop stays stopped
// until reload) is only `/agents abort` and a palette action, both confirmed.

import type { CommandContext, CommandContribution, CommandScope, SlashCommand } from '../../commands/types'
import { MAIN_LOOP } from '../../api/types'
import { agentName, completeAgents, completePath, describeAgent, expandPath, findAgent, parseAgentLoopRef } from './model'
import { abortAgent, interruptAgent, loadAgent, openChat, refreshFleet, runAutostart, startAgent, stopAgent } from './ops'
import { askUntrack, completeFolder, completeTrackedFolders, loadFolders, TRACK_OVERLAY, trackFolder } from './folders'

export const LOAD_OVERLAY = 'fleet.load'

function resolveAgent(ctx: CommandContext, query: string | undefined): string | null {
  if (!query) {
    if (!ctx.agentId) ctx.print('No agent selected — name one', 'warn')
    return ctx.agentId
  }
  const id = findAgent(ctx.state(), query)
  if (!id) ctx.print(`No loaded agent matches "${query}"`, 'warn')
  return id
}

const agentArg = (partial: string, scope: CommandScope) => completeAgents(scope.state(), partial)

function fleetSummary(ctx: CommandContext): string {
  const state = ctx.state()
  const agents = state.agentOrder.map(id => state.agents[id]).filter(Boolean)
  const busy = agents.filter(a => describeAgent(a).busy)
  const pending = agents.reduce((n, a) => n + a.pendingTasks.length + a.pendingAsks.length, 0)
  const loops = agents.reduce((n, a) => n + (a.loops?.length ?? 1), 0)
  const busyText = busy.length ? ` · busy: ${busy.map(a => `${agentName(a)}(${describeAgent(a).runningLoops.join(',')})`).join(' ')}` : ''
  return `${agents.length} agents · ${loops} loops${busyText}${pending ? ` · ${pending} pending approvals/asks` : ''}`
}

export const agentsCommand: SlashCommand = {
  name: 'agents',
  args: '[interrupt|abort <agent> [loop] | refresh]',
  description: 'Fleet overview; interrupt an agent\'s running turns (abort = hard stop until reload); refresh',
  complete: (partial, scope) => {
    const words = partial.split(/\s+/)
    const verb = words[0]
    if (words.length <= 1) return ['interrupt', 'abort', 'refresh'].filter(w => w.startsWith(verb ?? ''))
    if ((verb === 'interrupt' || verb === 'abort') && words.length === 2) return agentArg(words[1], scope).map(h => `${verb} ${h}`)
    if ((verb === 'interrupt' || verb === 'abort') && words.length === 3) {
      const id = findAgent(scope.state(), words[1])
      const loops = id ? scope.state().agents[id]?.loops ?? [] : []
      return loops.map(l => l.info.name).filter(n => n.startsWith(words[2])).map(n => `${verb} ${words[1]} ${n}`)
    }
    return []
  },
  run: async ctx => {
    const [sub, agent, loop] = ctx.args
    if (sub === 'interrupt' || sub === 'abort') {
      const id = resolveAgent(ctx, agent)
      if (id) await (sub === 'abort' ? abortAgent : interruptAgent)(ctx.store, id, loop)
      return
    }
    if (sub === 'refresh') { await refreshFleet(ctx.store); return }
    ctx.actions.setView('fleet')
    ctx.actions.setFocus('main')
    ctx.print(fleetSummary(ctx))
  },
}

export const startCommand: SlashCommand = {
  name: 'start',
  args: '[agent]',
  description: 'Start an agent (runs its startup turn when it starts active)',
  complete: agentArg,
  run: async ctx => {
    const id = resolveAgent(ctx, ctx.rest.trim() || undefined)
    if (id) await startAgent(ctx.store, id)
  },
}

export const stopCommand: SlashCommand = {
  name: 'stop',
  aliases: ['unload'],
  args: '[agent]',
  description: 'Stop and unload an agent and all its loops (asks first)',
  complete: agentArg,
  run: async ctx => {
    const id = resolveAgent(ctx, ctx.rest.trim() || undefined)
    if (id) await stopAgent(ctx.store, id)
  },
}

export const loadCommand: SlashCommand = {
  name: 'load',
  args: '[path.adf] [--review] [--start]',
  description: 'Load an .adf into the daemon (no path: file picker with Tab completion)',
  complete: partial => {
    if (/\s--/.test(partial)) return []
    const { value, candidates } = completePath(partial)
    if (candidates.length <= 1) return value !== partial ? [value] : []
    const cut = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'))
    const dir = cut >= 0 ? partial.slice(0, cut + 1) : ''
    return candidates.map(c => dir + c)
  },
  run: async ctx => {
    const flags = new Set(ctx.args.filter(a => a.startsWith('--')))
    const path = ctx.args.filter(a => !a.startsWith('--')).join(' ')
    if (!path) {
      ctx.actions.pushOverlay({ kind: LOAD_OVERLAY, props: { requireReview: flags.has('--review'), start: flags.has('--start') } })
      return
    }
    await loadAgent(ctx.store, expandPath(path), { requireReview: flags.has('--review'), start: flags.has('--start') })
  },
}

export const switchCommand: SlashCommand = {
  name: 'switch',
  aliases: ['sw'],
  args: '<agent>[/loop]',
  description: 'Jump to an agent (fuzzy) or one of its loops and open the chat',
  complete: (partial, scope) => {
    const { agent, loop } = parseAgentLoopRef(partial)
    if (loop !== undefined || /[/:]$/.test(partial.trim())) {
      const base = partial.trim().replace(/[/:]$/, '')
      const id = findAgent(scope.state(), loop !== undefined ? agent : base)
      const name = loop !== undefined ? agent : base
      return (id ? scope.state().agents[id]?.loops ?? [] : [])
        .map(l => l.info.name)
        .filter(n => n.startsWith(loop ?? ''))
        .map(n => `${name}/${n}`)
    }
    return agentArg(partial, scope)
  },
  run: ctx => {
    if (!ctx.rest.trim()) { ctx.print('Usage: /switch <agent>[/loop]', 'warn'); return }
    const { agent, loop: target } = parseAgentLoopRef(ctx.rest)
    const id = findAgent(ctx.state(), agent)
    if (!id) { ctx.print(`No loaded agent matches "${agent}"`, 'warn'); return }
    const entry = ctx.state().agents[id]
    if (target && entry?.loops && !entry.loops.some(l => l.info.name === target)) {
      ctx.print(`${agentName(entry)} has no loop "${target}" — loops: ${entry.loops.map(l => l.info.name).join(', ')}`, 'warn')
      return
    }
    openChat(ctx.store, id, target ?? MAIN_LOOP)
    ctx.print(`${entry ? agentName(entry) : id} ${target ?? MAIN_LOOP}`, 'success')
  },
}

export const autostartCommand: SlashCommand = {
  name: 'autostart',
  args: '[dir…]',
  description: 'Scan tracked directories and start every reviewed autostart agent (asks first)',
  run: async ctx => {
    await runAutostart(ctx.store, ctx.args.length ? ctx.args.map(a => expandPath(a)) : undefined)
  },
}

export const trackCommand: SlashCommand = {
  name: 'track',
  args: '[dir]',
  description: 'Track a folder of agents (its reviewed autostart agents load now and at every daemon start); no dir: folder picker',
  complete: partial => {
    const { value, candidates } = completeFolder(partial)
    if (candidates.length <= 1) return value !== partial ? [value] : []
    const cut = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'))
    const dir = cut >= 0 ? partial.slice(0, cut + 1) : ''
    return candidates.map(c => dir + c)
  },
  run: async ctx => {
    const path = ctx.rest.trim()
    if (!path) { ctx.actions.pushOverlay({ kind: TRACK_OVERLAY }); return }
    await trackFolder(ctx.store, expandPath(path), { toastProblems: true })
  },
}

export const untrackCommand: SlashCommand = {
  name: 'untrack',
  args: '<dir>',
  description: 'Stop tracking a folder (asks; files are not touched; optionally unload its agents)',
  complete: (partial, scope) => completeTrackedFolders(scope.store, partial),
  run: async ctx => {
    const wanted = ctx.rest.trim().replace(/^"(.*)"$/, '$1')
    if (!wanted) { ctx.print('Usage: /untrack <dir> (Tab lists tracked folders; Runtime › Folders shows them)', 'warn'); return }
    let tracked: string[]
    try {
      tracked = (await loadFolders(ctx.store)).map(d => d.path)
    } catch (err) {
      ctx.print(`Untrack: ${err instanceof Error ? err.message : String(err)}`, 'error')
      return
    }
    // The stored spelling when it matches, else the daemon matches any spelling of the same folder.
    const match = tracked.find(p => p === wanted) ?? tracked.find(p => p.toLowerCase() === wanted.toLowerCase())
    askUntrack(ctx.store, match ?? expandPath(wanted))
  },
}

const hasAgent = (scope: CommandScope) => !!scope.agentId

export const fleetCommands: CommandContribution = {
  commands: [agentsCommand, startCommand, stopCommand, loadCommand, switchCommand, autostartCommand, trackCommand, untrackCommand],
  actions: [
    { id: 'fleet.track', title: 'Track a folder…', group: 'Fleet', shortcut: 'f', keywords: ['folder', 'directory', 'tracked', 'add', 'watch'], run: ctx => { ctx.actions.pushOverlay({ kind: TRACK_OVERLAY }) } },
    { id: 'fleet.untrack', title: 'Untrack folder…', group: 'Fleet', keywords: ['folder', 'directory', 'tracked', 'remove', 'stop tracking'], run: ctx => { ctx.actions.prefillPrompt('/untrack ') } },
    { id: 'fleet.load', title: 'Load agent file (.adf)…', group: 'Fleet', shortcut: 'o', keywords: ['open', 'add'], run: ctx => { ctx.actions.pushOverlay({ kind: LOAD_OVERLAY }) } },
    { id: 'fleet.start', title: 'Start selected agent', group: 'Fleet', shortcut: 's', available: hasAgent, run: async ctx => { if (ctx.agentId) await startAgent(ctx.store, ctx.agentId) } },
    { id: 'fleet.stop', title: 'Stop + unload selected agent…', group: 'Fleet', shortcut: 'x', available: hasAgent, run: async ctx => { if (ctx.agentId) await stopAgent(ctx.store, ctx.agentId) } },
    { id: 'fleet.interrupt', title: 'Interrupt running turns of selected agent…', group: 'Fleet', shortcut: 'a', available: hasAgent, keywords: ['abort', 'cancel', 'stop turn'], run: async ctx => { if (ctx.agentId) await interruptAgent(ctx.store, ctx.agentId) } },
    { id: 'fleet.abort', title: 'Hard abort selected agent’s running loops (stopped until reload)…', group: 'Fleet', available: hasAgent, keywords: ['kill', 'abort'], run: async ctx => { if (ctx.agentId) await abortAgent(ctx.store, ctx.agentId) } },
    { id: 'fleet.autostart', title: 'Autostart agents from tracked directories…', group: 'Fleet', shortcut: 'shift+a', run: async ctx => { await runAutostart(ctx.store) } },
    { id: 'fleet.refresh', title: 'Refresh fleet (agents, timers, inbox, runtime)', group: 'Fleet', shortcut: 'r', run: async ctx => { await refreshFleet(ctx.store) } },
    { id: 'fleet.open', title: 'Open selected agent + loop in chat', group: 'Fleet', shortcut: 'enter', available: hasAgent, run: ctx => { if (ctx.agentId) openChat(ctx.store, ctx.agentId, ctx.loop) } },
  ],
}
