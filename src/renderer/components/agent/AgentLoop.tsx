import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAgentStore, type AgentLogEntry } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAppStore } from '../../stores/app.store'
import { toDisplayState } from '../../hooks/useAgent'
import { nanoid } from 'nanoid'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { isAdfFileUrl, openAdfFileLink } from '../../utils/open-adf-link'
import type { ContentBlock } from '../../../shared/types/provider.types'

const MAX_INPUT_ROWS = 8
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

/** Try to pretty-print JSON, otherwise return the raw string. */
function formatToolOutput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Truncate a shell command for inline display in the loop. */
function formatShellCommand(command?: string): string {
  if (!command) return ''
  return command.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Parse shell tool JSON output into structured parts. */
function parseShellOutput(raw: string): { exit_code: number; stdout: string; stderr: string } | null {
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
 * Simple syntax highlighter for code strings.
 * Produces React spans with Tailwind color classes.
 */
function highlightCode(code: string): React.ReactNode {
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
function isRichString(value: string): boolean {
  return value.includes('\n') || value.length > 80
}

/** Does this string look like code (vs. natural language)? */
function looksLikeCode(value: string): boolean {
  if (!value.includes('\n')) return false
  // Simple heuristic: contains common code patterns
  return /[{};=()]/.test(value) || /^\s*(const|let|var|function|import|class|def |for |if |#include)\b/m.test(value)
}

/** Render tool input: separate long/code string fields from scalar params. */
function renderToolInput(data: unknown): React.ReactNode {
  if (data == null) return '(no input data)'
  if (typeof data !== 'object' || Array.isArray(data)) {
    return JSON.stringify(data, null, 2)
  }

  const record = data as Record<string, unknown>
  const richEntries: [string, string, boolean][] = [] // [key, value, isCode]
  const rest: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && isRichString(value)) {
      richEntries.push([key, value, looksLikeCode(value)])
    } else {
      rest[key] = value
    }
  }

  // If no rich strings found, fall back to plain JSON
  if (richEntries.length === 0) {
    return JSON.stringify(data, null, 2)
  }

  const preClass =
    'bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 text-xs font-mono text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap break-all max-h-60 overflow-y-auto'

  return (
    <div className="space-y-3">
      {/* Scalar / short params */}
      {Object.keys(rest).length > 0 && (
        <pre className={preClass}>{JSON.stringify(rest, null, 2)}</pre>
      )}
      {/* Rich string fields */}
      {richEntries.map(([key, value, isCode]) => (
        <div key={key}>
          <div className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            {key}
          </div>
          <pre className={preClass}>
            {isCode ? highlightCode(value.trim()) : value.trim()}
          </pre>
        </div>
      ))}
    </div>
  )
}

/** Format a unix-ms timestamp as a compact local time string. */
function formatLoopTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`
}

// Configure marked for loop messages: no async, open links externally
marked.use({ async: false, breaks: true })

/** Percent-encode spaces in adf-file:// URLs so markdown parsers don't break on them. */
function encodeAdfFileUrls(src: string): string {
  return src.replace(
    /adf-file:\/\/([^\s)>"'\]]+(?:\s[^\s)>"'\]]+)*)/g,
    (_match, path: string) => 'adf-file://' + path.replace(/ /g, '%20')
  )
}

function renderMarkdown(src: string): string {
  const raw = marked.parse(encodeAdfFileUrls(src)) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|adf-file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  })
}

// Memoized markdown component to avoid re-parsing on every render
const MarkdownEntry = memo(({ content }: { content: string }) => {
  const html = useMemo(() => renderMarkdown(content), [content])
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (href && isAdfFileUrl(href)) {
      e.preventDefault()
      openAdfFileLink(href)
    }
  }, [])
  return (
    <div
      className="bg-blue-50 dark:bg-blue-900/30 rounded-lg p-2.5 text-neutral-800 dark:text-neutral-200 loop-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  )
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
  dynamic_instructions: 'Dynamic Instructions'
}

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
  onApprovalRespond,
  pendingAsk,
  isSuspendEntry,
  onSuspendRespond,
  toolResultIsError,
  toolResultImageUrl,
  askAnswer
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
  onApprovalRespond?: (requestId: string, approved: boolean) => void
  pendingAsk?: { requestId: string; question: string }
  isSuspendEntry?: boolean
  onSuspendRespond?: (resume: boolean) => void
  toolResultIsError?: boolean | null
  toolResultImageUrl?: string | null
  askAnswer?: string | null
}) => {
  return (
    <div className="text-sm px-3">
      {entry.type === 'user' && (
        <div className="flex flex-col items-end gap-0.5">
          <div className="bg-blue-500 text-white rounded-lg p-2.5 max-w-[85%] whitespace-pre-wrap break-words">
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
      {entry.type === 'thinking' && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg overflow-hidden">
          <button
            onClick={() => onToggleThinking(entry.id)}
            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
          >
            <span className="text-amber-500 dark:text-amber-400">
              {expandedThinking.has(entry.id) ? '\u25BC' : '\u25B6'}
            </span>
            <span className="font-medium">Thinking</span>
            <span className="text-amber-400 dark:text-amber-500 ml-auto flex items-center gap-2">
              {(entry.metadata?.tokens as { output?: number } | undefined)?.output
                ? `${((entry.metadata!.tokens as { output: number }).output).toLocaleString()} tokens`
                : `${Math.ceil(entry.content.length / 4)} tokens`}
            </span>
          </button>
          {expandedThinking.has(entry.id) && (
            <div className="px-2.5 pb-2 text-xs text-amber-800 dark:text-amber-300 whitespace-pre-wrap border-t border-amber-200 dark:border-amber-700 pt-2 max-h-64 overflow-y-auto">
              {entry.content}
            </div>
          )}
        </div>
      )}
      {entry.type === 'text' && (() => {
        const usage = entry.metadata?.tokens as { input?: number; output?: number } | undefined
        const model = entry.metadata?.model as string | undefined
        const infoParts: string[] = []
        if (entry.timestamp > 0) infoParts.push(formatLoopTime(entry.timestamp))
        if (model) infoParts.push(model)
        if (usage?.output) infoParts.push(`${usage.output.toLocaleString()} tokens`)
        return (
          <div>
            <MarkdownEntry content={entry.content} />
            {infoParts.length > 0 && (
              <div className="mt-0.5 px-1 text-[10px] text-neutral-400 dark:text-neutral-500">
                {infoParts.join(' · ')}
              </div>
            )}
          </div>
        )
      })()}
      {entry.type === 'tool_call' && (entry.metadata?.name as string) === 'say' && (
        <div>
          <MarkdownEntry content={(entry.metadata?.input as { message?: string })?.message ?? entry.content} />
        </div>
      )}
      {entry.type === 'tool_call' && (entry.metadata?.name as string) !== 'say' && (
        <>
          <div
            className={`rounded-lg p-2 text-xs font-mono cursor-pointer transition-colors break-all overflow-hidden ${
              pendingApprovalRequestId
                ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400'
                : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
            }`}
            onClick={() => onToolClick(entry)}
          >
            <div className="flex items-center justify-between">
              <span className="min-w-0 flex-1 break-words">
                <span className="text-blue-600 font-semibold">
                  {(entry.metadata?.name as string) ?? 'tool'}
                </span>
                {pendingApprovalRequestId
                  ? ' — awaiting approval'
                  : (entry.metadata?.name as string) === 'adf_shell'
                    ? <span className="text-neutral-500 dark:text-neutral-400 ml-1.5">{formatShellCommand((entry.metadata?.input as { command?: string })?.command)}</span>
                    : (entry.metadata?.input as Record<string, unknown>)?._reason
                      ? <span className="text-neutral-500 dark:text-neutral-400 ml-1.5">{String((entry.metadata?.input as Record<string, unknown>)._reason)}</span>
                      : (() => {
                          const raw = entry.metadata?.input
                          if (!raw) return ' called'
                          try {
                            const str = JSON.stringify(raw)
                            const display = str.length > 60 ? str.slice(0, 60) + '…' : str
                            return <span className="text-neutral-500 dark:text-neutral-400 ml-1.5 font-mono">{display}</span>
                          } catch { return ' called' }
                        })()
                }
              </span>
              {toolResultIsError === true && <span className="text-red-500" title="Error">&#x2718;</span>}
              {toolResultIsError === false && <span className="text-green-500" title="Success">&#x2714;</span>}
              {pendingApprovalRequestId && onApprovalRespond && (
                <span className="flex gap-1.5 ml-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-green-500 hover:bg-green-600 text-white transition-colors"
                    onClick={() => onApprovalRespond(pendingApprovalRequestId, true)}
                  >
                    Approve
                  </button>
                  <button
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
                    onClick={() => onApprovalRespond(pendingApprovalRequestId, false)}
                  >
                    Reject
                  </button>
                </span>
              )}
            </div>
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
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2 text-red-700 dark:text-red-400 text-xs">
          {entry.content}
        </div>
      )}
      {entry.type === 'trigger' && (() => {
        const triggerType = (entry.metadata?.triggerType as string) ?? 'unknown'
        const label = TRIGGER_LABELS[triggerType] ?? 'Trigger'
        const isExpanded = expandedTriggers.has(entry.id)
        return (
          <div className="bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
            <button
              onClick={() => onToggleTrigger(entry.id)}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700/50 transition-colors"
            >
              <span className="text-neutral-400 dark:text-neutral-500">
                {isExpanded ? '\u25BC' : '\u25B6'}
              </span>
              <span className="font-medium">{label}</span>
              {entry.timestamp > 0 && (
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto">
                  {formatLoopTime(entry.timestamp)}
                </span>
              )}
            </button>
            {isExpanded && (
              <div className="px-2.5 pb-2 text-xs text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap border-t border-neutral-200 dark:border-neutral-700 pt-2 max-h-64 overflow-y-auto">
                {entry.content}
              </div>
            )}
          </div>
        )
      })()}
      {entry.type === 'context' && (() => {
        const category = (entry.metadata?.category as string) ?? 'unknown'
        const label = CONTEXT_LABELS[category] ?? 'Context Injected'
        const isExpanded = expandedContexts.has(entry.id)
        return (
          <div className="bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
            <button
              onClick={() => onToggleContext(entry.id)}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700/50 transition-colors"
            >
              <span className="text-neutral-400 dark:text-neutral-500">
                {isExpanded ? '\u25BC' : '\u25B6'}
              </span>
              <span className="font-medium">{label}</span>
              {entry.timestamp > 0 && (
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto">
                  {formatLoopTime(entry.timestamp)}
                </span>
              )}
            </button>
            {isExpanded && (
              <div className="px-2.5 pb-2 text-xs text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap border-t border-neutral-200 dark:border-neutral-700 pt-2 max-h-64 overflow-y-auto">
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
        <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-300 dark:border-purple-700 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-purple-700 dark:text-purple-400">Agent Suspended</div>
          <div className="text-sm text-purple-800 dark:text-purple-300">
            The agent has reached its maximum active turns limit and has been paused.
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onSuspendRespond(true)}
              className="px-3 py-1.5 text-xs font-medium bg-green-500 hover:bg-green-600 text-white rounded-md transition-colors"
            >
              Resume
            </button>
            <button
              onClick={() => onSuspendRespond(false)}
              className="px-3 py-1.5 text-xs font-medium bg-red-500 hover:bg-red-600 text-white rounded-md transition-colors"
            >
              Shut Down
            </button>
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
          <div
            className={`rounded-lg p-2.5 ${
              isIncoming
                ? 'bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700'
                : 'bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700'
            }`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span
                className={`text-[10px] font-semibold ${
                  isIncoming ? 'text-purple-600 dark:text-purple-400' : 'text-indigo-600 dark:text-indigo-400'
                }`}
              >
                {isIncoming ? `From: ${fromAgent}` : `To: ${toAgent}`}
              </span>
              {channel && (
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                    isIncoming
                      ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-500 dark:text-purple-400'
                      : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-500 dark:text-indigo-400'
                  }`}
                >
                  {channel}
                </span>
              )}
            </div>
            <div
              className={`text-xs whitespace-pre-wrap ${
                isIncoming ? 'text-purple-800 dark:text-purple-300' : 'text-indigo-800 dark:text-indigo-300'
              }`}
            >
              {entry.content}
            </div>
          </div>
        )
      })()}
    </div>
  )
})

