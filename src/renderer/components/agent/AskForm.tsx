import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '../ui'
import { parseAskResult, type AskAnswer, type AskQuestion } from '../../../shared/utils/ask-form'

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

const EMPTY_DRAFT: AskDraft = { picks: [], other: '', otherPicked: false }

/** Click an option: single choice replaces the pick (and clears Other), multiple toggles it. */
function pickOption(q: AskQuestion, d: AskDraft, label: string): AskDraft {
  if (!q.multiple) return { ...d, picks: [label], otherPicked: false }
  return { ...d, picks: d.picks.includes(label) ? d.picks.filter((p) => p !== label) : [...d.picks, label] }
}

/** Click the "Other…" radio/checkbox. */
function toggleOther(q: AskQuestion, d: AskDraft): AskDraft {
  if (!q.multiple) return { ...d, picks: [], otherPicked: true }
  return { ...d, otherPicked: !d.otherPicked }
}

/** Click the checked radio again: the question goes back to unanswered. Other's text stays. */
function clearPick(d: AskDraft): AskDraft {
  return { ...d, picks: [], otherPicked: false }
}

/** Type in the "Other…" box (or a text question's box). Typing selects Other. */
function typeOther(q: AskQuestion, d: AskDraft, text: string): AskDraft {
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
      <div className="space-y-1.5">
        <QuestionHeading q={q} index={index} count={count} id={headingId} />
        <AutoGrowTextarea
          value={draft.other}
          onChange={(text) => onChange(typeOther(q, draft, text))}
          placeholder="Answer"
          aria-labelledby={headingId}
        />
      </div>
    )
  }

  const type = q.multiple ? 'checkbox' : 'radio'
  const name = `${formId}-q${index}`
  // A checked radio fires no change when clicked again: its click unpicks it.
  const unpick = q.multiple ? undefined : () => onChange(clearPick(draft))
  return (
    <fieldset className="min-w-0 space-y-1" aria-labelledby={headingId}>
      <div className="space-y-0.5">
        <QuestionHeading q={q} index={index} count={count} id={headingId} />
        {q.multiple && <div className="text-[11px] text-[var(--ink-faint)]">Multiple selection</div>}
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
                onClick={checked ? unpick : undefined}
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
        <div
          className={`${ROW} items-center ${draft.otherPicked ? 'bg-[var(--tint-soft)]' : ''}`}
          onClick={(e) => { if (e.target === e.currentTarget) otherRef.current?.focus() }}
        >
          <input
            type={type}
            name={name}
            className={MARK}
            checked={draft.otherPicked}
            onChange={() => {
              const next = toggleOther(q, draft)
              onChange(next)
              if (next.otherPicked) otherRef.current?.focus()
            }}
            onClick={draft.otherPicked ? unpick : undefined}
            aria-label={`Other${n}`}
          />
          <input
            ref={otherRef}
            type="text"
            value={draft.other}
            onChange={(e) => onChange(typeOther(q, draft, e.target.value))}
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
type AskSubmit = (answers: AskAnswer[]) => Promise<string | null | undefined> | string | null | undefined | void

/**
 * A pending ask, answerable. `onSubmit` gets one answer per question (`null`
 * = skipped) and resolves with an error message when the answer did not land.
 * `drafts` seeds what was entered before (the loop list unmounts rows scrolled
 * away) and `onDraftsChange` hands every edit back to be kept.
 */
export function AskForm({ questions, drafts: initialDrafts, onDraftsChange, onSubmit }: {
  questions: AskQuestion[]
  drafts?: AskDraft[]
  onDraftsChange?: (drafts: AskDraft[]) => void
  onSubmit: AskSubmit
}) {
  const formId = useId()
  const [drafts, setDrafts] = useState<AskDraft[]>(() => initialDrafts ?? questions.map(() => EMPTY_DRAFT))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editDraft = (index: number, draft: AskDraft) => {
    const next = questions.map((_, j) => (j === index ? draft : drafts[j] ?? EMPTY_DRAFT))
    setDrafts(next)
    onDraftsChange?.(next)
  }

  const send = async (answers: AskAnswer[]) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const failure = await onSubmit(answers)
      if (failure) setError(failure)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => void send(questions.map((q, i) => draftAnswer(q, drafts[i] ?? EMPTY_DRAFT)))
  const skipAll = () => void send(questions.map(() => null))

  const handleKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter') return
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      submit()
      return
    }
    // Only ⌘/Ctrl+Enter and the Submit button send: Enter in a text box,
    // radio or checkbox must not submit the whole form implicitly.
    if (e.target instanceof HTMLInputElement) e.preventDefault()
  }

  return (
    <form
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
          onChange={(draft) => editDraft(i, draft)}
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
 * The ask card in the loop: the form while the ask is pending (`onSubmit`
 * given), else the questions and answers (`result` = the stored tool result).
 */
export function AskCard({ questions, result, drafts, onDraftsChange, onSubmit }: {
  questions: AskQuestion[]
  result?: string | null
  drafts?: AskDraft[]
  onDraftsChange?: (drafts: AskDraft[]) => void
  onSubmit?: AskSubmit
}) {
  return (
    <div className={`overflow-hidden rounded-[var(--adf-ui-container-radius)] border border-[var(--rule)] bg-[var(--paper)] ${onSubmit ? 'border-l-2 border-l-[var(--blue)]' : ''}`}>
      <div className="p-2.5">
        <div className="mb-1.5 text-[12px] font-medium text-[var(--ink-muted)]">
          {questions.length > 1 ? `${questions.length} questions` : 'Question'}
        </div>
        {onSubmit
          ? <AskForm questions={questions} drafts={drafts} onDraftsChange={onDraftsChange} onSubmit={onSubmit} />
          : <AskAnswers questions={questions} answers={result ? parseAskResult(questions, result) : null} />}
      </div>
    </div>
  )
}
