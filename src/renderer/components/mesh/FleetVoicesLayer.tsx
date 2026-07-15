import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { joinDir, type TerrainCell } from './fleet-layout'
import { hueFromPath, isDarkMode } from './FleetTerrainNode'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

/**
 * Voices — the group-status layer, rendered in SCREEN space above the whole
 * canvas (like the hover cards) rather than inside the React Flow world.
 * That buys three things the in-world chips couldn't do:
 *  - pixel-constant type: the font never warps with zoom, so a status is
 *    exactly as readable from orbit as up close (no growing truncation)
 *  - clean z-order: nothing from the node layer (start buttons, pips)
 *    pokes through
 *  - a semantic zoom hierarchy: far out only the ROOT dir speaks; closing
 *    in crossfades to the subdir voices; closer still everything yields to
 *    tile-level text. Territories without subdirs keep their voice longer.
 */

export interface VoiceTerrain {
  dirPath: string
  /** Terrain node origin in world coords (cells are node-relative) */
  x: number
  y: number
  cells: TerrainCell[]
  districts: string[]
  memberPaths: string[]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const fadeIn = (z: number, a: number, b: number) => clamp((z - a) / (b - a), 0, 1)
const fadeOut = (z: number, a: number, b: number) => clamp((b - z) / (b - a), 0, 1)

/** Crossfade band: root voices hand over to district voices as plots resolve */
const CROSS_A = 0.3
const CROSS_B = 0.44

const FONT = 13
const LINE_H = FONT * 1.35

interface ChipSpec {
  key: string
  dir: string
  hue: number
  /** World-space anchor (plot centroid) */
  wx: number
  wy: number
  /** World-space plot width */
  span: number
  voice: FleetAgentStatus
  isSteward: boolean
  level: 'root' | 'district'
  hasDistricts: boolean
}

export const FleetVoicesLayer = memo(function FleetVoicesLayer({
  terrains
}: {
  terrains: VoiceTerrain[]
}) {
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)
  const stewards = useFleetStore((s) => s.stewards)
  const lens = useFleetStore((s) => s.lens)
  const voicesOverride = useFleetStore((s) => s.voicesOverride)
  const dark = isDarkMode()
  const voicesOn = voicesOverride ?? lens === 'terrain'

  // World-space chip anchors + voice selection — independent of the viewport
  const chips = useMemo<ChipSpec[]>(() => {
    const byPath = new Map(agents.map((a) => [a.filePath, a]))
    const byDid = new Map(agents.filter((a) => a.did).map((a) => [a.did!, a]))

    const pickVoice = (paths: string[], stewardDid?: string): { voice?: FleetAgentStatus; isSteward: boolean } => {
      const steward = stewardDid ? byDid.get(stewardDid) : undefined
      if (steward) return { voice: steward, isSteward: true }
      let voice: FleetAgentStatus | undefined
      let bestAt = -1
      for (const p of paths) {
        const a = byPath.get(p)
        if (!a) continue
        const acts = nodeActivities[p]
        const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
        const score = a.state === 'active' ? last + 1e15 : last
        if (score > bestAt) {
          bestAt = score
          voice = a
        }
      }
      return { voice, isSteward: false }
    }

    const out: ChipSpec[] = []
    for (const t of terrains) {
      const hue = hueFromPath(t.dirPath)
      const occupied = t.cells.filter((c) => c.filePath)
      if (occupied.length === 0) continue

      const anchorOf = (cells: TerrainCell[]) => {
        const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length
        const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length
        const span =
          Math.max(...cells.map((c) => c.x)) - Math.min(...cells.map((c) => c.x)) + 400
        return { wx: t.x + cx, wy: t.y + cy, span }
      }

      // Root voice speaks for the whole territory, anchored on the capital
      const capital = occupied.filter((c) => c.district === '')
      const { voice, isSteward } = pickVoice(t.memberPaths, stewards[t.dirPath])
      if (voice && (voice.status || voice.handle)) {
        out.push({
          key: `root:${t.dirPath}`,
          dir: t.dirPath,
          hue,
          ...anchorOf(capital.length > 0 ? capital : occupied),
          voice,
          isSteward,
          level: 'root',
          hasDistricts: t.districts.length > 0
        })
      }

      for (const district of t.districts) {
        const owned = occupied.filter((c) => c.district === district)
        if (owned.length === 0) continue
        const dir = joinDir(t.dirPath, district)
        const paths = owned.map((c) => c.filePath!).filter(Boolean)
        const dv = pickVoice(paths, stewards[dir])
        if (!dv.voice || (!dv.voice.status && !dv.voice.handle)) continue
        out.push({
          key: `district:${dir}`,
          dir,
          hue,
          ...anchorOf(owned),
          voice: dv.voice,
          isSteward: dv.isSteward,
          level: 'district',
          hasDistricts: false
        })
      }
    }
    return out
  }, [terrains, agents, nodeActivities, stewards])

  if (!voicesOn || zoom <= 0.05) return null

  // Semantic-zoom opacity per level
  const alphaFor = (c: ChipSpec): number => {
    if (c.level === 'root') {
      const out = c.hasDistricts ? fadeOut(zoom, CROSS_A, CROSS_B) : fadeOut(zoom, 0.55, 0.8)
      return fadeIn(zoom, 0.05, 0.09) * out
    }
    return fadeIn(zoom, CROSS_A, CROSS_B) * fadeOut(zoom, 0.6, 0.8)
  }

  // Project to screen, cull, estimate boxes, declutter (push lower chip down)
  const W = window.innerWidth
  const H = window.innerHeight
  const visible = chips
    .map((c) => {
      const alpha = alphaFor(c)
      if (alpha <= 0.02) return null
      const sx = c.wx * zoom + tx
      const sy = c.wy * zoom + ty
      if (sx < -400 || sx > W + 400 || sy < -300 || sy > H + 300) return null
      const maxW = clamp(c.span * zoom * 1.4, 260, 480)
      const chars = c.voice.handle.length + (c.voice.status?.length ?? 0) + 3
      const lines = clamp(Math.ceil((chars * FONT * 0.52) / (maxW - 20)), 1, 3)
      const w = Math.min(maxW, chars * FONT * 0.55 + 22)
      const h = lines * LINE_H + 12
      return { ...c, alpha, sx, sy, maxW, w, h }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.sy - b.sy)
  const placed: { sx: number; sy: number; w: number; h: number }[] = []
  for (const c of visible) {
    for (const p of placed) {
      if (Math.abs(c.sx - p.sx) < ((c.w + p.w) / 2) * 0.9 && Math.abs(c.sy - p.sy) < (c.h + p.h) / 2) {
        c.sy = p.sy + (p.h + c.h) / 2 + 6
      }
    }
    placed.push({ sx: c.sx, sy: c.sy, w: c.w, h: c.h })
  }

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 5 }}>
      {visible.map((c) => (
        <div
          key={c.key}
          className="fleet-voice-chip absolute cursor-pointer"
          style={{
            left: c.sx,
            top: c.sy,
            transform: 'translate(-50%, -50%)',
            maxWidth: c.maxW,
            opacity: c.alpha,
            pointerEvents: c.alpha < 0.15 ? 'none' : 'auto',
            fontSize: FONT,
            lineHeight: 1.35,
            padding: '5px 10px',
            borderRadius: 12,
            background: dark ? 'rgba(15, 18, 22, 0.85)' : 'rgba(255, 255, 255, 0.9)',
            border: `1px solid hsla(${c.hue}, 30%, ${dark ? 55 : 45}%, 0.45)`,
            color: dark ? 'rgba(190,190,190,0.85)' : 'rgba(90,90,90,0.85)',
            boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.35)' : '0 2px 10px rgba(0,0,0,0.08)'
          }}
          onClick={() => useFleetStore.getState().setReadoutDir(c.dir)}
          onMouseEnter={() => useFleetStore.getState().setHoverDir(c.dir)}
          onMouseLeave={() => useFleetStore.getState().setHoverDir(null)}
          title="Click for the full group readout"
        >
          <span style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            <span style={{ fontWeight: 600, color: dark ? 'rgba(235,235,235,0.95)' : 'rgba(45,45,45,0.95)' }}>
              {c.isSteward ? '♛ ' : ''}{c.voice.handle}
            </span>
            {c.voice.status ? <span style={{ fontStyle: 'italic' }}> — {c.voice.status}</span> : null}
          </span>
        </div>
      ))}
    </div>
  )
})