export function AgentLoop() {
  const filePath = useDocumentStore((s) => s.filePath)
  const draftInputs = useDocumentStore((s) => s.draftInputs)
  const setDraftInput = useDocumentStore((s) => s.setDraftInput)
  const input = filePath ? (draftInputs[filePath] ?? '') : ''
  const setInput = useCallback((value: string) => {
    if (filePath) setDraftInput(filePath, value)
  }, [filePath, setDraftInput])
  const log = useAgentStore((s) => s.log)
  const logVersion = useAgentStore((s) => s.logVersion)
  const state = useAgentStore((s) => s.state)
  const clearLog = useAgentStore((s) => s.clearLog)
  const pendingApprovals = useAgentStore((s) => s.pendingApprovals)
  const removePendingApproval = useAgentStore((s) => s.removePendingApproval)
  const pendingAsks = useAgentStore((s) => s.pendingAsks)
  const removePendingAsk = useAgentStore((s) => s.removePendingAsk)
  const updateEntryAt = useAgentStore((s) => s.updateEntryAt)
  const pendingSuspend = useAgentStore((s) => s.pendingSuspend)
  const setPendingSuspend = useAgentStore((s) => s.setPendingSuspend)
  const messageQueue = useAgentStore((s) => s.messageQueue)
  const addToQueue = useAgentStore((s) => s.addToQueue)
  const removeFromQueue = useAgentStore((s) => s.removeFromQueue)
  const config = useAgentStore((s) => s.config)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [expandedTriggers, setExpandedTriggers] = useState<Set<string>>(new Set())
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(new Set())
  const [inspectedToolCall, setInspectedToolCall] = useState<AgentLogEntry | null>(null)
  const [showRawJson, setShowRawJson] = useState(false)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [draggingOverInput, setDraggingOverInput] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const starting = useAppStore((s) => filePath ? s.startingFilePaths.has(filePath) : false)

  const handleApprovalRespond = useCallback((requestId: string, approved: boolean) => {
    window.adfApi?.respondToolApproval(requestId, approved)
    // Find the logEntryId for this requestId and remove it
    for (const [logEntryId, rid] of pendingApprovals.entries()) {
      if (rid === requestId) {
        removePendingApproval(logEntryId)
        break
      }
    }
  }, [pendingApprovals, removePendingApproval])

  const handleAskRespond = useCallback((logEntryId: string, requestId: string, answer: string) => {
    window.adfApi?.respondAsk(requestId, answer)
    const idx = log.findIndex((entry) => entry.id === logEntryId)
    if (idx >= 0) {
      updateEntryAt(idx, (entry) => {
        entry.metadata = {
          ...entry.metadata,
          askAnswer: answer
        }
      })
    }
    removePendingAsk(logEntryId)
  }, [log, removePendingAsk, updateEntryAt])

  const handleSuspendRespond = useCallback((resume: boolean) => {
    window.adfApi?.respondSuspend(resume)
    setPendingSuspend(null)
  }, [setPendingSuspend])

  // Track whether user is at the bottom of the scroll container
  const isAtBottom = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  // Virtual scrolling setup
  // Filter out tool_result entries — their content is accessible via the tool_call inspector
  const displayLog = useMemo(() => log.filter((e) => e.type !== 'tool_result'), [log, logVersion])

  const isActive = state === 'active'
  // +1 for the activity indicator row when agent is active or starting
  const showActivityRow = isActive || starting
  const itemCount = displayLog.length + (showActivityRow ? 1 : 0)

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 8,
  })

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    isAtBottom.current = atBottom
    if (atBottom) setShowScrollBtn(false)
  }, [])

  // Scroll to bottom on mount (component remounts per-agent via key prop)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
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

  const agentName = config?.name?.trim() || 'the agent'

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
    removeFromQueue(id)
    addLogEntry({
      id: nanoid(),
      type: 'user',
      content: msg.text,
      timestamp: Date.now(),
      metadata: msg.imagePreviewUrls && msg.imagePreviewUrls.length > 0 ? { imagePreviewUrls: msg.imagePreviewUrls } : undefined
    })
    window.adfApi?.invokeAgent(msg.text, filePath ?? undefined, msg.content)
  }, [messageQueue, removeFromQueue, addLogEntry, filePath])

  const buildSubmitContent = useCallback((message: string): ContentBlock[] => {
    const nativeAttachments = attachments.filter((item) => item.native && item.contentBlock)
    const blocks: ContentBlock[] = []
    if (message) blocks.push({ type: 'text', text: message })
    else if (nativeAttachments.length > 0) blocks.push({ type: 'text', text: 'Please review the attached media.' })
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const hasNativeAttachments = attachments.some((item) => item.native && item.contentBlock)
    if ((!input.trim() && !hasNativeAttachments) || starting || uploadingFiles) return
    const message = input.trim()
    const content = buildSubmitContent(message)
    // Capture the target agent at submit time so navigation can't redirect the message
    const targetFilePath = filePath

    // Autonomous + active: queue message instead of sending directly
    if (state === 'active') {
      addToQueue(message || 'Attached media', content, imagePreviewUrls)
      setInput('')
      setAttachments([])
      return
    }

    // Clear input and show user message immediately
    setInput('')
    setAttachments([])
    addLogEntry({
      id: nanoid(),
      type: 'user',
      content: message || 'Attached media',
      timestamp: Date.now(),
      metadata: imagePreviewUrls.length > 0 ? { imagePreviewUrls } : undefined
    })

    // If agent is off, start it first then invoke with the message
    if (state === 'off') {
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
      setState('active')
    }

    window.adfApi?.invokeAgent(message, targetFilePath ?? undefined, content)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const handleClearLoop = () => {
    clearLog()
    // Clear persisted loop and session messages in main process
    window.adfApi?.clearChat()
  }

  // Build a tool_call → tool_result index for O(1) lookups.
  // Keyed by entry id → paired { call, result }.
  const toolPairIndex = useMemo(() => {
    const index = new Map<string, { call: AgentLogEntry | null; result: AgentLogEntry | null }>()
    // Track unmatched tool_call entries by their tool_use_id (metadata.tool_id)
    const pendingCallsById = new Map<string, AgentLogEntry>()
    // Fallback: track by name for entries without tool_use_id
    const pendingCallsByName = new Map<string, AgentLogEntry>()

    for (const entry of log) {
      if (entry.type === 'tool_call') {
        const toolId = entry.metadata?.tool_id as string | undefined
        if (toolId) {
          pendingCallsById.set(toolId, entry)
        } else {
          const name = entry.metadata?.name as string
          pendingCallsByName.set(name, entry)
        }
      } else if (entry.type === 'tool_result') {
        const toolUseId = entry.metadata?.tool_use_id as string | undefined
        let call: AgentLogEntry | null = null

        if (toolUseId) {
          call = pendingCallsById.get(toolUseId) ?? null
          if (call) pendingCallsById.delete(toolUseId)
        }
        // Fallback: match by name if no tool_use_id
        if (!call) {
          const name = entry.metadata?.name as string
          call = pendingCallsByName.get(name) ?? null
          if (call) pendingCallsByName.delete(name)
        }

        if (call) {
          index.set(call.id, { call, result: entry })
          index.set(entry.id, { call, result: entry })
        } else {
          index.set(entry.id, { call: null, result: entry })
        }
      }
    }
    // Any unmatched calls
    for (const call of pendingCallsById.values()) {
      if (!index.has(call.id)) {
        index.set(call.id, { call, result: null })
      }
    }
    for (const call of pendingCallsByName.values()) {
      if (!index.has(call.id)) {
        index.set(call.id, { call, result: null })
      }
    }
    return index
  }, [log.length, logVersion])

  const findToolPair = useCallback((entry: AgentLogEntry) => {
    return toolPairIndex.get(entry.id) ?? { call: null, result: null }
  }, [toolPairIndex])

  const handleToolClick = (entry: AgentLogEntry) => {
    setInspectedToolCall(entry)
    setShowRawJson(false) // Reset to formatted view when opening
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

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="flex flex-col h-full">
      {/* Header with clear button */}
      {log.length > 0 && (
        <div className="flex items-center justify-end px-3 pt-2">
          <button
            onClick={handleClearLoop}
            className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
          >
            Clear loop
          </button>
        </div>
      )}

      {/* Log */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto">
        {displayLog.length === 0 && !isActive && !starting && (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 text-center mt-8">
            Agent output will appear here.
          </p>
        )}
        {displayLog.length === 0 && (isActive || starting) && (
          <div className="flex items-center justify-center gap-2 text-sm text-neutral-400 mt-8">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" />
              <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0.1s]" />
              <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0.2s]" />
            </div>
            <span>{starting ? 'Starting agent\u2026' : 'Processing'}</span>
          </div>
        )}
        {displayLog.length > 0 && (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualItem) => {
              const isActivityRow = virtualItem.index >= displayLog.length
              if (isActivityRow) {
                return (
                  <div
                    key="activity-indicator"
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
                    <div className="flex items-center gap-2 text-sm text-neutral-400 px-3 py-1">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" />
                        <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0.1s]" />
                        <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                      </div>
                      {starting && <span>Starting agent&hellip;</span>}
                    </div>
                  </div>
                )
              }

              const entry = displayLog[virtualItem.index]
              if (!entry) return null
              const toolPair = entry.type === 'tool_call' ? toolPairIndex.get(entry.id) : undefined
              const askAnswer = entry.metadata?.askAnswer as string | undefined
              const pairedAskAnswer = entry.type === 'tool_call' && entry.metadata?.name === 'ask'
                ? extractAskAnswer(toolPair?.result?.content ?? (entry.metadata?.result as string | undefined))
                : null

              return (
                <div
                  key={entry.id}
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
                  <div className="py-1">
                    <LogEntryRow
                      entry={entry}
                      expandedThinking={expandedThinking}
                      onToggleThinking={toggleThinking}
                      expandedTriggers={expandedTriggers}
                      onToggleTrigger={toggleTrigger}
                      expandedContexts={expandedContexts}
                      onToggleContext={toggleContext}
                      onToolClick={handleToolClick}
                      pendingApprovalRequestId={pendingApprovals.get(entry.id)}
                      onApprovalRespond={handleApprovalRespond}
                      pendingAsk={pendingAsks.get(entry.id)}
                      isSuspendEntry={pendingSuspend === entry.id}
                      onSuspendRespond={handleSuspendRespond}
                      toolResultIsError={entry.type === 'tool_call' ? (toolPair?.result?.metadata?.isError as boolean | undefined) ?? null : null}
                      toolResultImageUrl={entry.type === 'tool_call' ? (toolPair?.result?.metadata?.imageUrl as string | undefined) ?? null : null}
                      askAnswer={askAnswer ?? pairedAskAnswer}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 right-3 w-7 h-7 flex items-center justify-center rounded-full bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 shadow-md hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors z-10"
          title="Scroll to bottom"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 2.5v9m0 0l-3.5-3.5M7 11.5l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      </div>

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
          <form
            onSubmit={handleInputSubmit}
            onDrop={activeAsk ? undefined : handleInputDrop}
            onDragOver={activeAsk ? undefined : handleInputDragOver}
            onDragLeave={activeAsk ? undefined : handleInputDragLeave}
            className={`border-t px-3 pb-3 ${messageQueue.length > 0 ? 'pt-1' : 'pt-2'} ${activeAsk ? 'border-blue-400 dark:border-blue-600' : 'border-neutral-200 dark:border-neutral-700'}`}
          >
            {activeAsk && (
              <div className="mb-1.5 px-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">Agent asks:</span>
                  <button
                    type="button"
                    onClick={handleSkipAsk}
                    className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  >
                    Skip
                  </button>
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
            <div className={`relative rounded-2xl border bg-white dark:bg-neutral-900 shadow-sm transition-colors ${
              draggingOverInput
                ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-400/20'
                : activeAsk
                  ? 'border-blue-400 dark:border-blue-600'
                  : 'border-neutral-200 dark:border-neutral-700 focus-within:border-blue-400 dark:focus-within:border-blue-500'
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
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  activeAsk ? 'Type your answer...'
                  : state === 'active' ? `Queue something for ${agentName}...`
                  : state === 'off' ? `What should ${agentName} do?`
                  : `What should ${agentName} do?`
                }
                rows={3}
                className="block w-full min-h-[5.25rem] resize-none overflow-y-auto border-0 bg-transparent px-3 py-3 text-sm leading-5 text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
              <div className="flex items-center justify-between gap-2 px-2 pb-2">
                <div className="flex items-center gap-1.5">
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
                    className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title="Attach files"
                  >
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                      <path d="M9 3.25v11.5M3.25 9h11.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </button>
                  {uploadingFiles && (
                    <span className="text-[11px] text-neutral-400 dark:text-neutral-500">Uploading...</span>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    activeAsk ? 'bg-blue-500 hover:bg-blue-600'
                    : state === 'off' ? 'bg-green-500 hover:bg-green-600'
                    : state === 'active' ? 'bg-amber-500 hover:bg-amber-600'
                    : 'bg-blue-500 hover:bg-blue-600'
                  }`}
                  title={activeAsk ? 'Reply' : state === 'active' ? 'Queue message' : state === 'off' ? 'Start agent' : 'Send'}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    {state === 'active' && !activeAsk ? (
                      <path d="M4 5.25h10M4 9h10M4 12.75h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    ) : (
                      <path d="M9 14.25V3.75m0 0L4.75 8M9 3.75 13.25 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                </button>
              </div>
            </div>
          </form>
        )
      })()}

      {/* Tool Call Inspector Modal */}
      {inspectedToolCall && (() => {
        const { call, result } = findToolPair(inspectedToolCall)
        const toolName = (call?.metadata?.name ?? result?.metadata?.name ?? 'tool') as string
        const inputData = call?.metadata?.input
        const isError = result?.metadata?.isError as boolean | undefined
        const modalApprovalRequestId = call ? pendingApprovals.get(call.id) : undefined

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
            onClick={() => setInspectedToolCall(null)}
          >
            <div
              className="bg-white dark:bg-neutral-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200 dark:border-neutral-700">
                <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100 font-mono">
                  {toolName}
                  {modalApprovalRequestId && (
                    <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                      — awaiting approval
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-3">
                  {modalApprovalRequestId && (
                    <>
                      <button
                        onClick={() => { handleApprovalRespond(modalApprovalRequestId, true); setInspectedToolCall(null) }}
                        className="px-2.5 py-1 text-xs font-medium rounded bg-green-500 hover:bg-green-600 text-white transition-colors"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => { handleApprovalRespond(modalApprovalRequestId, false); setInspectedToolCall(null) }}
                        className="px-2.5 py-1 text-xs font-medium rounded bg-red-500 hover:bg-red-600 text-white transition-colors"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setShowRawJson(!showRawJson)}
                    className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                      showRawJson
                        ? 'bg-blue-500 text-white'
                        : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600'
                    }`}
                  >
                    {showRawJson ? 'Formatted' : 'Raw'}
                  </button>
                  <button
                    onClick={() => setInspectedToolCall(null)}
                    className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 text-lg leading-none"
                  >
                    &#x2715;
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {showRawJson ? (
                  /* Raw JSON View */
                  <div>
                    <div className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-1.5">
                      Raw Response Data
                    </div>
                    <pre className="border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all bg-neutral-50 dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300">
                      {JSON.stringify({
                        call: call ? {
                          id: call.id,
                          type: call.type,
                          content: call.content,
                          timestamp: call.timestamp,
                          metadata: call.metadata
                        } : null,
                        result: result ? {
                          id: result.id,
                          type: result.type,
                          content: result.content,
                          timestamp: result.timestamp,
                          metadata: result.metadata
                        } : null
                      }, null, 2)}
                    </pre>
                  </div>
                ) : toolName === 'adf_shell' ? (
                  /* Shell-specific formatted view */
                  <>
                    {/* Command */}
                    <div>
                      <div className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-1.5">
                        Command
                      </div>
                      <pre className="bg-neutral-900 dark:bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all text-green-400">
                        {(inputData as { command?: string })?.command ?? ''}
                      </pre>
                    </div>

                    {/* Shell output */}
                    {result ? (() => {
                      const shell = parseShellOutput(result.content)
                      if (!shell) {
                        return (
                          <pre className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all text-neutral-700 dark:text-neutral-300">
                            {formatToolOutput(result.content)}
                          </pre>
                        )
                      }
                      return (
                        <div className="space-y-3">
                          {/* stdout */}
                          {shell.stdout && (
                            <div>
                              <div className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-1.5">
                                stdout
                              </div>
                              <pre className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto text-neutral-700 dark:text-neutral-300">
                                {shell.stdout}
                              </pre>
                            </div>
                          )}

                          {/* stderr */}
                          {shell.stderr && (
                            <div>
                              <div className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-1.5">
                                stderr
                              </div>
                              <pre className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto text-red-700 dark:text-red-400">
                                {shell.stderr}
                              </pre>
                            </div>
                          )}

                          {/* Exit code badge */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500 dark:text-neutral-400">Exit code:</span>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                              shell.exit_code === 0
                                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                            }`}>
                              {shell.exit_code}
                            </span>
                            {!shell.stdout && !shell.stderr && shell.exit_code === 0 && (
                              <span className="text-xs text-neutral-400 dark:text-neutral-500 italic">
                                (no output)
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })() : (
                      <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">Pending...</p>
                    )}
                  </>
                ) : (
                  /* Generic formatted view */
                  <>
                    {/* Input */}
                    <div>
                      <div className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-1.5">
                        Input
                      </div>
                      {renderToolInput(inputData)}
                    </div>

                    {/* Output */}
                    <div>
                      <div className={`text-xs font-semibold uppercase tracking-wider mb-1.5 ${isError ? 'text-red-500' : 'text-neutral-500 dark:text-neutral-400'}`}>
                        {isError ? 'Output (Error)' : 'Output'}
                      </div>
                      {result ? (
                        <pre className={`border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto ${
                          isError
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700 text-red-700 dark:text-red-400'
                            : 'bg-neutral-50 dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300'
                        }`}>
                          {formatToolOutput(result.content)}
                        </pre>
                      ) : (
                        <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">Pending...</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
