import { COMPACT_WEB_QUERY } from '../renderer/hooks/useCompactWebLayout'

/** Safari may resize/pan only the visual viewport when its keyboard opens.
 * Keep the app inside that rectangle, but don't counteract intentional pinch zoom.
 */
export function installWebViewport(win: Window = window): () => void {
  const root = win.document.documentElement
  const media = win.matchMedia(COMPACT_WEB_QUERY)
  const viewport = win.visualViewport
  let frame = 0

  const update = () => {
    frame = 0
    if (!media.matches) {
      delete root.dataset.compactWeb
      root.style.removeProperty('--web-viewport-height')
      root.style.removeProperty('--web-viewport-top')
      return
    }
    root.dataset.compactWeb = ''
    // Shrinking/repositioning the layout during a pinch would fight browser zoom.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return
    const height = viewport?.height ?? win.innerHeight
    const top = viewport?.offsetTop ?? 0
    if (height > 0) root.style.setProperty('--web-viewport-height', `${height}px`)
    root.style.setProperty('--web-viewport-top', `${Math.max(0, top)}px`)
  }
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(update) }
  update()
  media.addEventListener('change', schedule)
  win.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  return () => {
    win.cancelAnimationFrame(frame)
    media.removeEventListener('change', schedule)
    win.removeEventListener('resize', schedule)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    delete root.dataset.compactWeb
    root.style.removeProperty('--web-viewport-height')
    root.style.removeProperty('--web-viewport-top')
  }
}
