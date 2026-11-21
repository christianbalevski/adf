import { memo, useRef, useLayoutEffect, useCallback } from 'react'
import { renderMarkdownToSafeHtml, useMarkdownHighlightVersion } from '../../utils/markdown'
import { createMarkdownDomRenderer } from '../../utils/markdown-dom'
import { isAdfFileUrl, openAdfFileLink } from '../../utils/open-adf-link'
import { isRuntimeWebsiteLink } from '../../../shared/utils/agent-website-url'
import { useRuntimeWebsiteLink } from '../../hooks/useRuntimeWebsiteLink'

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

// Fallback for streams with no explicit completion event. The last content is
// rendered canonically once it holds still.
const MARKDOWN_SETTLE_MS = 200

export const MarkdownEntry = memo(({ content, streaming = false, className = 'px-1.5 py-1 text-neutral-800 dark:text-neutral-200' }: {
  content: string
  streaming?: boolean
  className?: string
}) => {
  const openWebsite = useRuntimeWebsiteLink()
  const container = useRef<HTMLDivElement>(null)
  const renderer = useRef<ReturnType<typeof createMarkdownDomRenderer> | null>(null)
  const highlightVersion = useMarkdownHighlightVersion()
  useLayoutEffect(() => {
    if (!container.current) return
    const dom = renderer.current ??= createMarkdownDomRenderer(container.current, renderMarkdown)
    dom.update(content, highlightVersion, streaming)
    if (!streaming) return
    const timer = setTimeout(() => dom.update(content, highlightVersion, false), MARKDOWN_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [content, highlightVersion, streaming])
  useLayoutEffect(() => () => renderer.current?.cancelPending(), [])
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return
    if (isRuntimeWebsiteLink(href)) {
      e.preventDefault()
      openWebsite(href)
    } else if (isAdfFileUrl(href)) {
      e.preventDefault()
      openAdfFileLink(href)
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      // Plain anchors would navigate the renderer in place, which main's
      // will-navigate guard blocks. Route through window.open so the
      // setWindowOpenHandler hands the URL to the OS browser instead.
      e.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }, [openWebsite])
  return (
    <div
      className={`loop-markdown ${className}`}
      ref={container}
      onClick={handleClick}
    />
  )
})
