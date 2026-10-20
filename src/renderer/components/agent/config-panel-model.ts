/**
 * Pure helpers behind the agent Config panel: the permission vocabulary,
 * tool-group gates, the tool filter, the approval-removal undo, MCP status
 * labels, the save status line and the Timers notice. No React, no store.
 */

import type { AgentConfig, McpServerStatus, ToolDeclaration, TriggersConfigV3 } from '../../../shared/types/adf-v02.types'

// ---------------------------------------------------------------------------
// Permission vocabulary. Labels and tooltips only: the config keys stay
// `restricted` (tools, MCP tools), `locked` / `locked_fields`, and
// `restricted_methods` / table `authorized` / `require_middleware_authorization`.
// ---------------------------------------------------------------------------

export type PermissionKind = 'approval' | 'locked' | 'restricted' | 'visible'

export const PERMISSION_LABELS: Record<PermissionKind, string> = {
  approval: 'Needs approval',
  locked: 'Locked',
  restricted: 'Restricted',
  visible: 'Visible',
}

export const PERMISSION_TIPS: Record<PermissionKind, string> = {
  approval: 'Needs approval: an agent call waits for human approval; authorized code calls it directly.',
  locked: "Locked: protected from the agent's own config edits.",
  restricted: 'Restricted: only authorized code can call it.',
  visible: 'Visible: shown in the active LLM tool list.',
}

/** Restricted, worded for the two cases that are not a call. */
export const RESTRICTED_TABLE_TIP = 'Restricted: only authorized code can write to it.'
export const RESTRICTED_MIDDLEWARE_TIP = 'Restricted: only middleware from authorized files runs.'

/** Table protection labels; the stored value `authorized` reads as Restricted. */
export function tableProtectionLabel(level: string): string {
  if (level === 'none') return 'No protection'
  if (level === 'append_only') return 'Append-only'
  if (level === 'authorized') return PERMISSION_LABELS.restricted
  return level
}

// ---------------------------------------------------------------------------
// Tool groups switched off by something outside the Tools section.
// ---------------------------------------------------------------------------

export interface ToolGroupGate {
  /** Shown inline under the group header. */
  text: string
  /** Config section title the jump link opens (pendingConfigSection). */
  section: string
}

/**
 * A tool group whose rows are set from another section. Only Inbox: its
 * tools follow the Messaging section's Inbox mode switch, which rewrites
 * their flags. Messaging (msg_send, agent_discover) is never gated here: the
 * On inbox message trigger only decides whether the agent wakes on a message,
 * and an agent that sends but never wakes on its inbox is a valid setup
 * (owner decision).
 */
export function toolGroupGate(groupLabel: string, config: Pick<AgentConfig, 'messaging'>): ToolGroupGate | null {
  if (groupLabel === 'Inbox' && config.messaging?.inbox_mode !== true) {
    return { text: 'Needs Inbox mode', section: 'Messaging' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tool filter.
// ---------------------------------------------------------------------------

/** Case-insensitive substring match on the tool name or its group label. */
export function toolMatchesFilter(toolName: string, groupLabel: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return toolName.toLowerCase().includes(q) || groupLabel.toLowerCase().includes(q)
}

// ---------------------------------------------------------------------------
// Approval-removal undo.
// ---------------------------------------------------------------------------

/** Names of tools that needed approval before and do not after. */
export function approvalRemoved(before: ToolDeclaration[], after: ToolDeclaration[]): string[] {
  const was = new Set(before.filter((t) => t.restricted).map((t) => t.name))
  return after.filter((t) => was.has(t.name) && !t.restricted).map((t) => t.name)
}

/** Put the approval gate back on `names`; every other field is left as it is now. */
export function restoreApproval(tools: ToolDeclaration[], names: string[]): ToolDeclaration[] {
  const set = new Set(names)
  return tools.map((t) => (set.has(t.name) && !t.restricted ? { ...t, restricted: true } : t))
}

export function approvalRemovedMessage(count: number): string {
  return `Approval removed from ${count} tool${count === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// MCP server status.
// ---------------------------------------------------------------------------

export type McpStatusTone = 'ok' | 'pending' | 'failed' | 'idle'

export function mcpStatusView(status: McpServerStatus | undefined): { label: string; tone: McpStatusTone } | null {
  switch (status) {
    case 'connected': return { label: 'Connected', tone: 'ok' }
    case 'connecting': return { label: 'Connecting', tone: 'pending' }
    case 'installing': return { label: 'Installing', tone: 'pending' }
    case 'needs_sign_in': return { label: 'Sign-in needed', tone: 'pending' }
    case 'error': return { label: 'Failed', tone: 'failed' }
    case 'stopped': return { label: 'Stopped', tone: 'idle' }
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Save status line.
// ---------------------------------------------------------------------------

export type ConfigSaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; error: string }

export function saveStatusText(status: ConfigSaveStatus): string {
  switch (status.kind) {
    case 'saving': return 'Saving…'
    case 'saved': return 'Saved'
    case 'error': return `Not saved: ${status.error}`
    default: return ''
  }
}

/** The reason a refused or failed save shows. */
export function saveFailureReason(answer: unknown): string {
  if (answer instanceof Error) return answer.message || 'The save failed'
  if (typeof answer === 'string' && answer) return answer
  const error = (answer as { error?: unknown } | null | undefined)?.error
  return typeof error === 'string' && error ? error : 'The save was refused'
}

// ---------------------------------------------------------------------------
// Timers.
// ---------------------------------------------------------------------------

/** True when the on_timer trigger is off, so no timer fires (trigger-evaluator gate). */
export function timersBlocked(config: Pick<AgentConfig, 'triggers'> | null | undefined): boolean {
  if (!config) return false
  return !(config.triggers as TriggersConfigV3 | undefined)?.on_timer?.enabled
}
