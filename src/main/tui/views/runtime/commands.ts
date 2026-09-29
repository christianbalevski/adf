// /runtime [tab] and the daemon pages it holds: /status /usage /providers
// /network /settings /compute /events all open their Runtime tab (one place,
// the same page every time) instead of a dialog.

import type { CommandContext, CommandContribution, PaletteAction, SlashCommand } from '../../commands/types'
import { parseTypeFilter } from '../inspect/events'
import { findRuntimeTab, openRuntime, readRuntimeState, RUNTIME_TABS, type RuntimeTab } from './state'

const open = (ctx: Pick<CommandContext, 'actions' | 'state'>, tab: RuntimeTab) => openRuntime(ctx.actions, ctx.state(), { tab })

const runtime: SlashCommand = {
  name: 'runtime',
  args: `[${RUNTIME_TABS.map(t => t.id).join('|')}]`,
  description: 'The daemon: status, owner identity, sign-in, providers, usage, network, compute, MCP, channels, settings, every agent’s events',
  complete: partial => RUNTIME_TABS.map(t => t.id).filter(t => t.startsWith(partial.trim())),
  run: ctx => {
    const wanted = ctx.args[0]
    const tab = wanted ? findRuntimeTab(wanted) : undefined
    if (wanted && !tab) { ctx.print(`No Runtime tab "${wanted}". Tabs: ${RUNTIME_TABS.map(t => t.id).join(', ')}`, 'warn'); return }
    if (tab) open(ctx, tab)
    else ctx.actions.setView('runtime')
  },
}

function page(name: RuntimeTab, description: string): SlashCommand {
  return { name, description: `${description} (Runtime › ${RUNTIME_TABS.find(t => t.id === name)?.title})`, run: ctx => open(ctx, name) }
}

const events: SlashCommand = {
  name: 'events',
  args: '[type-filter…] [--agent] [--loop] [--all]',
  description: 'Every agent’s live umbilical events (tail -f), e.g. /events tool. -turn.delta --agent (Runtime › Events)',
  complete: partial => {
    const last = partial.split(/\s+/).at(-1) ?? ''
    const base = partial.slice(0, partial.length - last.length)
    return ['tool.', 'turn.', 'llm.', 'loop.', 'agent.', 'hil.', 'ask.', 'timer.', 'config.', '-turn.delta', '--agent', '--loop', '--all']
      .filter(v => v.startsWith(last))
      .map(v => `${base}${v}`)
  },
  run: ctx => {
    const flags = new Set(ctx.args.filter(a => a.startsWith('--')))
    const typeArgs = ctx.args.filter(a => !a.startsWith('--'))
    const types = typeArgs.join(' ')
    const current = readRuntimeState(ctx.state()).events
    const all = flags.has('--all')
    const loop = flags.has('--loop') ? 'selected' as const : all ? 'all' as const : current.loop
    const agent = flags.has('--agent') || flags.has('--loop') ? 'selected' as const : all ? 'all' as const : current.agent
    if ((agent === 'selected' || loop === 'selected') && !ctx.agentId) ctx.print('No agent selected; showing all agents', 'warn')
    openRuntime(ctx.actions, ctx.state(), {
      tab: 'events',
      events: { types: typeArgs.length ? types : all ? '' : current.types, agent: ctx.agentId ? agent : 'all', loop: ctx.agentId ? loop : 'all', follow: true },
    })
    const terms = parseTypeFilter(types)
    if (ctx.args.length) ctx.print(`Events: ${terms.include.join(', ') || 'all types'}${terms.exclude.length ? `, without ${terms.exclude.join(', ')}` : ''}${agent === 'selected' ? ' · this agent' : ''}${loop === 'selected' ? ` · loop ${ctx.loop}` : ''}`, 'info')
  },
}

const commands: SlashCommand[] = [
  runtime,
  page('status', 'Daemon health, version, uptime and every agent’s loops'),
  page('usage', 'Token usage across agents, by model'),
  page('providers', 'LLM providers and which agents use them'),
  page('network', 'Mesh, LAN and WebSocket status; mesh and server on/off'),
  page('compute', 'Container runtime and containers'),
  page('settings', 'Daemon settings (secrets redacted)'),
  events,
]

const actions: PaletteAction[] = RUNTIME_TABS.map((t): PaletteAction => ({
  id: `runtime.tab.${t.id}`,
  title: `Runtime: ${t.title}`,
  hint: t.description,
  group: 'Runtime',
  keywords: ['runtime', 'daemon', t.id],
  run: ctx => open(ctx, t.id),
}))

export const runtimeCommands: CommandContribution = { commands, actions }
