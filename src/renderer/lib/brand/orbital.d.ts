/**
 * Types for the vendored orbital.js (adf-org/brand/orbital.js). Hand-written
 * from its JSDoc; only the exports Studio uses. Keep in step with a re-vendor.
 */

export type V3 = [number, number, number]

/** One real hydrogen orbital |n l m> with an amplitude. */
export interface Term {
  n: number
  l: number
  m: number
  c: number
}

export interface OrbitalSpec {
  seed: string
  salt: number
  /** true for ava */
  canonical: boolean
  terms: Term[]
  /** Viewing elevation above the orbital's equator (rad). */
  elev: number
  /** In-plane tilt of the axis from vertical (rad). */
  tilt: number
  /** Turns per second of the global phase (two-tone shading). */
  phaseSpeed: number
  hue: number
  accent: boolean
  density: number
  L: number
  tries?: number
  rejected?: string[]
}

export interface DrawOptions {
  /** Box size in CSS px; the shape fills about 84% of it. */
  size: number
  theme?: 'light' | 'dark'
  /** Seconds of animated time (phase shading); default 0. */
  t?: number
  /** Rotation about the orbital axis (rad); default t * 0.4. */
  spin?: number
  cx?: number
  cy?: number
  /** Overall opacity 0..1; default 1. */
  alpha?: number
  /** Where the core looks, -1..1 each; default [0, 0]. */
  gaze?: [number, number]
}

export const CONTOUR_P: number
export const AVA: Readonly<OrbitalSpec>

export function orbitalFromSeed(seed: string, opts?: { canonical?: boolean }): OrbitalSpec

/**
 * Draw an orbital into a 2D context. Respects the context's transform (scale
 * by devicePixelRatio first). Does not clear.
 */
export function drawOrbital(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  spec: OrbitalSpec,
  opts: DrawOptions
): void
