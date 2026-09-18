import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_PLANTS, generateAgentName } from '../../../shared/utils/agent-names'

/** Words each column rolls through before landing, and how long the roll takes. */
const SPIN_STEPS = 6
const SPIN_MS = 700
const LINE_PX = 16
/** Same rule as the rename dialog and main's file check: a name is a file name. */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/
const MAX_NAME = 64

export function nameProblem(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'A name is needed.'
  if (name.length > MAX_NAME) return `Keep the name under ${MAX_NAME} characters.`
  if (INVALID_NAME_CHARS.test(name)) return 'Names cannot contain / \\ : * ? " < > |'
  if (name.endsWith('.')) return 'A name cannot end with a dot.'
  return null
}

function pickOthers(list: readonly string[], avoid: string, n: number): string[] {
  const out: string[] = []
  while (out.length < n) {
    const w = list[Math.floor(Math.random() * list.length)]
    if (w !== avoid && out[out.length - 1] !== w) out.push(w)
  }
  return out
}

/**
 * The next agent's name, as a chip with two handles: the shuffle at the left
 * edge rolls one (fixed spot, so repeat clicks need no re-aiming), and
 * clicking the name types one. A roll spins the adjective column up
 * and the plant column down and lands in under a second. Typed names only
 * have to be file names; rolled ones are always adjective-plant. `onSpin`
 * is told about every roll so the composer can react after a few, and
 * `onInvalid` gets the reason a typed name was refused.
 */
export function NameChip({ name, onChange, onSpin, onInvalid, refused = 0 }: {
  name: string
  onChange: (name: string) => void
  onSpin: () => void
  onInvalid?: (reason: string) => void
  /** Bumped by the owner each time this name is refused (taken, bad); the chip turns red and shakes once per bump. */
  refused?: number
}) {
  const dash = name.indexOf('-')
  const [adj, plant] = dash > 0 ? [name.slice(0, dash), name.slice(dash + 1)] : [name, '']
  // `id` changes per roll so the strips remount and their keyframes restart
  // from the top, even when a click lands mid-spin.
  const [spin, setSpin] = useState<{ id: number; adj: string[]; plant: string[]; to: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rolls = useRef(0)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const isEditing = editing !== null
  useEffect(() => {
    if (isEditing) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [isEditing])

  const roll = useCallback(() => {
    if (editing !== null) setEditing(null)
    onSpin()
    let next = generateAgentName()
    while (next === name) next = generateAgentName()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // A typed name has no columns to spin from; land the new one directly.
    if (reduce || !plant) { onChange(next); return }
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
  }, [adj, editing, name, onChange, onSpin, plant])

  const commit = () => {
    if (editing === null) return
    const typed = editing.trim()
    setEditing(null)
    if (!typed) { onChange(generateAgentName()); return }
    if (typed === name) return
    const problem = nameProblem(typed)
    if (problem) { setBadTyped((n) => n + 1); onInvalid?.(problem); return }
    onChange(typed)
  }

  const travel = (SPIN_STEPS + 1) * LINE_PX
  const spinStyle = { '--name-spin-travel': `${travel}px`, '--name-spin-ms': `${SPIN_MS}ms` } as React.CSSProperties
  const shell = 'inline-flex h-6 items-center gap-0.5 rounded-full border bg-[var(--adf-ui-canvas)] pl-0.5 pr-2 text-[11.5px] font-medium text-[var(--adf-ui-text)] transition-colors'
  // The refusal look lasts until the name changes; the shake plays once per bump.
  const [refusedFor, setRefusedFor] = useState<{ n: number; name: string } | null>(null)
  useEffect(() => { if (refused > 0) setRefusedFor({ n: refused, name }) }, [refused]) // eslint-disable-line react-hooks/exhaustive-deps
  const isRefused = !!refusedFor && refusedFor.name === name
  const [badTyped, setBadTyped] = useState(0)
  const shakeKey = (refusedFor?.n ?? 0) * 1000 + badTyped
  const shake = isRefused || badTyped > 0 ? 'name-shake' : ''

  if (editing !== null) {
    return (
      <span key={`edit-${shakeKey}`} className={`${shell} ${shake} ${isRefused ? 'border-[var(--adf-ui-danger)]' : 'border-[var(--adf-ui-accent)]'}`}>
        <ShuffleButton onClick={roll} />
        <input
          ref={inputRef}
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
          }}
          aria-label="Agent name"
          spellCheck={false}
          style={{ width: `${Math.max(6, Math.min(MAX_NAME, editing.length + 1))}ch` }}
          className="bg-transparent font-medium text-[var(--adf-ui-text)] outline-none"
        />
      </span>
    )
  }

  return (
    <span key={`show-${shakeKey}`} className={`${shell} ${shake} ${isRefused ? 'border-[var(--adf-ui-danger)] text-[var(--adf-ui-danger)]' : 'border-[var(--adf-ui-border)] hover:border-[var(--adf-ui-accent)]'}`}>
      <ShuffleButton onClick={roll} />
      <button
        type="button"
        onClick={() => setEditing(spin ? spin.to : name)}
        aria-label={`Name: ${spin ? spin.to : name}. Click to type another`}
        className="inline-flex items-baseline overflow-hidden rounded-sm px-0.5 hover:bg-[var(--adf-ui-surface-hover)]"
        style={{ height: LINE_PX, lineHeight: `${LINE_PX}px` }}
      >
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
          <span className="max-w-[16rem] truncate">{name}</span>
        )}
      </button>
    </span>
  )
}

function ShuffleButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Roll a new name"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--adf-ui-accent)] transition-colors hover:bg-[var(--adf-ui-accent-subtle)]"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 4v6h6M21 20v-6h-6" />
        <path d="M21 10A9 9 0 0 0 5.6 6.3L3 10M3 14a9 9 0 0 0 15.4 3.7L21 14" />
      </svg>
    </button>
  )
}
