/**
 * Convert standard markdown to WhatsApp formatting.
 *
 * WhatsApp uses *bold*, _italic_, ~strikethrough~ and ```monospace```.
 * There is no link syntax — URLs are auto-linked, so [text](url) becomes
 * "text (url)".
 */
export function markdownToWhatsApp(text: string): string {
  let out = text

  // Links [text](url) → "text (url)"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // Bold **text** → *text* (before italic so ** doesn't half-match)
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*')

  // Italic: markdown *text* (single asterisk) → _text_
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '_$1_')

  // Strikethrough ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, '~$1~')

  // Headings (# Title) → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  return out
}
