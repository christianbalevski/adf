import { memo, useEffect, useState } from 'react'

/**
 * Loading veil — covers the canvas while the first fleet poll and layout
 * land, so the user never sees the half-built grid assembling itself.
 * Civ-style: a slowly-orbiting hex sigil over the garden's atmosphere
 * washes, the title, and a rotating survey line. Fades out (700ms) once the
 * world is ready and unmounts entirely after the fade.
 */

const SURVEY_LINES = [
  'Reading the lattice…',
  'Listening for heartbeats…',
  'Retracing old routes…',
  'Counting what burned…',
  'Waking the stewards…',
  'Settling the dew…',
  'Consulting the ledger…',
  'Warming the wires…',
  'Raising the territories…',
  'Asking the garden what grew…',
  'Following the moss…',
  'Sounding the perimeter…'
]

/** Fisher–Yates — a different survey every time the veil rises */
function shuffled<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export const FleetLoadingVeil = memo(function FleetLoadingVeil({ visible }: { visible: boolean }) {
  const [gone, setGone] = useState(false)
  const [line, setLine] = useState(0)
  const [lines] = useState(() => shuffled(SURVEY_LINES))

  useEffect(() => {
    if (visible) return
    const t = setTimeout(() => setGone(true), 750)
    return () => clearTimeout(t)
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => setLine((l) => l + 1), 1400)
    return () => clearInterval(t)
  }, [visible])

  if (gone) return null

  return (
    <div
      className={`absolute inset-0 z-30 flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 transition-opacity duration-700 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* Garden atmosphere — same washes the live map breathes under */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(55% 45% at 22% 18%, rgba(45, 212, 191, 0.07), transparent 70%), radial-gradient(60% 50% at 82% 85%, rgba(167, 139, 250, 0.05), transparent 70%)'
        }}
      />
      <div className="relative flex flex-col items-center gap-4 select-none">
        {/* Hex sigil — dashed survey ring orbiting a glowing core */}
        <svg width="120" height="120" viewBox="-60 -60 120 120" className="overflow-visible">
          <polygon
            points="52,0 26,45 -26,45 -52,0 -26,-45 26,-45"
            fill="none"
            stroke="rgba(45, 212, 191, 0.55)"
            strokeWidth="2.5"
            strokeDasharray="26 17"
            strokeLinecap="round"
            style={{ animation: 'hexDashFlow 7s linear infinite' }}
          />
          <polygon
            points="34,0 17,29.4 -17,29.4 -34,0 -17,-29.4 17,-29.4"
            fill="rgba(45, 212, 191, 0.06)"
            stroke="rgba(45, 212, 191, 0.3)"
            strokeWidth="1.5"
          />
          <circle r="6" fill="rgba(94, 234, 212, 0.9)" style={{ animation: 'hexPulse 2.2s ease-in-out infinite' }} />
        </svg>

        <div className="text-lg font-semibold tracking-wide text-neutral-700 dark:text-neutral-200">
          Age of Agents
        </div>

        <div className="h-4 text-[12px] italic text-neutral-500 dark:text-neutral-400" style={{ animation: 'meshFadeIn 400ms ease-out' }} key={line}>
          {lines[line % lines.length]}
        </div>

        <div className="mesh-pulse-bar w-44 rounded-full" />
      </div>
    </div>
  )
})
