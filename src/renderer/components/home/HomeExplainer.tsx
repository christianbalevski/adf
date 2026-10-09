import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { usePrefersReducedMotion } from '../orbital/orbital-env'
import { NextAgentOrbital } from './NextAgentIdentity'
import type { OrbitalCreature } from '../orbital/orbital-creature'
import { SpeechBubble } from '../common/SpeechBubble'

/** Quips by reroll count, highest first so one roll shows one line. */
const SPIN_LINES: ReadonlyArray<readonly [number, string]> = [
  [15, "Ok chill! This thing was vibe coded, don't break it!"],
  [12, 'I guess not lol'],
  [8, "Can't find what you're looking for? Maybe the next spin will be it"],
  [4, 'You can rename it later.'],
]
/** Brand speech timing: types at 30 ms per char, holds, fades over 220 ms. */
const TYPE_MS = 30
const HOLD_MS = 3000
const FADE_MS = 220

export interface Quip { id: number; text: string }

/**
 * The orbital's reaction to rerolls of this agent: the obvious at four, then
 * a nudge, a shrug, and a plea. Each line once per agent; `reset` (after a
 * send) starts the count over for the next one.
 */
export function useRerollQuips(): { quip: Quip | null; spin: () => void; reset: () => void } {
  const spins = useRef(0)
  const said = useRef<Set<number>>(new Set())
  const [quip, setQuip] = useState<Quip | null>(null)
  const spin = useCallback(() => {
    spins.current += 1
    const hit = SPIN_LINES.find(([at]) => spins.current >= at && !said.current.has(at))
    if (!hit) return
    said.current.add(hit[0])
    setQuip((q) => ({ id: (q?.id ?? 0) + 1, text: hit[1] }))
  }, [])
  const reset = useCallback(() => {
    spins.current = 0
    said.current.clear()
    setQuip(null)
  }, [])
  return { quip, spin, reset }
}

/**
 * A small speech bubble to the right of the orbital, tail pointing at it.
 * Types in, holds, fades; under reduced motion it shows whole and hides
 * without a fade. Never takes pointer events. Screen readers get the whole
 * line once, politely.
 */
function QuipBubble({ quip }: { quip: Quip | null }) {
  const reduce = usePrefersReducedMotion()
  const [typed, setTyped] = useState(0)
  const [on, setOn] = useState(false)
  const text = quip?.text ?? ''
  useEffect(() => {
    if (!quip) { setOn(false); return }
    const len = quip.text.length
    setOn(true)
    setTyped(reduce ? len : 0)
    const start = performance.now()
    const typer = reduce ? null : setInterval(() => {
      const n = Math.min(len, Math.floor((performance.now() - start) / TYPE_MS))
      setTyped(n)
      if (n >= len && typer) clearInterval(typer)
    }, TYPE_MS)
    const hide = setTimeout(() => setOn(false), len * TYPE_MS + HOLD_MS)
    return () => { if (typer) clearInterval(typer); clearTimeout(hide) }
  }, [quip, reduce])

  return (
    <>
      <span className="sr-only" aria-live="polite">{on ? text : ''}</span>
      {quip && (
        <SpeechBubble
          className="pointer-events-none absolute left-full top-3 ml-3 w-max max-w-[220px]"
          style={{ opacity: on ? 1 : 0, transition: reduce ? 'none' : `opacity ${FADE_MS}ms ease` }}
        >
          {/* The full line holds the size so the bubble does not grow while typing. */}
          <span aria-hidden className="grid">
            <span className="invisible col-start-1 row-start-1">{text}</span>
            <span className="col-start-1 row-start-1">{text.slice(0, typed)}</span>
          </span>
        </SpeechBubble>
      )}
    </>
  )
}

/**
 * One faint beat in the empty middle of home: the next agent's orbital, from
 * the identity it will be created with, and a hello in its name. The orbital
 * is alive (NextAgentOrbital), turns as the name is typed and says something
 * after a few rerolls.
 */
export function HomeExplainer({ did, quip, creature }: { did: string | null; quip: Quip | null; creature: OrbitalCreature }) {
  const name = useAppStore((s) => s.homeName)?.trim() ?? ''
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-2 text-center text-[var(--adf-ui-text-subtle)]">
      <div className="mb-3">
        <NextAgentOrbital did={did} spinImpulse={name.length} creature={creature}>
          <QuipBubble quip={quip} />
        </NextAgentOrbital>
      </div>
      <p className="max-w-full break-words text-[13px] font-medium text-[var(--adf-ui-text-muted)]">
        {name
          ? <>Hi, I&apos;m <span className="font-semibold text-[var(--adf-ui-text)]">{name}</span>.</>
          : 'Hi. Give me a name below.'}
      </p>
    </div>
  )
}
