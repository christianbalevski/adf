import { useEffect, useRef, useState } from 'react'
import { pickSuggestions } from './suggestions'

/** How often one row changes; the rows take turns, so each changes every SWAP_MS × rows. */
const SWAP_MS = 5000
/** The fade out, then the fade in (globals.css .home-suggestion-row). */
const FADE_OUT_MS = 300

/**
 * Rows of suggestion chips that stand still. Every few seconds one row,
 * in turn, fades to chips not on screen. Nothing slides: text moving a few
 * pixels a second judders on a standard-density monitor however it is
 * drawn, while an opacity fade is smooth everywhere. Hovering or focusing
 * the rows holds them so a chip can be clicked. "Hide suggestions" is the
 * opt-out.
 */
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

  useEffect(() => {
    let fadeTimer: ReturnType<typeof setTimeout> | null = null
    const swap = setInterval(() => {
      if (held.current || document.hidden || fadingRef.current !== null) return
      const index = next.current % rowCount
      next.current = index + 1
      fadingRef.current = index
      setFading(index)
      fadeTimer = setTimeout(() => {
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
        <div key={i} className="home-suggestion-row" data-fading={fading === i ? '' : undefined}>
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
      ))}
    </div>
  )
}
