// Loops slash commands and palette actions. `/loop` and `/main` are reserved
// for this view (CONTRACT.md §4); timers, triggers and history live here too
// because a timer or trigger with a `loop` is how an inner loop runs on its own.

import { MAIN_LOOP } from '../../api/types'
import type { CommandContext, CommandContribution, CommandScope, PaletteAction } from '../../commands/types'
import { agentName, openTab } from './common'
import { findTemplate, LOOP_TEMPLATES } from './templates'
import { confirmDeleteLoop, confirmDeleteTimer, openChat, openLoopWizard, openTimerDialog, toggleLoopEnabled } from './ops'
import { sendToLoop } from './SendDialog'

const LOOP_SUBCOMMANDS = ['new', 'edit', 'rm', 'on', 'off', 'send', 'chat', 'schedule']

function loopNames(scope: CommandScope, innerOnly = false): string[] {
  if (!scope.agentId) return []
  return (scope.state().agents[scope.agentId]?.loops ?? []).filter(l => !innerOnly || !l.info.isMain).map(l => l.info.name)
}

function hasAgent(scope: CommandScope): boolean {
  return !!scope.agentId
}

function needAgent(ctx: CommandContext): string | null {
  if (!ctx.agentId) ctx.print('Select an agent first (/agent <name>)', 'warn')
  return ctx.agentId
}

function completeLoop(partial: string, scope: CommandScope): string[] {
  const text = partial.replace(/^\s+/, '')
  const [sub = '', arg = ''] = text.split(/\s+/)
  if (!/\s/.test(text)) {
    return [...LOOP_SUBCOMMANDS, ...loopNames(scope)].filter(n => n.startsWith(sub))
  }
  if (sub === 'new') return LOOP_TEMPLATES.filter(t => t.id !== 'blank' && t.id.startsWith(arg)).map(t => `new ${t.id}`)
  if (['edit', 'rm', 'on', 'off'].includes(sub)) return loopNames(scope, true).filter(n => n.startsWith(arg)).map(n => `${sub} ${n}`)
  if (['send', 'chat', 'schedule'].includes(sub)) return loopNames(scope).filter(n => n.startsWith(arg)).map(n => `${sub} ${n}`)
  return []
}

