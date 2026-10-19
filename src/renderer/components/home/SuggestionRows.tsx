import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { pickSuggestions } from './suggestions'

/** How often one row changes; the rows take turns, so each changes every SWAP_MS × rows. */
const SWAP_MS = 5000
/** The fade out, then the fade in (globals.css .home-suggestion-row). */
const FADE_OUT_MS = 300

/**
 * Rows of suggestion chips that stand still. Every few seconds one row,
 * in turn, fades to chips not on screen. Nothing slides: text moving a few
 * pixels a second judders on a standard-density monitor however it is
 * drawn, while an opacity fade is smooth everywhere. A row is wider than
 * the page and starts centred; a sideways swipe (or Shift+wheel) scrolls it
 * by hand, the up/down wheel stays the page's. Hovering or focusing the
 * rows holds them so a chip can be clicked. "Hide suggestions" is the
 * opt-out.
 */

/** Scroll a row so its middle is in the middle. */
function centre(row: HTMLElement | null): void {
  if (row) row.scrollLeft = (row.scrollWidth - row.clientWidth) / 2
}
export function SuggestionRows({ rowCount, perRow, onPick, disabled }: {
  rowCount: number
  perRow: number
  onPick: (s: string) => void
  disabled: boolean
}) {
  const [rows, setRows] = useState(() => {
    const picks = pickSuggestions(rowCount * perRow)
    return Array.from({ length: rowCount }, (_, i) => picks.slice(i * perRow, (i + 1) * perRow))
  })
  const [fading, setFading] = useState<number | null>(null)
  const fadingRef = useRef<number | null>(null)
  const held = useRef(false)
  const next = useRef(0)
  const rowEls = useRef<Array<HTMLDivElement | null>>([])
  // The row whose chips just changed starts centred again; null centres every row.
  const recentre = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (recentre.current === null) rowEls.current.forEach(centre)
    else centre(rowEls.current[recentre.current] ?? null)
  }, [rows])

  // A resize (or the chip font arriving) centres the rows again, unless one is in use.
  useEffect(() => {
    const ro = new ResizeObserver(() => { if (!held.current) rowEls.current.forEach(centre) })
    rowEls.current.forEach((el) => el && ro.observe(el))
    return () => ro.disconnect()
  }, [rowCount])

  useEffect(() => {
    let fadeTimer: ReturnType<typeof setTimeout> | null = null
    const swap = setInterval(() => {
      if (held.current || document.hidden || fadingRef.current !== null) return
      const index = next.current % rowCount
      next.current = index + 1
      fadingRef.current = index
      setFading(index)
      fadeTimer = setTimeout(() => {
        recentre.current = index
        setRows((current) => {
          const shown = new Set(current.flat())
          const fresh = pickSuggestions(perRow, Math.random, shown)
          return current.map((row, i) => (i === index && fresh.length > 0 ? fresh : row))
        })
        fadingRef.current = null
        setFading(null)
      }, FADE_OUT_MS)
    }, SWAP_MS)
    return () => {
      clearInterval(swap)
      if (fadeTimer) clearTimeout(fadeTimer)
    }
  }, [rowCount, perRow])

  return (
    <div
      className="space-y-2"
      aria-label="Suggestions"
      onMouseEnter={() => { held.current = true }}
      onMouseLeave={() => { held.current = false }}
      onFocus={() => { held.current = true }}
      onBlur={() => { held.current = false }}
    >
      {rows.map((row, i) => (
        <div key={i} ref={(el) => { rowEls.current[i] = el }} className="home-suggestion-row" data-fading={fading === i ? '' : undefined}>
          <div className="home-suggestion-track">
          {row.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              disabled={disabled}
              className="shrink-0 whitespace-nowrap rounded-full border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] px-3 py-1 text-[12px] text-[var(--adf-ui-text-muted)] transition-colors hover:border-[var(--adf-ui-accent)] hover:text-[var(--adf-ui-text)] disabled:opacity-60"
            >
              {s}
            </button>
          ))}
          </div>
        </div>
      ))}
    </div>
  )
}
