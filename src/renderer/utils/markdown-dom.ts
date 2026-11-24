import { stableBlockBoundary, UNSAFE_TO_SPLIT } from './markdown-split'

const LARGE_TAIL_CHARS = 8 * 1024
const LARGE_TAIL_INTERVAL_MS = 200

/** Reconcile direct children after an immutable prefix. Equal nodes keep their
 * identity, including DOM selection, and no wrappers change Markdown's CSS. */
function replaceSuffix(root: HTMLElement, anchor: ChildNode | null, fragment: DocumentFragment): ChildNode[] {
  let old = anchor ? anchor.nextSibling : root.firstChild
  const nodes: ChildNode[] = []
  for (const next of Array.from(fragment.childNodes)) {
    const following = old?.nextSibling ?? null
    if (old?.isEqualNode(next)) nodes.push(old)
    else {
      if (old) root.replaceChild(next, old)
      else root.appendChild(next)
      nodes.push(next)
    }
    old = following
  }
  while (old) {
    const next = old.nextSibling
    root.removeChild(old)
    old = next
  }
  return nodes
}

/** Owns ONLY the children of an otherwise React-managed Markdown container.
 * `render` must return sanitized HTML. All chunks remain direct children, so
 * first/last-child selectors, lists, tables and margin collapsing stay intact. */
export function createMarkdownDomRenderer(root: HTMLElement, render: (source: string) => string) {
  let previous: string | null = null
  let version: number | undefined
  let settled = 0
  let anchor: ChildNode | null = null
  let canonical = false
  let lastPaint = -Infinity
  let pending: { source: string; version: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const fragment = (html: string): DocumentFragment => {
    const template = root.ownerDocument.createElement('template')
    template.innerHTML = html
    return template.content
  }
  const paint = (source: string, nextVersion: number, streaming: boolean): void => {
    if (source === previous && version === nextVersion && (streaming || canonical)) return
    const grew = streaming && version === nextVersion && previous !== null
      && source.length > previous.length && source.startsWith(previous)
    const boundary = grew ? stableBlockBoundary(source.slice(settled)) : UNSAFE_TO_SPLIT
    canonical = boundary === UNSAFE_TO_SPLIT || (settled === 0 && boundary === 0)
    if (canonical) {
      replaceSuffix(root, null, fragment(render(source)))
      settled = 0
      anchor = null
    } else {
      const cut = settled + boundary
      const prefix = boundary > 0 ? fragment(render(source.slice(settled, cut))) : root.ownerDocument.createDocumentFragment()
      const prefixCount = prefix.childNodes.length
      prefix.appendChild(fragment(render(source.slice(cut))))
      const nodes = replaceSuffix(root, anchor, prefix)
      if (prefixCount > 0) anchor = nodes[prefixCount - 1]
      settled = cut
    }
    previous = source
    version = nextVersion
    lastPaint = performance.now()
  }

  const cancelPending = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = undefined
  }

  return {
    update(source: string, nextVersion: number, streaming: boolean): void {
      const wait = lastPaint + LARGE_TAIL_INTERVAL_MS - performance.now()
      // A long, unsettled block (such as an open fence) or an unsafe cut can
      // cost a multi-KiB parse on every delta. Keep the last sanitized DOM
      // interactive while coalescing these updates into one trailing paint.
      if (streaming && previous && version === nextVersion && source.length > previous.length
          && source.length - settled >= LARGE_TAIL_CHARS && wait > 0) {
        pending = { source, version: nextVersion }
        timer ??= setTimeout(() => {
          const next = pending
          cancelPending()
          if (next) paint(next.source, next.version, true)
        }, wait)
        return
      }
      cancelPending()
      paint(source, nextVersion, streaming)
    },
    cancelPending,
  }
}
