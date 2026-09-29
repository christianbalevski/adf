// /skills: the selected agent's skills (src/main/tui/skills). The dialog is
// registered by the shell's overlay host (kind 'skills').

import * as panelNs from '../../../../shared/utils/skills-panel'
import type { CommandContext, CommandScope, PaletteAction, SlashCommand } from '../types'
import { cjs } from '../../interop'
import { CATALOG_SOURCES_SETTING, readCatalogSources } from '../../skills/catalog'
import { parseAddTarget } from '../../skills/model'
import { cachedSkillNames, openSkills, removeSkill, setSkillMuted } from '../../skills/ops'

const { addCatalogSource } = cjs(panelNs)

const hasAgent = (scope: CommandScope) => !!scope.agentId
const VERBS = ['add', 'mute', 'unmute', 'remove', 'sources']

const agentLabel = (ctx: CommandScope, agentId: string) => {
  const s = ctx.state().agents[agentId]?.summary
  return s?.handle || s?.name || agentId
}

async function mute(ctx: CommandContext, name: string | undefined, enabled: boolean): Promise<void> {
  const verb = enabled ? 'unmute' : 'mute'
  if (!ctx.agentId) { ctx.print('Select an agent first', 'warn'); return }
  if (!name) { ctx.print(`Usage: /skills ${verb} <name>`, 'warn'); return }
  const error = await setSkillMuted(ctx.client, ctx.agentId, name, enabled)
  if (error) { ctx.print(error, 'error'); return }
  ctx.print(enabled ? `${name} unmuted` : `${name} muted: its description left ${agentLabel(ctx, ctx.agentId)}'s prompt`, 'success')
}

async function remove(ctx: CommandContext, name: string | undefined): Promise<void> {
  if (!ctx.agentId) { ctx.print('Select an agent first', 'warn'); return }
  if (!name) { ctx.print('Usage: /skills remove <name>', 'warn'); return }
  const agentId = ctx.agentId
  const who = agentLabel(ctx, agentId)
  const ok = await ctx.actions.confirm({
    title: `Remove ${name}`,
    message: `Delete skills/${name}/ (SKILL.md and every file beside it) from ${who}?`,
    confirmLabel: 'Remove',
    danger: true,
  })
  if (!ok) return
  const outcome = await ctx.actions.run(`Remove ${name}`, c => removeSkill(c, agentId, name))
  if (!outcome) return
  if (outcome.deleted === 0 && outcome.failed.length === 0) { ctx.print(`${who} has no skills/${name}/`, 'warn'); return }
  if (outcome.failed.length) ctx.print(`${name}: ${outcome.deleted} deleted, not deleted: ${outcome.failed.join('; ')}`, 'warn')
  else ctx.print(`Removed ${name} from ${who}`, 'success')
}

async function sources(ctx: CommandContext): Promise<void> {
  const verb = ctx.args[1]?.toLowerCase()
  const url = ctx.args[2]
  const current = await readCatalogSources(ctx.client)
  if (!verb || verb === 'list') {
    ctx.print(current.sources.length ? `Catalog sources: ${current.sources.join(' , ')}` : 'No catalog sources. /skills sources add <https-url>', current.note ? 'warn' : 'info')
    return
  }
  if (verb === 'add') {
    const result = addCatalogSource(current.sources, url ?? '')
    if (!result.ok) { ctx.print(result.error, 'warn'); return }
    const saved = await ctx.actions.run('Save catalog sources', c => c.putSetting(CATALOG_SOURCES_SETTING, result.sources))
    if (saved) ctx.print(`Added ${url} (${result.sources.length} source${result.sources.length === 1 ? '' : 's'}; Studio shares the list)`, 'success')
    return
  }
  if (verb === 'remove' || verb === 'rm') {
    if (!url || !current.sources.includes(url)) { ctx.print(`Not a listed source: ${url ?? ''}. /skills sources lists them.`, 'warn'); return }
    const next = current.sources.filter(s => s !== url)
    const saved = await ctx.actions.run('Save catalog sources', c => c.putSetting(CATALOG_SOURCES_SETTING, next))
    if (saved) ctx.print(`Removed ${url}`, 'success')
    return
  }
  ctx.print('Usage: /skills sources [add|remove <https-url>]', 'warn')
}

export const skillsCommand: SlashCommand = {
  name: 'skills',
  args: '[add [name | https-url | ./path] | mute|unmute|remove <name> | sources [add|remove <url>]]',
  description: 'The selected agent’s skills: preview, mute, edit, remove; add from the catalog, a URL or a local folder',
  complete: (partial, scope) => {
    const parts = partial.split(/\s+/)
    if (parts.length <= 1) return VERBS.filter(v => v.startsWith(partial.trim()))
    if (['mute', 'unmute', 'remove', 'rm'].includes(parts[0])) {
      return cachedSkillNames(scope.agentId).filter(n => n.startsWith(parts[1] ?? '')).map(n => `${parts[0]} ${n}`)
    }
    if (parts[0] === 'sources' && parts.length === 2) return ['add', 'remove'].filter(v => v.startsWith(parts[1])).map(v => `sources ${v}`)
    return []
  },
  run: async ctx => {
    const verb = ctx.args[0]?.toLowerCase()
    if (!verb || verb === 'list') { openSkills(ctx.store, {}); return }
    if (verb === 'add' || verb === 'install') {
      const arg = ctx.rest.trim().replace(/^\S+\s*/, '')
      const target = parseAddTarget(arg)
      if (target.kind === 'invalid') { ctx.print(target.error, 'warn'); return }
      openSkills(ctx.store, { add: arg })
      return
    }
    if (verb === 'mute' || verb === 'disable') { await mute(ctx, ctx.args[1], false); return }
    if (verb === 'unmute' || verb === 'enable') { await mute(ctx, ctx.args[1], true); return }
    if (verb === 'remove' || verb === 'rm') { await remove(ctx, ctx.args[1]); return }
    if (verb === 'sources' || verb === 'source') { await sources(ctx); return }
    // `/skills pdf` = preview the installed pdf skill, else search the catalog for it.
    const name = ctx.args[0]
    openSkills(ctx.store, cachedSkillNames(ctx.agentId).includes(name) ? { skill: name } : { add: ctx.rest.trim() })
  },
}

export const skillsActions: PaletteAction[] = [
  { id: 'skills.open', title: 'Skills of this agent', hint: 'preview, mute, edit, remove', group: 'Actions', keywords: ['skills', 'skill', 'instructions', 'SKILL.md', 'mute'], available: hasAgent, run: ctx => openSkills(ctx.store, {}) },
  { id: 'skills.add', title: 'Add a skill', hint: 'catalog, URL or local folder', group: 'Actions', keywords: ['skills', 'skill', 'install', 'catalog', 'marketplace'], available: hasAgent, run: ctx => openSkills(ctx.store, { add: '' }) },
]
