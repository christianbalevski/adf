// What the palette can do: views, agents, every loop of every agent, all
// registered slash commands and palette actions, and recent files.

import { MAIN_LOOP, type FileListEntry } from '../../api/types'
import { createScope, runSlash, type CommandRegistry } from '../../commands/registry'
import type { SlashCommand } from '../../commands/types'
import type { TuiStore } from '../../state/store'
import type { ViewDefinition } from '../../views/types'
import { scoreEntry } from './fuzzy'
import { isTrackedKey } from '../../state/tracked'

export interface PaletteEntry {
  id: string
  group: string
  title: string
  /** Secondary text (description, state, goal). */
  hint?: string
  /** Key binding shown right-aligned, e.g. `4`, `ctrl+k`. */
  shortcut?: string
  keywords?: string
  run: () => void | Promise<void>
}

export const GROUP_ORDER = ['Recent', 'Views', 'Agents', 'Loops', 'Commands', 'Actions', 'Files']

// --- memory (per process) -------------------------------------------------------

const MRU_MAX = 12
const mru: string[] = []
const recentFiles: Array<{ agentId: string; path: string; at: number }> = []

export function rememberRun(id: string): void {
  const at = mru.indexOf(id)
  if (at >= 0) mru.splice(at, 1)
  mru.unshift(id)
  if (mru.length > MRU_MAX) mru.length = MRU_MAX
}

export function recentRuns(): readonly string[] {
  return mru
}

/** Files view (or anything that opens a file) reports it here so the palette can offer it again. */
export function recordRecentFile(agentId: string, path: string): void {
  const at = recentFiles.findIndex(f => f.agentId === agentId && f.path === path)
  if (at >= 0) recentFiles.splice(at, 1)
  recentFiles.unshift({ agentId, path, at: Date.now() })
  if (recentFiles.length > 20) recentFiles.length = 20
}

export function resetPaletteMemory(): void {
  mru.length = 0
  recentFiles.length = 0
}

// --- entries --------------------------------------------------------------------

export interface EntryContext {
  store: TuiStore
  views: ViewDefinition[]
  registry: CommandRegistry
  exit: () => void
  loopGlyph?: string
  /** The selected agent's files (most recently updated first), when fetched. */
  files?: FileListEntry[]
}

/** `<x>` marks a required argument; commands without one run straight from the palette. */
export function needsArgs(command: SlashCommand): boolean {
  return !!command.args && /<[^>]+>/.test(command.args)
}

