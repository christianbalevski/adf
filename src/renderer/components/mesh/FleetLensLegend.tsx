import { memo, useMemo } from 'react'
import { useFleetStore } from '../../stores/fleet.store'
import { useMeshStore } from '../../stores/mesh.store'
import { isDarkMode, modelHue } from './FleetTerrainNode'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Small hex swatch matching the map's tile shape. */
function HexSwatch({ fill, stroke, dashed }: { fill: string; stroke: string; dashed?: boolean }) {
  return (
    <svg width="16" height="14" viewBox="0 0 20 18" className="shrink-0">
      <polygon
        points="5,1 15,1 19,9 15,17 5,17 1,9"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.5"
        strokeDasharray={dashed ? '3 2' : undefined}
      />
    </svg>
  )
}

function LegendRow({ swatch, label, hint }: { swatch: React.ReactNode; label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {swatch}
      <span className="truncate text-[10px] text-neutral-600 dark:text-neutral-300">{label}</span>
      {hint && <span className="ml-auto shrink-0 text-[9px] text-neutral-400 dark:text-neutral-500 tabular-nums">{hint}</span>}
    </div>
  )
}

/**
 * Lens legend — swaps its key with the active lens so the coloring is never
 * a guessing game: state swatches for terrain/health, an anchored gradient
 * for burn, and the live model → hue mapping (with counts) for the model
 * lens. Sits top-right, clear of the burn panel and the minimap.
 */
export const FleetLensLegend = memo(function FleetLensLegend() {
  const lens = useFleetStore((s) => s.lens)
  const burn = useFleetStore((s) => s.burn)
  const agents = useMeshStore((s) => s.agents)
  const dark = isDarkMode()

  const models = useMemo(() => {
    if (lens !== 'model') return []
    const counts = new Map<string, number>()
    for (const a of agents) {
      if (!a.model) continue
      counts.set(a.model, (counts.get(a.model) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [lens, agents])

  const maxBurn = useMemo(() => {
    if (lens !== 'burn' || !burn?.perAgent) return 0
    let max = 0
    for (const e of Object.values(burn.perAgent)) max = Math.max(max, e.tokensPerMin)
    return max
  }, [lens, burn])

  const body = (() => {
    switch (lens) {
      case 'terrain':
        return (
          <>
            <LegendRow swatch={<HexSwatch fill={`hsla(45, 85%, ${dark ? 40 : 74}%, 0.7)`} stroke={`hsla(45, 90%, ${dark ? 58 : 48}%, 0.9)`} />} label="active — working now" />
            <LegendRow swatch={<HexSwatch fill={`hsla(140, 40%, ${dark ? 28 : 84}%, 0.7)`} stroke={`hsla(140, 45%, ${dark ? 48 : 55}%, 0.6)`} />} label="idle — folder tint" />
            <LegendRow swatch={<HexSwatch fill={`hsla(0, 60%, ${dark ? 32 : 82}%, 0.7)`} stroke={`hsla(0, 70%, ${dark ? 52 : 55}%, 0.8)`} />} label="error" />
            <LegendRow swatch={<HexSwatch fill={`hsla(0, 0%, ${dark ? 32 : 85}%, 0.6)`} stroke={`hsla(0, 0%, ${dark ? 55 : 50}%, 0.6)`} dashed />} label="offline — not started" />
            <LegendRow swatch={<HexSwatch fill="none" stroke="#f59e0b" />} label="amber ring — needs you" />
          </>
        )
      case 'burn': {
        const stops = [0, 0.33, 0.66, 1]
        return (
          <>
            <div className="flex items-center gap-0.5">
              {stops.map((h) => (
                <HexSwatch
                  key={h}
                  fill={`hsla(${210 - 190 * h}, ${45 + 35 * h}%, ${dark ? 26 + 16 * h : 82 - 22 * h}%, ${0.5 + 0.4 * h})`}
                  stroke={`hsla(${210 - 190 * h}, 70%, ${dark ? 55 : 45}%, ${0.35 + 0.5 * h})`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[9px] text-neutral-400 dark:text-neutral-500">
              <span>cold</span>
              <span>{maxBurn > 0 ? `${formatTokens(maxBurn)}/m` : 'hottest'}</span>
            </div>
            <span className="text-[9px] text-neutral-400 dark:text-neutral-500">log scale · hottest tile pulses</span>
          </>
        )
      }
      case 'model':
        return models.length === 0 ? (
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">no models reported</span>
        ) : (
          <>
            {models.slice(0, 8).map(([model, count]) => (
              <LegendRow
                key={model}
                swatch={<HexSwatch fill={`hsla(${modelHue(model)}, 48%, ${dark ? 30 : 80}%, 0.8)`} stroke={`hsla(${modelHue(model)}, 55%, ${dark ? 55 : 45}%, 0.7)`} />}
                label={model}
                hint={`${count}`}
              />
            ))}
            {models.length > 8 && (
              <span className="text-[9px] text-neutral-400 dark:text-neutral-500">+{models.length - 8} more</span>
            )}
          </>
        )
      case 'health':
        return (
          <>
            <LegendRow swatch={<HexSwatch fill={`hsla(0, 72%, ${dark ? 34 : 74}%, 0.85)`} stroke="hsla(0, 80%, 55%, 0.95)" />} label="error" />
            <LegendRow swatch={<HexSwatch fill={`hsla(40, 90%, ${dark ? 36 : 74}%, 0.8)`} stroke="hsla(40, 95%, 50%, 0.95)" />} label="needs you" />
            <LegendRow swatch={<HexSwatch fill={`hsla(215, 25%, ${dark ? 32 : 78}%, 0.7)`} stroke="hsla(215, 30%, 55%, 0.7)" />} label="held" />
            <LegendRow swatch={<HexSwatch fill={`hsla(220, 8%, ${dark ? 18 : 90}%, 0.5)`} stroke={`hsla(220, 8%, ${dark ? 34 : 65}%, 0.4)`} dashed />} label="offline" />
            <LegendRow swatch={<HexSwatch fill={`hsla(140, 30%, ${dark ? 24 : 86}%, 0.6)`} stroke={`hsla(140, 35%, ${dark ? 42 : 55}%, 0.5)`} />} label="fine" />
          </>
        )
    }
  })()

  return (
    <div className="absolute right-3 top-[4.7rem] z-10 w-[188px] pointer-events-auto select-none">
      <div className="rounded-lg bg-white/85 dark:bg-neutral-900/85 backdrop-blur-sm border border-neutral-200 dark:border-neutral-800 shadow-sm px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{lens}</span>
          <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700 text-[9px] text-neutral-400 dark:text-neutral-500">L</kbd>
        </div>
        {body}
      </div>
    </div>
  )
})
