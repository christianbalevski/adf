import { useEffect, useRef, useState } from 'react'

/** Pixels per second, one per row, so the rows drift out of step. */
const ROW_SPEEDS = [16, 12, 14]

/**
 * Rows of suggestion chips drifting sideways, alternating direction. The
 * same chips twice per row and an animation over one copy's width make the
 * loop seamless. The drift is a Web Animation of `transform`, so the
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
  return (
    <div className="space-y-2" aria-label="Suggestions">
      {rows.map((row, i) => (
        <MarqueeRow
          key={i}
          chips={row}
          speed={ROW_SPEEDS[i % ROW_SPEEDS.length] * (i % 2 === 1 ? -1 : 1)}
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
      const progress = anim && duration > 0 ? wrap(Number(anim.currentTime ?? 0)) / duration : Math.random()
      anim?.cancel()
      duration = (width / Math.abs(speed)) * 1000
      anim = track.animate(
        [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${-width}px, 0, 0)` }],
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
