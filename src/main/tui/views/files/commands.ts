// Files commands. Editing needs the mounted view (ink's suspendTerminal), so
// /edit, /open, /doc, /mind and /new-file post a request the view picks up.

import type { CommandContext, CommandContribution, CommandScope, PaletteAction } from '../../commands/types'
import { cachedFiles, listFiles } from './io'
import { DOCUMENT_KEY, MIND_KEY, fuzzyBest, fuzzyRank } from './model'
import { readViewState, sendRequest, VIEW_ID, type FilesTab } from './state'

const hasAgent = (scope: CommandScope) => !!scope.agentId

const PSEUDO: Record<string, string> = { document: DOCUMENT_KEY, doc: DOCUMENT_KEY, mind: MIND_KEY }

function completePaths(partial: string, scope: CommandScope): string[] {
  const paths = [...Object.keys(PSEUDO).filter(p => p !== 'doc'), ...(cachedFiles(scope.agentId)?.map(f => f.path) ?? [])]
  const q = partial.trim()
  return q ? fuzzyRank(q, paths, 8) : paths.slice(0, 8)
}

/** Resolve a fuzzy path argument to a target key (document/mind pseudo-entries included). */
async function resolveKey(ctx: CommandContext, arg: string): Promise<string | null> {
  const q = arg.trim()
  if (PSEUDO[q.toLowerCase()]) return PSEUDO[q.toLowerCase()]
  const agentId = ctx.agentId!
  let files = cachedFiles(agentId)
  if (!files) files = await ctx.actions.run('Files', c => listFiles(c, agentId))
  const paths = files?.map(f => f.path) ?? []
  if (paths.includes(q)) return `file:${q}`
  const best = fuzzyBest(q, [...paths, 'document', 'mind'])
  if (!best) {
    ctx.print(`No file in the agent matches "${q}"`, 'warn')
    return null
  }
  return PSEUDO[best] ?? `file:${best}`
}

function openTab(ctx: CommandContext, tab: FilesTab) {
  const current = readViewState(ctx.state())
  ctx.actions.setViewState(VIEW_ID, { ...current, tab, pane: 'list' })
  ctx.actions.setView(VIEW_ID)
}

const tabAction = (tab: FilesTab, title: string, keywords: string[]): PaletteAction => ({
  id: `files.${tab}`,
  title,
  group: 'Files',
  keywords,
  available: hasAgent,
  run: ctx => openTab(ctx, tab),
})

export const filesCommands: CommandContribution = {
  commands: [
    {
      name: 'files',
      description: 'Browse the selected agent’s document, mind and files',
      available: hasAgent,
      run: ctx => openTab(ctx, 'files'),
    },
    {
      name: 'open',
      args: '<path>',
      description: 'Open a file of the agent in the viewer (fuzzy path; also document, mind)',
      available: hasAgent,
      complete: completePaths,
      run: async ctx => {
        if (!ctx.rest.trim()) { openTab(ctx, 'files'); return }
        const key = await resolveKey(ctx, ctx.rest)
        if (key) sendRequest(ctx.store, { kind: 'open', key })
      },
    },
    {
      name: 'edit',
      args: '<path>',
      description: 'Edit a file of the agent in $VISUAL/$EDITOR, then confirm the write',
      available: hasAgent,
      complete: completePaths,
      run: async ctx => {
        if (!ctx.rest.trim()) { ctx.print('Usage: /edit <path> (or document, mind)', 'warn'); return }
        const key = await resolveKey(ctx, ctx.rest)
        if (key) sendRequest(ctx.store, { kind: 'edit', key })
      },
    },
    {
      name: 'doc',
      aliases: ['document'],
      description: 'Show the agent document',
      available: hasAgent,
      run: ctx => sendRequest(ctx.store, { kind: 'open', key: DOCUMENT_KEY }),
    },
    {
      name: 'mind',
      description: 'Show the agent’s mind (its memory; inner loops such as a consolidator tend it)',
      available: hasAgent,
      run: ctx => sendRequest(ctx.store, { kind: 'open', key: MIND_KEY }),
    },
    {
      name: 'new-file',
      args: '[path]',
      description: 'Create a file in the agent (opens $EDITOR)',
      available: hasAgent,
      run: ctx => sendRequest(ctx.store, { kind: 'new', path: ctx.rest.trim() || undefined }),
    },
    {
      name: 'rm',
      args: '<path>',
      description: 'Delete a file of the agent (asks first)',
      available: hasAgent,
      complete: (partial, scope) => completePaths(partial, scope).filter(p => !PSEUDO[p]),
      run: async ctx => {
        const agentId = ctx.agentId!
        const path = ctx.rest.trim()
        if (!path) { ctx.print('Usage: /rm <path>', 'warn'); return }
        const files = cachedFiles(agentId) ?? await ctx.actions.run('Files', c => listFiles(c, agentId)) ?? []
        if (!files.some(f => f.path === path)) { ctx.print(`No file "${path}" in the agent (use the exact path)`, 'warn'); return }
        const ok = await ctx.actions.confirm({ title: 'Delete file', message: `Delete ${path} from the agent?`, confirmLabel: 'Delete', danger: true })
        if (!ok) return
        const result = await ctx.actions.run('Delete', c => c.deleteFile(agentId, path))
        if (result?.success) ctx.print(`Deleted ${path}`, 'success')
        else if (result) ctx.print(`${path} was not deleted (missing or protected)`, 'warn')
        await ctx.actions.run('Files', c => listFiles(c, agentId))
      },
    },
    {
      name: 'mv',
      args: '<from> <to>',
      description: 'Rename or move a file of the agent',
      available: hasAgent,
      complete: (partial, scope) => (/\s/.test(partial.trim()) ? [] : completePaths(partial, scope).filter(p => !PSEUDO[p])),
      run: async ctx => {
        const agentId = ctx.agentId!
        const [from, to] = ctx.args
        if (!from || !to) { ctx.print('Usage: /mv <from> <to>', 'warn'); return }
        const result = await ctx.actions.run('Rename', c => c.renameFile(agentId, from, to))
        if (result?.success) ctx.print(`Renamed ${from} to ${to}`, 'success')
        else if (result) ctx.print(`${from} was not renamed (missing, protected, or ${to} exists)`, 'warn')
        await ctx.actions.run('Files', c => listFiles(c, agentId))
      },
    },
  ],
  actions: [
    { id: 'files.document', title: 'Show agent document', group: 'Files', keywords: ['doc', 'readme'], available: hasAgent, run: ctx => sendRequest(ctx.store, { kind: 'open', key: DOCUMENT_KEY }) },
    { id: 'files.mind', title: 'Show agent mind', group: 'Files', keywords: ['memory'], available: hasAgent, run: ctx => sendRequest(ctx.store, { kind: 'open', key: MIND_KEY }) },
    { id: 'files.edit-mind', title: 'Edit agent mind in $EDITOR', group: 'Files', keywords: ['memory'], available: hasAgent, run: ctx => sendRequest(ctx.store, { kind: 'edit', key: MIND_KEY }) },
    { id: 'files.new', title: 'New file…', group: 'Files', keywords: ['create'], available: hasAgent, run: ctx => sendRequest(ctx.store, { kind: 'new' }) },
    tabAction('files', 'Browse files', ['tree']),
    tabAction('inbox', 'Show inbox', ['mesh', 'messages', 'alf']),
    tabAction('outbox', 'Show outbox', ['mesh', 'messages', 'sent']),
    tabAction('meta', 'Show meta', ['metadata', 'keys']),
  ],
}
