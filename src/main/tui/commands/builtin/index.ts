// Shell-level commands. Feature-specific commands live with their view
// (views/<id>/commands.ts); the daemon pages (/status /usage …) belong to the
// Runtime view. /theme's dialog is registered by the inspect view
// (`inspect.theme`); help and terminal-setup are the shell's own overlays.

import { DaemonClient } from '../../api/client'
import { MAIN_LOOP } from '../../api/types'
import type { CommandContext, CommandContribution, CommandScope, PaletteAction, SlashCommand } from '../types'
import { patchInspectState, readInspectState } from '../../views/inspect/state'
import { themeNames } from './themes'
import { setMouse, setSidebarHidden } from '../../app/layout'
import { TERMINAL_SETUP_OVERLAY } from '../../app/terminal-setup'
import { identityActions, identityCommand, newAgentCommand } from './identity'
import { authActions, authCommand, loginCommand, logoutCommand } from './auth'
import { copySiteCommand, openSiteCommand, webActions, webCommand } from './web'
import { channelsCommand, mcpCommand, providerCommand, setupActions, welcomeCommand } from './setup'
import { templatesActions, templatesCommand } from './templates'
import { skillsActions, skillsCommand } from './skills'
import { contextActions, contextCommand } from './context'

export { createQuitGuard, QUIT_WINDOW_MS } from './quit'
export { THEMES, applyTheme, findTheme, nextThemeName } from './themes'
export { REPORTS, type ReportKind } from './reports'

function agentHandles(scope: CommandScope): string[] {
  const state = scope.state()
  return state.agentOrder.map(id => state.agents[id]?.summary.handle || state.agents[id]?.summary.name || id)
}

function findAgentId(scope: CommandScope, wanted: string): string | undefined {
  const state = scope.state()
  return state.agentOrder.find(agentId => {
    const s = state.agents[agentId]?.summary
    return agentId === wanted || s?.handle === wanted || s?.name === wanted
  })
}

export function openHelp(ctx: Pick<CommandContext, 'actions'>): void {
  ctx.actions.pushOverlay({ id: 'help', kind: 'help' })
}

const help: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  description: 'Keys, commands and what loops are',
  run: ctx => openHelp(ctx),
}

const quit: SlashCommand = {
  name: 'quit',
  aliases: ['exit', 'q'],
  description: 'Leave the terminal app (agents keep running in the daemon)',
  run: ctx => ctx.exit(),
}

const VIEW_IDS = ['fleet', 'chat', 'files', 'loops', 'inspect', 'runtime']

const view: SlashCommand = {
  name: 'view',
  args: `<${VIEW_IDS.join('|')}>`,
  description: 'Switch the main pane',
  complete: (partial) => VIEW_IDS.filter(v => v.startsWith(partial.trim())),
  run: ctx => {
    const target = ctx.args[0]
    if (!target) { ctx.print('Usage: /view <id>', 'warn'); return }
    ctx.actions.setView(target)
  },
}

const agent: SlashCommand = {
  name: 'agent',
  aliases: ['a'],
  args: '<handle|id> [loop]',
  description: 'Select an agent, and optionally one of its loops (default main)',
  complete: (partial, scope) => {
    const parts = partial.split(/\s+/)
    if (parts.length <= 1) return agentHandles(scope).filter(h => h.startsWith(partial.trim()))
    const id = findAgentId(scope, parts[0])
    const loops = id ? scope.state().agents[id]?.loops?.map(l => l.info.name) ?? [] : []
    return loops.filter(l => l.startsWith(parts[1] ?? '')).map(l => `${parts[0]} ${l}`)
  },
  run: ctx => {
    const wanted = ctx.args[0]
    if (!wanted) { ctx.print('Usage: /agent <handle|id> [loop]', 'warn'); return }
    const id = findAgentId(ctx, wanted)
    if (!id) { ctx.print(`No loaded agent "${wanted}"`, 'warn'); return }
    ctx.actions.selectAgent(id)
    const loop = ctx.args[1]
    if (loop) {
      const known = ctx.state().agents[id]?.loops
      if (known && !known.some(l => l.info.name === loop)) { ctx.print(`${wanted} has no loop "${loop}"; selected main`, 'warn'); return }
      ctx.actions.selectLoop(id, loop)
    }
    ctx.print(`Selected ${wanted} › ${loop ?? ctx.state().selectedLoop[id] ?? MAIN_LOOP}`, 'success')
  },
}

