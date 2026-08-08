import { z } from 'zod'

/**
 * The `message_meta.form` routing-hint convention.
 *
 * An agent sends a structured questionnaire by passing `message_meta.form`
 * on msg_send. The hint rides the existing routing-hints channel
 * (message_meta → OutboundMessage.routingHints) — no ALF or adapter-contract
 * changes. Adapters that recognize the hint render it natively (Telegram
 * inline keyboards, Slack Block Kit, Discord components); adapters that
 * don't, or receive an invalid hint, fall back to a plain-text rendering.
 * Answers come back as ordinary inbound messages threaded to the form via
 * parent_id, with form_id/question_id/answer_id in source_context.
 *
 * ID length limits are load-bearing: Telegram callback_data is capped at
 * 64 bytes and carries `f|{form_id}|{question_id}|{option_id}` (max 36 bytes
 * within budget).
 */

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
  /** Verbatim plain-text rendering used by adapters without native form support */
  fallback_text: z.string().max(4000).optional()
})

export type FormOption = z.infer<typeof FormOptionSchema>
export type FormQuestion = z.infer<typeof FormQuestionSchema>
export type FormHint = z.infer<typeof FormHintSchema>

/**
 * Parse a routing-hints `form` value. Returns null for anything invalid —
 * callers fall back to plain-text rendering rather than failing the send.
 */
export function parseFormHint(value: unknown): FormHint | null {
  const result = FormHintSchema.safeParse(value)
  return result.success ? result.data : null
}

/** Encode a Telegram/Slack/Discord component action id: f|form|question|option */
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
