/**
 * The `ask` tool's form model, shared by the executor, every answering
 * surface (Studio, TUI, CLI, daemon) and the transcript renderers.
 *
 * A form is a list of questions. A question with no options takes free text;
 * with options it takes one pick (or several with `multiple`), and "Other"
 * free text is always allowed. Every question can be skipped.
 *
 * The agent gets plain question/answer text back — it already has the
 * options in its own tool call.
 */

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  options?: AskOption[]
  multiple?: boolean
}

/**
 * One answer per question, in order. A string is free text (or one pick);
 * an array is several picks. A value that is not one of the option labels is
 * the human's "Other" text. `null` = skipped.
 */
export type AskAnswer = string | string[] | null

export const ASK_SKIPPED = '(skipped)'
export const ASK_ALL_SKIPPED = 'The human skipped all questions.'

/** A malformed answer payload — surfaces map it to a 400 / inline error. */
export class AskAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AskAnswerError'
  }
}

/**
 * Read an `ask` tool call's input as questions. Also reads the pre-form
 * `{ question }` shape so stored history keeps rendering.
 */
export function askQuestions(input: unknown): AskQuestion[] {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (Array.isArray(obj.questions)) {
    const out: AskQuestion[] = []
    for (const raw of obj.questions) {
      if (!raw || typeof raw !== 'object') continue
      const q = raw as Record<string, unknown>
      if (typeof q.question !== 'string') continue
      const options = Array.isArray(q.options)
        ? q.options.flatMap((o): AskOption[] => {
            if (o && typeof o === 'object' && typeof (o as AskOption).label === 'string') {
              const { label, description } = o as AskOption
              return [typeof description === 'string' && description ? { label, description } : { label }]
            }
            return []
          })
        : []
      out.push({
        question: q.question,
        ...(options.length > 0 ? { options } : {}),
        ...(options.length > 0 && q.multiple === true ? { multiple: true } : {})
      })
    }
    return out
  }
  if (typeof obj.question === 'string') return [{ question: obj.question }]
  return []
}

/** One line for alerts, notifications and menus: the first question, plus how many more. */
export function summarizeAsk(questions: AskQuestion[]): string {
  if (questions.length === 0) return ''
  const first = questions[0].question
  return questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first
}

/**
 * Validate and normalize a submitted answer payload against the questions.
 * Trims text, drops empty picks, turns empty answers into `null`. Throws
 * AskAnswerError naming the offending question.
 */
export function normalizeAskAnswers(questions: AskQuestion[], raw: unknown): AskAnswer[] {
  if (!Array.isArray(raw)) throw new AskAnswerError('answers must be an array with one entry per question')
  if (raw.length !== questions.length) {
    throw new AskAnswerError(`answers has ${raw.length} entries but the ask has ${questions.length} question${questions.length === 1 ? '' : 's'}`)
  }
  return questions.map((q, i) => {
    const value = raw[i]
    const n = i + 1
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value.trim() || null
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new AskAnswerError(`answer ${n} must be a string, an array of strings, or null`)
    }
    const picks = (value as string[]).map((v) => v.trim()).filter(Boolean)
    if (picks.length === 0) return null
    return q.multiple ? picks : picks.join(', ')
  })
}

function answerText(q: AskQuestion, answer: AskAnswer): string {
  if (answer === null) return ASK_SKIPPED
  const labels = new Set((q.options ?? []).map((o) => o.label))
  const picks = Array.isArray(answer) ? answer : [answer]
  if (!q.options) return picks.join(', ')
  return picks.map((p) => (labels.has(p) ? p : `Other: ${p}`)).join(', ')
}

/** The tool result the agent reads: question/answer pairs. */
export function formatAskAnswers(questions: AskQuestion[], answers: AskAnswer[]): string {
  if (answers.every((a) => a === null)) return ASK_ALL_SKIPPED
  return questions
    .map((q, i) => `Q: ${q.question}\nA: ${answerText(q, answers[i] ?? null)}`)
    .join('\n\n')
}

const LEGACY_PREFIX = 'Human answered: '

/**
 * Recover per-question display answers from a stored tool result, for
 * rendering an answered form. `null` = skipped. Also reads the pre-form
 * `Human answered: X` result.
 */
export function parseAskResult(questions: AskQuestion[], result: string): Array<string | null> {
  if (result === ASK_ALL_SKIPPED) return questions.map(() => null)
  if (result.startsWith(LEGACY_PREFIX)) {
    const text = result.slice(LEGACY_PREFIX.length)
    return questions.map((_, i) => (i === 0 ? (text && text !== '[skipped]' ? text : null) : null))
  }
  // Walk the blocks in order using the known question text as delimiters, so
  // answers may span lines.
  const out: Array<string | null> = []
  let cursor = 0
  for (let i = 0; i < questions.length; i++) {
    const head = `Q: ${questions[i].question}\nA: `
    const start = result.indexOf(head, cursor)
    if (start < 0) { out.push(null); continue }
    const bodyStart = start + head.length
    const next = i + 1 < questions.length ? result.indexOf(`\n\nQ: ${questions[i + 1].question}\nA: `, bodyStart) : -1
    const body = next < 0 ? result.slice(bodyStart) : result.slice(bodyStart, next)
    out.push(body === ASK_SKIPPED ? null : body)
    cursor = next < 0 ? result.length : next
  }
  return out
}
