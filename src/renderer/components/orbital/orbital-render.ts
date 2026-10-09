/**
 * Draws one cached orbital image (static frame or sprite strip) to PNG bytes.
 * Runs in the render worker; the main thread uses it directly only when the
 * worker cannot start.
 */

import { drawOrbital, orbitalFromSeed } from '../../lib/brand/orbital.js'
import { ORBITAL_DRAW_SIZE, ORBITAL_FRAME_PX, ORBITAL_STRIP_FRAMES } from './orbital-geometry'
import type { OrbitalCacheRequest } from '../../../shared/utils/orbital-cache-key'

export async function renderOrbitalPng(req: OrbitalCacheRequest): Promise<ArrayBuffer> {
  const spec = orbitalFromSeed(req.seed)
  const frames = req.kind === 'strip' ? ORBITAL_STRIP_FRAMES : 1
  const canvas = new OffscreenCanvas(ORBITAL_FRAME_PX * frames, ORBITAL_FRAME_PX)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const scale = ORBITAL_FRAME_PX / ORBITAL_DRAW_SIZE
  for (let i = 0; i < frames; i++) {
    // Frame i turns the shape i/frames of a revolution and moves the two-tone
    // phase the same fraction of its cycle, so the strip loops seamlessly.
    // Frame 0 is the static image exactly.
    const f = i / frames
    ctx.setTransform(scale, 0, 0, scale, i * ORBITAL_FRAME_PX, 0)
    drawOrbital(ctx, spec, {
      size: ORBITAL_DRAW_SIZE,
      theme: req.theme,
      spin: f * 2 * Math.PI,
      t: spec.phaseSpeed > 0 ? f / spec.phaseSpeed : 0
    })
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}