const refresh: SlashCommand = {
  name: 'refresh',
  aliases: ['r'],
  description: 'Re-read agents, loops and approvals from the daemon',
  run: async ctx => {
    await ctx.actions.refreshAgents()
    ctx.print('Refreshed', 'success')
  },
}

const theme: SlashCommand = {
  name: 'theme',
  args: '[adf|adf-light|adf-contrast|adf-mono|next]',
  description: 'Pick a color theme (no argument opens the picker)',
  complete: partial => [...themeNames(), 'next', 'light', 'dark', 'mono'].filter(n => n.startsWith(partial.trim())),
  run: ctx => { ctx.actions.pushOverlay({ kind: 'inspect.theme', props: ctx.args[0] ? { name: ctx.args[0] } : {} }) },
}

/** Normalize `host:port` / `http://host:port/` to a base URL, or null. */
export function normalizeDaemonUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

type DaemonUrlSetter = (url: string, token?: string) => Promise<boolean | void>

const url: SlashCommand = {
  name: 'url',
  args: '[daemon-url] [--token <token>]',
  description: 'Show the daemon URL, or reconnect to another daemon (for a remote daemon pass --token or set ADF_DAEMON_TOKEN)',
  run: async ctx => {
    const state = ctx.state()
    if (!ctx.args[0]) {
      ctx.print(`Daemon ${state.daemonUrl} ${'·'} live events ${state.connection.state}. /url <url> switches.`, 'info')
      return
    }
    const args = [...ctx.args]
    const at = args.indexOf('--token')
    const token = at >= 0 ? args[at + 1] : undefined
    if (at >= 0) {
      if (!token) { ctx.print('Usage: /url <daemon-url> --token <token>', 'warn'); return }
      args.splice(at, 2)
    }
    const target = args[0] ? normalizeDaemonUrl(args[0]) : null
    if (!target) { ctx.print(`Not a daemon URL: ${args[0] ?? ''}`, 'warn'); return }
    const setter = (ctx.actions as unknown as { setDaemonUrl?: DaemonUrlSetter }).setDaemonUrl
    if (typeof setter === 'function') {
      ctx.print(`Connecting to ${target}…`, 'info')
      await setter(target, token)
      return
    }
    try {
      await new DaemonClient({ baseUrl: target, timeoutMs: 4000 }).health()
    } catch (err) {
      ctx.print(`${target} is not answering: ${err instanceof Error ? err.message : String(err)}`, 'error')
      return
    }
    ctx.print(`${target} is up, but this build cannot switch daemons live. Restart with: adf --url ${target}`, 'warn')
  },
}

const onOff = (arg: string | undefined): boolean | undefined => {
  const a = arg?.toLowerCase()
  return a === 'on' || a === 'show' ? true : a === 'off' || a === 'hide' ? false : undefined
}

const sidebar: SlashCommand = {
  name: 'sidebar',
  args: '[on|off]',
  description: 'Show or hide the fleet sidebar (Ctrl+B); remembered across launches',
  complete: partial => ['on', 'off'].filter(v => v.startsWith(partial.trim())),
  run: ctx => {
    const on = onOff(ctx.args[0])
    setSidebarHidden(ctx.store, on === undefined ? undefined : !on)
  },
}

const mouse: SlashCommand = {
  name: 'mouse',
  args: '[on|off]',
  description: 'Mouse mode (on, the default: click expands, drag selects + copies, right-click pastes, the wheel scrolls under the pointer; off: the terminal’s own mouse); remembered',
  complete: partial => ['on', 'off'].filter(v => v.startsWith(partial.trim())),
  run: ctx => { setMouse(ctx.store, onOff(ctx.args[0])) },
}

