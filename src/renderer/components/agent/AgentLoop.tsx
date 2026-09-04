import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAgentStore, selectLoopSlice, MAIN_LOOP, type AgentLogEntry, type PendingApprovalInfo } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAppStore, selectChatInCenter, selectChatColumnCapped, selectCanPromoteChat, type AppState } from '../../stores/app.store'
import { toDisplayState } from '../../hooks/useAgent'
import { nanoid } from 'nanoid'
import { renderMarkdownToSafeHtml } from '../../utils/markdown'
import { isAdfFileUrl, openAdfFileLink } from '../../utils/open-adf-link'
import { loopColor } from '../../utils/loop-color'
import { SKILLS_REGISTRY_PATH, parseSkillsRegistry } from '../../utils/skills-panel'
import {
  buildSlashCommands,
  completionText,
  composeSkillMessage,
  filterSlashCommands,
  isSlashInput,
  matchSlashCommand,
  needsArgument,
  parseSkillInterface,
  skillInterfacePath,
  slashQuery,
  BUILTIN_COMMANDS,
  type SlashCommand,
} from '../../utils/slash-commands'
import { Button } from '../ui'
import { ApprovalControls } from './ApprovalControls'
import { SlashCommandPalette } from './SlashCommandPalette'
import { ToolCallModal } from './ToolCallModal'
import {
  TOOL_FAMILY_STYLES,
  ATTENTION_TOOL_STYLE,
  ERROR_TOOL_STYLE,
  getToolFamily,
  getToolTarget,
  humanizeToolName,
  isShellFailure,
  formatShellCommand,
  formatActivityDuration,
  type ToolFamily,
} from './tool-presentation'
import type { ContentBlock } from '../../../shared/types/provider.types'

const MAX_INPUT_ROWS = 10
// Model-facing text for attachment-only messages; also shown in the UI so the
// optimistic entry matches what the loop table persists and restores.
const ATTACHMENT_ONLY_TEXT = 'Please review the attached media.'
const DEFAULT_MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  video: 20 * 1024 * 1024,
}

type UploadKind = 'image' | 'audio' | 'video' | 'file'

interface PendingAttachment {
  id: string
  name: string
  path: string
  mimeType: string
  size: number
  kind: UploadKind
  native: boolean
  referenceText?: string
  contentBlock?: ContentBlock
}

/** Copy-to-clipboard button for the error inspector modal header. */
function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => { /* clipboard unavailable */ })
      }}
      className="px-2 py-0.5 text-[11px] font-medium rounded-full shrink-0 border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
      title="Copy full error to clipboard"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function extractAskAnswer(content?: string | null): string | null {
  if (!content) return null
  const prefix = 'Human answered: '
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}

function sanitizeUploadName(name: string): string {
  return (name || 'upload')
    .replace(/[/\\]/g, '-')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    || 'upload'
}

function inferMimeType(file: File): string {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase()
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
  }
  return ext ? byExt[ext] ?? 'application/octet-stream' : 'application/octet-stream'
}

