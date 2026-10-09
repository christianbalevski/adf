/**
 * One requestAnimationFrame loop for every live orbital. Stops while the
 * document is hidden and while nothing is subscribed.
 */

type FrameFn = (now: number, dt: number) => void

const subscribers = new Set<FrameFn>()
let raf = 0
let last = 0

function tick(now: number): void {
  raf = 0
  // Cap dt so a long stall (a hidden window, a debugger) does not jump the motion.
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
  last = now
  for (const fn of subscribers) fn(now, dt)
  schedule()
}

function schedule(): void {
  if (raf || subscribers.size === 0 || document.hidden) return
  raf = requestAnimationFrame(tick)
}

function onVisibility(): void {
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    last = 0
  } else {
    schedule()
  }
}

export function subscribeFrames(fn: FrameFn): () => void {
  if (subscribers.size === 0) document.addEventListener('visibilitychange', onVisibility)
  subscribers.add(fn)
  schedule()
  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      last = 0
    }
  }
}
