import React from 'react'

/**
 * Shared presentation helpers for tool calls — used by the loop rows, the
 * unified ToolCallModal, and the fleet map surfaces. Pure functions and
 * style tables only; no component state.
 */

/** Try to pretty-print JSON, otherwise return the raw string. */
export function formatToolOutput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Truncate a shell command for inline display in the loop. */
export function formatShellCommand(command?: string): string {
  if (!command) return ''
  return command.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
}

const TARGET_MAX_CHARS = 48

/** Keep the tail — for paths and URLs the end is the informative part. */
function keepTail(value: string): string {
  return value.length > TARGET_MAX_CHARS ? `…${value.slice(-(TARGET_MAX_CHARS - 1))}` : value
}

/** Keep the head — for SQL and shell commands the start is the informative part. */
function keepHead(value: string): string {
  return value.length > TARGET_MAX_CHARS ? `${value.slice(0, TARGET_MAX_CHARS - 1)}…` : value
}

/** The primary object a tool call operates on (file path, URL, key, …), for inline display. */
export function getToolTarget(name: string, input: Record<string, unknown> | null): string {
  if (!input) return ''
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  switch (name) {
    case 'fs_read':
    case 'fs_write':
    case 'fs_delete':
    case 'fs_transfer':
      return keepTail(str(input.path))
    case 'fs_list':
      return keepTail(str(input.prefix))
    case 'sys_fetch':
      return keepTail(str(input.url).replace(/^https?:\/\//, ''))
    case 'sys_lambda':
      return keepTail(str(input.source))
    case 'adf_shell':
      return keepHead(formatShellCommand(str(input.command)))
    case 'db_query':
    case 'db_execute':
      return keepHead(str(input.sql).replace(/\s+/g, ' '))
    case 'msg_send':
      return keepTail(str(input.recipient) || str(input.address))
    case 'sys_get_meta':
    case 'sys_set_meta':
    case 'sys_delete_meta':
      return keepTail(str(input.key))
    case 'sys_set_state':
      return str(input.state)
    case 'npm_install': {
      const name = str(input.name)
      const version = str(input.version)
      return keepTail(name && version ? `${name}@${version}` : name)
    }
    case 'npm_uninstall':
    case 'mcp_uninstall':
    case 'mcp_restart':
    case 'sys_create_adf':
      return keepTail(str(input.name))
    case 'mcp_install':
      return keepTail(str(input.name) || str(input.package) || str(input.url))
    case 'ws_connect':
      return keepTail(str(input.id) || str(input.url))
    case 'ws_send':
      return keepTail(str(input.connection_id))
    default:
      // MCP/unknown tools: surface the most common target-shaped fields.
      return keepTail(str(input.path) || str(input.url))
  }
}

export const TOOL_FALLBACK_LABELS: Record<string, string> = {
  adf_shell: 'Run command',
  agent_discover: 'Discover agents',
  fs_delete: 'Delete file',
  fs_list: 'List files',
  fs_read: 'Read file',
  fs_write: 'Write file',
  msg_list: 'Check messages',
  msg_read: 'Read messages',
  msg_send: 'Send message',
  msg_update: 'Update message',
  sys_code: 'Run code',
  sys_get_config: 'Inspect configuration',
  sys_get_meta: 'Check agent metadata',
  sys_list_timers: 'Check timers',
  sys_set_timer: 'Set timer',
  sys_update_config: 'Update configuration',
}

export type ToolFamily = 'read' | 'write' | 'message' | 'code' | 'system' | 'neutral'

export const TOOL_FAMILY_STYLES: Record<ToolFamily, { dot: string; rail: string; name: string }> = {
  read: {
    dot: 'bg-cyan-500/70 dark:bg-cyan-400/70',
    rail: 'border-cyan-500/40 dark:border-cyan-400/40',
    name: 'text-cyan-700/60 dark:text-cyan-300/60',
  },
  write: {
    dot: 'bg-violet-500/70 dark:bg-violet-400/70',
    rail: 'border-violet-500/40 dark:border-violet-400/40',
    name: 'text-violet-700/60 dark:text-violet-300/60',
  },
  message: {
    dot: 'bg-teal-500/70 dark:bg-teal-400/70',
    rail: 'border-teal-500/40 dark:border-teal-400/40',
    name: 'text-teal-700/60 dark:text-teal-300/60',
  },
  code: {
    dot: 'bg-fuchsia-500/70 dark:bg-fuchsia-400/70',
    rail: 'border-fuchsia-500/40 dark:border-fuchsia-400/40',
    name: 'text-fuchsia-700/60 dark:text-fuchsia-300/60',
  },
  system: {
    dot: 'bg-slate-500/70 dark:bg-slate-400/70',
    rail: 'border-slate-500/40 dark:border-slate-400/40',
    name: 'text-slate-600/65 dark:text-slate-300/60',
  },
  neutral: {
    dot: 'bg-neutral-400/70 dark:bg-neutral-500/80',
    rail: 'border-neutral-300/60 dark:border-neutral-600/60',
    name: 'text-neutral-400 dark:text-neutral-500',
  },
}

export const ATTENTION_TOOL_STYLE = {
  dot: 'bg-[var(--adf-ui-warning)]',
  rail: 'border-[color:var(--adf-ui-warning)]/60',
  name: 'text-[var(--adf-ui-warning)]',
}

export const ERROR_TOOL_STYLE = {
  dot: 'bg-red-500/80',
  rail: 'border-red-500/60',
  name: 'text-red-500/80 dark:text-red-400/80',
}

export function getToolFamily(name: string): ToolFamily {
  const normalized = name.toLowerCase()
  if (normalized === 'ask' || /^(msg|agent)[_-]/.test(normalized)) return 'message'
  if (normalized === 'adf_shell' || normalized === 'sys_code' || normalized === 'sys_lambda'
    || /(^|[_-])(code|shell|lambda|exec|execute)([_-]|$)/.test(normalized)) return 'code'
  if (normalized === 'sys_fetch' || normalized.startsWith('sys_fetch_')) return 'read'
  if (normalized.startsWith('sys_')) return 'system'
  if (normalized.startsWith('db_')) {
    return /(^|[_-])(read|get|list|query|select|search|find|inspect)([_-]|$)/.test(normalized) ? 'read' : 'write'
  }
  if (/(^|[_-])(write|update|create|delete|insert|upsert|patch|save|move|copy|rename|transfer)([_-]|$)/.test(normalized)) return 'write'
  if (/(^|[_-])(read|fetch|get|list|search|find|inspect|query|select|browse|open)([_-]|$)/.test(normalized)) return 'read'
  return 'neutral'
}

export function humanizeToolName(name: string): string {
  const mapped = TOOL_FALLBACK_LABELS[name]
  if (mapped) return mapped
  const words = name.replace(/^mcp[_-]/, '').replace(/[_-]+/g, ' ').trim()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : 'Working'
}

/** Parse shell tool JSON output into structured parts. */
export function parseShellOutput(raw: string): { exit_code: number; stdout: string; stderr: string } | null {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'exit_code' in parsed) {
      return {
        exit_code: parsed.exit_code ?? 0,
        stdout: parsed.stdout ?? '',
        stderr: parsed.stderr ?? '',
      }
    }
  } catch { /* not shell output */ }
  return null
}

