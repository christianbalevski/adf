import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_PLANTS, generateAgentName } from '../../../shared/utils/agent-names'

/** Words each column rolls through before landing, and how long the roll takes. */
const SPIN_STEPS = 6
const SPIN_MS = 700
const LINE_PX = 16

function pickOthers(list: readonly string[], avoid: string, n: number): string[] {
  const out: string[] = []
  while (out.length < n) {
    const w = list[Math.floor(Math.random() * list.length)]
    if (w !== avoid && out[out.length - 1] !== w) out.push(w)
  }
  return out
}

/**
 * The next agent's name, as a chip. Clicking it rolls a new one: the
 * adjective column spins up, the plant column spins down, both land in
 * under a second. `onSpin` is told about every roll so the composer can say
 * "you can rename it later" after a few.
 */
export function NameChip({ name, onChange, onSpin }: {
  name: string
  onChange: (name: string) => void
  onSpin: () => void
}) {
  const [adj, plant] = name.split('-')
  // `id` changes per roll so the strips remount and their keyframes restart
  // from the top, even when a click lands mid-spin.
  const [spin, setSpin] = useState<{ id: number; adj: string[]; plant: string[]; to: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rolls = useRef(0)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const roll = useCallback(() => {
    onSpin()
    let next = generateAgentName()
    while (next === name) next = generateAgentName()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) { onChange(next); return }
    const [nAdj, nPlant] = next.split('-')
    if (timer.current) clearTimeout(timer.current)
    // Adjective strip: current at the top, new at the bottom; slides up.
    // Plant strip: new at the top, current at the bottom; slides down.
    rolls.current += 1
    setSpin({
      id: rolls.current,
      adj: [adj, ...pickOthers(AGENT_NAME_ADJECTIVES, nAdj, SPIN_STEPS), nAdj],
      plant: [nPlant, ...pickOthers(AGENT_NAME_PLANTS, nPlant, SPIN_STEPS), plant],
      to: next,
    })
    timer.current = setTimeout(() => {
      onChange(next)
      setSpin(null)
    }, SPIN_MS + 40)
  }, [adj, name, onChange, onSpin, plant])

  const travel = (SPIN_STEPS + 1) * LINE_PX
  const spinStyle = { '--name-spin-travel': `${travel}px`, '--name-spin-ms': `${SPIN_MS}ms` } as React.CSSProperties

  return (
    <button
      type="button"
      onClick={roll}
      aria-label={`Name: ${spin ? spin.to : name}. Click for another`}
      className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] pl-1.5 pr-2 text-[11.5px] font-medium text-[var(--adf-ui-text)] transition-colors hover:border-[var(--adf-ui-accent)]"
    >
      <LeafIcon />
      <span className="inline-flex items-baseline overflow-hidden" style={{ height: LINE_PX, lineHeight: `${LINE_PX}px` }} aria-hidden>
        {spin ? (
          <>
            <span key={`up-${spin.id}`} className="name-spin name-spin-up inline-grid" style={spinStyle}>
              {spin.adj.map((w, i) => <span key={i} className="block" style={{ height: LINE_PX }}>{w}</span>)}
            </span>
            <span>-</span>
            <span key={`down-${spin.id}`} className="name-spin name-spin-down inline-grid" style={spinStyle}>
              {spin.plant.map((w, i) => <span key={i} className="block" style={{ height: LINE_PX }}>{w}</span>)}
            </span>
          </>
        ) : (
          <>
            <span key="adj">{adj}</span>
            <span>-</span>
            <span key="plant">{plant}</span>
          </>
        )}
      </span>
      <ShuffleIcon />
    </button>
  )
}

function LeafIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--adf-ui-accent)]" aria-hidden>
      <path d="M20 4c-8 0-14 5-14 13 0 1 .1 2 .3 3C11 20 20 16 20 4z" />
      <path d="M6 20c3-5 7-9 12-12" />
    </svg>
  )
}

function ShuffleIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--adf-ui-text-subtle)]" aria-hidden>
      <path d="M3 4v6h6M21 20v-6h-6" />
      <path d="M21 10A9 9 0 0 0 5.6 6.3L3 10M3 14a9 9 0 0 0 15.4 3.7L21 14" />
    </svg>
  )
}
