/**
 * What the macOS menu bar icon shows, as plain data.
 *
 * Kept free of Electron so the content rules are testable on their own:
 * menu-bar.ts turns this into a native Menu and owns every side effect.
 *
 * The menu is built fresh each time it opens (a click reads the live state),
 * so nothing here needs to track changes. Only the icon's title — the count of
 * requests waiting on the user — updates on its own, from the ApprovalHub.
 */

import type { AgentState, PendingNotification } from '../../shared/types/ipc.types'

export interface MenuBarAgent {
  filePath: string
  /** The .adf basename — an agent's name is its file name. */
  name: string
  state: AgentState
  /** Inner loops mid-turn; main is excluded (`state` is main's). */
  activeLoops?: number
  /** The agent open in the Studio window, as opposed to a background agent. */
  foreground?: boolean
}

export interface MenuBarSnapshot {
  /** "ADF Studio" or "ADF Daemon": the menu says which runtime it belongs to. */
  surface: string
  pending: PendingNotification[]
  agents: MenuBarAgent[]
  tokensToday: { input: number; output: number }
}

export type MenuBarAction =
  | { type: 'reveal'; notification: PendingNotification }
  | { type: 'open-agent'; filePath: string }
  | { type: 'show' }
  | { type: 'settings' }
  | { type: 'quit' }

export type MenuBarItem =
  | { kind: 'separator' }
  /** Informational row: rendered disabled. */
  | { kind: 'info'; label: string }
  | { kind: 'action'; label: string; action: MenuBarAction; toolTip?: string }

export interface MenuBarModel {
  /** Text beside the icon. Empty when nothing is waiting. */
  title: string
  tooltip: string
  items: MenuBarItem[]
}

/** Rows per section before the rest collapse into "N more…". */
export const MENU_BAR_SECTION_MAX = 8

const LABEL_MAX = 60

function truncate(text: string, max = LABEL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Compact token count: 950, 41.2k, 3.4M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A running agent is any agent the runtime holds that is not switched off. */
function isRunning(agent: MenuBarAgent): boolean {
  return agent.state !== 'off' && agent.state !== 'not_participating'
}

const STATE_MARK: Partial<Record<AgentState, string>> = {
  active: '●',
  idle: '○',
  suspended: '◐',
  hibernate: '◌',
  error: '✕'
}

const STATE_WORD: Partial<Record<AgentState, string>> = {
  active: 'working',
  idle: 'idle',
  suspended: 'waiting',
  hibernate: 'hibernating',
  error: 'error'
}

function agentLabel(agent: MenuBarAgent): string {
  const parts = [STATE_WORD[agent.state] ?? agent.state]
  if (agent.activeLoops) parts.push(`${agent.activeLoops} loop${agent.activeLoops === 1 ? '' : 's'}`)
  if (agent.foreground) parts.push('open')
  return `${STATE_MARK[agent.state] ?? '○'}  ${truncate(agent.name, 40)} — ${parts.join(', ')}`
}

function pendingLabel(n: PendingNotification): string {
  const what = n.kind === 'ask'
    ? `asks: ${n.preview}`
    : `${n.toolName ?? 'tool'}: ${n.preview}`
  const loop = n.loop && n.loop !== 'main' ? ` (${n.loop})` : ''
  return truncate(`${n.agentName}${loop} — ${what}`)
}

function countPhrase(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export function buildMenuBarModel(snap: MenuBarSnapshot): MenuBarModel {
  const running = snap.agents
    .filter(isRunning)
    .sort((a, b) => Number(!!b.foreground) - Number(!!a.foreground) || a.name.localeCompare(b.name))
  const waiting = snap.pending.length

  const summary = [
    running.length ? `${countPhrase(running.length, 'agent')} running` : 'No agents running',
    ...(waiting ? [`${waiting} waiting on you`] : [])
  ].join(' · ')

  const items: MenuBarItem[] = [{ kind: 'info', label: `${snap.surface} — ${summary}` }]

  if (waiting) {
    items.push({ kind: 'separator' }, { kind: 'info', label: 'Waiting on you' })
    for (const n of snap.pending.slice(0, MENU_BAR_SECTION_MAX)) {
      items.push({
        kind: 'action',
        label: pendingLabel(n),
        toolTip: n.question ?? n.preview,
        action: { type: 'reveal', notification: n }
      })
    }
    if (waiting > MENU_BAR_SECTION_MAX) {
      // Oldest first, so the overflow opens the oldest one not listed.
      items.push({
        kind: 'action',
        label: `${waiting - MENU_BAR_SECTION_MAX} more…`,
        action: { type: 'reveal', notification: snap.pending[MENU_BAR_SECTION_MAX] }
      })
    }
  }

  if (running.length) {
    items.push({ kind: 'separator' }, { kind: 'info', label: 'Running' })
    for (const agent of running.slice(0, MENU_BAR_SECTION_MAX)) {
      items.push({
        kind: 'action',
        label: agentLabel(agent),
        toolTip: agent.filePath,
        action: { type: 'open-agent', filePath: agent.filePath }
      })
    }
    if (running.length > MENU_BAR_SECTION_MAX) {
      items.push({
        kind: 'action',
        label: `${running.length - MENU_BAR_SECTION_MAX} more…`,
        action: { type: 'show' }
      })
    }
  }

  const { input, output } = snap.tokensToday
  items.push(
    { kind: 'separator' },
    { kind: 'info', label: `Today: ${formatTokens(input)} tokens in · ${formatTokens(output)} out` },
    { kind: 'separator' },
    { kind: 'action', label: `Open ${snap.surface}`, action: { type: 'show' } },
    { kind: 'action', label: 'Settings…', action: { type: 'settings' } },
    { kind: 'separator' },
    { kind: 'action', label: `Quit ${snap.surface}`, action: { type: 'quit' } }
  )

  return {
    title: waiting ? String(waiting) : '',
    tooltip: `${snap.surface} — ${summary}`,
    items
  }
}
