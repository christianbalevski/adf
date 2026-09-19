import { useEffect, useRef, useState } from 'react'

/** Pixels per second, one per row, so the rows drift out of step. */
const ROW_SPEEDS = [16, 12, 14]

/**
 * Rows of suggestion chips drifting sideways, alternating direction. The
 * same chips twice per row and a position wrapped to one copy's width make
 * the loop seamless. Hovering pauses the drift; the wheel (or a trackpad
 * swipe) scrolls the hovered row by hand. Not gated on reduced motion: RDP
 * sessions report it by default, and "Hide suggestions" is the opt-out.
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
  // Position in px, kept in (-W, 0] where W is one copy's width; a ref, not
  // state, because it changes every frame.
  const pos = useRef<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const hoveredRef = useRef(false)
  hoveredRef.current = hovered

  useEffect(() => {
    const track = trackRef.current
    const group = groupRef.current
    if (!track || !group) return
    const width = () => group.getBoundingClientRect().width
    const apply = () => {
      const w = width()
      if (w <= 0) return
      if (pos.current === null) pos.current = -Math.random() * w
      // Wrap into (-w, 0]: the second copy makes any such offset look whole.
      pos.current = ((pos.current % w) - w) % w
      track.style.transform = `translate3d(${pos.current}px, 0, 0)`
    }

    let last = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (!hoveredRef.current && pos.current !== null) {
        pos.current -= speed * dt
      }
      apply()
      frame = requestAnimationFrame(tick)
    }
    apply()
    frame = requestAnimationFrame(tick)

    const row = rowRef.current
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0) return
      e.preventDefault()
      if (pos.current !== null) pos.current -= delta
      apply()
    }
    row?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      row?.removeEventListener('wheel', onWheel)
    }
  }, [speed])

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