export function buildEntries(ctx: EntryContext): PaletteEntry[] {
  const { store, views, registry, exit } = ctx
  const state = store.getState()
  const scope = createScope(store, exit)
  const glyph = ctx.loopGlyph ?? '@'
  const out: PaletteEntry[] = []
  const handle = (id: string) => state.agents[id]?.summary.handle || state.agents[id]?.summary.name || id

  for (const view of views) {
    out.push({ id: `view:${view.id}`, group: 'Views', title: `Go to ${view.title}`, shortcut: view.key, keywords: `view ${view.id}`, run: () => store.actions.setView(view.id) })
  }

  for (const id of state.agentOrder) {
    const agent = state.agents[id]
    if (!agent) continue
    const pending = agent.pendingTasks.length + agent.pendingAsks.length
    out.push({
      id: `agent:${id}`,
      group: 'Agents',
      title: handle(id),
      hint: ['switch agent', agent.executorState ?? agent.status?.runtimeState, pending ? `${pending} pending` : ''].filter(Boolean).join(' · '),
      keywords: `switch to agent select ${agent.summary.name} ${id}`,
      run: () => store.actions.selectAgent(id),
    })
  }

  // Tracked agents that are not loaded: select one (its panel says how to start it).
  for (const t of state.tracked?.stopped ?? []) {
    out.push({
      id: `agent:${t.key}`,
      group: 'Agents',
      title: t.agent.name,
      hint: ['stopped', t.agent.status === 'needs_review' ? 'needs review' : '', t.relPath].filter(Boolean).join(' · '),
      keywords: `switch to agent select stopped tracked start ${t.relPath}`,
      run: () => store.actions.selectAgent(t.key),
    })
  }

  // Every loop of every agent: loops are the agent's parallel chat sessions.
  for (const id of state.agentOrder) {
    const loops = state.agents[id]?.loops ?? []
    for (const loop of loops) {
      const name = loop.info.name
      const status = loop.info.enabled === false ? 'disabled' : loop.executorState ?? loop.info.status
      out.push({
        id: `loop:${id}:${name}`,
        group: 'Loops',
        title: `${handle(id)} ${glyph} ${name}`,
        hint: [status, name === MAIN_LOOP ? 'talks to you' : loop.info.goal].filter(Boolean).join(' · '),
        keywords: `loop thread session chat ${loop.info.goal ?? ''}`,
        run: () => {
          if (store.getState().selectedAgentId !== id) store.actions.selectAgent(id)
          store.actions.selectLoop(id, name)
        },
      })
    }
  }

  const seen = new Set<SlashCommand>()
  for (const command of registry.commands) {
    if (seen.has(command)) continue
    seen.add(command)
    if (command.available && !command.available(scope)) continue
    const takesArgs = needsArgs(command)
    out.push({
      id: `cmd:${command.name}`,
      group: 'Commands',
      title: `/${command.name}${command.args ? ` ${command.args}` : ''}`,
      hint: command.description,
      keywords: `${command.aliases?.join(' ') ?? ''} ${command.view ?? ''}`,
      run: () => {
        if (takesArgs) store.actions.prefillPrompt(`/${command.name} `)
        else return runSlash(`/${command.name}`, registry, store, exit).then(() => undefined)
      },
    })
  }

  for (const action of registry.actions) {
    if (action.available && !action.available(scope)) continue
    out.push({
      id: `action:${action.id}`,
      group: action.group ?? 'Actions',
      title: action.title,
      hint: action.hint,
      shortcut: action.shortcut,
      keywords: `${action.keywords?.join(' ') ?? ''} ${action.id}`,
      run: () => action.run({ ...createScope(store, exit), args: [], rest: '' }),
    })
  }

  const agentId = state.selectedAgentId
  if (agentId && !isTrackedKey(agentId)) {
    const paths: string[] = []
    for (const f of recentFiles) if (f.agentId === agentId && !paths.includes(f.path)) paths.push(f.path)
    for (const f of ctx.files ?? []) if (!paths.includes(f.path)) paths.push(f.path)
    for (const path of paths.slice(0, 8)) {
      out.push({
        id: `file:${agentId}:${path}`,
        group: 'Files',
        title: `Open ${path}`,
        hint: handle(agentId),
        keywords: 'file open recent',
        run: () => openFile(ctx, agentId, path),
      })
    }
  }
  return out
}

async function openFile(ctx: EntryContext, agentId: string, path: string): Promise<void> {
  recordRecentFile(agentId, path)
  const { store, registry, exit } = ctx
  if (registry.find('open')) {
    await runSlash(`/open "${path.replace(/"/g, '\\"')}"`, registry, store, exit)
    return
  }
  store.actions.setView('files')
  store.actions.toast(`Files view opened; select ${path}`, 'info')
}

/** Filter + rank. Empty query: recently run first, then by group order. */
export function rankEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const recent = recentRuns()
  if (!query.trim()) {
    const byId = new Map(entries.map(e => [e.id, e]))
    const head = recent.map(id => byId.get(id)).filter((e): e is PaletteEntry => !!e).map(e => ({ ...e, group: 'Recent' }))
    const headIds = new Set(head.map(e => e.id))
    const rest = entries.filter(e => !headIds.has(e.id))
      .map((e, i) => ({ e, i, g: GROUP_ORDER.indexOf(e.group) < 0 ? GROUP_ORDER.length : GROUP_ORDER.indexOf(e.group) }))
      .sort((a, b) => a.g - b.g || a.i - b.i)
      .map(r => r.e)
    return [...head, ...rest]
  }
  return entries
    .map((entry, i) => {
      const base = scoreEntry(query, entry.title, `${entry.group} ${entry.hint ?? ''} ${entry.keywords ?? ''}`)
      const boost = base > 0 && recent.includes(entry.id) ? 10 - recent.indexOf(entry.id) * 0.5 : 0
      return { entry, i, score: base + boost }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(r => r.entry)
}
