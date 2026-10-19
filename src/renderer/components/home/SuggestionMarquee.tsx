import { useEffect, useRef, useState } from 'react'

/** The drift aimed for, in CSS px per second; the real speed locks to the display. */
const TARGET_SPEED = 14

/**
 * The drift speed for a display: a whole device pixel every k frames, k
 * whole, nearest to TARGET_SPEED. A drift of 14 px/s on a 60 Hz 1x monitor
 * moves a quarter pixel a frame, shown as a pixel every 4 or 5 frames,
 * unevenly: a judder. Every 4 frames exactly (15 px/s) moves evenly.
 * 60 Hz at 1x and 120 Hz at 2x both give 15 px/s.
 */
export function frameLockedSpeed(refreshHz: number, dpr: number): number {
  const perFrame = 1 / dpr
  const k = Math.max(1, Math.round(refreshHz * perFrame / TARGET_SPEED))
  return (refreshHz * perFrame) / k
}

/** The display's refresh rate from the median of a few frame intervals. */
function measureRefresh(frames = 24): Promise<number> {
  return new Promise((resolve) => {
    const deltas: number[] = []
    let last = 0
    const step = (now: number) => {
      if (last) deltas.push(now - last)
      last = now
      if (deltas.length < frames) { requestAnimationFrame(step); return }
      deltas.sort((a, b) => a - b)
      const median = deltas[Math.floor(deltas.length / 2)]
      // A common rate when the measure is plausible; 60 Hz when frames were throttled.
      resolve(median > 2 && median < 50 ? 1000 / median : 60)
    }
    requestAnimationFrame(step)
  })
}

/** The drift speed for the display the window is on, measured again when it moves to another. */
function useDisplaySpeed(): number {
  const [speed, setSpeed] = useState(() => frameLockedSpeed(60, window.devicePixelRatio || 1))
  useEffect(() => {
    let cancelled = false
    const measure = () => {
      measureRefresh().then((hz) => {
        if (!cancelled) setSpeed(frameLockedSpeed(hz, window.devicePixelRatio || 1))
      })
    }
    measure()
    let media: MediaQueryList | null = null
    const watchDpr = () => {
      media?.removeEventListener('change', onDpr)
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      media.addEventListener('change', onDpr)
    }
    const onDpr = () => { watchDpr(); measure() }
    watchDpr()
    // Chromium fires `change` on window.screen when the window moves to another display.
    const scr = window.screen as Screen & EventTarget
    scr.addEventListener?.('change', measure)
    return () => {
      cancelled = true
      media?.removeEventListener('change', onDpr)
      scr.removeEventListener?.('change', measure)
    }
  }, [])
  return speed
}

/**
 * Rows of suggestion chips drifting sideways, alternating direction, at a
 * speed locked to the display (frameLockedSpeed). The same chips twice per
 * row and an animation over one copy's width make the loop seamless. The drift is a Web Animation of `transform`, so the
 * compositor moves the already drawn row: no per-frame JavaScript to stutter
 * when the page is busy, and no text redrawn at fractional pixels. Hovering
 * pauses the drift; the wheel (or a trackpad swipe) scrolls the hovered row
 * by hand. Not gated on reduced motion: RDP sessions report it by default,
 * and "Hide suggestions" is the opt-out.
 */
export function SuggestionMarquee({ rows, onPick, disabled }: {
  rows: string[][]
  onPick: (s: string) => void
  disabled: boolean
}) {
  const speed = useDisplaySpeed()
  return (
    <div className="space-y-2" aria-label="Suggestions">
      {rows.map((row, i) => (
        <MarqueeRow
          key={i}
          chips={row}
          speed={speed * (i % 2 === 1 ? -1 : 1)}
          onPick={onPick}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

function MarqueeRow({ chips, speed, onPick, disabled }: {
  chips: string[]
  /** Pixels per second; negative drifts right. */
  speed: number
  onPick: (s: string) => void
  disabled: boolean
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const hoveredRef = useRef(false)
  hoveredRef.current = hovered
  // Plays or pauses the row's animation from hover, screen and window state.
  const syncRef = useRef<(() => void) | null>(null)
  // Where the row is in its loop (0-1), kept when the speed changes so the row does not jump.
  const progressRef = useRef<number | null>(null)

  useEffect(() => {
    const track = trackRef.current
    const group = groupRef.current
    if (!track || !group || speed === 0) return
    let anim: Animation | null = null
    // One loop: the track moves one copy's width. A negative speed plays it in reverse.
    let duration = 0
    const wrap = (t: number) => ((t % duration) + duration) % duration

    const build = (width: number) => {
      if (width <= 0) return
      const progress = anim && duration > 0 ? wrap(Number(anim.currentTime ?? 0)) / duration : (progressRef.current ?? Math.random())
      anim?.cancel()
      duration = (width / Math.abs(speed)) * 1000
      // perspective() at z = 0 draws the same, but the transform is no longer a
      // plain translation, which Chromium snaps to whole device pixels.
      anim = track.animate(
        [{ transform: 'perspective(1000px) translate3d(0, 0, 0)' }, { transform: `perspective(1000px) translate3d(${-width}px, 0, 0)` }],
        { duration, iterations: Infinity, easing: 'linear', direction: speed < 0 ? 'reverse' : 'normal' },
      )
      anim.currentTime = progress * duration
      sync()
    }

    const row = rowRef.current
    // Drift only while the row is on screen, the window is shown, and the row is not hovered.
    let onScreen = true
    const sync = () => {
      if (!anim) return
      const play = onScreen && !document.hidden && !hoveredRef.current
      if (play && anim.playState !== 'running') anim.play()
      else if (!play && anim.playState === 'running') anim.pause()
    }
    syncRef.current = sync

    const ro = new ResizeObserver(() => build(group.getBoundingClientRect().width))
    ro.observe(group)

    let io: IntersectionObserver | null = null
    if (row) {
      io = new IntersectionObserver((entries) => {
        onScreen = entries[entries.length - 1].isIntersecting
        sync()
      })
      io.observe(row)
    }

    document.addEventListener('visibilitychange', sync)

    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0 || !anim || duration <= 0) return
      e.preventDefault()
      // A wheel step of `delta` px moves the row that far left, either direction of drift.
      anim.currentTime = wrap(Number(anim.currentTime ?? 0) + (delta / speed) * 1000)
    }
    row?.addEventListener('wheel', onWheel, { passive: false })

    build(group.getBoundingClientRect().width)
    return () => {
      syncRef.current = null
      if (anim && duration > 0) progressRef.current = wrap(Number(anim.currentTime ?? 0)) / duration
      anim?.cancel()
      ro.disconnect()
      io?.disconnect()
      document.removeEventListener('visibilitychange', sync)
      row?.removeEventListener('wheel', onWheel)
    }
  }, [speed])

  useEffect(() => { syncRef.current?.() }, [hovered])

  return (
    <div
      ref={rowRef}
      className="home-marquee"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div ref={trackRef} className="home-marquee-track">
        {[0, 1].map((copy) => (
          <div key={copy} ref={copy === 0 ? groupRef : undefined} className="home-marquee-group" aria-hidden={copy === 1}>
            {chips.map((s) => (
              <button
                key={s}
                type="button"
                tabIndex={copy === 1 ? -1 : 0}
                onClick={() => onPick(s)}
                disabled={disabled}
                className="whitespace-nowrap rounded-full border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] px-3 py-1 text-[12px] text-[var(--adf-ui-text-muted)] transition-colors hover:border-[var(--adf-ui-accent)] hover:text-[var(--adf-ui-text)] disabled:opacity-60"
              >
                {s}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
