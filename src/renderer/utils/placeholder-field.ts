/**
 * A credential field that shows a placeholder for a stored value it cannot
 * read (a remote ADF daemon never sends stored values; the field shows
 * `__redacted__` as dots). The first edit replaces the placeholder with what
 * the user typed or pasted: backspacing or typing into the dots must not
 * save a piece of the placeholder as the secret (tracker §6, W3-C follow-up).
 */

export const STORED_VALUE_PLACEHOLDER = '__redacted__'

/**
 * The field's next value after an edit. While the previous value is the
 * placeholder, only the newly entered text is kept (the part of `next`
 * between the placeholder's unchanged start and end); an edit that only
 * deletes leaves the field empty. Any other field changes as typed.
 */
export function editPlaceholderField(previous: string, next: string): string {
  if (previous !== STORED_VALUE_PLACEHOLDER || next === previous) return next
  let start = 0
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++
  let end = 0
  while (end < previous.length - start && end < next.length - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end++
  return next.slice(start, next.length - end)
}
