import { MAIN_LOOP } from '../../api/types'
import type { CommandContribution, PaletteAction, SlashCommand } from '../../commands/types'
import { findTab, patchInspectState, TABS, INSPECT_VIEW } from './state'

const inspect: SlashCommand = {
  name: 'inspect',
  args: `[${TABS.map(t => t.id).join('|')}]`,
  description: 'Inspect the selected agent: status, config, usage, MCP, adapters, identities, logs, tables, its events',
  complete: partial => TABS.map(t => t.id).filter(t => t.startsWith(partial.trim())),
  run: ctx => {
    const wanted = ctx.args[0]
    const tab = wanted ? findTab(wanted) : undefined
    if (wanted && !tab) { ctx.print(`No inspector tab "${wanted}". Tabs: ${TABS.map(t => t.id).join(', ')}`, 'warn'); return }
    if (tab) patchInspectState(ctx.actions, ctx.state(), { tab })
    ctx.actions.setView(INSPECT_VIEW)
  },
}

const actions: PaletteAction[] = [
  {
    id: 'inspect.events.loop',
    title: 'Events of the selected loop only',
    group: 'Inspect',
    keywords: ['events', 'loop', 'thread', 'filter', 'umbilical'],
    available: scope => !!scope.agentId,
    hint: 'this agent › loop',
    run: ctx => {
      patchInspectState(ctx.actions, ctx.state(), { tab: 'events', events: { loop: 'selected' } })
      ctx.actions.setView(INSPECT_VIEW)
      ctx.print(`Events of ${ctx.loop === MAIN_LOOP ? 'main' : ctx.loop} only (l toggles)`, 'info')
    },
  },
  ...TABS.map((t): PaletteAction => ({
    id: `inspect.tab.${t.id}`,
    title: `Inspect: ${t.title}`,
    hint: t.description,
    group: 'Inspect',
    keywords: ['inspect', 'agent', t.id],
    available: scope => !!scope.agentId,
    run: ctx => { patchInspectState(ctx.actions, ctx.state(), { tab: t.id }); ctx.actions.setView(INSPECT_VIEW) },
  })),
]

export const inspectCommands: CommandContribution = { commands: [inspect], actions }
