import { memo, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { renderMarkdownToSafeHtml, useMarkdownHighlightVersion } from '../../utils/markdown'
import { createMarkdownDomRenderer } from '../../utils/markdown-dom'
import { isAdfFileUrl, openAdfFileLink } from '../../utils/open-adf-link'

/** Percent-encode spaces in adf-file:// URLs so markdown parsers don't break on them. */
function encodeAdfFileUrls(src: string): string {
  return src.replace(
    /adf-file:\/\/([^\s)>"'\]]+(?:\s[^\s)>"'\]]+)*)/g,
    (_match, path: string) => 'adf-file://' + path.replace(/ /g, '%20')
  )
}

// Parse and sanitize through the shared renderer (utils/markdown.ts), which owns
// the marked configuration and the DOMPurify allowlist for every untrusted
// document Studio paints. Only the adf-file:// pre-pass is the loop's own.
function renderMarkdown(src: string): string {
  return renderMarkdownToSafeHtml(encodeAdfFileUrls(src))
}

// How long a streamed answer must hold still before it is parsed once more in
// full. The incremental path only ever concatenates independently-parsed
// blocks; this pass guarantees the transcript the user keeps is byte-for-byte
// the whole-document parse.
const MARKDOWN_SETTLE_MS = 200

// Memoized markdown component to avoid re-parsing on every render.
// While an answer streams, the DOM renderer re-parses and replaces only
// the block still being written instead of the whole accumulated text (which is
// quadratic at ~20 deltas/s). A row that never changes — every restored
// transcript row — takes exactly the one full parse it always did.
export const MarkdownEntry = memo(({ content, className = 'px-1.5 py-1 text-neutral-800 dark:text-neutral-200' }: { content: string; className?: string }) => {
  const container = useRef<HTMLDivElement>(null)
  const renderer = useRef<ReturnType<typeof createMarkdownDomRenderer> | null>(null)
  const mountedContent = useRef(content)
  const highlightVersion = useMarkdownHighlightVersion()
  useLayoutEffect(() => {
    if (!container.current) return
    renderer.current ??= createMarkdownDomRenderer(container.current, renderMarkdown)
    renderer.current.update(content, highlightVersion)
  }, [content, highlightVersion])
  useEffect(() => {
    if (content === mountedContent.current) return
    const timer = setTimeout(() => renderer.current?.settle(content, highlightVersion), MARKDOWN_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [content, highlightVersion])
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return
    if (isAdfFileUrl(href)) {
      e.preventDefault()
      openAdfFileLink(href)
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      // Plain anchors would navigate the renderer in place, which main's
      // will-navigate guard blocks. Route through window.open so the
      // setWindowOpenHandler hands the URL to the OS browser instead.
      e.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }, [])
  return (
    <div
      className={`loop-markdown ${className}`}
      ref={container}
      onClick={handleClick}
    />
  )
})
