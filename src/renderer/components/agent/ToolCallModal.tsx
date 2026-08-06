import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { diffLines, diffWordsWithSpace, type Change } from 'diff'
import {
  TOOL_FAMILY_STYLES,
  ATTENTION_TOOL_STYLE,
  ERROR_TOOL_STYLE,
  getToolFamily,
  getToolTarget,
  parseShellOutput,
  formatToolOutput,
  formatCallDuration,
  highlightCode,
  looksLikeCode,
  isRichString,
} from './tool-presentation'

/**
 * Unified tool call modal — the single inspector for tool calls across the
 * loop chat and the fleet map. Input renders as YAML-like flowing text
 * (key: value, kind-aware — prose wraps under its key, commands get a
 * terminal block, edits get a collapsing diff); the result sits in the one
 * bordered "console" card, which alone marks the input/output boundary.
 * Host surfaces supply their own chrome via slots (headerLead,
 * headerActions, approvalControls) — no per-tool custom interfaces, the
 * argument *shape* drives the treatment.
 */

export interface ToolCallModalResult {
  content: string
  isError: boolean
  imageUrl?: string
}

const SECTION_LABEL = 'text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1'
const KEY_CLS = 'font-mono text-[11px] font-semibold text-indigo-500 dark:text-indigo-400'
const PRE_PLAIN = 'text-xs font-mono whitespace-pre-wrap break-all overflow-y-auto text-neutral-600 dark:text-neutral-300'

// --- Diff (jsdiff) with word-level highlights and collapsing runs ------------

type DiffUnit =
  | { kind: 'same'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }
  /** Paired removal→addition with word-level pieces for intra-line highlighting. */
  | { kind: 'hunk'; del: Change[]; add: Change[] }

const WORD_DIFF_MAX_CHARS = 10_000

function stripTrail(value: string): string {
  return value.replace(/\n$/, '')
}

function pushLines(units: DiffUnit[], kind: 'del' | 'add', value: string): void {
  for (const text of stripTrail(value).split('\n')) units.push({ kind, text })
}

/**
 * Line diff via jsdiff (Myers); a removal immediately followed by an addition
 * becomes a word-diffed hunk so prose edits highlight the changed words
 * instead of repainting whole paragraphs.
 */
function buildDiffUnits(oldText: string | undefined, newText: string | undefined): DiffUnit[] {
  const units: DiffUnit[] = []
  if (!oldText) {
    if (newText) pushLines(units, 'add', newText)
    return units
  }
  if (!newText) {
    pushLines(units, 'del', oldText)
    return units
  }
  const parts = diffLines(stripTrail(oldText), stripTrail(newText))
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (!part.added && !part.removed) {
      for (const text of stripTrail(part.value).split('\n')) units.push({ kind: 'same', text })
      continue
    }
    if (part.removed) {
      const next = parts[index + 1]
      if (next?.added) {
        index++
        if (part.value.length + next.value.length <= WORD_DIFF_MAX_CHARS) {
          const words = diffWordsWithSpace(stripTrail(part.value), stripTrail(next.value))
          units.push({
            kind: 'hunk',
            del: words.filter((w) => !w.added),
            add: words.filter((w) => !w.removed),
          })
        } else {
          pushLines(units, 'del', part.value)
          pushLines(units, 'add', next.value)
        }
        continue
      }
      pushLines(units, 'del', part.value)
    } else {
      pushLines(units, 'add', part.value)
    }
  }
  return units
}

const DIFF_CONTEXT = 2

