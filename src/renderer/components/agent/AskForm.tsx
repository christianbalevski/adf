import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '../ui'
import {
  ASK_ALL_SKIPPED,
  parseAskResult,
  type AskAnswer,
  type AskQuestion,
} from '../../../shared/utils/ask-form'

/**
 * The agent's `ask` as a form: one block per question. Free text takes a
 * growing text box; options take one pick (radio) or several (`multiple`,
 * checkboxes), and every choice question ends in "Other…" with its own text.
 * Nothing is required: a blank question is sent as skipped.
 */

/** What the human has entered for one question. */
export interface AskDraft {
  /** Option labels picked. */
  picks: string[]
  /** Free text: the answer of a text question, or the "Other…" text. */
  other: string
  /** "Other…" is selected (choice questions only). */
  otherPicked: boolean
}

export const EMPTY_DRAFT: AskDraft = { picks: [], other: '', otherPicked: false }

/** Click an option: single choice replaces the pick (and clears Other), multiple toggles it. */
export function pickOption(q: AskQuestion, d: AskDraft, label: string): AskDraft {
  if (!q.multiple) return { ...d, picks: [label], otherPicked: false }
  return { ...d, picks: d.picks.includes(label) ? d.picks.filter((p) => p !== label) : [...d.picks, label] }
}

/** Click the "Other…" radio/checkbox. */
export function toggleOther(q: AskQuestion, d: AskDraft): AskDraft {
  if (!q.multiple) return { ...d, picks: [], otherPicked: true }
  return { ...d, otherPicked: !d.otherPicked }
}

/** Type in the "Other…" box (or a text question's box). Typing selects Other. */
export function typeOther(q: AskQuestion, d: AskDraft, text: string): AskDraft {
  if (!q.options) return { ...d, other: text }
  if (!q.multiple) return { picks: [], other: text, otherPicked: true }
  return { ...d, other: text, otherPicked: d.otherPicked || text.trim() !== '' }
}

/** The answer a draft sends: `null` when nothing was entered. */
export function draftAnswer(q: AskQuestion, d: AskDraft): AskAnswer {
  const other = d.other.trim()
  if (!q.options) return other || null
  const extra = d.otherPicked && other ? [other] : []
  if (q.multiple) {
    const all = [...d.picks, ...extra]
    return all.length > 0 ? all : null
  }
  if (d.otherPicked) return other || null
  return d.picks[0] ?? null
}

/**
 * Per-question display answers of an answered ask, from its tool result
 * (`null` = skipped). A single question whose result is in no known shape
 * (an answer kept as typed) shows the text as is.
 */
export function askDisplayAnswers(questions: AskQuestion[], result: string): Array<string | null> {
  const known = result === ASK_ALL_SKIPPED || result.startsWith('Q: ') || result.startsWith('Human answered: ')
  if (!known && questions.length === 1) return [result && result !== '[skipped]' ? result : null]
  return parseAskResult(questions, result)
}

function AutoGrowTextarea({ value, onChange, ...props }: {
  value: string
  onChange: (value: string) => void
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])
  return (
    <textarea
      {...props}
      ref={ref}
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full resize-none overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--paper)] px-2 py-1.5 text-sm leading-5 text-[var(--ink)] placeholder:text-[var(--ink-faint)]"
    />
  )
}

function QuestionHeading({ q, index, count, id }: { q: AskQuestion; index: number; count: number; id?: string }) {
  return (
    <span id={id} className="flex gap-1.5 text-sm text-[var(--ink)]">
      {count > 1 && <span className="shrink-0 tabular-nums text-[var(--ink-muted)]">{index + 1}.</span>}
      <span className="min-w-0 whitespace-pre-wrap break-words">{q.question}</span>
    </span>
  )
}

const ROW = 'flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--paper-sunken)]'
const MARK = 'h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--blue)]'

