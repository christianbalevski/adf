import { stableBlockBoundary, UNSAFE_TO_SPLIT } from './markdown-split'

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

  const fragment = (html: string): DocumentFragment => {
    const template = root.ownerDocument.createElement('template')
    template.innerHTML = html
    return template.content
  }
  const full = (source: string): void => {
    replaceSuffix(root, null, fragment(render(source)))
    settled = 0
    anchor = null
  }

  return {
    update(source: string, nextVersion: number): void {
      if (source === previous && version === nextVersion) return
      const grew = version === nextVersion && previous !== null
        && source.length > previous.length && source.startsWith(previous)
      previous = source
      version = nextVersion
      const boundary = grew ? stableBlockBoundary(source.slice(settled)) : UNSAFE_TO_SPLIT
      if (boundary === UNSAFE_TO_SPLIT) {
        full(source)
        return
      }
      const cut = settled + boundary
      const prefix = boundary > 0 ? fragment(render(source.slice(settled, cut))) : root.ownerDocument.createDocumentFragment()
      const prefixCount = prefix.childNodes.length
      prefix.appendChild(fragment(render(source.slice(cut))))
      const nodes = replaceSuffix(root, anchor, prefix)
      if (prefixCount > 0) anchor = nodes[prefixCount - 1]
      settled = cut
    },
    /** Canonical parse after a pause. Stale timers cannot overwrite a newer
     * answer/grammar. Reconciliation preserves all unchanged settled nodes. */
    settle(source: string, expectedVersion: number): void {
      if (source !== previous || expectedVersion !== version) return
      full(source)
    },
  }
}
