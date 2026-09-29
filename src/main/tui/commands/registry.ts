// Collects commands from views + builtins and runs slash input. First
// registration of a name wins; duplicates are reported, not silently merged.

import type { ViewDefinition } from '../views/types'
import { isTrackedKey } from '../state/tracked'
import type { TuiStore } from '../state/store'
import { MAIN_LOOP } from '../api/types'
import type {
  CommandContext,
  CommandContribution,
  CommandScope,
  PaletteAction,
  SlashCommand,
} from './types'

export interface CommandRegistry {
  commands: SlashCommand[]
  actions: PaletteAction[]
  /** Name/alias collisions found while collecting ("/x from view a shadows view b"). */
  conflicts: string[]
  find(name: string): SlashCommand | undefined
}

export function collectCommands(views: ViewDefinition[], builtins: CommandContribution[] = []): CommandRegistry {
  const commands: SlashCommand[] = []
  const actions: PaletteAction[] = []
  const conflicts: string[] = []
  const byName = new Map<string, SlashCommand>()
  const actionIds = new Set<string>()

  const addCommand = (command: SlashCommand, owner: string) => {
    const withView = command.view ? command : { ...command, view: owner }
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const key = name.toLowerCase()
      const existing = byName.get(key)
      if (existing) {
        conflicts.push(`/${key} from ${owner} is shadowed by ${existing.view ?? 'builtin'}`)
        continue
      }
      byName.set(key, withView)
    }
    commands.push(withView)
  }
  const addAction = (action: PaletteAction, owner: string) => {
    if (actionIds.has(action.id)) {
      conflicts.push(`palette action ${action.id} from ${owner} is a duplicate`)
      return
    }
    actionIds.add(action.id)
    actions.push(action.view ? action : { ...action, view: owner })
  }

  for (const builtin of builtins) {
    for (const command of builtin.commands ?? []) addCommand(command, 'builtin')
    for (const action of builtin.actions ?? []) addAction(action, 'builtin')
  }
  for (const view of views) {
    for (const command of view.commands ?? []) addCommand(command, view.id)
    for (const action of view.actions ?? []) addAction(action, view.id)
  }

  return {
    commands,
    actions,
    conflicts,
    find: name => byName.get(name.toLowerCase()),
  }
}

/** Split `/name rest` → name + args (double/single quotes group words). */
export function parseSlash(text: string): { name: string; args: string[]; rest: string } | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  const match = trimmed.slice(1).match(/^(\S*)\s*([\s\S]*)$/)
  if (!match) return null
  const rest = match[2] ?? ''
  return { name: match[1].toLowerCase(), args: splitArgs(rest), rest }
}

export function splitArgs(text: string): string[] {
  const args: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) args.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3])
  return args
}

export function createScope(store: TuiStore, exit: () => void): CommandScope {
  const state = store.getState()
  const selected = state.selectedAgentId
  // A stopped (not loaded) tracked agent has no daemon id: agent commands see
  // no agent; `/start` and the prompt use `stoppedKey`.
  const stoppedKey = isTrackedKey(selected) ? selected : null
  const agentId = stoppedKey ? null : selected
  return {
    store,
    actions: store.actions,
    client: store.client,
    state: () => store.getState(),
    agentId,
    stoppedKey,
    loop: agentId ? state.selectedLoop[agentId] ?? MAIN_LOOP : MAIN_LOOP,
    print: (text, level = 'info') => store.actions.toast(text, level),
    exit,
  }
}

/**
 * Run slash input. Returns false when the text is not a slash command (send
 * it as chat); true when it was handled, including "unknown command" (which
 * is reported, never sent to the agent by accident).
 */
export async function runSlash(text: string, registry: CommandRegistry, store: TuiStore, exit: () => void): Promise<boolean> {
  const parsed = parseSlash(text)
  if (!parsed) return false
  const scope = createScope(store, exit)
  const command = registry.find(parsed.name)
  if (!command) {
    store.actions.toast(`Unknown command /${parsed.name} — /help lists commands`, 'warn')
    return true
  }
  if (command.available && !command.available(scope)) {
    store.actions.toast(`/${command.name} is not available here`, 'warn')
    return true
  }
  const ctx: CommandContext = { ...scope, args: parsed.args, rest: parsed.rest }
  try {
    await command.run(ctx)
  } catch (err) {
    store.actions.toast(`/${command.name}: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
  return true
}

/** Commands whose name/alias starts with the typed prefix (for the prompt's completion menu). */
export function completeSlash(text: string, registry: CommandRegistry, scope: CommandScope): Array<{ value: string; command: SlashCommand }> {
  const parsed = parseSlash(text)
  if (!parsed) return []
  const hasArgs = /\s/.test(text.trimStart().slice(1))
  if (hasArgs) {
    const command = registry.find(parsed.name)
    if (!command?.complete) return []
    return command.complete(parsed.rest, scope).map(value => ({ value: `/${command.name} ${value}`, command }))
  }
  const seen = new Set<SlashCommand>()
  const out: Array<{ value: string; command: SlashCommand }> = []
  for (const command of registry.commands) {
    if (seen.has(command)) continue
    if (command.available && !command.available(scope)) continue
    const names = [command.name, ...(command.aliases ?? [])]
    if (names.some(n => n.startsWith(parsed.name))) {
      seen.add(command)
      out.push({ value: `/${command.name}`, command })
    }
  }
  // An exact name or alias leads (`/copy` before `/copy-site`): Enter takes the first.
  const exact = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])].some(n => n.toLowerCase() === parsed.name)
  return [...out.filter(o => exact(o.command)), ...out.filter(o => !exact(o.command))]
}
