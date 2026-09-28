import { MAIN_LOOP } from '../../api/types'
import type { CommandContribution, PaletteAction, SlashCommand } from '../../commands/types'
import { findTab, patchInspectState, TABS, INSPECT_VIEW } from './state'
import { MODEL_OVERLAY, applyModel, parseModelArg, providerChoices } from './model-picker'

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

const model: SlashCommand = {
  name: 'model',
  args: '[[provider/]model | inherit]',
  description: 'Change the selected agent › loop’s model (main: the agent config; an inner loop: its override, inherit clears it). No argument: picker',
  available: scope => !!scope.agentId,
  complete: (partial, scope) => (scope.loop !== MAIN_LOOP ? ['inherit'].filter(v => v.startsWith(partial.trim())) : []),
  run: async ctx => {
    if (!ctx.agentId) { ctx.print('No agent selected', 'warn'); return }
    const arg = ctx.rest.trim()
    if (!arg) { ctx.actions.pushOverlay({ kind: MODEL_OVERLAY, props: { agentId: ctx.agentId, loop: ctx.loop } }); return }
    if (arg === 'inherit') {
      if (ctx.loop === MAIN_LOOP) { ctx.print('main is the agent: it always has its own model', 'warn'); return }
      await applyModel(ctx.store, ctx.agentId, ctx.loop, null)
      return
    }
    const d = await ctx.actions.run('Providers', c => c.providers())
    if (!d) return
    const providers = providerChoices(d.providers as unknown as Array<Record<string, unknown>>, ctx.state().auth)
    const parsed = parseModelArg(arg, providers)
    const agent = ctx.state().agents[ctx.agentId]
    const loopModel = ctx.loop === MAIN_LOOP ? undefined : agent?.loops?.find(l => l.info.name === ctx.loop)?.info.config?.model
    const provider = parsed.provider ?? loopModel?.provider ?? agent?.config?.model?.provider
    if (!provider) { ctx.print('Name the provider too: /model <provider>/<model> (or /model for the picker)', 'warn'); return }
    await applyModel(ctx.store, ctx.agentId, ctx.loop, { provider, model: parsed.model })
  },
}

const config: SlashCommand = {
  name: 'config',
  args: '[edit]',
  description: 'The selected agent’s config (Inspect › Config); edit opens it in $EDITOR',
  available: scope => !!scope.agentId,
  complete: partial => ['edit'].filter(v => v.startsWith(partial.trim())),
  run: ctx => {
    if (!ctx.agentId) { ctx.print('No agent selected', 'warn'); return }
    const edit = ctx.args[0] === 'edit'
    if (ctx.args[0] && !edit) { ctx.print('Usage: /config [edit]', 'warn'); return }
    patchInspectState(ctx.actions, ctx.state(), { tab: 'config', ...(edit ? { editRequest: Date.now() } : {}) })
    ctx.actions.setView(INSPECT_VIEW)
  },
}

const actions: PaletteAction[] = [
  { id: 'inspect.model', title: 'Change model', hint: 'the selected agent › loop', group: 'Inspect', keywords: ['model', 'provider', 'llm', 'switch model'], available: scope => !!scope.agentId, run: ctx => { if (ctx.agentId) ctx.actions.pushOverlay({ kind: MODEL_OVERLAY, props: { agentId: ctx.agentId, loop: ctx.loop } }) } },
  { id: 'inspect.config.edit', title: 'Edit agent config in $EDITOR', group: 'Inspect', keywords: ['config', 'settings', 'edit'], available: scope => !!scope.agentId, run: ctx => config.run({ ...ctx, args: ['edit'] }) },
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

export const inspectCommands: CommandContribution = { commands: [inspect, model, config], actions }
