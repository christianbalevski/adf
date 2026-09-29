// /context: the selected agent's context usage for the selected loop (Studio's
// context breakdown). The dialog lives in src/main/tui/context and is a shell
// overlay.

import type { PaletteAction, SlashCommand } from '../types'
import { openContext } from '../../context/model'

export const contextCommand: SlashCommand = {
  name: 'context',
  args: '[loop]',
  description: 'Context usage of the selected loop: total vs the auto-compact threshold, what fills it (prompt, files, tools, MCP, conversation), compact now',
  available: scope => !!scope.agentId,
  complete: (partial, scope) => {
    const loops = scope.agentId ? scope.state().agents[scope.agentId]?.loops ?? [] : []
    return loops.map(l => l.info.name).filter(name => name.startsWith(partial.trim()))
  },
  run: ctx => {
    if (!ctx.agentId) { ctx.print('Select an agent first', 'warn'); return }
    openContext(ctx.store, { agentId: ctx.agentId, loop: ctx.args[0] || ctx.loop })
  },
}

export const contextActions: PaletteAction[] = [
  {
    id: 'context.show',
    title: 'Context usage',
    hint: 'what fills the selected loop’s context',
    group: 'Actions',
    keywords: ['context', 'tokens', 'window', 'compact', 'breakdown', 'usage'],
    available: scope => !!scope.agentId,
    run: ctx => { if (ctx.agentId) openContext(ctx.store, { agentId: ctx.agentId, loop: ctx.loop }) },
  },
]