function timerIdArg(ctx: CommandContext, raw: string | undefined): number | null {
  const id = Number(String(raw ?? '').replace(/^#/, ''))
  if (!raw || !Number.isInteger(id) || id <= 0) return null
  return id
}

async function findTimer(ctx: CommandContext, agentId: string, id: number) {
  const list = await ctx.actions.run('Timers', c => c.timers(agentId))
  const timer = list?.timers.find(t => t.id === id)
  if (list && !timer) ctx.print(`No timer #${id} on ${agentName(ctx.state(), agentId)}`, 'warn')
  return timer
}

export const loopsCommands: CommandContribution = {
  commands: [
    {
      name: 'loop',
      args: '[<name> | new [template | <name> <goal…>] | edit|rm|on|off <name> | send <name> <msg…> | chat <name> | schedule <name>]',
      description: 'Loops: switch, create (templates), edit, enable/disable, delete, message or schedule an inner loop',
      available: hasAgent,
      complete: completeLoop,
      run: async ctx => {
        const agentId = needAgent(ctx)
        if (!agentId) return
        const [sub, name, ...rest] = ctx.args
        switch (sub) {
          case undefined:
            openTab(ctx.actions, ctx.state(), 'loops')
            return
          case 'new': {
            const template = findTemplate(name)
            if (!name || (template && rest.length === 0)) {
              openLoopWizard(ctx.actions, { agentId, mode: 'create', template: template?.id })
              return
            }
            if (rest.length === 0) {
              ctx.print(`No template "${name}". Use /loop new (picker), /loop new <${LOOP_TEMPLATES.map(t => t.id).join('|')}> or /loop new <name> <goal…>`, 'warn')
              return
            }
            if (await ctx.actions.createLoop(agentId, { name, goal: rest.join(' '), autostart: false })) ctx.actions.selectLoop(agentId, name)
            return
          }
          case 'edit':
            if (!name) { ctx.print('Usage: /loop edit <name>', 'warn'); return }
            openLoopWizard(ctx.actions, { agentId, mode: 'edit', name })
            return
          case 'on':
          case 'off':
            if (!name) { ctx.print(`Usage: /loop ${sub} <name>`, 'warn'); return }
            await toggleLoopEnabled(ctx.actions, ctx.state(), agentId, name, sub === 'on')
            return
          case 'rm':
          case 'delete':
            if (!name) { ctx.print('Usage: /loop rm <name>', 'warn'); return }
            await confirmDeleteLoop(ctx.actions, ctx.state(), agentId, name)
            return
          case 'send': {
            const text = ctx.rest.replace(/^\s*send\s+\S+\s*/, '')
            if (!name || !text.trim()) { ctx.print('Usage: /loop send <name> <message…>', 'warn'); return }
            await sendToLoop(ctx.actions, agentId, name, text.trim(), agentName(ctx.state(), agentId))
            return
          }
          case 'chat':
            openChat(ctx.actions, agentId, name ?? ctx.loop)
            return
          case 'schedule':
            openTimerDialog(ctx.actions, { agentId, loop: name ?? ctx.loop })
            return
          default:
            if (!loopNames(ctx).includes(sub)) { ctx.print(`No loop "${sub}" on this agent (/loop new creates one)`, 'warn'); return }
            ctx.actions.selectLoop(agentId, sub)
            ctx.print(`Talking to ${sub}`, 'success')
        }
      },
    },
    {
      name: 'main',
      description: 'Back to the main loop',
      available: hasAgent,
      run: ctx => { if (ctx.agentId) ctx.actions.selectLoop(ctx.agentId, MAIN_LOOP) },
    },
    {
      name: 'loops',
      description: 'Loops manager: this agent\'s loops, timers, triggers and history',
      run: ctx => openTab(ctx.actions, ctx.state(), 'loops'),
    },
    {
      name: 'timers',
      args: '[all]',
      description: 'Timers of this agent, or all agents\' upcoming timers',
      complete: partial => ['all'].filter(x => x.startsWith(partial.trim())),
      run: ctx => openTab(ctx.actions, ctx.state(), 'timers', { fleet: ctx.args[0] === 'all' || !ctx.agentId, timerIndex: 0 }),
    },
    {
      name: 'timer',
      args: 'add [--loop <name>] | edit <id> | rm <id>',
      description: 'Create, edit or delete a timer (a timer with a loop runs that loop on a schedule)',
      available: hasAgent,
      complete: (partial, scope) => {
        const text = partial.replace(/^\s+/, '')
        if (!/\s/.test(text)) return ['add', 'edit', 'rm'].filter(x => x.startsWith(text))
        if (/^add\s+--loop\s+\S*$/.test(text)) {
          const arg = text.split(/\s+/)[2] ?? ''
          return loopNames(scope).filter(n => n.startsWith(arg)).map(n => `add --loop ${n}`)
        }
        if (/^add\s+-*\S*$/.test(text)) return ['add --loop ']
        return []
      },
      run: async ctx => {
        const agentId = needAgent(ctx)
        if (!agentId) return
        const [sub, ...rest] = ctx.args
        if (sub === 'add' || sub === 'new' || sub === undefined) {
          const at = rest.findIndex(a => a === '--loop' || a.startsWith('--loop='))
          const loop = at < 0 ? undefined : rest[at].startsWith('--loop=') ? rest[at].slice(7) : rest[at + 1]
          if (at >= 0 && !loop) { ctx.print('Usage: /timer add --loop <name>', 'warn'); return }
          if (loop && ctx.state().agents[agentId]?.loops && !loopNames(ctx).includes(loop)) { ctx.print(`No loop "${loop}" on this agent`, 'warn'); return }
          openTimerDialog(ctx.actions, { agentId, loop: loop ?? ctx.loop })
          return
        }
        const id = timerIdArg(ctx, rest[0])
        if (id === null) { ctx.print(`Usage: /timer ${sub} <id>`, 'warn'); return }
        if (sub === 'edit') { openTimerDialog(ctx.actions, { agentId, timerId: id }); return }
        if (sub === 'rm' || sub === 'delete') {
          const timer = await findTimer(ctx, agentId, id)
          if (timer) await confirmDeleteTimer(ctx.actions, ctx.state(), agentId, timer)
          return
        }
        ctx.print('Usage: /timer add [--loop <name>] | edit <id> | rm <id>', 'warn')
      },
    },
    {
      name: 'triggers',
      description: 'Triggers of this agent: enable/disable, edit targets and the loop each target wakes',
      available: hasAgent,
      run: ctx => openTab(ctx.actions, ctx.state(), 'triggers'),
    },
    {
      name: 'history',
      args: '[loop]',
      description: 'Browse a loop\'s persisted history (tokens per entry, filters)',
      available: hasAgent,
      complete: (partial, scope) => loopNames(scope).filter(n => n.startsWith(partial.trim())),
      run: ctx => {
        const agentId = needAgent(ctx)
        if (!agentId) return
        const loop = ctx.args[0]
        if (loop) {
          if (ctx.state().agents[agentId]?.loops && !loopNames(ctx).includes(loop)) { ctx.print(`No loop "${loop}" on this agent`, 'warn'); return }
          ctx.actions.selectLoop(agentId, loop)
        }
        openTab(ctx.actions, ctx.state(), 'history', { historyOffset: null, historyIndex: 0 })
      },
    },
  ],
  actions: paletteActions(),
}

function paletteActions(): PaletteAction[] {
  const group = 'Loops'
  return [
    { id: 'loops.new', group, title: 'New inner loop…', hint: 'templates: consolidator, researcher, critic, reflector', keywords: ['create', 'loop', 'thread', 'session', 'side'], available: hasAgent, run: ctx => { if (ctx.agentId) openLoopWizard(ctx.actions, { agentId: ctx.agentId, mode: 'create' }) } },
    ...LOOP_TEMPLATES.filter(t => t.id !== 'blank').map<PaletteAction>(t => ({
      id: `loops.new.${t.id}`,
      group,
      title: `New loop from template: ${t.title}`,
      hint: t.summary,
      keywords: ['create', 'loop', 'template', t.id],
      available: hasAgent,
      run: ctx => { if (ctx.agentId) openLoopWizard(ctx.actions, { agentId: ctx.agentId, mode: 'create', template: t.id }) },
    })),
    { id: 'loops.manage', group, title: 'Manage loops', keywords: ['loops', 'threads'], available: hasAgent, run: ctx => openTab(ctx.actions, ctx.state(), 'loops') },
    { id: 'loops.schedule', group, title: 'Schedule the selected loop…', hint: 'a timer whose loop targets it', keywords: ['timer', 'recurring', 'cron', 'every'], available: hasAgent, run: ctx => { if (ctx.agentId) openTimerDialog(ctx.actions, { agentId: ctx.agentId, loop: ctx.loop }) } },
    { id: 'loops.timers', group, title: 'Timers', keywords: ['schedule', 'cron'], available: hasAgent, run: ctx => openTab(ctx.actions, ctx.state(), 'timers', { fleet: false }) },
    { id: 'loops.upcoming', group, title: 'Upcoming timers (all agents)', keywords: ['fleet', 'schedule', 'next'], run: ctx => openTab(ctx.actions, ctx.state(), 'timers', { fleet: true, timerIndex: 0 }) },
    { id: 'loops.triggers', group, title: 'Triggers', keywords: ['on_timer', 'on_inbox', 'wake'], available: hasAgent, run: ctx => openTab(ctx.actions, ctx.state(), 'triggers') },
    { id: 'loops.history', group, title: 'Loop history', hint: 'persisted entries with token usage', keywords: ['entries', 'tokens'], available: hasAgent, run: ctx => openTab(ctx.actions, ctx.state(), 'history', { historyOffset: null, historyIndex: 0 }) },
    { id: 'loops.edit', group, title: 'Edit the selected loop…', available: scope => !!scope.agentId && scope.loop !== MAIN_LOOP, run: ctx => { if (ctx.agentId) openLoopWizard(ctx.actions, { agentId: ctx.agentId, mode: 'edit', name: ctx.loop }) } },
  ]
}
