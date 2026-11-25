/**
 * Map a selection in the rich markdown view back to the file's own text.
 *
 * The rich view shows rendered text: `**bold**` reads as `bold`, list markers
 * and heading hashes are gone. A comment that quoted that would not be text
 * the file contains, so an agent could not use it to find (or `fs_write` edit)
 * the passage. This finds the source lines the selection came from and quotes
 * the source: the exact selected text when the file has it as-is, else the
 * whole lines (which the file has as-is by definition).
 */

/** A selection in the rich view, as the editor reports it. */
export interface RichSelection {
  /** The selected text as shown, blocks joined with '\n'. */
  text: string
  /** The full shown text of the block the selection starts in, and of the one it ends in. */
  startBlock: string
  endBlock: string
  /** Whether it starts and ends in the same block (one paragraph, list item, cell or code block). */
  sameBlock: boolean
  /** Characters into its start block where the selection begins. */
  startOffset: number
  /** Where the selection starts, as a fraction of the document (0..1): picks between identical blocks. */
  position: number
}

export interface SourceQuote {
  text: string
  /** 1-based. */
  startLine: number
  endLine: number
}

/** Text compared without markdown inline syntax, so shown and source text agree. */
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\\*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One source line as the rich view would show it: block markers off, then `plain`. */
function shownLine(line: string): string {
  return plain(
    line
      .replace(/^\s*(>\s*)*/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''),
  )
}

/**
 * Source line ranges [first, last] whose shown text contains `block`, from
 * line `from` on. A paragraph may be wrapped over several source lines, so a
 * line that starts the block is extended until the block is covered.
 */
function blockRanges(shown: string[], block: string, from: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let i = from; i < shown.length; i++) {
    if (!shown[i]) continue
    let acc = shown[i]
    let k = i
    while (!acc.includes(block) && block.startsWith(acc) && k + 1 < shown.length && shown[k + 1]) {
      k++
      acc = `${acc} ${shown[k]}`
    }
    if (acc.includes(block)) ranges.push([i, k])
  }
  return ranges
}

function nearest<T>(items: T[], distance: (item: T) => number): T | undefined {
  let best: T | undefined
  let bestDistance = Infinity
  for (const item of items) {
    const d = distance(item)
    if (d < bestDistance) {
      best = item
      bestDistance = d
    }
  }
  return best
}

function count(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/** The source text a rich-view selection came from, or null when it cannot be placed. */
export function locateInSource(source: string, selection: RichSelection): SourceQuote | null {
  const lines = source.split('\n')
  const shown = lines.map(shownLine)
  const startBlock = plain(selection.startBlock)
  const endBlock = plain(selection.endBlock)
  if (!startBlock || !endBlock) return null

  const hintLine = selection.position * lines.length
  const start = nearest(blockRanges(shown, startBlock, 0), ([i]) => Math.abs(i - hintLine))
  if (!start) return null
  // A later block is searched for after the start block's lines; a table cell
  // on the start block's own row is the fallback.
  const end = selection.sameBlock
    ? start
    : blockRanges(shown, endBlock, start[1] + 1)[0] ?? blockRanges(shown, endBlock, start[0])[0]
  if (!end) return null

  const region = lines.slice(start[0], end[1] + 1).join('\n')
  const wanted = selection.text
  const hits: number[] = []
  for (let at = region.indexOf(wanted); at !== -1 && wanted; at = region.indexOf(wanted, at + 1)) hits.push(at)
  // Several hits in the block (a repeated word): the one nearest where the selection starts in it.
  const hit = nearest(hits, (at) => Math.abs(at - selection.startOffset))
  if (hit !== undefined) {
    const startLine = start[0] + 1 + count(region.slice(0, hit), '\n')
    return { text: wanted, startLine, endLine: startLine + count(wanted.replace(/\n$/, ''), '\n') }
  }
  // The selection crosses markup or blocks: the whole lines are text the file has.
  return { text: region, startLine: start[0] + 1, endLine: end[1] + 1 }
}
