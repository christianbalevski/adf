import { z } from 'zod'

/**
 * The ADF form content type: a message whose `content` is a structured
 * questionnaire (JSON matching FormHintSchema) and whose `content_type` is
 * `application/vnd.adf.form+json`.
 *
 * A form is content of a specific type — it lives in the message body, not
 * in meta. That means it is signed and (over mesh) encrypted with the
 * payload, and the outbox/inbox record holds the real form. Adapters render
 * it natively where the platform supports interactive components (Telegram
 * inline keyboards; Slack Block Kit and Discord components as follow-ups)
 * and fall back to a plain-text questionnaire elsewhere. Agent recipients
 * over mesh parse the content directly. Answers come back as ordinary
 * inbound messages threaded to the form via parent_id, with
 * form_id/question_id/answer_id in source_context.
 *
 * `message_meta` remains reserved for true delivery hints (reply_all/cc/bcc).
 *
 * ID length limits are load-bearing: Telegram callback_data is capped at
 * 64 bytes and carries `f|{form_id}|{question_id}|{option_id}` (max 36 bytes
 * within budget).
 */

export const FORM_CONTENT_TYPE = 'application/vnd.adf.form+json'

const idPattern = /^[a-z0-9_-]+$/

export const FormOptionSchema = z.object({
  id: z.string().min(1).max(8).regex(idPattern),
  label: z.string().min(1).max(100)
})

export const FormQuestionSchema = z.object({
  id: z.string().min(1).max(8).regex(idPattern),
  text: z.string().min(1).max(1000),
  type: z.enum(['choice', 'multi', 'text']),
  options: z.array(FormOptionSchema).min(1).max(12).optional(),
  required: z.boolean().optional()
}).refine(
  (q) => q.type === 'text' || (q.options && q.options.length > 0),
  { message: 'choice/multi questions require options' }
)

export const FormHintSchema = z.object({
  id: z.string().min(1).max(16).regex(idPattern),
  title: z.string().max(200).optional(),
  questions: z.array(FormQuestionSchema).min(1).max(10),
  /**
   * REQUIRED rendering choice — the agent owns this decision; the adapter
   * only validates and dispatches. A choice the form's shape doesn't satisfy
   * fails the delivery with the precise reason. Telegram surfaces:
   * 'poll' (native poll — single choice/multi question, 2-10 options,
   * title+question <=300 chars, option labels <=100), 'compact' (one message,
   * one combined keyboard — no text questions), 'per_question' (one message
   * per question, any shape). Adapters without native form surfaces render
   * the plain-text questionnaire regardless of this field.
   */
  render: z.enum(['poll', 'compact', 'per_question']),
  /** Verbatim plain-text rendering used by adapters without native form support */
  fallback_text: z.string().max(4000).optional()
})

export type FormOption = z.infer<typeof FormOptionSchema>
export type FormQuestion = z.infer<typeof FormQuestionSchema>
export type FormHint = z.infer<typeof FormHintSchema>

/**
 * Parse a typed form body (content_type `application/vnd.adf.form+json`).
 * Returns null for anything invalid — adapter callers fall back to
 * plain-text rendering; msg_send separately rejects invalid forms at send
 * time.
 */
export function parseFormHint(value: unknown): FormHint | null {
  const result = FormHintSchema.safeParse(value)
  return result.success ? result.data : null
}

/** Encode a Telegram inline-keyboard callback action id (shared format for future Slack/Discord components): f|form|question|option */
export function encodeFormAction(formId: string, questionId: string, optionId: string): string {
  return `f|${formId}|${questionId}|${optionId}`
}

/** Decode an `f|form|question|option` action id; null if it isn't one */
export function decodeFormAction(data: string): { formId: string; questionId: string; optionId: string } | null {
  const parts = data.split('|')
  if (parts.length !== 4 || parts[0] !== 'f') return null
  const [, formId, questionId, optionId] = parts
  if (!formId || !questionId || !optionId) return null
  return { formId, questionId, optionId }
}

/** Sentinel option id for finalizing a multi-select question */
export const FORM_MULTI_DONE = '__done'

/** Sentinel option id on rows of an already-answered question (taps ignored) */
export const FORM_ANSWERED = '__answered'
