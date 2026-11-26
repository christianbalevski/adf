/**
 * A comment on text selected in one of the agent's files, waiting in the
 * composer as a chip until the owner sends. Nothing about it is stored in the
 * file or the agent: on send it becomes plain text in the message, the same
 * words the owner could have typed by hand.
 */
export interface SelectionComment {
  id: string
  /** The file's path in the agent, as its tab shows it. */
  path: string
  /** 1-based lines of the selection, when the editor knows them exactly (source views). */
  startLine?: number
  endLine?: number
  quote: string
  comment: string
}

/**
 * `notes.md (lines 12-14)` or `notes.md (line 3)`. A quote with no lines is
 * the rendered text of a rich view that could not be placed in the source:
 * the header says so, since the file does not contain it as written.
 */
export function selectionCommentHeader(c: Pick<SelectionComment, 'path' | 'startLine' | 'endLine'>): string {
  if (c.startLine == null) return `${c.path} (rendered text, not file text)`
  const end = c.endLine ?? c.startLine
  return end === c.startLine ? `${c.path} (line ${c.startLine})` : `${c.path} (lines ${c.startLine}-${end})`
}

/** `"""`, or one `"` more than the longest run of them in `quote`, so the quote cannot close it early. */
function fence(quote: string): string {
  const longest = Math.max(0, ...(quote.match(/"+/g) ?? []).map((run) => run.length))
  return '"'.repeat(Math.max(3, longest + 1))
}

/**
 * One comment as the agent reads it:
 *
 *     notes.md (lines 12-14)
 *     """
 *     the selected text
 *     """
 *     comment: this is wrong
 */
export function formatSelectionComment(c: SelectionComment): string {
  const delimiter = fence(c.quote)
  const lines = [selectionCommentHeader(c), delimiter, c.quote, delimiter]
  const comment = c.comment.trim()
  if (comment) lines.push(`comment: ${comment}`)
  return lines.join('\n')
}

/** The message a send carries: each comment, then what the owner typed. */
export function withSelectionComments(comments: readonly SelectionComment[], message: string): string {
  return [...comments.map(formatSelectionComment), message].filter((part) => part.length > 0).join('\n\n')
}
