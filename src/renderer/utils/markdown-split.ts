/**
 * Where a growing markdown document can be cut so the part before the cut never
 * has to be parsed again.
 *
 * A streamed answer arrives ~20×/s and the naive renderer re-parses the whole
 * accumulated text every time, which is quadratic in the answer's length. Cut
 * the text at the last blank line that provably ends a block and the prefix can
 * be parsed once; only the in-progress trailing block is re-parsed per delta.
 *
 * "Provably" is the whole job here, because `parse(a) + parse(b)` only equals
 * `parse(a + b)` when the two halves cannot interact. The rules below are
 * deliberately pessimistic — when a boundary is even slightly ambiguous we move
 * it earlier (or give up and let the caller parse the whole thing), because a
 * missed optimisation costs milliseconds while a wrong cut changes what the
 * user reads.
 */

/** Chunk needs a whole-document parse — no cut is safe anywhere in it. */
export const UNSAFE_TO_SPLIT = -1

/**
 * Reference-style link/image definitions (`[id]: https://…`) are resolved
 * document-wide, so a definition in one half and its use in the other would
 * render as literal text. Any of these and the chunk is off-limits.
 */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]*\]:/

/** A fence opener/closer: three or more backticks or tildes, up to 3 spaces in. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Block starts that may be a CONTINUATION of what came before the blank line:
 * a loose list's next item, another blockquote chunk, another table row, an
 * indented code block's next paragraph. Cutting in front of one of these would
 * split a single element into two, so such a boundary is rejected.
 */
const CONTINUATION_START = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}>|\|| {4}|\t)/

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/**
 * Offset in `chunk` just past the last block that is safe to render on its own.
 *
 * `chunk` MUST begin at a block boundary that is outside any code fence — the
 * caller guarantees this by only ever passing text that starts where a previous
 * cut landed (or at the very start of the document).
 *
 * Returns 0 when nothing is settled yet, or `UNSAFE_TO_SPLIT` when the chunk
 * holds a construct whose meaning is document-wide.
 */
export function stableBlockBoundary(chunk: string): number {
  if (!chunk) return 0

  let cut = 0
  let offset = 0
  let fence: string | null = null
  /** A blank line is only a boundary once real content follows it. */
  let pendingBoundary = -1
  /** Did the block that just ended open as a list/quote/table/indented code?
   *  Only those can swallow a blank line and keep going. */
  let openContainer = false
  /** The next non-blank line outside a fence begins a new block. */
  let atBlockStart = true

  while (offset < chunk.length) {
    let end = chunk.indexOf('\n', offset)
    const hasNewline = end !== -1
    if (!hasNewline) end = chunk.length
    // Keep \r with the line so a CRLF document's blank lines still read blank.
    const line = chunk.slice(offset, end)
    const next = hasNewline ? end + 1 : chunk.length

    if (fence) {
      // Only the matching fence character closes the block; everything between
      // is literal, including text that would otherwise look like a boundary.
      const close = FENCE.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
    } else {
      const open = FENCE.exec(line)
      if (!open && isBlank(line)) {
        // The blank line belongs to the prefix; the boundary is what follows.
        if (pendingBoundary === -1) pendingBoundary = next
        atBlockStart = true
      } else {
        if (!open && REFERENCE_DEFINITION.test(line)) return UNSAFE_TO_SPLIT
        if (atBlockStart) {
          // A fence opener always starts a block of its own.
          const continuation = !open && CONTINUATION_START.test(line)
          if (pendingBoundary !== -1) {
            // Safe unless a container was left open across the blank line and
            // this line could be its next item.
            if (!openContainer || !continuation) cut = pendingBoundary
            pendingBoundary = -1
          }
          openContainer = continuation
          atBlockStart = false
        }
        if (open) fence = open[1]
      }
    }

    offset = next
  }

  // An unterminated fence means everything after its opener is still in flight;
  // `cut` already predates it, so nothing more to do.
  return cut
}

/**
 * Wrap a whole-document renderer so a GROWING document only pays for the block
 * still being written. The settled prefix's output is kept between calls and
 * each finished block is rendered exactly once.
 *
 * The first call — and any call whose text is not simply the previous text plus
 * more — renders the whole thing, so text that never streams (a restored
 * transcript row) costs exactly what it always did.
 *
 * `render` must be pure and block-local: the result is a concatenation of
 * independently rendered blocks, which is why the boundary rules above refuse
 * every cut two blocks could reach across.
 */
export function createIncrementalRenderer(
  render: (source: string) => string
): (source: string) => string {
  /** Source already folded into `settledOutput`. */
  let settled = ''
  let settledOutput = ''
  let previous: string | null = null
  let lastOutput = ''

  return (source: string): string => {
    // Idempotent for a repeat of the same text — React may render twice.
    if (previous === source) return lastOutput
    const grew = previous !== null && source.length > previous.length && source.startsWith(previous)
    previous = source

    const boundary = grew ? stableBlockBoundary(source.slice(settled.length)) : UNSAFE_TO_SPLIT
    if (boundary === UNSAFE_TO_SPLIT) {
      // Either the text was rewritten rather than extended, or it holds a
      // construct no cut survives — start over from a whole-document render.
      settled = ''
      settledOutput = ''
      lastOutput = render(source)
      return lastOutput
    }

    if (boundary > 0) {
      const cut = settled.length + boundary
      settledOutput += render(source.slice(settled.length, cut))
      settled = source.slice(0, cut)
    }
    const tail = source.slice(settled.length)
    lastOutput = tail ? settledOutput + render(tail) : settledOutput
    return lastOutput
  }
}