function QuestionField({ q, index, count, draft, onChange, formId }: {
  q: AskQuestion
  index: number
  count: number
  draft: AskDraft
  onChange: (draft: AskDraft) => void
  formId: string
}) {
  const headingId = `${formId}-q${index}`
  const otherRef = useRef<HTMLInputElement>(null)
  const n = count > 1 ? ` ${index + 1}` : ''

  if (!q.options) {
    return (
      <label className="block space-y-1.5">
        <QuestionHeading q={q} index={index} count={count} />
        <AutoGrowTextarea
          value={draft.other}
          onChange={(text) => onChange(typeOther(q, draft, text))}
          placeholder="Your answer"
          data-ask-field
        />
      </label>
    )
  }

  const type = q.multiple ? 'checkbox' : 'radio'
  const name = `${formId}-q${index}`
  return (
    <fieldset className="min-w-0 space-y-1" aria-labelledby={headingId}>
      <div className="space-y-0.5">
        <QuestionHeading q={q} index={index} count={count} id={headingId} />
        {q.multiple && <div className="text-[11px] text-[var(--ink-faint)]">Pick any</div>}
      </div>
      <div className="-mx-1.5">
        {q.options.map((option) => {
          const checked = draft.picks.includes(option.label)
          return (
            <label key={option.label} className={`${ROW} ${checked ? 'bg-[var(--tint-soft)]' : ''}`}>
              <input
                type={type}
                name={name}
                className={`${MARK} mt-[3px]`}
                checked={checked}
                onChange={() => onChange(pickOption(q, draft, option.label))}
                data-ask-field
              />
              <span className="min-w-0">
                <span className="block text-sm text-[var(--ink)] break-words">{option.label}</span>
                {option.description && (
                  <span className="block text-[11px] leading-4 text-[var(--ink-muted)] break-words">{option.description}</span>
                )}
              </span>
            </label>
          )
        })}
        <div className={`${ROW} items-center ${draft.otherPicked ? 'bg-[var(--tint-soft)]' : ''}`} onClick={() => otherRef.current?.focus()}>
          <input
            type={type}
            name={name}
            className={MARK}
            checked={draft.otherPicked}
            onChange={() => {
              onChange(toggleOther(q, draft))
              otherRef.current?.focus()
            }}
            aria-label={`Other${n}`}
          />
          <input
            ref={otherRef}
            type="text"
            value={draft.other}
            onChange={(e) => onChange(typeOther(q, draft, e.target.value))}
            onKeyDown={(e) => {
              // Enter alone must not send the whole form from one text box.
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) e.preventDefault()
            }}
            placeholder="Other…"
            aria-label={`Other answer${n}`}
            className="min-w-0 flex-1 border-0 border-b border-[var(--rule)] bg-transparent px-0 py-0.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--blue)]"
          />
        </div>
      </div>
    </fieldset>
  )
}

/** Resolves with an error message when the answer did not land. */
export type AskSubmit = (answers: AskAnswer[]) => Promise<string | null | undefined> | string | null | undefined | void

// Entered answers by ask, so a form scrolled out of the list and back keeps them.
const keptDrafts = new Map<string, AskDraft[]>()
const focusedForms = new Set<string>()

/**
 * A pending ask, answerable. `onSubmit` gets one answer per question (`null`
 * = skipped) and resolves with an error message when the answer did not land.
 */