function uploadKind(mimeType: string): UploadKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  return 'file'
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function audioFormat(file: File, mimeType: string): string {
  if (mimeType.includes('mpeg')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  return file.name.split('.').pop()?.toLowerCase() || 'wav'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function attachmentReference(path: string, mimeType: string, size: number): string {
  return `[Uploaded file: ${path} (${mimeType}, ${formatBytes(size)}). Use fs_read with path "${path}" to inspect it.]`
}

function adfFileUrl(path: string): string {
  return `adf-file://${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Compact fallback for older tool calls that do not provide `_reason`. */
function summarizeToolInput(input: unknown): string {
  if (!input) return 'Called tool'
  try {
    const summary = JSON.stringify(input)
    return summary.length > 100 ? `${summary.slice(0, 100)}\u2026` : summary
  } catch {
    return 'Called tool'
  }
}

function getToolInputRecord(entry: AgentLogEntry): Record<string, unknown> | null {
  const input = entry.metadata?.input
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

function getToolReason(entry: AgentLogEntry): string {
  const rawReason = getToolInputRecord(entry)?._reason
  if (rawReason == null) return ''
  return (typeof rawReason === 'string' ? rawReason : String(rawReason)).trim()
}

const loopTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const loopDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const loopDateWithYearFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** Format a unix-ms timestamp without repeating date detail the user already knows. */
function formatLoopTime(ms: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const now = new Date()
  const time = loopTimeFormatter.format(date)
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (isToday) return time

  const datePart = date.getFullYear() === now.getFullYear()
    ? loopDateFormatter.format(date)
    : loopDateWithYearFormatter.format(date)
  return `${datePart}, ${time}`
}

/** Percent-encode spaces in adf-file:// URLs so markdown parsers don't break on them. */
function encodeAdfFileUrls(src: string): string {
  return src.replace(
    /adf-file:\/\/([^\s)>"'\]]+(?:\s[^\s)>"'\]]+)*)/g,
    (_match, path: string) => 'adf-file://' + path.replace(/ /g, '%20')
  )
}

// Parse and sanitize through the shared renderer (utils/markdown.ts), which owns
// the marked configuration and the DOMPurify allowlist for every untrusted
// document Studio paints. Only the adf-file:// pre-pass is the loop's own.
function renderMarkdown(src: string): string {
  return renderMarkdownToSafeHtml(encodeAdfFileUrls(src))
}

// Memoized markdown component to avoid re-parsing on every render
const MarkdownEntry = memo(({ content }: { content: string }) => {
  const html = useMemo(() => renderMarkdown(content), [content])
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return
    if (isAdfFileUrl(href)) {
      e.preventDefault()
      openAdfFileLink(href)
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      // Plain anchors would navigate the renderer in place, which main's
      // will-navigate guard blocks. Route through window.open so the
      // setWindowOpenHandler hands the URL to the OS browser instead.
      e.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }, [])
  return (
    <div
      className="px-1.5 py-1 loop-markdown text-neutral-800 dark:text-neutral-200"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  )
})

// Reasoning traces are mostly plain text, but reasoning summaries (OpenAI
// codex models) mark section headlines as **bold**. Render just that marker —
// full markdown would mangle arbitrary reasoning prose.
const ThinkingContent = memo(({ content }: { content: string }) => {
  const nodes = useMemo(
    () => content.split(/\*\*([^*\n]+)\*\*/g).map((seg, i) => (i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg)),
    [content]
  )
  return <div className="whitespace-pre-wrap">{nodes}</div>
})

// Memoized individual log entry renderer
const TRIGGER_LABELS: Record<string, string> = {
  document_edit: 'Doc Edit',
  message_received: 'Message Received',
  schedule: 'Timer Fired',
  inbox_notification: 'Inbox',
  autonomous_start: 'Auto Start',
  file_change: 'File Change',
  outbox: 'Outbox',
  tool_call: 'Tool Intercepted',
  task_complete: 'Task Complete'
}

const CONTEXT_LABELS: Record<string, string> = {
  system_prompt: 'System Prompt',
  dynamic_instructions: 'Dynamic Instructions',
  loop: 'Loop Message'
}

/**
 * A message delivered by another loop's `loop_send`. It arrives as a plain user
 * row (adf_loop has no metadata column) and is classified by its durable
 * `[from loop:<name>]` stamp — in `parseLoopToDisplay` on rehydrate and in
 * `useAgent`'s event router live, both producing this shape.
 */
function isLoopMessageEntry(entry: AgentLogEntry): boolean {
  return entry.type === 'context'
    && entry.metadata?.category === 'loop'
    && typeof entry.metadata?.fromLoop === 'string'
}

type ToolPair = { call: AgentLogEntry | null; result: AgentLogEntry | null }
type ToolPairIndex = Map<string, ToolPair>
type DisplayItem =
  | { kind: 'entry'; id: string; entry: AgentLogEntry }
  | { kind: 'activity'; id: string; entries: AgentLogEntry[] }

function buildToolPairIndex(log: AgentLogEntry[]): ToolPairIndex {
  const index: ToolPairIndex = new Map()
  const pendingCallsById = new Map<string, AgentLogEntry>()
  const pendingCallsByName = new Map<string, AgentLogEntry>()

  for (const entry of log) {
    if (entry.type === 'tool_call') {
      const toolId = entry.metadata?.tool_id as string | undefined
      if (toolId) pendingCallsById.set(toolId, entry)
      else pendingCallsByName.set(entry.metadata?.name as string, entry)
      continue
    }
    if (entry.type !== 'tool_result') continue

    const toolUseId = entry.metadata?.tool_use_id as string | undefined
    let call: AgentLogEntry | null = null
    if (toolUseId) {
      call = pendingCallsById.get(toolUseId) ?? null
      if (call) pendingCallsById.delete(toolUseId)
    }
    if (!call) {
      const name = entry.metadata?.name as string
      call = pendingCallsByName.get(name) ?? null
      if (call) pendingCallsByName.delete(name)
    }
    if (call) {
      const pair = { call, result: entry }
      index.set(call.id, pair)
      index.set(entry.id, pair)
    } else {
      index.set(entry.id, { call: null, result: entry })
    }
  }

  for (const call of [...pendingCallsById.values(), ...pendingCallsByName.values()]) {
    if (!index.has(call.id)) index.set(call.id, { call, result: null })
  }
  return index
}

function isSuccessfulStatusChange(entry: AgentLogEntry, toolPairs: ToolPairIndex): boolean {
  if (entry.type !== 'tool_call' || entry.metadata?.name !== 'sys_set_meta') return false
  const input = entry.metadata?.input as { key?: unknown; value?: unknown } | undefined
  return input?.key === 'status'
    && typeof input.value === 'string'
    && input.value.trim().length > 0
    && toolPairs.get(entry.id)?.result?.metadata?.isError === false
}

function isCollapsibleActivity(entry: AgentLogEntry, toolPairs: ToolPairIndex): boolean {
  // A delivered inter-loop message is content, not workflow noise — folding it
  // into an activity group under a tool-call label would hide it entirely.
  if (isLoopMessageEntry(entry)) return false
  if (entry.type === 'thinking' || entry.type === 'context' || entry.type === 'trigger') return true
  if (entry.type !== 'tool_call') return false
  const name = entry.metadata?.name as string | undefined
  if (name === 'say' || name === 'ask') return false
  return !isSuccessfulStatusChange(entry, toolPairs)
}

function buildDisplayItems(entries: AgentLogEntry[], toolPairs: ToolPairIndex): DisplayItem[] {
  const items: DisplayItem[] = []
  let activityEntries: AgentLogEntry[] = []

  const flushActivity = () => {
    if (activityEntries.length === 0) return
    if (activityEntries.length === 1) {
      // A one-step block is noise — show the step directly.
      items.push({ kind: 'entry', id: activityEntries[0].id, entry: activityEntries[0] })
    } else {
      items.push({ kind: 'activity', id: `activity:${activityEntries[0].id}`, entries: activityEntries })
    }
    activityEntries = []
  }

  for (const entry of entries) {
    if (isCollapsibleActivity(entry, toolPairs)) {
      activityEntries.push(entry)
    } else {
      flushActivity()
      items.push({ kind: 'entry', id: entry.id, entry })
    }
  }
  flushActivity()
  return items
}

const LOW_SIGNAL_ACTIVITY_TOOLS = new Set(['msg_update', 'sys_get_meta', 'sys_set_meta', 'sys_delete_meta'])

function getActivitySummary(entries: AgentLogEntry[]): { label: string; family: ToolFamily } {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type !== 'tool_call') continue
    const name = entry.metadata?.name as string | undefined
    if (!name || LOW_SIGNAL_ACTIVITY_TOOLS.has(name)) continue
    const reason = getToolReason(entry)
    if (reason) return { label: reason, family: getToolFamily(name) }
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.type !== 'tool_call') continue
    const reason = getToolReason(entry)
    const name = (entry.metadata?.name as string | undefined) ?? ''
    if (reason) return { label: reason, family: getToolFamily(name) }
  }

  const toolCalls = entries.filter((entry) => entry.type === 'tool_call')
  const usefulFallback = [...toolCalls].reverse().find((entry) => {
    const name = entry.metadata?.name as string | undefined
    return name && !LOW_SIGNAL_ACTIVITY_TOOLS.has(name)
  }) ?? toolCalls.at(-1)
  if (usefulFallback) {
    const name = (usefulFallback.metadata?.name as string | undefined) ?? ''
    return { label: humanizeToolName(name), family: getToolFamily(name) }
  }

  const lastEntry = entries.at(-1)
  if (lastEntry?.type === 'trigger') {
    return { label: TRIGGER_LABELS[lastEntry.metadata?.triggerType as string] ?? 'Trigger', family: 'neutral' }
  }
  if (lastEntry?.type === 'context') {
    return { label: CONTEXT_LABELS[lastEntry.metadata?.category as string] ?? 'Context', family: 'neutral' }
  }
  if (lastEntry?.type === 'thinking') return { label: 'Thinking', family: 'neutral' }
  return { label: 'Working', family: 'neutral' }
}

function isTurnCompleteMarker(entry: AgentLogEntry): boolean {
  return entry.type === 'system' && entry.content.trim().toLowerCase() === 'turn complete'
}

function getActivityDurationMs(entries: AgentLogEntry[], toolPairs: ToolPairIndex): number | null {
  let startedAt = Number.POSITIVE_INFINITY
  let completedAt = 0

  for (const entry of entries) {
    if (entry.timestamp > 0) startedAt = Math.min(startedAt, entry.timestamp)

    if (entry.type === 'tool_call') {
      const result = toolPairs.get(entry.id)?.result
      if (!result) return null
      completedAt = Math.max(completedAt, result.timestamp || entry.timestamp)
    } else {
      completedAt = Math.max(completedAt, entry.timestamp)
    }
  }

  if (!Number.isFinite(startedAt) || completedAt <= 0) return null
  return Math.max(0, completedAt - startedAt)
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** Milliseconds since `startedAt`, re-evaluated once a second while mounted. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return Math.max(0, now - startedAt)
}

const STILL_WORKING_AFTER_MS = 60_000

/**
 * The pinned "what is the agent doing right now" row between the stream and
 * the composer. It IS the live tail: the in-flight entry (a tool call still
 * awaiting its result, or streaming reasoning) is withheld from the stream
 * above and rendered only here, so the label never lags the thread. The timer
 * ticks in here, so a second passing re-renders this one row and never the
 * virtualised log. Mounted only while the loop is active/starting/blocked on
 * the human, so mount time doubles as the turn start when the log carries no
 * "turn complete" marker to anchor on.
 */
const AgentStatusStrip = memo(({ label, dotClass, entry, turnStartedAt, onOpen }: {
  label: string
  dotClass: string
  /** The withheld in-flight entry this row stands in for; null for a bare phase. */
  entry: AgentLogEntry | null
  turnStartedAt: number | null
  onOpen: (entry: AgentLogEntry) => void
}) => {
  const [mountedAt] = useState(() => Date.now())
  const elapsedMs = useElapsed(turnStartedAt ?? mountedAt)
  // Each new item glimmers at its own pace and from its own phase — a fresh
  // roll per entry (or per bare phase label) so consecutive steps don't read
  // as one continuous loop. Negative delay starts mid-cycle. Inline props
  // override the class's 2s default; reduced motion never animates at all.
  const shimmerKey = entry?.id ?? label
  const shimmerStyle = useMemo(() => {
    const duration = 1.6 + Math.random()
    const offset = Math.random() * duration
    return { animationDuration: `${duration.toFixed(2)}s`, animationDelay: `-${offset.toFixed(2)}s` }
  }, [shimmerKey])
  // Only a tool call has a detail view (the inspector already handles a call
  // with no result). Thinking lands in the thread as an expandable row once it
  // finishes; the bare phases have nothing to open.
  const clickable = entry?.type === 'tool_call'
  const handleOpen = () => { if (entry && clickable) onOpen(entry) }
  return (
    // Deliberately not a live region: the timer ticks every second and
    // would turn a screen reader into a metronome.
    <button
      type="button"
      disabled={!clickable}
      onClick={handleOpen}
      aria-label={clickable ? `Open details for ${label}` : undefined}
      title={clickable ? `Open details for ${label}` : label}
      className={`flex h-7 w-full shrink-0 items-center gap-1.5 rounded px-3 text-left text-xs text-neutral-500 transition-colors dark:text-neutral-400 ${
        clickable ? 'hover:bg-neutral-100/70 dark:hover:bg-neutral-800/60' : 'cursor-default'
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full motion-safe:animate-pulse ${dotClass}`} aria-hidden />
      <span className="adf-shimmer-text min-w-0 truncate font-medium" style={shimmerStyle}>{label}</span>
      <span className="ml-auto shrink-0 tabular-nums text-neutral-400 dark:text-neutral-500">
        {formatElapsed(elapsedMs)}
        {elapsedMs >= STILL_WORKING_AFTER_MS && <span> &middot; still working</span>}
      </span>
    </button>
  )
})

const LogEntryRow = memo(({
  entry,
  expandedThinking,
  onToggleThinking,
  expandedTriggers,
  onToggleTrigger,
  expandedContexts,
  onToggleContext,
  onToolClick,
  pendingApprovalRequestId,
  pendingApprovalMeta,
  onApprovalRespond,
  onAlwaysApprove,
  pendingAsk,
  isSuspendEntry,
  onSuspendRespond,
  toolResultIsError,
  toolResultImageUrl,
  askAnswer,
  compact = false
}: {
  entry: AgentLogEntry
  expandedThinking: Set<string>
  onToggleThinking: (id: string) => void
  expandedTriggers: Set<string>
  onToggleTrigger: (id: string) => void
  expandedContexts: Set<string>
  onToggleContext: (id: string) => void
  onToolClick: (entry: AgentLogEntry) => void
  pendingApprovalRequestId?: string
  pendingApprovalMeta?: PendingApprovalInfo
  onApprovalRespond?: (requestId: string, approved: boolean, feedback?: string) => void
  onAlwaysApprove?: (requestId: string, toolName: string) => void
  pendingAsk?: { requestId: string; question: string }
  isSuspendEntry?: boolean
  onSuspendRespond?: (resume: boolean) => void
  toolResultIsError?: boolean | null
  toolResultImageUrl?: string | null
  askAnswer?: string | null
  compact?: boolean
}) => {
  const toolName = (entry.metadata?.name as string | undefined) ?? 'tool'
  const toolInput = entry.metadata?.input
  const toolInputRecord = getToolInputRecord(entry)
  const toolReason = getToolReason(entry)
  const shellCommand = toolName === 'adf_shell'
    ? formatShellCommand(toolInputRecord?.command as string | undefined)
    : ''
  // Protection/lock approvals carry a plain-English consequence — prefer it as
  // the row title so the human reads WHAT they are approving, not the tool name.
  const approvalDescription = pendingApprovalMeta?.protection?.description
  const toolSummary = approvalDescription || toolReason || shellCommand || summarizeToolInput(toolInput)
  // Only shown alongside a reason — the no-reason fallback already surfaces the input.
  const toolTarget = !approvalDescription && toolReason ? getToolTarget(toolName, toolInputRecord) : ''
  const toolFamilyStyle = TOOL_FAMILY_STYLES[getToolFamily(toolName)]
  const toolAccent = toolResultIsError === true
    ? ERROR_TOOL_STYLE
    : pendingApprovalRequestId
      ? ATTENTION_TOOL_STYLE
      : toolFamilyStyle
  // Neutral steps stay transparent — a per-step left rail only appears when it
  // carries signal (an error, or a pending approval).
  const toolRail = toolResultIsError === true || pendingApprovalRequestId
    ? toolAccent.rail
    : 'border-transparent'
  // Terminal state for synthesized (outOfBand) approval entries — they never
  // get a paired tool_result (the gated call runs inside the shell/code that
  // raised the approval), so the human's decision is the entry's outcome.
  const overrideOutcome = entry.metadata?.overrideOutcome as 'approved' | 'denied' | undefined
  const statusValue = toolName === 'sys_set_meta' && toolInputRecord?.key === 'status' && typeof toolInputRecord.value === 'string'
    ? toolInputRecord.value.trim()
    : ''
  const showStatusChange = entry.type === 'tool_call' && statusValue.length > 0 && toolResultIsError === false

  return (
    <div className={`text-sm ${compact ? 'px-1' : 'px-3'}`}>
      {entry.type === 'user' && (
        <div className="flex flex-col items-end gap-0.5">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg border border-[var(--adf-ui-focus)] bg-[var(--adf-ui-accent-subtle)] px-3 py-2 text-[var(--adf-ui-text)]">
            {entry.content}
          </div>
          {Array.isArray(entry.metadata?.imagePreviewUrls) && entry.metadata.imagePreviewUrls.length > 0 && (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {(entry.metadata.imagePreviewUrls as string[]).map((url, index) => (
                <img
                  key={`${url}-${index}`}
                  src={url}
                  alt="uploaded image"
                  className="max-h-64 max-w-full rounded-lg border border-neutral-200 dark:border-neutral-700"
                />
              ))}
            </div>
          )}
          {entry.timestamp > 0 && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 mr-1">
              {formatLoopTime(entry.timestamp)}
            </span>
          )}
        </div>
      )}
      {entry.type === 'thinking' && (() => {
        const encrypted = entry.metadata?.encryptedReasoning === true
        const preserved = entry.metadata?.preservedReasoning === true
        const hasText = entry.content.trim().length > 0
        const outTokens = (entry.metadata?.tokens as { output?: number } | undefined)?.output
        return (
        <div className="overflow-hidden">
          <button
            onClick={() => onToggleThinking(entry.id)}
            className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100/70 dark:text-neutral-400 dark:hover:bg-neutral-700/30"
          >
            <span>Thinking{encrypted ? ' (encrypted)' : ''}</span>
            <span className="ml-auto flex items-center gap-2 text-neutral-400 dark:text-neutral-500">
              {hasText
                ? (outTokens ? `${outTokens.toLocaleString()} tokens` : `${Math.ceil(entry.content.length / 4)} tokens`)
                : (encrypted ? '\uD83D\uDD12 not human-readable' : `${outTokens ?? 0} tokens`)}
            </span>
          </button>
          {expandedThinking.has(entry.id) && (
            <div className="max-h-64 overflow-y-auto px-1 pb-2 pt-1 text-xs text-neutral-600 dark:text-neutral-300">
              {hasText && <ThinkingContent content={entry.content} />}
              {(encrypted || (preserved && !hasText)) && (
                <p className="mt-1 text-[10px] italic text-neutral-400 dark:text-neutral-500">
                  {encrypted
                    ? 'Encrypted reasoning \u2014 not human-readable. The provider returns only an opaque/signed block; it is retained and sent back to the model to preserve tool-call continuity.'
                    : 'Reasoning preserved for tool-call continuity. Displayed traces are provider-side summaries, not the full reasoning.'}
                </p>
              )}
            </div>
          )}
        </div>
        )
      })()}
      {entry.type === 'text' && (() => {
        // An assistant turn that ended with no content at all — the "end
        // quietly" pattern loop prompting encourages, and what a model that
        // spends its turn on reasoning alone produces. Rendered as a muted
        // one-liner rather than nothing: an invisible row makes a correct quiet
        // ending indistinguishable from a crash or a dropped stream.
        // Cheap emptiness test — trim() allocates a full copy of the (growing)
        // streamed string on every render, so this ran O(n²) over a turn (B15).
        if (entry.content.length === 0 || !/\S/.test(entry.content)) {
          return (
            <div className="px-1 py-1 text-[11px] italic leading-5 text-neutral-400 dark:text-neutral-500">
              ended quietly (no output)
              {entry.timestamp > 0 && (
                <span className="ml-1.5 not-italic">{formatLoopTime(entry.timestamp)}</span>
              )}
            </div>
          )
        }
        return (
          <div>
            <MarkdownEntry content={entry.content} />
            {entry.timestamp > 0 && (
              <div className="mt-0.5 px-1 text-[10px] text-neutral-400 dark:text-neutral-500">
                {formatLoopTime(entry.timestamp)}
              </div>
            )}
          </div>
        )
      })()}
      {entry.type === 'tool_call' && toolName === 'say' && (
        <div>
          <MarkdownEntry
            content={(entry.metadata?.input as { message?: string })?.message ?? entry.content}
          />
        </div>
      )}
      {showStatusChange && (
        <div className="px-1.5 py-1 font-mono text-[11px] leading-5 text-neutral-500 dark:text-neutral-500">
          {statusValue}
        </div>
      )}
      {entry.type === 'tool_call' && toolName !== 'say' && !showStatusChange && (
        <>
          <div
            className={`group cursor-pointer overflow-hidden rounded border-l transition-colors ${toolRail} ${
              pendingApprovalRequestId
                ? 'bg-[var(--adf-ui-warning-subtle)] text-[var(--adf-ui-warning)]'
                : toolResultIsError === true
                  ? 'bg-red-50/70 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30'
                  : 'hover:bg-neutral-100/70 dark:hover:bg-neutral-700/30'
            }`}
            onClick={() => onToolClick(entry)}
          >
            <div className="flex min-w-0 items-center gap-2 px-1 py-1">
              <span
                className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${
                  toolReason
                    ? 'font-normal text-neutral-700 dark:text-neutral-300'
                    : 'font-mono text-xs text-neutral-700 dark:text-neutral-300'
                }`}
                title={toolSummary}
              >
                {toolSummary}
              </span>
              {toolTarget && (
                <span
                  className="max-w-[40%] shrink-0 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500"
                  title={toolTarget}
                >
                  {toolTarget}
                </span>
              )}
              <span
                className={`max-w-[35%] shrink-0 truncate font-mono text-[10px] ${toolAccent.name}`}
                title={toolName}
              >
                {toolName}
              </span>
              {toolResultIsError === true && <span className="shrink-0 text-red-500" title="Error">&#x2718;</span>}
            </div>
            {!pendingApprovalRequestId && overrideOutcome && (
              <div className="px-1 pb-1">
                <span className={`text-[10px] font-medium ${
                  overrideOutcome === 'approved'
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-500 dark:text-red-400'
                }`}>
                  {overrideOutcome === 'approved' ? 'Approved — ran in the calling shell/code' : 'Denied'}
                </span>
              </div>
            )}
            {pendingApprovalRequestId && onApprovalRespond && (
              <div className="flex min-w-0 items-center justify-between gap-2 border-t border-[color:var(--adf-ui-warning)]/15 px-1 pb-1 pt-1">
                <span className="min-w-0 truncate text-[10px] font-medium text-[var(--adf-ui-warning)]">
                  Awaiting approval
                </span>
                <span className="shrink-0">
                  <ApprovalControls
                    compact
                    overlay
                    toolName={toolName}
                    onApprove={() => onApprovalRespond(pendingApprovalRequestId, true)}
                    onAlwaysApprove={() => onAlwaysApprove?.(pendingApprovalRequestId, toolName)}
                    onReject={(feedback) => onApprovalRespond(pendingApprovalRequestId, false, feedback)}
                    alwaysApproveDisabled={pendingApprovalMeta?.canAlwaysApprove === false}
                    alwaysApproveDisabledReason={pendingApprovalMeta?.alwaysApproveBlockedReason}
                  />
                </span>
              </div>
            )}
          </div>
          {entry.metadata?.name === 'ask' && (entry.metadata?.input as { question?: string })?.question && (
            <div className="mt-1 border border-blue-400 dark:border-blue-600 rounded-lg overflow-hidden">
              <div className="p-2.5">
                <div className="text-[10px] font-semibold uppercase text-blue-500 dark:text-blue-400 mb-1">
                  Agent asked
                </div>
                <div className="text-sm text-blue-700 dark:text-blue-300 whitespace-pre-wrap">
                  {(entry.metadata.input as { question: string }).question}
                </div>
              </div>
              {askAnswer && (
                <div className="border-t border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10 p-2.5">
                  <div className="text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400 mb-1">
                    User response
                  </div>
                  <div className="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">
                    {askAnswer}
                  </div>
                </div>
              )}
              {pendingAsk && !askAnswer && (
                <div className="border-t border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-900/10 px-2.5 py-1.5 text-xs text-blue-600 dark:text-blue-300">
                  Awaiting response
                </div>
              )}
            </div>
          )}
          {entry.metadata?.name !== 'ask' && toolResultImageUrl && (
            <div className="mt-1">
              <img
                src={toolResultImageUrl}
                alt={(entry.metadata?.input as { path?: string })?.path ?? 'image'}
                className="max-w-full max-h-64 rounded-lg border border-neutral-200 dark:border-neutral-700"
              />
            </div>
          )}
        </>
      )}
      {/* tool_result entries are merged into their tool_call block above */}
      {entry.type === 'error' && (
        <div
          className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2 text-red-700 dark:text-red-400 text-xs cursor-pointer transition-colors hover:bg-red-100 dark:hover:bg-red-900/30"
          onClick={() => onToolClick(entry)}
          title="Click for full error details"
        >
          {entry.content}
        </div>
      )}
      {entry.type === 'trigger' && (() => {
        const triggerType = (entry.metadata?.triggerType as string) ?? 'unknown'
        const label = TRIGGER_LABELS[triggerType] ?? 'Trigger'
        const isExpanded = expandedTriggers.has(entry.id)
        return (
          <div className="overflow-hidden">
            <button
              onClick={() => onToggleTrigger(entry.id)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100/70 dark:text-neutral-400 dark:hover:bg-neutral-700/30"
            >
              <span>{label}</span>
              {entry.timestamp > 0 && (
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto">
                  {formatLoopTime(entry.timestamp)}
                </span>
              )}
            </button>
            {isExpanded && (
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-1 pb-2 pt-1 text-xs text-neutral-600 dark:text-neutral-300">
                {entry.content}
              </div>
            )}
          </div>
        )
      })()}
      {isLoopMessageEntry(entry) && (() => {
        // Inter-loop delivery. Same card as an inter-agent message — an inbound
        // message from another cognition stream, explicitly not owner input.
        // The rail + label carry the SENDER's identity colour, so main's thread
        // (where deliveries from every inner loop land) is readable at a glance.
        const fromLoop = entry.metadata?.fromLoop as string
        const sender = loopColor(fromLoop)
        return (
        // Sides are coloured individually on purpose: a blanket `border-neutral-*`
        // also sets border-left-color, and which of the two wins would then
        // depend on Tailwind's emit order rather than on intent.
        <div className={`rounded-md border-y border-r border-l-[3px] border-y-neutral-200 border-r-neutral-200 bg-neutral-50/60 p-1.5 dark:border-y-neutral-700 dark:border-r-neutral-700 dark:bg-neutral-800/35 ${sender.rail}`}>
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`text-[10px] font-semibold ${sender.label}`}>
              {`from loop:${fromLoop}`}
            </span>
            {entry.timestamp > 0 && (
              <span className="ml-auto text-[10px] text-neutral-400 dark:text-neutral-500">
                {formatLoopTime(entry.timestamp)}
              </span>
            )}
          </div>
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-neutral-700 dark:text-neutral-300">
            {entry.content}
          </div>
        </div>
        )
      })()}
      {entry.type === 'context' && !isLoopMessageEntry(entry) && (() => {
        const category = (entry.metadata?.category as string) ?? 'unknown'
        const label = CONTEXT_LABELS[category] ?? 'Context Injected'
        const isExpanded = expandedContexts.has(entry.id)
        return (
          <div className="overflow-hidden">
            <button
              onClick={() => onToggleContext(entry.id)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-neutral-500 transition-colors hover:bg-neutral-100/70 dark:text-neutral-400 dark:hover:bg-neutral-700/30"
            >
              <span>{label}</span>
              <span className="text-neutral-400 dark:text-neutral-500 ml-auto">
                {`~${Math.ceil(entry.content.length / 4).toLocaleString()} tokens`}
              </span>
            </button>
            {isExpanded && (
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-1 pb-2 pt-1 text-xs text-neutral-600 dark:text-neutral-300">
                {entry.content}
              </div>
            )}
          </div>
        )
      })()}
      {entry.type === 'compaction' && (
        <div className="border border-dashed border-neutral-300 dark:border-neutral-600 bg-neutral-100 dark:bg-neutral-800/60 rounded-lg p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500 inline-block" />
              <span className="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                Loop compacted{entry.metadata?.audited ? <> &middot; Prior context audited</> : null}
              </span>
            </div>
            {entry.timestamp > 0 && (
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {formatLoopTime(entry.timestamp)}
              </span>
            )}
          </div>
          <div className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap break-words">
            {entry.content}
          </div>
        </div>
      )}
      {entry.type === 'system' && entry.metadata?.isAsk && (
        <div className="border border-blue-400 dark:border-blue-600 rounded-lg overflow-hidden">
          <div className="p-2.5">
            <div className="text-[10px] font-semibold uppercase text-blue-500 dark:text-blue-400 mb-1">
              Agent asked
            </div>
            <div className="text-sm text-blue-700 dark:text-blue-300 whitespace-pre-wrap">
              {entry.content}
            </div>
          </div>
          {askAnswer && (
            <div className="border-t border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10 p-2.5">
              <div className="text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400 mb-1">
                User response
              </div>
              <div className="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">
                {askAnswer}
              </div>
            </div>
          )}
          {pendingAsk && !askAnswer && (
            <div className="border-t border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-900/10 px-2.5 py-1.5 text-xs text-blue-600 dark:text-blue-300">
              Awaiting response
            </div>
          )}
        </div>
      )}
      {entry.type === 'system' && !isSuspendEntry && !entry.metadata?.isAsk && (
        <div className="text-xs text-neutral-400 dark:text-neutral-500 text-center">
          {entry.content}
        </div>
      )}
      {entry.type === 'system' && isSuspendEntry && onSuspendRespond && (
        <div className="space-y-2 rounded-[var(--adf-ui-dialog-radius)] border border-[var(--adf-ui-warning)]/35 bg-[var(--adf-ui-warning-subtle)] p-3">
          <div className="text-xs font-semibold text-[var(--adf-ui-warning)]">Agent Suspended</div>
          <div className="text-sm text-[var(--adf-ui-text)]">
            The agent has reached its maximum active turns limit and has been paused.
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => onSuspendRespond(true)}
              size="compact"
              variant="primary"
            >
              Resume
            </Button>
            <Button
              onClick={() => onSuspendRespond(false)}
              size="compact"
              variant="danger"
            >
              Shut Down
            </Button>
          </div>
        </div>
      )}
      {entry.type === 'inter_agent' && (() => {
        const direction = entry.metadata?.direction as string
        const fromAgent = entry.metadata?.fromAgent as string
        const toAgent = entry.metadata?.toAgent as string
        const channel = entry.metadata?.channel as string
        const isIncoming = direction === 'incoming'
        return (
          <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-2.5 dark:border-neutral-700 dark:bg-neutral-800/35">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400">
                {isIncoming ? `From: ${fromAgent}` : `To: ${toAgent}`}
              </span>
              {channel && (
                <span className="rounded-full bg-neutral-200/70 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:bg-neutral-700/70 dark:text-neutral-400">
                  {channel}
                </span>
              )}
            </div>
            <div className="whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-300">
              {entry.content}
            </div>
          </div>
        )
      })()}
    </div>
  )
})

