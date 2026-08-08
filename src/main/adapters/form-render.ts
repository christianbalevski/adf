import { parseFormHint, FORM_CONTENT_TYPE } from '../../shared/types/form-hints.types'
import type { FormHint } from '../../shared/types/form-hints.types'
import { HTML_CONTENT_TYPE, htmlToPlainText } from './shared/html-content'
import type { OutboundMessage } from '../../shared/types/channel-adapter.types'

/**
 * Parse a typed form body (payload with content_type application/vnd.adf.form+json).
 * Returns null for invalid JSON or schema mismatch — adapters fall back to a
 * plain-text send rather than failing delivery.
 */
export function parseFormJson(payload: string): FormHint | null {
  try {
    return parseFormHint(JSON.parse(payload))
  } catch {
    return null
  }
}

/**
 * Plain-text rendering of a form hint — used by every adapter without native
 * form rendering (currently all except Telegram) and as the fallback when a
 * hint fails validation.
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
 * without native form rendering: forms degrade to the plain-text
 * questionnaire, HTML converts to readable text, anything else passes
 * through unchanged. `isHtml` lets callers skip their markdown conversion
 * for HTML-derived text.
 */
export function resolveOutboundText(msg: OutboundMessage): { text: string; isHtml: boolean } {
  const form = msg.contentType === FORM_CONTENT_TYPE ? parseFormJson(msg.payload) : null
  const isHtml = msg.contentType === HTML_CONTENT_TYPE
  const text = form ? renderFormAsText(form) : isHtml ? htmlToPlainText(msg.payload) : msg.payload || ''
  return { text, isHtml }
}
