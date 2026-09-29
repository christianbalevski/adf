// /templates: agent templates (Studio's Settings > Agent templates). The
// dialog lives in src/main/tui/templates and is a shell overlay.

import type { CommandScope, PaletteAction, SlashCommand } from '../types'
import { openTemplates } from '../../templates/ops'

/** Ids of the last list this process read, for completion (no fetch while typing). */
let knownIds: string[] = []

function rememberIds(scope: CommandScope): void {
  void scope.client.templates().then(r => { knownIds = r.templates.map(t => t.id) }).catch(() => undefined)
}

export const templatesCommand: SlashCommand = {
  name: 'templates',
  args: '[template-id]',
  description: 'Agent templates: list, details, new, duplicate, rename, notes, default, review, reset, delete, edit in $EDITOR',
  complete: (partial, scope) => {
    if (knownIds.length === 0) rememberIds(scope)
    return knownIds.filter(id => id.startsWith(partial.trim()))
  },
  run: ctx => {
    const id = ctx.args[0]
    openTemplates(ctx.store, id ? { id } : {})
  },
}

export const templatesActions: PaletteAction[] = [
  { id: 'shell.templates', title: 'Agent templates', hint: 'what new agents start from', group: 'Actions', keywords: ['template', 'templates', 'default', 'new agent', 'review'], run: ctx => openTemplates(ctx.store) },
]