/**
 * adf_shell always returns isError:false — failure is encoded in the JSON
 * payload's exit_code (126 disabled, 127 not found, 124 timeout, 1 generic,
 * parse errors as 1). Effective-error for shell calls is exit_code !== 0.
 */
export function isShellFailure(toolName: string, resultContent: string | null | undefined): boolean {
  if (toolName !== 'adf_shell' || !resultContent) return false
  const shell = parseShellOutput(resultContent)
  return shell !== null && shell.exit_code !== 0
}

/**
 * Simple syntax highlighter for code strings.
 * Produces React spans with Tailwind color classes.
 */
export function highlightCode(code: string): React.ReactNode {
  // Regex matches: line comments, block comments, strings, numbers, keywords
  const TOKEN =
    /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|import|export|from|default|try|catch|finally|throw|typeof|instanceof|void|null|undefined|true|false|async|await|yield|of|in)\b)/gm

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = TOKEN.exec(code)) !== null) {
    // Plain text before this token
    if (match.index > lastIndex) {
      parts.push(code.slice(lastIndex, match.index))
    }

    const [text, comment, blockComment, str, num, keyword] = match
    let cls = ''
    if (comment || blockComment) cls = 'text-neutral-400 dark:text-neutral-500 italic'
    else if (str) cls = 'text-green-600 dark:text-green-400'
    else if (num) cls = 'text-amber-600 dark:text-amber-400'
    else if (keyword) cls = 'text-blue-600 dark:text-blue-400 font-semibold'

    parts.push(
      <span key={match.index} className={cls}>
        {text}
      </span>
    )
    lastIndex = match.index + text.length
  }

  // Remaining plain text
  if (lastIndex < code.length) {
    parts.push(code.slice(lastIndex))
  }

  return parts
}

/** Is this string "rich" enough to deserve its own display block? */
export function isRichString(value: string): boolean {
  return value.includes('\n') || value.length > 80
}

/** Does this string look like code (vs. natural language)? */
export function looksLikeCode(value: string): boolean {
  if (!value.includes('\n')) return false
  // Simple heuristic: contains common code patterns
  return /[{};=()]/.test(value) || /^\s*(const|let|var|function|import|class|def |for |if |#include)\b/m.test(value)
}

/** Coarse duration for step blocks and headers: <1s, Ns, 1.5m, 1.2h. */
export function formatActivityDuration(durationMs: number): string {
  if (durationMs < 1000) return '<1s'
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  return `${(minutes / 60).toFixed(1)}h`
}

/** Per-call duration: millisecond precision under a second, coarse above. */
export function formatCallDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : formatActivityDuration(durationMs)
}
