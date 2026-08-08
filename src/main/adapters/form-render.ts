import type { FormHint } from '../../shared/types/form-hints.types'

/**
 * Plain-text rendering of a form hint — used by adapters without native form
 * support (WhatsApp) and as the fallback when a hint fails validation.
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
