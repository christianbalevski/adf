import { useEffect, useRef } from 'react'

/**
 * Interval poll that only ticks while the window is actually shown (and, when
 * a ref is given, while that element is on screen). A backgrounded Studio with
 * a dozen panels mounted otherwise keeps firing IPC nobody is looking at.
 *
 * The callback fires immediately on mount and again whenever the panel comes
 * back into view, so the first paint after a return is never stale.
 */
export function usePollWhenVisible(
  fn: () => void,
  intervalMs: number,
  options: { enabled?: boolean; ref?: { current: Element | null } } = {}
): void {
  const { enabled = true, ref } = options
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return

    let timer: ReturnType<typeof setInterval> | null = null
    let onScreen = true

    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const start = () => {
      if (timer !== null) return
      fnRef.current()
      timer = setInterval(() => fnRef.current(), intervalMs)
    }
    const sync = () => {
      if (onScreen && !document.hidden) start()
      else stop()
    }

    let io: IntersectionObserver | null = null
    const el = ref?.current
    if (el) {
      onScreen = false
      io = new IntersectionObserver((entries) => {
        onScreen = entries[entries.length - 1].isIntersecting
        sync()
      })
      io.observe(el)
    }

    document.addEventListener('visibilitychange', sync)
    sync()

    return () => {
      stop()
      io?.disconnect()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [enabled, intervalMs, ref])
}
