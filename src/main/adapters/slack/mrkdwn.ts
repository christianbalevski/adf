/**
 * Convert standard markdown to Slack mrkdwn.
 *
 * Slack's mrkdwn dialect differs from CommonMark: bold is *single asterisks*,
 * italic is _underscores_, strikethrough is ~single tildes~, and links are
 * <url|text>. Code fences and inline code match markdown, so those are
 * shielded first and restored untouched.
 */
export function markdownToMrkdwn(text: string): string {
  const shields: string[] = []
  // NUL bytes never appear in chat text, so they make a collision-proof sentinel.
  const shield = (s: string): string => {
    shields.push(s)
    return `\x00${shields.length - 1}\x00`
  }

  // Shield code blocks and inline code so formatting passes leave them alone
  let out = text.replace(/```\w*\n?([\s\S]*?)```/g, (_m, body: string) => shield('```' + body + '```'))
  out = out.replace(/`([^`]+)`/g, (_m, body: string) => shield('`' + body + '`'))

  // Escape mrkdwn control characters (&, <, >)
  out = out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Links [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Strikethrough ~~text~~ → ~text~ (before bold, so strikes nested inside a
  // bold span are converted before the bold pass shields its body)
  out = out.replace(/~~(.+?)~~/g, '~$1~')

  // Bold **text** → *text* (before italic so ** doesn't half-match). Shielded
  // so the italic pass can't re-match the freshly-produced single asterisks.
  out = out.replace(/\*\*(.+?)\*\*/g, (_m, body: string) => shield(`*${body}*`))

  // Italic: markdown *text* (single asterisk) → _text_. Runs after bold, so
  // remaining single asterisks are true italics.
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '_$1_')

  // Headings (# Title) → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Restore shielded segments. Shielded strings can nest (e.g. a bold span
  // shielded by the bold pass may contain an earlier code-span token), and
  // String.replace does not rescan replacement text — so loop until no
  // sentinels remain. Terminates because a shield string can only reference
  // tokens created before it.
  while (/\x00\d+\x00/.test(out)) {
    out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => shields[Number(i)])
  }

  return out
}