/**
 * One loop's stream + composer. `loop` selects the store slice AND the target
 * of every send, so main's tab is byte-for-byte the pre-loops behaviour and a
 * side loop's tab is fully isolated from it.
 */
function LoopStream({ loop }: { loop: string }) {
  const isMainLoop = loop === MAIN_LOOP
  const filePath = useDocumentStore((s) => s.filePath)
  const draftInputs = useDocumentStore((s) => s.draftInputs)
  const setDraftInput = useDocumentStore((s) => s.setDraftInput)
  // Each loop tab keeps its own composer draft.
  const draftKey = filePath ? (isMainLoop ? filePath : `${filePath}#loop:${loop}`) : null
  const input = draftKey ? (draftInputs[draftKey] ?? '') : ''
  const setInput = useCallback((value: string) => {
    if (draftKey) setDraftInput(draftKey, value)
  }, [draftKey, setDraftInput])
  const log = useAgentStore((s) => selectLoopSlice(s, loop).log)
  const logVersion = useAgentStore((s) => selectLoopSlice(s, loop).logVersion)
  const earlierCount = useAgentStore((s) => selectLoopSlice(s, loop).earlierCount)
  const prependLog = useAgentStore((s) => s.prependLog)
  const setEarlierCount = useAgentStore((s) => s.setEarlierCount)
  const state = useAgentStore((s) => selectLoopSlice(s, loop).state)
  /** Agent-level state (= main's, §6.3) — governs the off/start gate for every tab. */
  const agentState = useAgentStore((s) => s.state)
  const pendingApprovals = useAgentStore((s) => selectLoopSlice(s, loop).pendingApprovals)
  const removePendingApproval = useAgentStore((s) => s.removePendingApproval)
  const markApprovalOutcome = useAgentStore((s) => s.markApprovalOutcome)
  const pendingAsks = useAgentStore((s) => selectLoopSlice(s, loop).pendingAsks)
  const removePendingAsk = useAgentStore((s) => s.removePendingAsk)
  const updateEntryAt = useAgentStore((s) => s.updateEntryAt)
  const pendingSuspend = useAgentStore((s) => selectLoopSlice(s, loop).pendingSuspend)
  const setPendingSuspend = useAgentStore((s) => s.setPendingSuspend)
  const messageQueue = useAgentStore((s) => selectLoopSlice(s, loop).messageQueue)
  const addToQueue = useAgentStore((s) => s.addToQueue)
  const removeFromQueue = useAgentStore((s) => s.removeFromQueue)
  const setLog = useAgentStore((s) => s.setLog)
  const config = useAgentStore((s) => s.config)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [expandedTriggers, setExpandedTriggers] = useState<Set<string>>(new Set())
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(new Set())
  const [inspectedToolCall, setInspectedToolCall] = useState<AgentLogEntry | null>(null)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [draggingOverInput, setDraggingOverInput] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const starting = useAppStore((s) => filePath ? s.startingFilePaths.has(filePath) : false)
  // Center stage with both side panels collapsed spans the whole window; the
  // `comfortable` default caps the stream + composer to a reading column. The
  // cap is a width on an inner wrapper, not on the scroller, so the scrollbar
  // stays at the panel edge and code blocks keep their own overflow scroll.
  const capColumn = useAppStore(selectChatColumnCapped)
  const columnClass = capColumn ? 'mx-auto w-full max-w-4xl' : 'w-full'
  // This loop's identity colour — used for the composer focus ring so the
  // thread you are typing into is identifiable without reading the tab strip.
  const loopStyle = loopColor(loop)

  const handleApprovalRespond = useCallback((requestId: string, approved: boolean, feedback?: string) => {
    window.adfApi?.respondToolApproval(requestId, approved, feedback)
    // Find the logEntryId for this requestId and remove it. The removal here
    // races ahead of the tool_approval_resolved round-trip, so the outOfBand
    // outcome stamp must happen here too — the event handler will find nothing.
    for (const [logEntryId, info] of pendingApprovals.entries()) {
      if (info.requestId === requestId) {
        markApprovalOutcome(logEntryId, approved, loop)
        removePendingApproval(logEntryId, loop)
        break
      }
    }
  }, [pendingApprovals, removePendingApproval, markApprovalOutcome, loop])

  // "Always approve" — server-side: the main process drops the HIL gate on the
  // tool (enabled, un-restricted), persists + propagates the config, then
  // approves the pending request. Refused there when the declaration is locked
  // or the approval is a protection override; on refusal the request stays
  // pending so the user can still Approve once.
  const handleAlwaysApprove = useCallback((requestId: string, toolName: string) => {
    void window.adfApi?.alwaysApproveTool(requestId, toolName).then((result) => {
      if (result && !result.success) {
        console.warn(`[AgentLoop] Always approve refused for ${toolName}: ${result.error}`)
        return
      }
      for (const [logEntryId, info] of selectLoopSlice(useAgentStore.getState(), loop).pendingApprovals.entries()) {
        if (info.requestId === requestId) {
          useAgentStore.getState().markApprovalOutcome(logEntryId, true, loop)
          removePendingApproval(logEntryId, loop)
          break
        }
      }
    })
  }, [removePendingApproval, loop])

  const handleAskRespond = useCallback((logEntryId: string, requestId: string, answer: string) => {
    window.adfApi?.respondAsk(requestId, answer)
    const idx = log.findIndex((entry) => entry.id === logEntryId)
    if (idx >= 0) {
      updateEntryAt(idx, (entry) => {
        entry.metadata = {
          ...entry.metadata,
          askAnswer: answer
        }
      }, loop)
    }
    removePendingAsk(logEntryId, loop)
  }, [log, removePendingAsk, updateEntryAt, loop])

  const handleSuspendRespond = useCallback((resume: boolean) => {
    window.adfApi?.respondSuspend(resume)
    setPendingSuspend(null, loop)
  }, [setPendingSuspend, loop])

  // Track whether user is at the bottom of the scroll container
  const isAtBottom = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  // Whether the user has scrolled up to the top of the loaded window — the
  // earlier-entries boundary banner only shows there.
  const [atTop, setAtTop] = useState(false)

  // Virtual scrolling setup
  // Filter out tool_result entries — their content is accessible via the tool_call inspector
  const displayLog = useMemo(
    () => log.filter((entry) => entry.type !== 'tool_result' && !isTurnCompleteMarker(entry)),
    [log, logVersion]
  )
  const toolPairIndex = useMemo(() => buildToolPairIndex(log), [log.length, logVersion])
  const isActive = state === 'active'

  // The in-flight tail: a collapsible step (tool call / thinking) the agent is
  // still on. While the loop is active it is withheld from the stream and
  // shown only in the pinned status strip, so the strip IS the live tail
  // rather than a verb lagging one row behind it. It slots back into the
  // thread the moment the next entry lands (its result, the next call, text…)
  // or the turn ends. Never withheld when it carries a pending approval/ask —
  // the approval card must stay reachable in the thread (the strip then reads
  // "Waiting for you"). `say`/`ask`/status-change calls are content rows, not
  // workflow steps, so they are never withheld either.
  const inFlightEntry = useMemo((): AgentLogEntry | null => {
    if (!isActive) return null
    const tail = displayLog.at(-1)
    if (!tail || !isCollapsibleActivity(tail, toolPairIndex)) return null
    if (pendingApprovals.has(tail.id) || pendingAsks.has(tail.id)) return null
    if (tail.type === 'tool_call') return toolPairIndex.get(tail.id)?.result ? null : tail
    // Streaming reasoning is always the raw log tail (useAgent merges deltas
    // into a tail `thinking` entry only) — once anything follows it, it is done.
    if (tail.type === 'thinking') return log.at(-1)?.id === tail.id ? tail : null
    return null
  }, [isActive, displayLog, log, logVersion, toolPairIndex, pendingApprovals, pendingAsks])
  // Filtered BEFORE grouping so the withheld entry never joins an activity
  // group early. Group ids key on the group's FIRST entry, so the tail joining
  // its group later keeps the row key stable; a lone step that later gains a
  // sibling changes key (entry id → activity:id) exactly as it always did.
  const visibleLog = useMemo(
    () => (inFlightEntry ? displayLog.slice(0, -1) : displayLog),
    [displayLog, inFlightEntry]
  )
  const displayItems = useMemo(
    () => buildDisplayItems(visibleLog, toolPairIndex),
    [visibleLog, toolPairIndex]
  )
  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(new Set())
  const [collapsedActivityGroups, setCollapsedActivityGroups] = useState<Set<string>>(new Set())
  const lastActivityIndex = useMemo(() => {
    for (let index = displayItems.length - 1; index >= 0; index--) {
      if (displayItems[index].kind === 'activity') return index
    }
    return -1
  }, [displayItems])

  const getVirtualItemKey = useCallback(
    (index: number) => displayItems[index]?.id ?? index,
    [displayItems]
  )

  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    getItemKey: getVirtualItemKey,
    overscan: 8,
    // NOTE: do not enable useAnimationFrameWithResizeObserver here. Deferring
    // measurement to rAF lets streamed entries regroup (shift data-index)
    // between the ResizeObserver snapshot and the measurement, so sizes get
    // written under the wrong item key — rows then overlap permanently.
  })

  // Width toggle (comfortable ↔ full) reflows the column, so every row's height
  // changes. The stream no longer remounts on a width change (B5), so nudge the
  // virtualiser to re-measure — otherwise rows keep their old estimated sizes
  // and overlap. The per-row measureElement ResizeObserver catches visible rows;
  // measure() also refreshes the ones scrolled out of view.
  useEffect(() => {
    virtualizer.measure()
  }, [capColumn, virtualizer])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    isAtBottom.current = atBottom
    if (atBottom) setShowScrollBtn(false)
    setAtTop(el.scrollTop < 40)
  }, [])

  // The active (first, in log order) pending approval. Auto-scroll keys on its
  // requestId so we only move the viewport when a NEW approval becomes active
  // (one resolves, the next takes its place) — never on unrelated re-renders,
  // so we don't fight a user who has scrolled away.
  const activeApproval = useMemo(() => {
    for (const entry of displayLog) {
      const info = pendingApprovals.get(entry.id)
      if (info) return { logEntryId: entry.id, requestId: info.requestId }
    }
    return null
  }, [displayLog, pendingApprovals])

  const lastScrolledApprovalRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!activeApproval) {
      lastScrolledApprovalRef.current = undefined
      return
    }
    if (lastScrolledApprovalRef.current === activeApproval.requestId) return
    lastScrolledApprovalRef.current = activeApproval.requestId
    const index = displayItems.findIndex((item) =>
      item.kind === 'entry'
        ? item.entry.id === activeApproval.logEntryId
        : item.entries.some((e) => e.id === activeApproval.logEntryId)
    )
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
  }, [activeApproval, displayItems, virtualizer])

  // Batched approvals fatigue the user one-by-one. "Approve all" resolves every
  // pending GATED (restricted) approval at once; protection/lock overrides are
  // excluded server-side and still require individual review.
  const gatedPendingCount = useMemo(() => {
    let count = 0
    for (const info of pendingApprovals.values()) {
      if (info.reason === 'restricted') count++
    }
    return count
  }, [pendingApprovals])

  const [approveAllNote, setApproveAllNote] = useState<string | null>(null)
  const handleApproveAllGated = useCallback(() => {
    // Snapshot the gated request rows so we can clear them optimistically; main
    // enforces the never-protection filter and also emits resolved events.
    const gatedLogIds: string[] = []
    for (const [logEntryId, info] of selectLoopSlice(useAgentStore.getState(), loop).pendingApprovals.entries()) {
      if (info.reason === 'restricted') gatedLogIds.push(logEntryId)
    }
    void window.adfApi?.approveAllGatedTools().then((result) => {
      if (!result?.success) return
      for (const logEntryId of gatedLogIds) removePendingApproval(logEntryId, loop)
      const remaining = result.skippedProtection ?? 0
      const approved = result.approved ?? gatedLogIds.length
      setApproveAllNote(
        remaining > 0
          ? `Approved ${approved} tool call${approved === 1 ? '' : 's'} — ${remaining} protection override${remaining === 1 ? '' : 's'} still need your review`
          : null
      )
    })
  }, [removePendingApproval, loop])

  // Clear the post-batch note once every remaining approval is resolved.
  useEffect(() => {
    if (pendingApprovals.size === 0 && approveAllNote) setApproveAllNote(null)
  }, [pendingApprovals, approveAllNote])

  // Side-loop streams are not part of the initial `getBatch()` payload (that
  // one carries main's loop only), so hydrate this tab's history the first time
  // it is opened. Main is already loaded by useAdfFile — never re-fetch it.
  const [sideLoopLoaded, setSideLoopLoaded] = useState(isMainLoop)
  useEffect(() => {
    if (isMainLoop || sideLoopLoaded) return
    let cancelled = false
    void Promise.resolve(window.adfApi?.getChat(loop))
      .then((result) => {
        if (cancelled) return
        const history = result?.chatHistory
        if (history?.uiLog?.length) {
          setLog(history.uiLog as AgentLogEntry[], history.earlierCount ?? 0, loop)
        }
      })
      .catch(() => { /* stream unavailable — the tab just starts empty */ })
      .finally(() => { if (!cancelled) setSideLoopLoaded(true) })
    return () => { cancelled = true }
  }, [isMainLoop, sideLoopLoaded, loop, setLog])

  // Scroll to bottom on mount (component remounts per-agent via key prop)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        // Short logs can't scroll — the top boundary is already visible
        setAtTop(scrollRef.current.scrollTop < 40)
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (scrollRef.current) {
      if (isAtBottom.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      } else {
        setShowScrollBtn(true)
      }
    }
  }, [logVersion])

  // Keep the tail visible while pinned.
  // The logVersion effect above scrolls synchronously, but rows use
  // estimateSize 60 and are only measured by ResizeObserver afterwards — when
  // measured sizes exceed the estimate, getTotalSize() grows after the scroll
  // and pushes the tail under the fold. Re-pin whenever the total changes, but
  // only if the user was already at the bottom (never fight a scrolled-up user).
  const virtualTotalSize = virtualizer.getTotalSize()
  useEffect(() => {
    const el = scrollRef.current
    if (el && isAtBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [virtualTotalSize])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
    setShowScrollBtn(false)
  }, [])

  // Auto-resize textarea to fit content, up to MAX_INPUT_ROWS lines
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20
    const maxHeight = lineHeight * MAX_INPUT_ROWS
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [input, resizeTextarea])

  const addLogEntry = useAgentStore((s) => s.addLogEntry)

  const setState = useAgentStore((s) => s.setState)
  const setSessionId = useAgentStore((s) => s.setSessionId)

  const mediaSupport = useMemo(() => ({
    image: config?.model.multimodal?.image ?? config?.model.vision ?? false,
    audio: config?.model.multimodal?.audio ?? false,
    video: config?.model.multimodal?.video ?? false,
  }), [config])

  const mediaLimits = useMemo(() => ({
    image: config?.limits?.max_image_size_bytes ?? DEFAULT_MEDIA_LIMITS.image,
    audio: config?.limits?.max_audio_size_bytes ?? DEFAULT_MEDIA_LIMITS.audio,
    video: config?.limits?.max_video_size_bytes ?? DEFAULT_MEDIA_LIMITS.video,
  }), [config])

  // Side loops are addressed as `agent:loop` (e.g. "aom:reflection") so the
  // composer placeholder names who actually receives the message.
  const agentName = isMainLoop
    ? (config?.name?.trim() || 'the agent')
    : `${config?.name?.trim() || 'agent'}:${loop}`

  // --- `/` command palette (design doc §5) --------------------------------
  //
  // Built-ins run a Studio/runtime action directly; skill commands only ever
  // compose a message and hand it to the ordinary send path. Nothing here
  // executes skill text — the catalog is read as data and painted as labels.
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(() => [...BUILTIN_COMMANDS])
  const [slashActive, setSlashActive] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)

  // Answering the agent's `ask` is prose, never a command.
  const askPending = pendingAsks.size > 0

  // --- Pinned status strip -------------------------------------------------
  //
  // Awaiting approval/ask maps to the `suspended` display state, so the strip
  // also stays up while the agent is blocked on the human — that is the one
  // phase where the verb ("Waiting for you") matters most.
  const waitingForUser = !!activeApproval || askPending
  const showStatusStrip = isActive || starting || waitingForUser

  // Strip content. Precedence: starting → blocked on the human → the withheld
  // in-flight entry, labelled exactly as an activity-group header would label
  // it (reason / humanised tool name with the family dot; "Thinking") →
  // "Working" (nothing withheld — e.g. assistant text streaming into the
  // thread, which needs no verb of its own).
  const statusPhase = useMemo((): { label: string; dotClass: string; entry: AgentLogEntry | null } | null => {
    if (!showStatusStrip) return null
    if (starting) return { label: 'Starting agent', dotClass: TOOL_FAMILY_STYLES.neutral.dot, entry: null }
    if (waitingForUser) return { label: 'Waiting for you', dotClass: ATTENTION_TOOL_STYLE.dot, entry: null }
    if (inFlightEntry) {
      const summary = getActivitySummary([inFlightEntry])
      return { label: summary.label, dotClass: TOOL_FAMILY_STYLES[summary.family].dot, entry: inFlightEntry }
    }
    return { label: 'Working', dotClass: TOOL_FAMILY_STYLES.neutral.dot, entry: null }
  }, [showStatusStrip, starting, waitingForUser, inFlightEntry])

  // When the current turn began: the first stamped entry after the last
  // "turn complete" marker. Null when there is no marker (fresh loop, or a
  // window that starts mid-turn) — the strip then counts from its own mount,
  // which is the moment the agent went active.
  const turnStartedAt = useMemo((): number | null => {
    if (!showStatusStrip) return null
    for (let index = log.length - 1; index >= 0; index--) {
      if (!isTurnCompleteMarker(log[index])) continue
      for (let next = index + 1; next < log.length; next++) {
        if (log[next].timestamp > 0) return log[next].timestamp
      }
      return null
    }
    return null
  }, [showStatusStrip, log, logVersion])
  const slashOpen = !askPending && !slashDismissed && isSlashInput(input)
  const slashRows = useMemo(
    () => (slashOpen ? filterSlashCommands(slashCommands, slashQuery(input)) : []),
    [slashOpen, slashCommands, input]
  )
  const slashIndex = slashRows.length > 0 ? Math.min(slashActive, slashRows.length - 1) : 0

  // Editing re-arms the palette: Escape hides it only until the next keystroke.
  useEffect(() => {
    setSlashActive(0)
    setSlashDismissed(false)
  }, [input])

  // The catalog belongs to the open agent, so it is re-read on every open
  // rather than cached — the indexer rewrites it whenever skills/ changes.
  useEffect(() => {
    setSlashCommands([...BUILTIN_COMMANDS])
  }, [filePath])
  useEffect(() => {
    if (!slashOpen) return
    let cancelled = false
    void (async () => {
      try {
        const file = await window.adfApi?.readInternalFile(SKILLS_REGISTRY_PATH)
        if (cancelled || file?.binary) return
        setSlashCommands(buildSlashCommands(parseSkillsRegistry(file?.content)?.entries ?? []))
      } catch { /* no catalog: the built-ins still work */ }
    })()
    return () => { cancelled = true }
  }, [slashOpen, filePath])

  /** Local, display-only feedback for a command. Never reaches the model. */
  const say = useCallback((text: string) => {
    addLogEntry({ id: nanoid(), type: 'system', content: text, timestamp: Date.now() })
  }, [addLogEntry])

  const buildAttachment = useCallback(async (file: File): Promise<PendingAttachment | null> => {
    const mimeType = inferMimeType(file)
    const kind = uploadKind(mimeType)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const uploadPath = `loop-upload/${Date.now()}-${nanoid(6)}/${sanitizeUploadName(file.name)}`
    const result = await window.adfApi?.uploadFile(uploadPath, Array.from(bytes), mimeType)
    if (!result?.success) return null

    const supportedNative = kind !== 'file' && mediaSupport[kind]
    const withinLimit = kind !== 'file' && bytes.length <= mediaLimits[kind]
    const native = supportedNative && withinLimit
    let contentBlock: ContentBlock | undefined
    if (native) {
      const base64 = bytesToBase64(bytes)
      if (kind === 'image') {
        contentBlock = { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
      } else if (kind === 'audio') {
        contentBlock = { type: 'input_audio', input_audio: { data: base64, format: audioFormat(file, mimeType) } }
      } else if (kind === 'video') {
        contentBlock = { type: 'video_url', video_url: { url: `data:${mimeType};base64,${base64}` } }
      }
    }

    return {
      id: nanoid(),
      name: file.name,
      path: uploadPath,
      mimeType,
      size: bytes.length,
      kind,
      native,
      contentBlock,
      referenceText: native ? undefined : attachmentReference(uploadPath, mimeType, bytes.length),
    }
  }, [mediaLimits, mediaSupport])

  const handleFilesSelected = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploadingFiles(true)
    try {
      const uploaded = (await Promise.all(files.map((file) => buildAttachment(file))))
        .filter((item): item is PendingAttachment => item != null)
      if (uploaded.length === 0) return

      setAttachments((current) => [...current, ...uploaded])
      const references = uploaded.map((item) => item.referenceText).filter(Boolean)
      if (references.length > 0) {
        const suffix = references.join('\n')
        const currentInput = input.trimEnd()
        setInput(currentInput ? `${currentInput}\n\n${suffix}` : suffix)
      }
    } finally {
      setUploadingFiles(false)
    }
  }, [buildAttachment, input, setInput])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const attachment = current.find((item) => item.id === id)
      if (attachment?.referenceText) {
        setInput(input.replace(`\n\n${attachment.referenceText}`, '').replace(attachment.referenceText, '').trimEnd())
      }
      return current.filter((item) => item.id !== id)
    })
  }, [input, setInput])

  const handleInterruptSend = useCallback((id: string) => {
    const msg = messageQueue.find(m => m.id === id)
    if (!msg) return
    removeFromQueue(id, loop)
    addLogEntry({
      id: nanoid(),
      type: 'user',
      content: msg.text,
      timestamp: Date.now(),
      metadata: msg.imagePreviewUrls && msg.imagePreviewUrls.length > 0 ? { imagePreviewUrls: msg.imagePreviewUrls } : undefined
    }, loop)
    window.adfApi?.invokeAgent(msg.text, filePath ?? undefined, msg.content, loop)
  }, [messageQueue, removeFromQueue, addLogEntry, filePath, loop])

  const buildSubmitContent = useCallback((message: string): ContentBlock[] => {
    const nativeAttachments = attachments.filter((item) => item.native && item.contentBlock)
    const blocks: ContentBlock[] = []
    if (message) blocks.push({ type: 'text', text: message })
    else if (nativeAttachments.length > 0) blocks.push({ type: 'text', text: ATTACHMENT_ONLY_TEXT })
    for (const item of nativeAttachments) {
      if (item.contentBlock) blocks.push(item.contentBlock)
    }
    return blocks
  }, [attachments])

  const imagePreviewUrls = useMemo(
    () => attachments
      .filter((item) => item.kind === 'image')
      .map((item) => adfFileUrl(item.path)),
    [attachments]
  )

  /**
   * The one send path. Everything the human sends goes through here, including
   * the message a `/<skill>` command composes — a skill command has to be
   * indistinguishable from the same words typed by hand, because that is the
   * whole of its authority.
   *
   * Callers clear the composer first; this owns the queue/start/invoke ladder.
   */
  const sendUserMessage = async (message: string, content: ContentBlock[], previews: string[]) => {
    // Capture the target agent at submit time so navigation can't redirect the message
    const targetFilePath = filePath

    // Autonomous + active: queue message instead of sending directly
    if (state === 'active') {
      // Callers already cleared the composer; the queue is keyed by loop so a
      // message typed into an inner loop's tab is sent to that loop.
      addToQueue(message || ATTACHMENT_ONLY_TEXT, content, previews, loop)
      return
    }

    // Show the user message immediately
    addLogEntry({
      id: nanoid(),
      type: 'user',
      content: message || ATTACHMENT_ONLY_TEXT,
      timestamp: Date.now(),
      metadata: previews.length > 0 ? { imagePreviewUrls: previews } : undefined
    }, loop)

    // If the AGENT (not just this loop) is off, start it first then invoke.
    // Side loops run inside the same process as main, so the gate is agent-level.
    if (agentState === 'off') {
      // Review gate: check if agent needs review before starting
      try {
        const review = await window.adfApi?.checkAgentReview()
        if (review?.needsReview) {
          useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
          return
        }
      } catch { /* fall through */ }

      if (targetFilePath) useAppStore.getState().addStartingFilePath(targetFilePath)
      try {
        const result = await window.adfApi?.startAgent(targetFilePath ?? undefined, true)
        // Only update UI if we're still viewing this agent
        const stillViewing = useDocumentStore.getState().filePath === targetFilePath
        if (stillViewing && result?.success) {
          setState(toDisplayState(result.agentState ?? 'idle'))
          setSessionId(result.sessionId ?? null)
        }
      } finally {
        if (targetFilePath) useAppStore.getState().removeStartingFilePath(targetFilePath)
      }
    }

    // Update activity state if still viewing, then always send the invoke
    const stillViewing = useDocumentStore.getState().filePath === targetFilePath
    if (stillViewing) {
      setState('active', loop)
    }

    window.adfApi?.invokeAgent(message, targetFilePath ?? undefined, content, loop)
  }

  /**
   * Run one palette row.
   *
   * Built-ins reuse the handlers Studio already has: `/clear` is the loop clear
   * behind the Clear Agent State control (`clearLog` + `clearChat`), `/skills`
   * is the right dock's own navigation action, `/idle` and `/hibernate` are the
   * fleet bar's own state setter aimed at this one agent, and `/stop` is the
   * Stop button's teardown. Nothing here invents a lifecycle state.
   *
   * A skill row does none of that. It reads the package's optional
   * `agents/openai.yaml`, composes a sentence, and sends it as an ordinary user
   * message — no execution, no tools, no config.
   */
  const runSlashCommand = async (command: SlashCommand, args: string) => {
    setInput('')
    if (command.kind === 'skill' && command.skill) {
      const name = command.skill
      let parsed = null
      try {
        const file = await window.adfApi?.readInternalFile(skillInterfacePath(name))
        parsed = file?.binary ? null : parseSkillInterface(file?.content)
      } catch { /* no interface file: the generic wording still works */ }
      const message = composeSkillMessage(name, parsed, args)
      const content = buildSubmitContent(message)
      const previews = imagePreviewUrls
      setAttachments([])
      await sendUserMessage(message, content, previews)
      return
    }

    switch (command.key) {
      case 'compact': {
        const result = await window.adfApi?.compactLoop()
        if (!result?.success) say(`/compact — ${result?.error ?? 'no agent is running.'}`)
        return
      }
      case 'clear': {
        useAgentStore.getState().clearLog()
        const result = await window.adfApi?.clearChat()
        if (!result?.success) say('/clear — the loop could not be cleared.')
        return
      }
      case 'skills': {
        useAppStore.getState().expandRightPanelToTab('agent', 'skills')
        return
      }
      case 'idle':
      case 'hibernate': {
        // MESH_SET_AGENT_STATE routes to the foreground executor when the path
        // is the open document's, so the fleet-shaped call is the single-agent
        // path too. It defers to a turn boundary rather than aborting.
        const target = useDocumentStore.getState().filePath
        if (!target) {
          say(`/${command.key} — no agent file is open.`)
          return
        }
        const result = await window.adfApi?.setFleetAgentState([target], command.key)
        const failure = result?.failed?.[0]
        say(failure
          ? `/${command.key} — ${failure.error}`
          : `Agent will go ${command.key === 'idle' ? 'idle' : 'into hibernation'} at the end of this turn.`)
        return
      }
      case 'stop': {
        // Exactly what the Stop button does (AgentPanel.handleStop): full
        // teardown, then the display state follows.
        await window.adfApi?.stopAgent()
        setState('off')
        say('Agent stopped')
        return
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const hasNativeAttachments = attachments.some((item) => item.native && item.contentBlock)
    if ((!input.trim() && !hasNativeAttachments) || starting || uploadingFiles) return
    const message = input.trim()

    // A `/` line is a command first and a message second. One that matches
    // nothing is sent verbatim — the palette must never swallow typed text.
    // Matched on the raw input, exactly as the palette decides whether to
    // open, so a line the palette never offered can never run either.
    const command = matchSlashCommand(input, slashCommands)
    if (command) {
      await runSlashCommand(command.command, command.args)
      return
    }

    const content = buildSubmitContent(message)
    const previews = imagePreviewUrls
    setInput('')
    setAttachments([])
    await sendUserMessage(message, content, previews)
  }

  /** Put a row's command words in the composer and wait for its arguments. */
  const completeSlashCommand = (command: SlashCommand) => {
    setInput(completionText(command))
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The palette owns Arrow/Tab/Escape, and Enter while a row is highlighted.
    if (slashOpen && slashRows.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActive((i) => (Math.min(i, slashRows.length - 1) + 1) % slashRows.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => (Math.min(i, slashRows.length - 1) + slashRows.length - 1) % slashRows.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        completeSlashCommand(slashRows[slashIndex])
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const picked = slashRows[slashIndex]
        // A skill row ends in a send, so it obeys the composer's own gates.
        if (picked.kind === 'skill' && (starting || uploadingFiles)) return
        const typed = matchSlashCommand(input, slashCommands)
        const args = typed?.command.key === picked.key ? typed.args : ''
        // A row that still wants an argument is completed, not run.
        if (needsArgument(picked, args)) completeSlashCommand(picked)
        else void runSlashCommand(picked, args)
        return
      }
    }
    // Enter sends, Shift+Enter inserts a newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Submit through the form so handleInputSubmit routes correctly (ask vs normal)
      e.currentTarget.form?.requestSubmit()
    }
  }

  const handleInputDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDraggingOverInput(false)
    handleFilesSelected(Array.from(e.dataTransfer.files))
  }, [handleFilesSelected])

  const handleInputDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDraggingOverInput(true)
    }
  }, [])

  const handleInputDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDraggingOverInput(false)
    }
  }, [])

  const handlePickFiles = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const [loadingOlder, setLoadingOlder] = useState(false)
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder) return
    // Oldest loaded loop row — display entries carry their source seq in metadata.
    // Live-streamed entries have no seq, so scan forward for the first that does.
    const s = selectLoopSlice(useAgentStore.getState(), loop)
    let oldestSeq: number | undefined
    for (const entry of s.log) {
      const seq = entry.metadata?.seq
      if (typeof seq === 'number') { oldestSeq = seq; break }
    }
    if (oldestSeq === undefined) return
    setLoadingOlder(true)
    try {
      const result = await window.adfApi.getChatOlder(oldestSeq, undefined, loop)
      if (result.uiLog.length > 0) {
        // Count grouped display items so the previous top item can be
        // re-anchored after the prepend without activity groups causing drift.
        const olderLog = result.uiLog as AgentLogEntry[]
        const olderDisplayLog = olderLog.filter((entry) => entry.type !== 'tool_result' && !isTurnCompleteMarker(entry))
        const prependedDisplayCount = buildDisplayItems(olderDisplayLog, buildToolPairIndex(olderLog)).length
        prependLog(olderLog, result.earlierCount, loop)
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(prependedDisplayCount, { align: 'start' })
        })
      } else {
        // No rows before the cursor — the boundary count was stale
        setEarlierCount(0, loop)
      }
    } catch (error) {
      console.error('[AgentLoop] Failed to load older loop entries:', error)
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder, prependLog, setEarlierCount, virtualizer, loop])

  const findToolPair = useCallback((entry: AgentLogEntry) => {
    return toolPairIndex.get(entry.id) ?? { call: null, result: null }
  }, [toolPairIndex])

  const handleToolClick = (entry: AgentLogEntry) => {
    setInspectedToolCall(entry)
  }

  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const toggleContext = useCallback((id: string) => {
    setExpandedContexts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleTrigger = useCallback((id: string) => {
    setExpandedTriggers((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleActivityGroup = useCallback((id: string, isExpanded: boolean) => {
    if (isExpanded) {
      setExpandedActivityGroups((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setCollapsedActivityGroups((previous) => new Set(previous).add(id))
    } else {
      setCollapsedActivityGroups((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setExpandedActivityGroups((previous) => new Set(previous).add(id))
    }
  }, [])

  const activityNeedsAttention = useCallback((entries: AgentLogEntry[]): boolean => {
    return entries.some((entry) => {
      if (pendingApprovals.has(entry.id) || pendingAsks.has(entry.id)) return true
      const result = toolPairIndex.get(entry.id)?.result
      return Boolean(result?.metadata?.imageUrl)
    })
  }, [pendingApprovals, pendingAsks, toolPairIndex])

  const renderLogEntry = (entry: AgentLogEntry, compact = false) => {
    const toolPair = entry.type === 'tool_call' ? toolPairIndex.get(entry.id) : undefined
    // Effective error: the executor's isError flag, OR — for adf_shell, which
    // always reports isError:false — a nonzero exit_code in the result payload.
    const pairedResult = toolPair?.result
    const toolResultIsError = entry.type === 'tool_call' && pairedResult
      ? isShellFailure((entry.metadata?.name as string | undefined) ?? '', pairedResult.content)
        || ((pairedResult.metadata?.isError as boolean | undefined) ?? null)
      : null
    const askAnswer = entry.metadata?.askAnswer as string | undefined
    const pairedAskAnswer = entry.type === 'tool_call' && entry.metadata?.name === 'ask'
      ? extractAskAnswer(toolPair?.result?.content ?? (entry.metadata?.result as string | undefined))
      : null

    return (
      <LogEntryRow
        entry={entry}
        expandedThinking={expandedThinking}
        onToggleThinking={toggleThinking}
        expandedTriggers={expandedTriggers}
        onToggleTrigger={toggleTrigger}
        expandedContexts={expandedContexts}
        onToggleContext={toggleContext}
        onToolClick={handleToolClick}
        pendingApprovalRequestId={pendingApprovals.get(entry.id)?.requestId}
        pendingApprovalMeta={pendingApprovals.get(entry.id)}
        onApprovalRespond={handleApprovalRespond}
        onAlwaysApprove={handleAlwaysApprove}
        pendingAsk={pendingAsks.get(entry.id)}
        isSuspendEntry={pendingSuspend === entry.id}
        onSuspendRespond={handleSuspendRespond}
        toolResultIsError={toolResultIsError}
        toolResultImageUrl={entry.type === 'tool_call' ? (toolPair?.result?.metadata?.imageUrl as string | undefined) ?? null : null}
        askAnswer={askAnswer ?? pairedAskAnswer}
        compact={compact}
      />
    )
  }

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="flex flex-col h-full">
      {/* Earlier-entries boundary — the loop table holds more rows than the
          loaded window; without this the cutoff is indistinguishable from a
          cleared loop. Only shown once the user scrolls up to the top of the
          loaded window. */}
      {earlierCount > 0 && atTop && (
        <div className="flex items-center justify-center gap-2 px-3 py-1 text-xs text-neutral-400 dark:text-neutral-500">
          <span>{earlierCount} earlier {earlierCount === 1 ? 'entry' : 'entries'} not shown</span>
          <button
            onClick={handleLoadOlder}
            disabled={loadingOlder}
            className="underline hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors disabled:opacity-50"
          >
            {loadingOlder ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}

      {/* Log */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto">
      <div className={columnClass}>
        {displayItems.length === 0 && !isActive && !starting && (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 text-center mt-8">
            Agent output will appear here.
          </p>
        )}
        {displayItems.length === 0 && (isActive || starting) && (
          <div className="flex items-center justify-center gap-2 text-sm text-neutral-400 mt-8">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" />
              <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0.1s]" />
              <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0.2s]" />
            </div>
            <span>{starting ? 'Starting agent\u2026' : 'Processing'}</span>
          </div>
        )}
        {displayItems.length > 0 && (
          <div
            style={{
              height: `${virtualTotalSize}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualItem) => {
              const displayItem = displayItems[virtualItem.index]
              if (!displayItem) return null
              const attentionRequired = displayItem.kind === 'activity' && activityNeedsAttention(displayItem.entries)
              const isTailGroup = displayItem.kind === 'activity' && virtualItem.index === lastActivityIndex
              const isLiveTail = isTailGroup && isActive && virtualItem.index === displayItems.length - 1
              const activityDurationMs = displayItem.kind === 'activity'
                ? getActivityDurationMs(displayItem.entries, toolPairIndex)
                : null
              const activitySummary = displayItem.kind === 'activity'
                ? getActivitySummary(displayItem.entries)
                : { label: '', family: 'neutral' as ToolFamily }
              const activityHasPending = displayItem.kind === 'activity'
                && displayItem.entries.some((entry) => pendingApprovals.has(entry.id) || pendingAsks.has(entry.id))
              const activityHasError = displayItem.kind === 'activity'
                && displayItem.entries.some((entry) => {
                  const result = toolPairIndex.get(entry.id)?.result
                  if (!result) return false
                  return result.metadata?.isError === true
                    || isShellFailure((entry.metadata?.name as string | undefined) ?? '', result.content)
                })
              const activityAccent = activityHasError
                ? ERROR_TOOL_STYLE
                : activityHasPending
                  ? ATTENTION_TOOL_STYLE
                  : TOOL_FAMILY_STYLES[activitySummary.family]
              const activityExpanded = displayItem.kind === 'activity'
                && (attentionRequired
                  || ((isTailGroup || expandedActivityGroups.has(displayItem.id))
                    && !collapsedActivityGroups.has(displayItem.id)))

              return (
                <div
                  key={displayItem.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                >
                  {displayItem.kind === 'entry' ? (
                    <div className="py-1">{renderLogEntry(displayItem.entry)}</div>
                  ) : (
                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => toggleActivityGroup(displayItem.id, activityExpanded)}
                        aria-expanded={activityExpanded}
                        className="flex w-full items-center gap-1.5 rounded px-3 py-1 text-left text-xs text-neutral-400 transition-colors hover:bg-neutral-100/70 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-300"
                      >
                        <span className="shrink-0 text-[11px] leading-none" aria-hidden>{activityExpanded ? '\u25BC' : '\u25B6'}</span>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityAccent.dot}`} aria-hidden />
                        <span className="shrink-0 font-medium text-neutral-500 dark:text-neutral-400">
                          ({displayItem.entries.length} {displayItem.entries.length === 1 ? 'step' : 'steps'})
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-left font-medium text-neutral-500 dark:text-neutral-400"
                          title={activitySummary.label}
                        >
                          {activitySummary.label}
                        </span>
                        {activityDurationMs != null && !isLiveTail && (
                          <span className="shrink-0 tabular-nums text-neutral-400 dark:text-neutral-500">
                            {formatActivityDuration(activityDurationMs)}
                          </span>
                        )}
                      </button>
                      {activityExpanded && (
                        <div className="pl-2">
                          {displayItem.entries.map((entry) => (
                            <div key={entry.id}>{renderLogEntry(entry, true)}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      </div>

      {/* Approve all (gated tools only) — shown when a batch of ≥2 gated
          approvals is queued. Protection/lock overrides are never included. */}
      {gatedPendingCount >= 2 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={handleApproveAllGated}
            className="px-3 py-1 text-xs font-medium rounded-full bg-green-500 hover:bg-green-600 text-white shadow-md transition-colors"
            title="Approve all pending gated tool calls at once — protection/lock overrides still need individual review"
          >
            Approve all {gatedPendingCount} tool calls
          </button>
        </div>
      )}

      {/* Post-batch note: how many protection overrides still need attention. */}
      {approveAllNote && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1 text-xs rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 shadow-md">
          <span>{approveAllNote}</span>
          <button
            onClick={() => setApproveAllNote(null)}
            className="text-amber-500 hover:text-amber-700 dark:hover:text-amber-100"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Bottom-right corner controls, stacked so the transient scroll button
          can never cover the persistent width toggle (and neither ever reaches
          the composer's own buttons, which live below this container). */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex flex-col items-end gap-1.5">
        {showScrollBtn && (
          <button
            onClick={scrollToBottom}
            className="pointer-events-auto w-7 h-7 flex items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 shadow-md hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors"
            title="Scroll to bottom"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 2.5v9m0 0l-3.5-3.5M7 11.5l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <ChatWidthToggle />
      </div>
      </div>

      {/* Pinned status strip — the live tail. Lives OUTSIDE the scroller so it
          never scrolls away and never enters the virtualiser's height maths.
          Sits above the composer's full-bleed hairline, narrowing with the
          column like the composer does: log → strip → hairline → composer. */}
      {statusPhase && (
        <div className={columnClass}>
          <AgentStatusStrip
            label={statusPhase.label}
            dotClass={statusPhase.dotClass}
            entry={statusPhase.entry}
            turnStartedAt={turnStartedAt}
            onOpen={setInspectedToolCall}
          />
        </div>
      )}

      {/* Input */}
      {(() => {
        // Get the active pending ask (if any) to transform the input bar
        let activeAsk: { logEntryId: string; requestId: string; question: string } | null = null
        for (const [logEntryId, ask] of pendingAsks.entries()) {
          activeAsk = { logEntryId, ...ask }
          break
        }

        const handleInputSubmit = (e: React.FormEvent) => {
          if (activeAsk) {
            e.preventDefault()
            if (!input.trim()) return
            handleAskRespond(activeAsk.logEntryId, activeAsk.requestId, input.trim())
            setInput('')
          } else {
            handleSubmit(e)
          }
        }

        const handleSkipAsk = () => {
          if (activeAsk) {
            handleAskRespond(activeAsk.logEntryId, activeAsk.requestId, '[skipped]')
          }
        }

        const canSubmit = activeAsk
          ? input.trim().length > 0
          : (input.trim().length > 0 || attachments.some((item) => item.native && item.contentBlock)) && !starting && !uploadingFiles

        return (
          // No divider above the composer: it reads as a floating card
          // (raised surface + shadow) rather than a panel with a hairline.
          <div className="pt-1">
          <form
            onSubmit={handleInputSubmit}
            onDrop={activeAsk ? undefined : handleInputDrop}
            onDragOver={activeAsk ? undefined : handleInputDragOver}
            onDragLeave={activeAsk ? undefined : handleInputDragLeave}
            className={`px-3 pb-3 ${messageQueue.length > 0 ? 'pt-1' : 'pt-2'} ${columnClass}`}
          >
            {activeAsk && (
              <div className="mb-1.5 px-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">Agent asks:</span>
                  <Button type="button" size="compact" variant="ghost" onClick={handleSkipAsk} className="h-6 px-1.5 text-[10px]">
                    Skip
                  </Button>
                </div>
                <div className="text-xs text-blue-700 dark:text-blue-300 whitespace-pre-wrap">
                  {activeAsk.question}
                </div>
              </div>
            )}
            {messageQueue.length > 0 && (
              <div className="mb-1 px-1 space-y-0.5">
                <span className="text-[10px] font-medium text-amber-600/80 dark:text-amber-400/80">
                  Queued ({messageQueue.length})
                </span>
                <div className="max-h-[6.5rem] overflow-y-auto space-y-0.5">
                  {messageQueue.map((msg) => (
                    <div key={msg.id} className="flex items-center gap-1 text-xs bg-amber-50/50 dark:bg-amber-900/10 border border-amber-200/40 dark:border-amber-800/30 rounded px-1.5 py-0.5">
                      <span className="flex-1 truncate text-neutral-700 dark:text-neutral-300">{msg.text}</span>
                      <button
                        type="button"
                        onClick={() => handleInterruptSend(msg.id)}
                        className="text-[10px] text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        Send now
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromQueue(msg.id)}
                        className="text-[10px] text-neutral-400 hover:text-red-500 dark:hover:text-red-400"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* The composer box clips its own overflow, so the palette anchors
                to this wrapper and floats above it. */}
            <div className="relative">
            {slashOpen && (
              <SlashCommandPalette
                commands={slashRows}
                activeIndex={slashIndex}
                listId="loop-slash-palette"
                onHighlight={setSlashActive}
                onSelect={(command) => {
                  const typed = matchSlashCommand(input, slashCommands)
                  const args = typed?.command.key === command.key ? typed.args : ''
                  if (needsArgument(command, args) || (command.kind === 'skill' && (starting || uploadingFiles))) {
                    completeSlashCommand(command)
                  } else {
                    void runSlashCommand(command, args)
                  }
                }}
              />
            )}
            <div className={`relative overflow-hidden rounded-2xl border bg-surface-raised shadow-card transition-[border-color,box-shadow] ${
              draggingOverInput
                ? 'border-[var(--adf-ui-accent)] ring-2 ring-[var(--adf-ui-focus)]'
                : activeAsk
                  ? 'border-blue-400 dark:border-blue-600'
                  : `border-hairline ${loopStyle.focus}`
            }`}>
              {draggingOverInput && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-blue-50/90 text-sm font-medium text-blue-600 dark:bg-blue-950/70 dark:text-blue-300">
                  Drop to attach
                </div>
              )}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                  {attachments.map((attachment) => (
                    <span
                      key={attachment.id}
                      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                        attachment.native
                          ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                          : 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
                      }`}
                      title={attachment.path}
                    >
                      <span className="truncate max-w-[10rem]">{attachment.name}</span>
                      <span className="shrink-0 text-neutral-400">{attachment.native ? attachment.kind : 'ref'}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(attachment.id)}
                        className="shrink-0 text-neutral-400 hover:text-red-500"
                        title="Remove attachment"
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* Single-row composer: "+" | textarea | send. items-end keeps the
                  buttons pinned to the bottom corners as the textarea grows. */}
              <div className="flex items-end gap-1.5 px-2 py-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    handleFilesSelected(Array.from(e.target.files ?? []))
                    e.currentTarget.value = ''
                  }}
                />
                <button
                  type="button"
                  onClick={handlePickFiles}
                  disabled={!!activeAsk || uploadingFiles}
                  className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  title="Attach files"
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path d="M9 3.25v11.5M3.25 9h11.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                </button>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  role="combobox"
                  aria-expanded={slashOpen}
                  aria-controls={slashOpen ? 'loop-slash-palette' : undefined}
                  aria-activedescendant={slashOpen && slashRows.length > 0 ? `loop-slash-palette-${slashIndex}` : undefined}
                  placeholder={
                    activeAsk ? 'Type your answer...'
                    : state === 'active' ? `Queue something for ${agentName}...`
                    : state === 'off' ? `What should ${agentName} do?`
                    : `What should ${agentName} do?`
                  }
                  rows={1}
                  className="loop-composer-input block min-h-[2.5rem] min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1.5 py-2.5 text-sm leading-5 text-neutral-900 placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                />
                <Button
                  type="submit"
                  disabled={!canSubmit}
                  size="default"
                  variant={state === 'active' && !activeAsk ? 'secondary' : 'primary'}
                  className="mb-1 w-[var(--adf-ui-control-height)] shrink-0 px-0 [&_svg]:shrink-0"
                  title={activeAsk ? 'Reply' : state === 'active' ? 'Queue message' : agentState === 'off' ? 'Start agent' : 'Send'}
                  aria-label={activeAsk ? 'Reply' : state === 'active' ? 'Queue message' : agentState === 'off' ? 'Start agent' : 'Send'}
                >
                  <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    {state === 'active' && !activeAsk ? (
                      <path d="M4 5.25h12M4 10h12M4 14.75h7.5" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
                    ) : (
                      <path d="M10 16V4m0 0L5.25 8.75M10 4l4.75 4.75" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                </Button>
              </div>
              {uploadingFiles && (
                <div className="px-3 pb-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">Uploading...</div>
              )}
            </div>
            </div>
          </form>
          </div>
        )
      })()}

      {/* Error Inspector Modal — full provider/turn error, copyable */}
      {inspectedToolCall?.type === 'error' && (() => {
        const details = inspectedToolCall.metadata?.details as string | undefined
        const full = details ? `${inspectedToolCall.content}\n\n${details}` : inspectedToolCall.content
        return (
          <ToolCallModal
            toolName="error"
            input={undefined}
            result={{ content: full, isError: true }}
            startedAt={inspectedToolCall.timestamp > 0 ? inspectedToolCall.timestamp : undefined}
            seq={inspectedToolCall.metadata?.seq as number | undefined}
            rawPayload={{ error: inspectedToolCall.content, details }}
            headerActions={<CopyErrorButton text={full} />}
            onClose={() => setInspectedToolCall(null)}
          />
        )
      })()}

      {/* Tool Call Inspector Modal */}
      {inspectedToolCall && inspectedToolCall.type !== 'error' && (() => {
        const { call, result } = findToolPair(inspectedToolCall)
        const toolName = (call?.metadata?.name ?? result?.metadata?.name ?? 'tool') as string
        const modalApproval = call ? pendingApprovals.get(call.id) : undefined
        const modalApprovalRequestId = modalApproval?.requestId
        const callDurationMs = call && result && call.timestamp > 0 && result.timestamp >= call.timestamp
          ? result.timestamp - call.timestamp
          : null
        return (
          <ToolCallModal
            toolName={toolName}
            input={call?.metadata?.input}
            result={result ? {
              content: result.content,
              isError: result.metadata?.isError === true,
              imageUrl: result.metadata?.imageUrl as string | undefined,
            } : null}
            awaitingApproval={!!modalApprovalRequestId}
            approvalTitle={modalApproval?.protection?.description}
            overrideOutcome={call?.metadata?.overrideOutcome as 'approved' | 'denied' | undefined}
            durationMs={callDurationMs}
            startedAt={call?.timestamp}
            toolId={call?.metadata?.tool_id as string | undefined}
            seq={call?.metadata?.seq as number | undefined}
            rawPayload={{ call, result }}
            approvalControls={modalApprovalRequestId ? (
              // dropUp + overlay: the modal card is overflow-hidden and its
              // footer sits near the viewport bottom — portal the popovers to
              // <body> and open them upward so nothing clips them.
              <ApprovalControls
                dropUp
                overlay
                toolName={toolName}
                onApprove={() => { handleApprovalRespond(modalApprovalRequestId, true); setInspectedToolCall(null) }}
                onAlwaysApprove={() => { handleAlwaysApprove(modalApprovalRequestId, toolName); setInspectedToolCall(null) }}
                onReject={(feedback) => { handleApprovalRespond(modalApprovalRequestId, false, feedback); setInspectedToolCall(null) }}
                alwaysApproveDisabled={modalApproval?.canAlwaysApprove === false}
                alwaysApproveDisabledReason={modalApproval?.alwaysApproveBlockedReason}
              />
            ) : undefined}
            onClose={() => setInspectedToolCall(null)}
          />
        )
      })()}
    </div>
  )
}

/**
 * The app's canonical state→dot palette (Sidebar's `StatusDot`, TitleBar's
 * `stateColors`). Duplicated rather than approximated: a second, private
 * colour scheme for the same six states is how "the agent is running" ends up
 * meaning two different things in two places on one screen.
 */
const LOOP_DOT_APPEARANCE: Record<string, { color: string; label: string; pulse?: boolean; ring?: boolean }> = {
  active: { color: 'bg-yellow-400', label: 'Active', pulse: true },
  idle: { color: 'bg-green-400', label: 'Idle' },
  hibernate: { color: 'bg-purple-500', label: 'Hibernate' },
  suspended: { color: 'border-red-400', label: 'Suspended', ring: true },
  off: { color: 'bg-neutral-400', label: 'Off' },
  error: { color: 'bg-red-400', label: 'Error' },
}

/**
 * One tab in the loop strip. Dot mirrors THAT loop's own live state; the
 * underline + label accent carry the loop's IDENTITY colour. The two are never
 * the same channel — see `loop-color.ts`.
 */
function LoopTab({ name, label, active, onSelect, scrollIntoViewOnActive = false }: {
  name: string
  label: string
  active: boolean
  onSelect: (name: string) => void
  /** Set for tabs inside the horizontal scroller, so selection can't leave one hidden. */
  scrollIntoViewOnActive?: boolean
}) {
  // Per-loop, never the agent-level state: `main` resolves to the store root
  // (which IS the agent state, §6.3) and a side loop to its own slice, which
  // `useAgent` fills the moment that loop's executor emits `state_changed`.
  const loopState = useAgentStore((s) => selectLoopSlice(s, name).state)
  // A side loop that has never emitted reads the default slice ('idle'), and a
  // stopped agent holds no runtime for it — painting that green would claim a
  // mind is alive behind the tab when the pool has none. Read main's state for
  // this gate only; nothing here ever writes it (side-loop state must never
  // move the agent-level state).
  const agentState = useAgentStore((s) => s.state)
  const state = name === MAIN_LOOP || agentState !== 'off' ? loopState : 'off'
  const dot = LOOP_DOT_APPEARANCE[state] ?? LOOP_DOT_APPEARANCE.off
  const identity = loopColor(name)
  // Calm states (idle/off/hibernate/suspended) on an UNFOCUSED tab compete with
  // both the active-tab affordance and the muted identity underline, so dim
  // their dot. Attention states — running (yellow-ping) and error (red) — stay
  // full brightness even on an unfocused tab so they still pop; the active tab
  // is always full. Rule: full when (tab active) OR (running/error).
  const dotAttention = state === 'active' || state === 'error'
  const dotMuted = !active && !dotAttention
  const ref = useRef<HTMLButtonElement>(null)

  // Whichever way the tab became active — a click, or a programmatic switch —
  // bring it into the scroller. `nearest` is a no-op when it is already visible.
  useEffect(() => {
    if (!active || !scrollIntoViewOnActive) return
    ref.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active, scrollIntoViewOnActive])

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(name)}
      title={`${name === MAIN_LOOP ? 'The host loop' : `Inner loop "${name}"`} — ${dot.label}`}
      // Identity is ALWAYS on the underline for an inner loop — muted when
      // inactive, full when active — so the strip stays a legend the eye can
      // match a sender-coloured `loop_send` card against without clicking. The
      // label text stays neutral until selected, so selection still reads.
      // `main` is not in the legend and keeps its bare inactive strip.
      className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors ${
        active
          ? `${identity.underline} ${identity.accent}`
          : `${identity.underlineMuted} text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300`
      }`}
    >
      <span className={`relative h-2 w-2 shrink-0 transition-opacity ${dotMuted ? 'opacity-60' : ''}`} title={dot.label} aria-hidden>
        {dot.pulse && (
          <span className={`absolute inset-0 rounded-full ${dot.color} animate-ping opacity-75`} />
        )}
        {dot.ring ? (
          <span className={`absolute inset-0 rounded-full border-[1.5px] ${dot.color}`} />
        ) : (
          <span className={`absolute inset-0 rounded-full ${dot.color}`} />
        )}
      </span>
      <span className="max-w-[9rem] truncate">{label}</span>
    </button>
  )
}

/**
 * Promotes the Loops panel from the right dock onto the center stage.
 *
 * One-way by design. The previous control was a panel-left/panel-right glyph
 * that read as "collapse this dock" — the dock's own collapse chevron is right
 * next to it — so the one thing it did (move the chat to the stage) was the one
 * thing it did not say. This is an unambiguous maximize: four corners opening
 * outward, an icon the app uses nowhere else, so it cannot be confused with
 * collapse or with the dock's expand.
 *
 * The return trip lives on the stage tab's X (and Ctrl+W), where "close this
 * tab" already means "put it back" — a second control in this header would be
 * a duplicate of a gesture the user can see.
 */
function PromoteChatToCenter() {
  const setChatPlacement = useAppStore((s: AppState) => s.setChatPlacement)
  const label = 'Open chat in center stage'

  return (
    <button
      type="button"
      onClick={() => setChatPlacement('center')}
      title={label}
      aria-label={label}
      className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
    >
      {/* maximize / arrows-out-corners */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3H5a2 2 0 0 0-2 2v3" />
        <path d="M16 3h3a2 2 0 0 1 2 2v3" />
        <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
        <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
      </svg>
    </button>
  )
}

/**
 * Toggles the chat's reading-column cap. Center placement only: in the dock the
 * panel is already narrow, so the control would be a switch with no visible
 * effect. Lives in the stream's bottom-right corner rather than the tab strip —
 * it is a property of the text you are reading, and the strip is absent
 * entirely for single-loop agents.
 */
function ChatWidthToggle() {
  const inCenter = useAppStore(selectChatInCenter)
  const chatWidth = useAppStore((s: AppState) => s.chatWidth)
  const setChatWidth = useAppStore((s: AppState) => s.setChatWidth)
  if (!inCenter) return null

  const goFull = chatWidth === 'comfortable'
  const label = goFull ? 'Full width' : 'Comfortable width'

  return (
    <button
      type="button"
      onClick={() => setChatWidth(goFull ? 'full' : 'comfortable')}
      title={label}
      aria-label={label}
      className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
    >
      {goFull ? (
        /* arrows-out-horizontal */
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8l-4 4 4 4" />
          <path d="M18 8l4 4-4 4" />
          <path d="M2 12h20" />
        </svg>
      ) : (
        /* arrows-in-horizontal */
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8l4 4-4 4" />
          <path d="M18 8l-4 4 4 4" />
          <path d="M2 12h8" />
          <path d="M14 12h8" />
        </svg>
      )}
    </button>
  )
}

/**
 * The agent's loop panel. With no enabled side loops this renders exactly what
 * it always did — a single `main` stream, no tab strip, zero visual change.
 * Otherwise it adds a tab strip: `main` first, then one tab per enabled
 * `AgentConfig.loops` entry, each showing that loop's own store slice and
 * sending through its own composer (§8).
 */
export function AgentLoop() {
  const configLoops = useAgentStore((s) => s.config?.loops)
  const sideLoops = useMemo(
    () => (configLoops ?? []).filter((l) => l.enabled && l.name && l.name !== MAIN_LOOP),
    [configLoops]
  )
  const [activeLoop, setActiveLoop] = useState<string>(MAIN_LOOP)
  // Only the dock offers the promotion; on the stage the tab's X is the way out.
  // Also suppressed while the fleet map holds the center stage (B2): promoting
  // there would send the chat to a stage the map is covering, and it would
  // vanish. selectCanPromoteChat = dock placement AND not on the map.
  const canPromote = useAppStore(selectCanPromoteChat)

  // A loop the user was viewing can be disabled or deleted (config edit or
  // `loop_manage`) — fall back to main rather than rendering a dead tab.
  useEffect(() => {
    if (activeLoop === MAIN_LOOP) return
    if (!sideLoops.some((l) => l.name === activeLoop)) setActiveLoop(MAIN_LOOP)
  }, [sideLoops, activeLoop])

  // Mirror the viewed tab into the store so the status-bar gauge (and anything
  // else outside this file) can follow it.
  const setViewedLoop = useAgentStore((s) => s.setViewedLoop)
  useEffect(() => {
    setViewedLoop(activeLoop)
    return () => setViewedLoop(MAIN_LOOP)
  }, [activeLoop, setViewedLoop])

  // Right-edge fade: shown only while there is strip left to scroll to, so it
  // never appears on the (common) two-or-three-loop case that already fits.
  const stripRef = useRef<HTMLDivElement>(null)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const syncStripOverflow = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1)
  }, [])
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    syncStripOverflow()
    // The dock is user-resizable and loops come and go — re-measure on both.
    const observer = new ResizeObserver(syncStripOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [syncStripOverflow, sideLoops.length])

  // Single-loop agents get no strip, but the promote affordance still has to be
  // reachable — a bare right-aligned row, no divider, so the stream keeps its
  // full height and the panel doesn't grow a second border under the dock's.
  // On the stage there is nothing to promote and no strip to host, so the row
  // disappears entirely and the stream takes the whole panel.
  if (sideLoops.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {canPromote && (
          <div className="flex shrink-0 items-center justify-end px-1 py-0.5">
            <PromoteChatToCenter />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <LoopStream loop={MAIN_LOOP} />
        </div>
      </div>
    )
  }

  const current = sideLoops.some((l) => l.name === activeLoop) ? activeLoop : MAIN_LOOP

  return (
    <div className="flex h-full flex-col">
      {/* Frozen-column strip: `main` is pinned OUTSIDE the scroller so the host
          loop is always one click away, then a hairline divider, then the inner
          loops in a horizontally scrollable row. The promote button sits
          outside the tablist — it is a panel control, not a loop. */}
      <div className="flex shrink-0 items-center border-b border-neutral-200 px-2 dark:border-neutral-700">
        <div role="tablist" aria-label="Agent loops" className="flex min-w-0 flex-1 items-center">
          <LoopTab name={MAIN_LOOP} label="main" active={current === MAIN_LOOP} onSelect={setActiveLoop} />
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />
          <div role="presentation" className="relative min-w-0 flex-1">
            <div
              ref={stripRef}
              role="presentation"
              onScroll={syncStripOverflow}
              className="scrollbar-none flex items-center gap-0.5 overflow-x-auto"
            >
              {sideLoops.map((l) => (
                <LoopTab
                  key={l.name}
                  name={l.name}
                  label={l.name}
                  active={current === l.name}
                  onSelect={setActiveLoop}
                  scrollIntoViewOnActive
                />
              ))}
            </div>
            {canScrollRight && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white to-transparent dark:from-neutral-900"
              />
            )}
          </div>
        </div>
        {canPromote && <PromoteChatToCenter />}
      </div>
      {/* Remount per tab so the virtualiser measures the stream it is showing. */}
      <div className="min-h-0 flex-1">
        <LoopStream key={current} loop={current} />
      </div>
    </div>
  )
}