export function AskForm({ questions, onSubmit, draftKey, autoFocus = false }: {
  questions: AskQuestion[]
  onSubmit: AskSubmit
  /** Keeps the entered answers across remounts (the loop list unmounts rows scrolled away). */
  draftKey?: string
  /** Move focus to the first field the first time this form shows. */
  autoFocus?: boolean
}) {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [drafts, setDraftState] = useState<AskDraft[]>(() =>
    (draftKey && keptDrafts.get(draftKey)) || questions.map(() => EMPTY_DRAFT))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setDrafts = (update: (all: AskDraft[]) => AskDraft[]) => setDraftState((all) => {
    const next = update(all)
    if (draftKey) keptDrafts.set(draftKey, next)
    return next
  })

  useEffect(() => {
    if (!autoFocus || (draftKey && focusedForms.has(draftKey))) return
    if (draftKey) focusedForms.add(draftKey)
    // Only take focus from nowhere or from the (now locked) composer.
    const active = document.activeElement
    if (active && active !== document.body && !active.classList.contains('loop-composer-input')) return
    formRef.current?.querySelector<HTMLElement>('[data-ask-field]')?.focus({ preventScroll: true })
  }, [autoFocus, draftKey])

  const send = useCallback(async (answers: AskAnswer[]) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const failure = await onSubmit(answers)
      if (failure) setError(failure)
      else if (draftKey) keptDrafts.delete(draftKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, onSubmit, draftKey])

  const submit = () => void send(questions.map((q, i) => draftAnswer(q, drafts[i] ?? EMPTY_DRAFT)))
  const skipAll = () => void send(questions.map(() => null))

  const handleKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => { e.preventDefault(); submit() }}
      onKeyDown={handleKeyDown}
      className="space-y-3"
      aria-busy={busy || undefined}
    >
      {questions.map((q, i) => (
        <QuestionField
          key={i}
          q={q}
          index={i}
          count={questions.length}
          draft={drafts[i] ?? EMPTY_DRAFT}
          formId={formId}
          onChange={(draft) => setDrafts((all) => all.map((d, j) => (j === i ? draft : d)))}
        />
      ))}
      {error && (
        <div role="alert" className="text-[11px] text-[var(--adf-ui-danger)]">{error}</div>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-[11px] text-[var(--ink-faint)]">
          {questions.length > 1 ? 'Blank questions are skipped' : 'Leave blank to skip'}
        </span>
        <Button type="button" size="compact" variant="ghost" onClick={skipAll} disabled={busy}>
          Skip all
        </Button>
        <Button type="submit" size="compact" variant="primary" loading={busy} title="Submit (⌘/Ctrl+Enter)">
          Submit
        </Button>
      </div>
    </form>
  )
}

/** An ask's questions with their answers, read-only. Without `answers` (no answer came) only the questions show. */
export function AskAnswers({ questions, answers }: {
  questions: AskQuestion[]
  answers?: Array<string | null> | null
}) {
  return (
    <ol className="space-y-2.5">
      {questions.map((q, i) => {
        const answer = answers ? answers[i] ?? null : undefined
        return (
          <li key={i} className="space-y-0.5">
            <QuestionHeading q={q} index={i} count={questions.length} />
            {answer !== undefined && (
              <div className={`${questions.length > 1 ? 'pl-4' : ''} text-sm whitespace-pre-wrap break-words ${answer === null ? 'italic text-[var(--ink-faint)]' : 'text-[var(--ink-muted)]'}`}>
                {answer === null ? 'Skipped' : answer}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The ask card in the loop: the form while the ask is pending, the questions
 * and answers once answered (`result` = the stored tool result).
 */
export function AskCard({ questions, pending, result, onSubmit, draftKey }: {
  questions: AskQuestion[]
  pending: boolean
  result?: string | null
  onSubmit?: AskSubmit
  /** The pending ask's request id: keeps entered answers across remounts. */
  draftKey?: string
}) {
  const answerable = pending && !result && onSubmit
  return (
    <div className={`overflow-hidden rounded-[var(--adf-ui-container-radius)] border border-[var(--rule)] bg-[var(--paper)] ${answerable ? 'border-l-2 border-l-[var(--blue)]' : ''}`}>
      <div className="p-2.5">
        <div className="mb-1.5 text-[12px] font-medium text-[var(--ink-muted)]">
          {questions.length > 1 ? `Agent asked ${questions.length} questions` : 'Agent asked'}
        </div>
        {answerable
          ? <AskForm questions={questions} onSubmit={onSubmit} draftKey={draftKey} autoFocus />
          : <AskAnswers questions={questions} answers={result ? askDisplayAnswers(questions, result) : null} />}
      </div>
    </div>
  )
}
