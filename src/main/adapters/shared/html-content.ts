import { convert } from 'html-to-text'

/**
 * Content type for HTML message bodies. Adapters whose platform accepts HTML
 * render it (email: full HTML body; telegram: sanitized to its tag subset);
 * everything else converts to readable plain text before sending.
 */
export const HTML_CONTENT_TYPE = 'text/html'

/** Convert an HTML body to readable plain text for text-only transports. */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      // Chat output — headings shouldn't SHOUT
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } }))
    ]
  }).trim()
}

/** Inline tags Telegram's HTML parse_mode accepts. */
const TELEGRAM_ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'code', 'pre', 'blockquote', 'a', 'tg-spoiler'
])

/**
 * Reduce arbitrary HTML to the subset Telegram's HTML parse_mode accepts:
 * structural elements become newlines/bullets/bold, allowed inline tags are
 * kept (attributes stripped, except a[href]), everything else is removed.
 * Output may still be rejected by Telegram for pathological input — callers
 * keep the existing plain-text fallback on parse failure.
 */
export function sanitizeTelegramHtml(html: string): string {
  let out = html

  // Drop non-content subtrees entirely
  out = out.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')

  // Line-breaking elements → newlines
  out = out.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  out = out.replace(/<\/\s*(p|div|section|article|tr|table|ul|ol)\s*>/gi, '\n')

  // Headings → bold lines
  out = out.replace(/<\s*h[1-6][^>]*>/gi, '<b>')
  out = out.replace(/<\/\s*h[1-6]\s*>/gi, '</b>\n')

  // List items → bullets
  out = out.replace(/<\s*li[^>]*>/gi, '• ')
  out = out.replace(/<\/\s*li\s*>/gi, '\n')

  // Keep the allowed inline subset (attributes stripped, a[href] preserved),
  // remove every other tag.
  out = out.replace(/<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)\s*\/?>/g, (match, tag: string, attrs: string) => {
    const t = tag.toLowerCase()
    if (!TELEGRAM_ALLOWED_TAGS.has(t)) return ''
    const closing = /^<\s*\//.test(match)
    if (t === 'a') {
      if (closing) return '</a>'
      const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
      const url = href?.[2] ?? href?.[3]
      // An anchor without a target renders as plain text
      return url ? `<a href="${url}">` : ''
    }
    return closing ? `</${t}>` : `<${t}>`
  })

  // Collapse runaway whitespace from removed block markup
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}