const terminalSetup: SlashCommand = {
  name: 'terminal-setup',
  aliases: ['terminal'],
  description: 'Shift+Enter for a newline in this terminal: what works now and how to set it up',
  run: ctx => { ctx.actions.pushOverlay({ kind: TERMINAL_SETUP_OVERLAY }) },
}

const json: SlashCommand = {
  name: 'json',
  args: '[on|off]',
  description: 'Toggle raw JSON in Inspect and Runtime pages',
  complete: partial => ['on', 'off'].filter(v => v.startsWith(partial.trim())),
  run: ctx => {
    const current = readInspectState(ctx.state()).json
    const arg = ctx.args[0]?.toLowerCase()
    const next = arg === 'on' ? true : arg === 'off' ? false : !current
    patchInspectState(ctx.actions, ctx.state(), { json: next })
    ctx.print(next ? 'Raw JSON on (Inspect and Runtime)' : 'Raw JSON off: readable tree', 'info')
  },
}

const commands: SlashCommand[] = [
  help,
  quit,
  view,
  agent,
  refresh,
  theme,
  url,
  authCommand,
  loginCommand,
  logoutCommand,
  json,
  sidebar,
  mouse,
  terminalSetup,
  identityCommand,
  newAgentCommand,
  webCommand,
  openSiteCommand,
  copySiteCommand,
  welcomeCommand,
  channelsCommand,
  providerCommand,
  mcpCommand,
  templatesCommand,
  skillsCommand,
  contextCommand,
]

const actions: PaletteAction[] = [
  { id: 'shell.refresh', title: 'Refresh from daemon', group: 'Actions', keywords: ['reload', 'sync'], run: ctx => ctx.actions.refreshAgents() },
  { id: 'shell.help', title: 'Keys & commands', group: 'Actions', shortcut: '?', keywords: ['help', 'keys', 'shortcuts'], run: ctx => openHelp(ctx) },
  { id: 'shell.theme.next', title: 'Next color theme', group: 'Actions', keywords: ['theme', 'color', 'light', 'dark', 'mono'], run: ctx => { ctx.actions.pushOverlay({ kind: 'inspect.theme', props: { name: 'next' } }) } },
  { id: 'shell.json', title: 'Toggle raw JSON in Inspect and Runtime', group: 'Actions', keywords: ['json', 'raw'], run: ctx => json.run(ctx) },
  { id: 'shell.sidebar', title: 'Show / hide the sidebar', hint: 'full-width view, remembered', group: 'Actions', shortcut: 'ctrl+b', keywords: ['sidebar', 'fleet', 'full screen', 'fullscreen', 'zen', 'collapse', 'layout'], run: ctx => { setSidebarHidden(ctx.store) } },
  { id: 'shell.mouse', title: 'Mouse mode on / off', hint: 'off: the terminal’s own select, copy and paste', group: 'Actions', keywords: ['mouse', 'wheel', 'scroll', 'select', 'copy'], run: ctx => { setMouse(ctx.store) } },
  { id: 'shell.terminal-setup', title: 'Terminal setup: Shift+Enter newline', group: 'Actions', keywords: ['shift enter', 'newline', 'keyboard', 'terminal', 'kitty', 'vscode', 'windows terminal'], run: ctx => { ctx.actions.pushOverlay({ kind: TERMINAL_SETUP_OVERLAY }) } },
  { id: 'shell.quit', title: 'Quit TUI (agents keep running)', group: 'Actions', shortcut: 'ctrl+c', keywords: ['exit', 'leave'], run: ctx => ctx.exit() },
  ...identityActions,
  ...authActions,
  ...webActions,
  ...setupActions,
  ...templatesActions,
  ...skillsActions,
  ...contextActions,
]

export const BUILTIN_COMMANDS: CommandContribution = { commands, actions }
