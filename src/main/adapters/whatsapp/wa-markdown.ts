/**
 * Convert standard markdown to WhatsApp formatting.
 *
 * WhatsApp uses *bold*, _italic_, ~strikethrough~ and ```monospace```.
 * There is no link syntax — URLs are auto-linked, so [text](url) becomes
 * "text (url)".
 */
export function markdownToWhatsApp(text: string): string {
  const shields: string[] = []
  // NUL bytes never appear in chat text, so they make a collision-proof sentinel.
  const shield = (s: string): string => {
    shields.push(s)
    return `\x00${shields.length - 1}\x00`
  }

  let out = text

  // Links [text](url) → "text (url)"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // Bold **text** → *text* (before italic so ** doesn't half-match). Shielded
  // so the italic pass can't re-match the freshly-produced single asterisks.
  out = out.replace(/\*\*(.+?)\*\*/g, (_m, body: string) => shield(`*${body}*`))

  // Italic: markdown *text* (single asterisk) → _text_
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '_$1_')

  // Strikethrough ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, '~$1~')

  // Headings (# Title) → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Restore shielded bold segments
  out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => shields[Number(i)])

  return out
}
