import { useCallback, useEffect, useRef } from 'react'
import { clampSize } from '../utils/stored-size'

type Bound = number | (() => number)

export interface DragResizeOptions {
  /** 'x' resizes a width (col-resize cursor), 'y' a height (row-resize). */
  axis: 'x' | 'y'
  /**
   * Which way the pointer moves to grow the panel: 1 = toward +x/+y (a panel
   * whose handle is on its right or bottom edge), -1 = toward -x/-y.
   */
  grow: 1 | -1
  min: Bound
  /** A function is read once at drag start, for limits that depend on layout. */
  max: Bound
  /** Size the drag starts from, read at mousedown. */
  getStart: () => number
  /**
   * The drag in progress, already clamped, at most once per animation frame.
   * Write the size straight to the element (or a CSS variable) here and never
   * to React state or a store: a state write per mousemove re-renders whatever
   * reads it at pointer rate. Called one last time, unthrottled, before
   * `onCommit`, so the element always ends on the final size.
   */
  onDrag: (size: number) => void
  /** Once on mouseup with the final size — the place for state and persistence. Skipped if the pointer never moved. */
  onCommit?: (size: number) => void
}

const resolve = (bound: Bound): number => (typeof bound === 'function' ? bound() : bound)

/**
 * Mousedown handler for a panel resize handle. Owns the gesture bookkeeping
 * every handle needs: the body cursor, text-selection lock, the
 * `panel-resizing` class that keeps webviews from swallowing the drag, and the
 * rAF throttle between pointer moves and paints.
 */
export function useDragResize(options: DragResizeOptions): (e: React.MouseEvent) => void {
  // Latest options without re-creating the handler mid-gesture.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const cleanupRef = useRef<(() => void) | null>(null)

  // Unmounting mid-drag (panel closed by a shortcut) must not strand the cursor.
  useEffect(() => () => cleanupRef.current?.(), [])

  return useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const { axis, grow, getStart } = optionsRef.current
    const startPos = axis === 'x' ? e.clientX : e.clientY
    const startSize = getStart()
    const min = resolve(optionsRef.current.min)
    const max = Math.max(min, resolve(optionsRef.current.max))
    let latest: number | null = null
    let frame = 0
    const paint = () => {
      frame = 0
      if (latest !== null) optionsRef.current.onDrag(latest)
    }

    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.body.classList.add('panel-resizing')

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ((axis === 'x' ? ev.clientX : ev.clientY) - startPos) * grow
      const next = clampSize(startSize + delta, min, max)
      if (next === latest) return
      latest = next
      if (!frame) frame = requestAnimationFrame(paint)
    }

    const cleanup = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0 }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.classList.remove('panel-resizing')
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      cleanupRef.current = null
    }

    const onMouseUp = () => {
      cleanup()
      if (latest === null) return
      // The pending frame was just cancelled; without this the element could
      // be left on an earlier size when the final one equals the old state and
      // React therefore has nothing to re-render.
      optionsRef.current.onDrag(latest)
      optionsRef.current.onCommit?.(latest)
    }

    cleanupRef.current = cleanup
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])
}
