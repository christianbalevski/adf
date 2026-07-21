import { memo, useMemo, useState } from 'react'
import { useFleetStore } from '../../stores/fleet.store'
import { useMeshStore } from '../../stores/mesh.store'
import { isDarkMode, modelHue } from './FleetTerrainNode'
import { factionHue } from './FleetStationNode'

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
export const FleetLensLegend = memo(function FleetLensLegend({
  foreignHubs = []
}: {
  /** Discovered peer runtimes — each gets its own cool allegiance hue. */
  foreignHubs?: { runtimeId: string; label: string }[]
}) {
  const lens = useFleetStore((s) => s.lens)
  const cycleLens = useFleetStore((s) => s.cycleLens)
  const burn = useFleetStore((s) => s.burn)
  const agents = useMeshStore((s) => s.agents)
  const dark = isDarkMode()
  const [collapsed, setCollapsed] = useState(false)

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
            <LegendRow swatch={<HexSwatch fill={`hsla(140, 40%, ${dark ? 28 : 84}%, 0.7)`} stroke={`hsla(140, 45%, ${dark ? 48 : 55}%, 0.6)`} />} label="idle — ready" />
            <LegendRow swatch={<HexSwatch fill={`hsla(0, 60%, ${dark ? 32 : 82}%, 0.7)`} stroke={`hsla(0, 70%, ${dark ? 52 : 55}%, 0.8)`} />} label="error" />
            <LegendRow swatch={<HexSwatch fill={`hsla(0, 0%, ${dark ? 32 : 85}%, 0.6)`} stroke={`hsla(0, 0%, ${dark ? 55 : 50}%, 0.6)`} dashed />} label="offline — not started" />
            <LegendRow swatch={<HexSwatch fill="none" stroke="#f59e0b" />} label="needs your attention" />
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
      case 'lineage': {
        // Sample family ramp — real hues are per-dynasty (hash of the root)
        const h = 200
        const L = (step: number) => (dark ? 26 + step * 9 : 46 + step * 10)
        return (
          <>
            <div className="flex items-center gap-0.5">
              {[0, 1, 2, 3].map((g) => (
                <HexSwatch
                  key={g}
                  fill={`hsla(${h}, 52%, ${L(g)}%, 0.8)`}
                  stroke={`hsla(${h}, 58%, ${dark ? L(g) + 16 : L(g) - 18}%, 0.8)`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[9px] text-neutral-400 dark:text-neutral-500">
              <span>root</span>
              <span>younger generations</span>
            </div>
            <LegendRow swatch={<HexSwatch fill={`hsla(220, 8%, ${dark ? 18 : 90}%, 0.4)`} stroke={`hsla(220, 8%, ${dark ? 34 : 65}%, 0.25)`} />} label="no family — solo agent" />
            <LegendRow swatch={<HexSwatch fill={`hsla(${h}, 52%, ${L(1)}%, 0.5)`} stroke={`hsla(${h}, 58%, ${dark ? 55 : 40}%, 0.7)`} dashed />} label="broken chain / offline" />
            <span className="text-[9px] text-neutral-400 dark:text-neutral-500">one hue per dynasty · darkest = founder</span>
          </>
        )
      }
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
        <div className="w-full flex items-center justify-between gap-2">
          {/* The overlay cycler lives here now — the legend is the overlay's
              home, so changing it happens where its meaning is explained */}
          <button
            onClick={cycleLens}
            className="group flex items-center gap-1.5 text-left"
            title="Change overlay — terrain (state), burn (token heat), model, health, lineage. Press L to cycle."
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-700 dark:group-hover:text-neutral-200">{lens}</span>
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300"
            >
              <path d="M17 2l4 4-4 4" />
              <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
              <path d="M7 22l-4-4 4-4" />
              <path d="M21 13v1a4 4 0 0 1-4 4H3" />
            </svg>
            <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700 text-[9px] text-neutral-400 dark:text-neutral-500">L</kbd>
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-0.5"
            title={collapsed ? 'Expand legend' : 'Collapse legend'}
          >
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
        {!collapsed && body}
        {/* Allegiance — foreign runtimes carry a cool per-hub hue on their
            cluster ground/border/label under every lens, so "not ours" reads
            at a glance regardless of the active metric. */}
        {!collapsed && foreignHubs.length > 0 && (
          <div className="pt-1.5 mt-0.5 border-t border-neutral-100 dark:border-neutral-800 space-y-1">
            <span className="text-[9px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">foreign runtimes</span>
            {foreignHubs.slice(0, 4).map((h) => {
              const fh = factionHue(h.runtimeId)
              return (
                <LegendRow
                  key={h.runtimeId}
                  swatch={<HexSwatch fill={`hsla(${fh}, ${dark ? 45 : 42}%, ${dark ? 56 : 62}%, 0.5)`} stroke={`hsla(${fh}, 58%, ${dark ? 66 : 46}%, 0.9)`} />}
                  label={h.label}
                />
              )
            })}
            {foreignHubs.length > 4 && (
              <span className="text-[9px] text-neutral-400 dark:text-neutral-500">+{foreignHubs.length - 4} more</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
