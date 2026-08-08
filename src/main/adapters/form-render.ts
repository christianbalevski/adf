import { parseFormHint, FORM_CONTENT_TYPE } from '../../shared/types/form-hints.types'
import type { FormHint } from '../../shared/types/form-hints.types'
import { HTML_CONTENT_TYPE, htmlToPlainText } from './shared/html-content'
import type { OutboundMessage } from '../../shared/types/channel-adapter.types'

/**
 * Contract violation in typed outbound content (e.g. form JSON that fails the
 * schema). Adapters fail the delivery with this error rather than silently
 * degrading — agents are competent: a clear error beats a mangled message.
 */
export class TypedContentError extends Error {}

/**
 * Parse a typed form body (payload with content_type application/vnd.adf.form+json).
 * Throws TypedContentError for invalid JSON or schema mismatch. msg_send
 * validates at send time, so reaching this error means the content bypassed
 * the tool contract (custom code) — fail loudly, never guess.
 */
export function parseFormJson(payload: string): FormHint {
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    throw new TypedContentError(`content_type is ${FORM_CONTENT_TYPE} but content is not valid JSON`)
  }
  const form = parseFormHint(json)
  if (!form) {
    throw new TypedContentError(`content_type is ${FORM_CONTENT_TYPE} but content does not match the form schema (see msg_send's content_type parameter for the expected shape)`)
  }
  return form
}

/**
 * Plain-text rendering of a form hint — used by every adapter without native
 * form rendering (currently all except Telegram).
 * Honors fallback_text verbatim when the sender provided one.
 */
export function renderFormAsText(form: FormHint): string {
  if (form.fallback_text) return form.fallback_text

  const lines: string[] = []
  if (form.title) lines.push(form.title, '')
  form.questions.forEach((q, qi) => {
    lines.push(`${qi + 1}. ${q.text}`)
    if (q.options) {
      q.options.forEach((opt, oi) => {
        lines.push(`   ${String.fromCharCode(97 + oi)}) ${opt.label}`)
      })
    }
  })
  lines.push('', 'Reply with your answer' + (form.questions.length > 1 ? 's (e.g. "1a, 2c")' : ''))
  return lines.join('\n')
}

/**
 * Resolve an outbound message's typed content to sendable text for adapters
 * without native form rendering: forms render as the plain-text
 * questionnaire, HTML converts to readable text, anything else passes
 * through unchanged. `isHtml` lets callers skip their markdown conversion
 * for HTML-derived text. Throws TypedContentError on malformed form content —
 * callers let it fail the delivery.
 */
export function resolveOutboundText(msg: OutboundMessage): { text: string; isHtml: boolean } {
  const form = msg.contentType === FORM_CONTENT_TYPE ? parseFormJson(msg.payload) : null
  const isHtml = msg.contentType === HTML_CONTENT_TYPE
  const text = form ? renderFormAsText(form) : isHtml ? htmlToPlainText(msg.payload) : msg.payload || ''
  return { text, isHtml }
}