/** A del/add row whose changed words carry a stronger tint. */
function HunkRow({ pieces, side }: { pieces: Change[]; side: 'del' | 'add' }) {
  const rowCls = side === 'del'
    ? 'text-red-600 dark:text-red-300'
    : 'text-green-700 dark:text-green-300'
  const gutterCls = side === 'del' ? 'text-red-400/80' : 'text-green-500/80'
  const strongCls = side === 'del'
    ? 'bg-red-200/80 dark:bg-red-800/60 rounded-[2px]'
    : 'bg-green-200/80 dark:bg-green-800/60 rounded-[2px]'
  return (
    <div className={`flex ${rowCls}`}>
      <span className={`w-5 shrink-0 select-none text-center ${gutterCls}`}>{side === 'del' ? '-' : '+'}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
        {pieces.map((piece, index) =>
          (side === 'del' ? piece.removed : piece.added)
            ? <span key={index} className={strongCls}>{piece.value}</span>
            : <Fragment key={index}>{piece.value}</Fragment>
        )}
      </span>
    </div>
  )
}

/**
 * Diff for edit-shaped inputs. Word-level highlights inside changed hunks;
 * unchanged runs longer than ~5 lines collapse into a clickable
 * "N unchanged lines" row (± context stays visible).
 */
function DiffBlock({ oldText, newText }: { oldText?: string; newText?: string }) {
  const units = useMemo(() => buildDiffUnits(oldText, newText), [oldText, newText])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Split into alternating segments of unchanged/changed units
  const segments = useMemo(() => {
    const segs: { same: boolean; units: DiffUnit[] }[] = []
    for (const unit of units) {
      const same = unit.kind === 'same'
      const last = segs[segs.length - 1]
      if (last && last.same === same) last.units.push(unit)
      else segs.push({ same, units: [unit] })
    }
    return segs
  }, [units])

  const renderUnit = (unit: DiffUnit, key: string) => {
    if (unit.kind === 'hunk') {
      return (
        <Fragment key={key}>
          <HunkRow pieces={unit.del} side="del" />
          <HunkRow pieces={unit.add} side="add" />
        </Fragment>
      )
    }
    return (
      <div
        key={key}
        className={`flex ${
          unit.kind === 'del'
            ? 'text-red-600 dark:text-red-300'
            : unit.kind === 'add'
              ? 'text-green-700 dark:text-green-300'
              : 'text-neutral-500 dark:text-neutral-400'
        }`}
      >
        <span className={`w-5 shrink-0 select-none text-center ${
          unit.kind === 'del' ? 'text-red-400/80' : unit.kind === 'add' ? 'text-green-500/80' : 'text-neutral-300 dark:text-neutral-600'
        }`}>
          {unit.kind === 'del' ? '-' : unit.kind === 'add' ? '+' : ' '}
        </span>
        <span className="whitespace-pre-wrap break-all pr-2">{unit.text || ' '}</span>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden text-xs font-mono leading-5 max-h-80 overflow-y-auto">
      {segments.map((seg, segIndex) => {
        if (!seg.same || seg.units.length <= DIFF_CONTEXT * 2 + 1 || expanded.has(segIndex)) {
          return <Fragment key={segIndex}>{seg.units.map((unit, k) => renderUnit(unit, `${segIndex}:${k}`))}</Fragment>
        }
        // Long unchanged run: keep context lines toward adjacent changes only
        const head = segIndex === 0 ? [] : seg.units.slice(0, DIFF_CONTEXT)
        const tail = segIndex === segments.length - 1 ? [] : seg.units.slice(seg.units.length - DIFF_CONTEXT)
        const hidden = seg.units.length - head.length - tail.length
        return (
          <Fragment key={segIndex}>
            {head.map((unit, k) => renderUnit(unit, `${segIndex}:h${k}`))}
            <button
              onClick={() => setExpanded((prev) => new Set(prev).add(segIndex))}
              className="flex w-full items-center gap-1.5 px-5 py-0.5 bg-neutral-50 dark:bg-neutral-800/60 text-[11px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <span aria-hidden>⋯</span>
              <span>{hidden} unchanged {hidden === 1 ? 'line' : 'lines'}</span>
            </button>
            {tail.map((unit, k) => renderUnit(unit, `${segIndex}:t${k}`))}
          </Fragment>
        )
      })}
    </div>
  )
}

// --- YAML-like argument rendering -------------------------------------------

/**
 * One argument as YAML-ish text: `key: value` with the value wrapping under
 * the key like a paragraph. Commands/code/large structures get an indented
 * block under the `key:` line instead.
 */
function YamlArg({ argKey, value }: { argKey: string; value: unknown }) {
  const keySpan = <span className={KEY_CLS}>{argKey}: </span>
  const block = (node: ReactNode) => (
    <div>
      <div className="leading-5">{keySpan}</div>
      <div className="mt-0.5 mb-1 ml-3">{node}</div>
    </div>
  )

  if (typeof value === 'string') {
    if (argKey === 'command') {
      return block(
        <pre className="bg-neutral-900 dark:bg-neutral-950 border border-neutral-700 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto text-green-400">
          {value}
        </pre>
      )
    }
    if (argKey === 'sql' || argKey === 'code' || looksLikeCode(value)) {
      return block(<pre className={`${PRE_PLAIN} max-h-60`}>{highlightCode(value.trim())}</pre>)
    }
    if (isRichString(value)) {
      return (
        <div className="leading-relaxed">
          {keySpan}
          <span className="text-[12.5px] text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap break-words">{value}</span>
        </div>
      )
    }
    return (
      <div className="leading-5">
        {keySpan}
        {value === ''
          ? <span className="text-xs font-mono text-neutral-400 dark:text-neutral-500">""</span>
          : <span className="text-[12.5px] text-neutral-700 dark:text-neutral-200 break-words">{value}</span>}
      </div>
    )
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return (
      <div className="leading-5">
        {keySpan}
        <span className="text-xs font-mono text-sky-600 dark:text-sky-400">{String(value)}</span>
      </div>
    )
  }

  let json: string
  try { json = JSON.stringify(value) } catch { json = String(value) }
  if (json.length <= 72) {
    return (
      <div className="leading-5">
        {keySpan}
        <span className="text-xs font-mono text-neutral-600 dark:text-neutral-300 break-all">{json}</span>
      </div>
    )
  }
  try { json = JSON.stringify(value, null, 2) } catch { /* keep compact form */ }
  return block(<pre className={`${PRE_PLAIN} max-h-60`}>{json}</pre>)
}

// --- Modal ------------------------------------------------------------------

export const ToolCallModal = memo(function ToolCallModal({
  toolName,
  input,
  result,
  awaitingApproval = false,
  durationMs,
  startedAt,
  toolId,
  subtitle,
  headerLead,
  headerActions,
  approvalControls,
  rawPayload,
  variant = 'fixed',
  onClose,
}: {
  toolName: string
  input: unknown
  /** Completed result; null/undefined while pending. */
  result?: ToolCallModalResult | null
  awaitingApproval?: boolean
  durationMs?: number | null
  /** Unix ms the call started — shown in the footer meta line. */
  startedAt?: number
  toolId?: string
  /** Second header line (fleet: the agent's file path). */
  subtitle?: string
  /** Rendered before the tool name (fleet: agent icon + "wants to call"). */
  headerLead?: ReactNode
  /** Extra header buttons, left of the close button. */
  headerActions?: ReactNode
  /** Approve/reject controls, shown in the footer while awaiting approval. */
  approvalControls?: ReactNode
  /** Payload for the Raw view; defaults to { input, result }. */
  rawPayload?: unknown
  /** fixed = app-level overlay (loop); absolute = within a positioned host (fleet map). */
  variant?: 'fixed' | 'absolute'
  onClose: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
  const reason = typeof record?._reason === 'string' ? record._reason.trim() : ''
  const target = getToolTarget(toolName, record)

  // Edit-shaped inputs render as a diff; write/append content renders as
  // all-added lines; message-shaped inputs (content + a recipient) render as
  // a sent-message card. Everything else falls through to YAML-style args.
  const { diff, message, argEntries } = useMemo(() => {
    const entries = record ? Object.entries(record).filter(([k]) => k !== '_reason') : []
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    const oldText = typeof record?.old_text === 'string' ? record.old_text : undefined
    const newText = typeof record?.new_text === 'string' ? record.new_text : undefined
    const content = typeof record?.content === 'string' ? record.content : undefined
    const mode = typeof record?.mode === 'string' ? record.mode : undefined
    if (oldText !== undefined || newText !== undefined) {
      return {
        diff: { oldText, newText },
        message: null,
        argEntries: entries.filter(([k]) => k !== 'old_text' && k !== 'new_text'),
      }
    }
    if (content !== undefined && (mode === 'write' || mode === 'append')) {
      return {
        diff: { oldText: undefined, newText: content },
        message: null,
        argEntries: entries.filter(([k]) => k !== 'content'),
      }
    }
    const recipient = str(record?.recipient) || str(record?.to)
    const address = str(record?.address)
    if (content !== undefined && (recipient || address)) {
      const MESSAGE_KEYS = new Set(['recipient', 'to', 'address', 'subject', 'content', 'thread_id'])
      return {
        diff: null,
        message: {
          to: recipient && address && recipient !== address ? `${recipient} (${address})` : recipient || address,
          subject: str(record?.subject),
          content,
          threadId: str(record?.thread_id),
        },
        argEntries: entries.filter(([k]) => !MESSAGE_KEYS.has(k)),
      }
    }
    return { diff: null, message: null, argEntries: entries }
  }, [record])

  const isError = result?.isError === true
  const shell = result && !isError ? parseShellOutput(result.content) : null
  const status = awaitingApproval
    ? { label: 'awaiting approval', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400' }
    : isError
      ? { label: 'error', cls: 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' }
      : result
        ? { label: 'ok', cls: 'bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400' }
        : { label: 'running…', cls: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400' }
  const accent = awaitingApproval ? ATTENTION_TOOL_STYLE : isError ? ERROR_TOOL_STYLE : TOOL_FAMILY_STYLES[getToolFamily(toolName)]

  const hasInput = Boolean(reason || diff || argEntries.length > 0 || (!record && input != null))

  return (
    <div
      className={`${variant === 'fixed' ? 'fixed' : 'absolute'} inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm`}
      style={variant === 'absolute' ? { animation: 'meshFadeIn 150ms ease-out' } : undefined}
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[82vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 pt-3 pb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {headerLead}
            <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} aria-hidden />
            <span className="text-[14px] font-mono font-semibold text-neutral-800 dark:text-neutral-100 shrink-0">
              {toolName}
            </span>
            {target && (
              <span className="min-w-0 truncate font-mono text-[11px] text-neutral-400 dark:text-neutral-500" title={target}>
                {target}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-px rounded-full font-medium shrink-0 ${status.cls}`}>
              {status.label}
            </span>
            {durationMs != null && (
              <span className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500 shrink-0">
                {formatCallDuration(durationMs)}
              </span>
            )}
            <span className="flex-1" />
            <button
              onClick={() => setShowRaw((v) => !v)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded-full shrink-0 transition-colors ${
                showRaw
                  ? 'bg-blue-500 text-white'
                  : 'border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              }`}
            >
              {showRaw ? 'Formatted' : 'Raw'}
            </button>
            {headerActions}
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 shrink-0"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
          {subtitle && (
            <div className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate mt-0.5" title={subtitle}>
              {subtitle}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3 space-y-2.5">
          {showRaw ? (
            <pre className={`${PRE_PLAIN} bg-neutral-50 dark:bg-neutral-900/70 border border-neutral-200 dark:border-neutral-700 rounded-lg p-2 max-h-[60vh]`}>
              {JSON.stringify(rawPayload ?? { input, result }, null, 2)}
            </pre>
          ) : (
            <>
              {/* Input — YAML-like flowing text, no card */}
              {hasInput && (
                <div>
                  <div className={SECTION_LABEL}>input</div>
                  <div className="space-y-1">
                    {reason && (
                      <div className="leading-relaxed">
                        <span className={`font-mono text-[11px] font-semibold ${
                          awaitingApproval ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-400 dark:text-neutral-500'
                        }`}>
                          reason:{' '}
                        </span>
                        <span className="text-[12.5px] text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap">
                          {reason}
                        </span>
                      </div>
                    )}
                    {message && (
                      <div className="rounded-xl border border-indigo-200 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-900/15 px-3 py-2">
                        <div className="flex items-baseline gap-2 min-w-0 text-[11px]">
                          <span className="shrink-0 font-semibold text-indigo-600 dark:text-indigo-400">To:</span>
                          <span className="min-w-0 truncate font-mono text-neutral-700 dark:text-neutral-200" title={message.to}>
                            {message.to}
                          </span>
                          {message.threadId && (
                            <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500" title={message.threadId}>
                              thread {message.threadId}
                            </span>
                          )}
                        </div>
                        {message.subject && (
                          <div className="mt-0.5 text-[12.5px] font-medium text-indigo-700 dark:text-indigo-300">
                            {message.subject}
                          </div>
                        )}
                        <div className="mt-1.5 border-t border-indigo-200/60 dark:border-indigo-800/40 pt-1.5 text-[12.5px] leading-relaxed text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                          {message.content}
                        </div>
                      </div>
                    )}
                    {argEntries.map(([key, value]) => (
                      <YamlArg key={key} argKey={key} value={value} />
                    ))}
                    {diff && <DiffBlock oldText={diff.oldText} newText={diff.newText} />}
                    {!record && input != null && (
                      <pre className={`${PRE_PLAIN} max-h-60`}>{JSON.stringify(input, null, 2)}</pre>
                    )}
                  </div>
                </div>
              )}

              {/* Result — the one bordered "console" card marks the output zone */}
              {!awaitingApproval && (
                <div>
                  <div className={`${SECTION_LABEL} ${isError ? 'text-red-500 dark:text-red-400' : ''}`}>
                    {isError ? 'result — error' : 'result'}
                  </div>
                  <div className={`rounded-xl border overflow-hidden ${
                    isError
                      ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/20'
                      : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950/40'
                  }`}>
                    {!result ? (
                      <p className="px-3 py-2 text-xs italic text-neutral-400 dark:text-neutral-500">Pending…</p>
                    ) : shell ? (
                      <div className="px-3 py-2 space-y-2">
                        {shell.stdout && (
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto text-neutral-700 dark:text-neutral-300">
                            {shell.stdout}
                          </pre>
                        )}
                        {shell.stderr && (
                          <pre className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto text-red-700 dark:text-red-400">
                            {shell.stderr}
                          </pre>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">exit</span>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                            shell.exit_code === 0
                              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                              : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                          }`}>
                            {shell.exit_code}
                          </span>
                          {!shell.stdout && !shell.stderr && shell.exit_code === 0 && (
                            <span className="text-xs text-neutral-400 dark:text-neutral-500 italic">(no output)</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="px-3 py-2">
                        <pre className={`text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto ${
                          isError ? 'text-red-700 dark:text-red-400' : 'text-neutral-700 dark:text-neutral-300'
                        }`}>
                          {formatToolOutput(result.content)}
                        </pre>
                        {result.imageUrl && (
                          <img
                            src={result.imageUrl}
                            alt="tool result"
                            className="mt-2 max-w-full max-h-64 rounded-lg border border-neutral-200 dark:border-neutral-700"
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer — meta line and, while pending approval, the decision bar */}
        {(approvalControls || startedAt || toolId) && (
          <div className="flex items-center gap-3 px-4 py-2 border-t border-neutral-100 dark:border-neutral-800">
            <span className="flex-1 min-w-0 truncate text-[10px] text-neutral-400 dark:text-neutral-500">
              {startedAt ? new Date(startedAt).toLocaleTimeString() : ''}
              {toolId ? `${startedAt ? ' · ' : ''}${toolId}` : ''}
            </span>
            {approvalControls}
          </div>
        )}
      </div>
    </div>
  )
})
