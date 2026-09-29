import { MAIN_LOOP } from '../../api/types'
import type { CommandContribution, PaletteAction, SlashCommand } from '../../commands/types'
import { findTab, patchInspectState, TABS, INSPECT_VIEW } from './state'
import { MODEL_OVERLAY, applyModel, parseModelArg, providerChoices } from './model-picker'
import { TASK_FILTERS, type TaskFilter } from './tasks'
import { COMPACTION_OVERLAY, INSTRUCTIONS_OVERLAY, TOOLS_OVERLAY } from './SettingsTab'
import { applyThreshold } from './SettingDialogs'
import { parseThreshold } from './settings-model'

const inspect: SlashCommand = {
  name: 'inspect',
  args: `[${TABS.map(t => t.id).join('|')}]`,
  description: 'Inspect the selected agent: status, settings, config, usage, MCP, channels, identities, logs, tables, its events',
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

const instructions: SlashCommand = {
  name: 'instructions',
  args: '[edit]',
  description: 'Edit the selected agent’s instructions (a dialog; edit opens $EDITOR)',
  available: scope => !!scope.agentId,
  complete: partial => ['edit'].filter(v => v.startsWith(partial.trim())),
  run: ctx => {
    if (!ctx.agentId) { ctx.print('No agent selected', 'warn'); return }
    if (ctx.args[0] && ctx.args[0] !== 'edit') { ctx.print('Usage: /instructions [edit]', 'warn'); return }
    ctx.actions.pushOverlay({ kind: INSTRUCTIONS_OVERLAY, props: { agentId: ctx.agentId, ...(ctx.args[0] === 'edit' ? { editor: true } : {}) } })
  },
}

const tools: SlashCommand = {
  name: 'tools',
  args: '[filter]',
  description: 'The selected agent’s tools: enable, show, require approval, lock (built-in and MCP)',
  available: scope => !!scope.agentId,
  run: ctx => {
    if (!ctx.agentId) { ctx.print('No agent selected', 'warn'); return }
    ctx.actions.pushOverlay({ kind: TOOLS_OVERLAY, props: { agentId: ctx.agentId, query: ctx.rest.trim() } })
  },
}

const compaction: SlashCommand = {
  name: 'compaction',
  args: '[tokens|default]',
  description: 'Compaction threshold of the selected agent › loop (80000, 80k; default = main’s default / an inner loop inherits). No argument: every loop',
  available: scope => !!scope.agentId,
  complete: partial => ['default'].filter(v => v.startsWith(partial.trim())),
  run: async ctx => {
    if (!ctx.agentId) { ctx.print('No agent selected', 'warn'); return }
    const arg = ctx.rest.trim()
    if (!arg) { ctx.actions.pushOverlay({ kind: COMPACTION_OVERLAY, props: { agentId: ctx.agentId, loop: ctx.loop } }); return }
    const parsed = parseThreshold(arg)
    if (!parsed.ok) { ctx.print(`${parsed.error}. Usage: /compaction [tokens|default]`, 'warn'); return }
    if (ctx.loop !== MAIN_LOOP && !ctx.state().agents[ctx.agentId]?.config?.loops?.some(l => l.name === ctx.loop)) {
      ctx.print(`${ctx.loop} is not an inner loop of this agent`, 'warn')
      return
    }
    await applyThreshold(ctx.store, ctx.agentId, ctx.loop, parsed.value)
  },
}

const TASK_FILTER_ARGS: readonly TaskFilter[] = TASK_FILTERS

const tasks: SlashCommand = {
  name: 'tasks',
  args: `[${TASK_FILTERS.join('|')}]`,
  description: 'The selected agent’s tasks (Inspect › Tasks): approvals and async tool calls; y/n/a act on a call waiting for approval',
  available: scope => !!scope.agentId,
  complete: partial => TASK_FILTERS.filter(f => f.startsWith(partial.trim())),
  run: ctx => {
    if (!ctx.agentId) { ctx.print('No agent selected', 'warn'); return }
    const wanted = ctx.args[0]?.toLowerCase()
    const filter = wanted ? TASK_FILTER_ARGS.find(f => f.startsWith(wanted)) : undefined
    if (wanted && !filter) { ctx.print(`Usage: /tasks [${TASK_FILTERS.join('|')}]`, 'warn'); return }
    patchInspectState(ctx.actions, ctx.state(), { tab: 'tasks', ...(filter ? { tasksFilter: filter } : {}) })
    ctx.actions.setView(INSPECT_VIEW)
    ctx.actions.setFocus('main')
  },
}

const actions: PaletteAction[] = [
  { id: 'inspect.settings', title: 'Agent settings', hint: 'instructions, tools, compaction, autonomy, messaging, host access', group: 'Inspect', keywords: ['settings', 'preferences', 'agent config', 'autonomous', 'autostart', 'host', 'visibility', 'mesh'], available: scope => !!scope.agentId, run: ctx => { patchInspectState(ctx.actions, ctx.state(), { tab: 'settings' }); ctx.actions.setView(INSPECT_VIEW); ctx.actions.setFocus('main') } },
  { id: 'inspect.instructions', title: 'Edit agent instructions', hint: 'the selected agent', group: 'Inspect', keywords: ['instructions', 'prompt', 'system prompt'], available: scope => !!scope.agentId, run: ctx => instructions.run({ ...ctx, args: [], rest: '' }) },
  { id: 'inspect.tools', title: 'Agent tools', hint: 'enable, show, require approval, lock', group: 'Inspect', keywords: ['tools', 'approval', 'restricted', 'hil', 'mcp', 'enable'], available: scope => !!scope.agentId, run: ctx => tools.run({ ...ctx, args: [], rest: '' }) },
  { id: 'inspect.compaction', title: 'Compaction threshold', hint: 'main and inner loops', group: 'Inspect', keywords: ['compaction', 'compact', 'context', 'tokens', 'threshold'], available: scope => !!scope.agentId, run: ctx => compaction.run({ ...ctx, args: [], rest: '' }) },
  { id: 'inspect.tasks', title: 'Show tasks', hint: 'the selected agent’s approvals and async tool calls', group: 'Inspect', keywords: ['tasks', 'hil', 'approval', 'approve', 'pending', 'adf_tasks'], available: scope => !!scope.agentId, run: ctx => tasks.run({ ...ctx, args: [], rest: '' }) },
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

export const inspectCommands: CommandContribution = { commands: [inspect, model, config, tasks, instructions, tools, compaction], actions }
