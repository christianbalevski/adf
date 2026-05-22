import type { AvatarKey } from '../../stores/app.store'

/**
 * MoodEffect — runtime-applied stylistic overlay on top of a baked avatar
 * flipbook. Picked from a per-(avatar, status-line-index) table so every
 * caption gets a visually distinct mood without requiring extra SVG art.
 *
 * Effects compose three layers:
 *   1. CSS filter on the <canvas> element (brightness pulse, hue-rotate,
 *      saturate, blur, drop-shadow glow). Driven each RAF tick.
 *   2. Canvas-space color overlays drawn AFTER the flipbook frames using
 *      compositing modes — multiply/screen/overlay for tints, source-atop
 *      for vignettes that only stain existing pixels.
 *   3. Speed multiplier on cycleSec for slower/faster motion.
 *
 * All effects are additive — undefined fields are no-ops.
 */
/**
 * Decoration — an additional visual element drawn ON TOP of the character pixels
 * (or in their immediate vicinity). Each kind has its own canvas-draw routine
 * driven by elapsed time so it's stateless and theme-aware.
 */
export type DecorationKind =
  | 'sparkles'      // tiny twinkling 4-point stars at random positions on the character
  | 'crescent'      // curved cutout overlay (mostly for moon)
  | 'orbit'         // small dot orbiting around the avatar center
  | 'embers'        // warm dots floating upward (flamie)
  | 'mist'          // horizontal smoky streaks drifting (spectre)
  | 'scanline'      // horizontal line sweeping vertically (ninja)
  | 'rings'         // concentric pulse rings emanating outward (summon / pulse)
  | 'dust-motes'    // slow drifting particles in negative space (ambient)
  | 'drift-stars'   // distant slow horizontal star drift across bg (pale light)
  | 'glitch-slice'  // brief horizontal slice offset (digital glitch / static)
  | 'breath-glow'   // single slow inhale/exhale radial glow (observing)
  | 'lightning-arc' // rare quick zap path across the avatar (online / charge)

export type Decoration = {
  kind: DecorationKind
  /** Override default color (uses themed default if absent). */
  color?: string
  /** Strength multiplier — 0 = none, 1 = full, can exceed 1. */
  intensity?: number
  /** Speed multiplier on the decoration's internal motion (default 1). */
  speed?: number
}

export type MoodEffect = {
  /** Multiplier on cycleSec. <1 = faster, >1 = slower. */
  speedMult?: number
  /**
   * Color wash painted ONTO the character pixels only (source-atop).
   * Background remains transparent so the avatar blends with document.md.
   */
  tint?: {
    color: string
    alpha: number
    /** @deprecated — kept for backward-compat; no longer affects rendering. */
    mode?: GlobalCompositeOperation
  }
  /** Directional gradient ON the avatar pixels (source-atop). */
  vignette?: {
    color: string
    /** 'radial' = center→edge; 'top'/'bottom' = top-bottom; etc. */
    direction: 'radial' | 'top' | 'bottom' | 'left' | 'right'
    /** Gradient stop where it starts becoming visible (0-1). */
    inner: number
    /** Gradient stop where it reaches full opacity (0-1). */
    outer: number
    /** Peak alpha at the outer stop. */
    alpha: number
  }
  /** Drop-shadow halo via CSS filter; renders as a "glow" around the avatar. */
  glow?: {
    color: string
    blur: number   // px in CSS pixels
    alpha?: number // unused; baked into color
  }
  /** Continuous brightness/scale oscillation. */
  pulse?: {
    /** Hz (cycles per second). */
    freq: number
    /** Amplitude. For brightness, 0.2 = ±20%. For scale, 0.05 = ±5%. */
    amp: number
    type?: 'brightness' | 'scale'
  }
  /** Random per-tick perturbations on top of pulse. */
  flicker?: {
    /** Probability per tick that flicker activates. */
    freq: number
    /** Brightness perturbation amplitude. */
    amp: number
  }
  /** Degrees of hue rotation. */
  hueRotate?: number
  /** Saturation factor; 1 = normal, 0 = grayscale, 2 = vivid. */
  saturate?: number
  /** Blur in px. */
  blur?: number
  /** Optional decorative overlay (sparkles, crescent, embers, etc). */
  decoration?: Decoration
}

const NEUTRAL: MoodEffect = {}

/**
 * Per-avatar, per-caption-index mood. Indexing aligns with STATUS_LINES in
 * FacePanel.tsx — entry N here decorates caption N there.
 */
export const MOOD_EFFECTS: Record<AvatarKey, MoodEffect[]> = {
  // ---- MOON ----
  moon: [
    // 'lunar reflection' — calm baseline + soft sparkles
    { speedMult: 1.00, glow: { color: 'rgba(180,200,255,0.5)', blur: 14 }, saturate: 0.9, decoration: { kind: 'sparkles', color: 'rgba(220,230,255,0.9)', intensity: 0.55 } },
    // '◐ phases shifting ◑' — half-moon overlay
    { speedMult: 1.20, vignette: { color: '#0a0a18', direction: 'right', inner: 0.25, outer: 0.95, alpha: 0.55 }, decoration: { kind: 'crescent', color: 'rgba(20,18,32,0.95)', intensity: 1 } },
    // 'tidal pull' — gentle pulse + sparkle
    { speedMult: 1.10, pulse: { freq: 0.5, amp: 0.10, type: 'brightness' }, tint: { color: '#80b0ff', alpha: 0.14 }, decoration: { kind: 'rings', color: 'rgba(140,180,255,0.9)', intensity: 0.9, speed: 1 } },
    // 'soft luminance' — bright glow, lots of sparkles
    { speedMult: 1.00, glow: { color: 'rgba(255,255,255,0.65)', blur: 22 }, saturate: 0.7, hueRotate: -10, decoration: { kind: 'sparkles', color: 'rgba(255,255,255,1)', intensity: 0.9 } },
    // 'moonlit watch' — subtle tint
    { speedMult: 1.00, tint: { color: '#a8c0ff', alpha: 0.12 }, glow: { color: 'rgba(160,180,255,0.4)', blur: 10 } },
    // '... in the pale light' — desaturated, drifting sparkles
    { speedMult: 1.15, saturate: 0.4, blur: 0.4, tint: { color: '#d0d8e8', alpha: 0.18 }, decoration: { kind: 'drift-stars', color: 'rgba(210,220,240,0.95)', intensity: 1, speed: 1 } },
    // '≈ orbiting ≈' — orbiting dot
    { speedMult: 0.95, hueRotate: 15, decoration: { kind: 'orbit', color: 'rgba(220,230,255,0.95)', intensity: 1 } },
  ],

  // ---- EYE ----
  eye: [
    // 'observing...' — slow breath glow
    { speedMult: 1.00, decoration: { kind: 'breath-glow', color: 'rgba(255,200,120,0.45)', intensity: 0.7, speed: 1 } },
    // 'pupil dilating' — subtle scale pulse
    { speedMult: 1.10, pulse: { freq: 0.6, amp: 0.06, type: 'scale' }, tint: { color: '#000000', alpha: 0.12 } },
    // 'tracking patterns' — green wash + tiny sparkle dots
    { speedMult: 0.92, tint: { color: '#80ff90', alpha: 0.14 }, saturate: 1.2, decoration: { kind: 'sparkles', color: 'rgba(120,255,160,0.8)', intensity: 0.35 } },
    // '◉ focused ◉' — red ring
    { speedMult: 1.00, glow: { color: 'rgba(255,60,60,0.55)', blur: 16 }, vignette: { color: '#ff3030', direction: 'radial', inner: 0.65, outer: 1, alpha: 0.35 }, saturate: 1.3 },
    // 'iris adjusting' — gentle brightness pulse
    { speedMult: 1.05, pulse: { freq: 0.4, amp: 0.14, type: 'brightness' } },
    // 'watching the watcher' — purple wash + glow
    { speedMult: 1.00, tint: { color: '#9050ff', alpha: 0.22 }, hueRotate: 20, glow: { color: 'rgba(140,80,255,0.5)', blur: 14 } },
    // 'pattern lock' — minor flicker (tamed) + red tint
    { speedMult: 0.90, flicker: { freq: 1.4, amp: 0.05 }, tint: { color: '#ff4040', alpha: 0.12 }, decoration: { kind: 'glitch-slice', color: 'rgba(255,60,80,0.95)', intensity: 1, speed: 1 } },
  ],

  // ---- NINJA ----
  ninja: [
    // 'SCANNING SECTOR' — red tint + horizontal scanline
    { speedMult: 1.00, tint: { color: '#ff2030', alpha: 0.10 }, decoration: { kind: 'scanline', color: 'rgba(255,40,60,0.5)', intensity: 0.8 } },
    // 'TARGET ACQUIRED' — slow heartbeat (tamed)
    { speedMult: 0.95, pulse: { freq: 0.8, amp: 0.07, type: 'brightness' }, glow: { color: 'rgba(255,30,40,0.6)', blur: 18 }, tint: { color: '#ff2030', alpha: 0.20 } },
    // 'stealth protocol' — dim
    { speedMult: 1.20, tint: { color: '#000000', alpha: 0.30 }, saturate: 0.5 },
    // '▣ tracking ▣' — green radar tint + scanline
    { speedMult: 1.00, tint: { color: '#30ff60', alpha: 0.22 }, glow: { color: 'rgba(50,255,90,0.45)', blur: 12 }, hueRotate: 30, decoration: { kind: 'scanline', color: 'rgba(80,255,120,0.55)', intensity: 1, speed: 1.4 } },
    // 'thermal sweep' — orange vignette + slow scanline
    { speedMult: 1.10, vignette: { color: '#ff6020', direction: 'bottom', inner: 0.2, outer: 1, alpha: 0.45 }, tint: { color: '#ff5020', alpha: 0.14 }, decoration: { kind: 'scanline', color: 'rgba(255,100,40,0.45)', intensity: 0.7, speed: 0.6 } },
    // 'ARTEMIS // online' — glow accent
    { speedMult: 0.98, glow: { color: 'rgba(255,80,100,0.4)', blur: 10 }, saturate: 1.25, decoration: { kind: 'lightning-arc', color: 'rgba(255,200,220,1)', intensity: 1, speed: 1 } },
    // 'spectrum scan: clear' — cyan + scanline
    { speedMult: 1.00, tint: { color: '#40c8ff', alpha: 0.20 }, hueRotate: -25, glow: { color: 'rgba(80,180,255,0.45)', blur: 12 }, decoration: { kind: 'glitch-slice', color: 'rgba(120,220,255,0.95)', intensity: 1, speed: 1.2 } },
  ],

  // ---- FLAMIE ----
  flamie: [
    // 'crackling...' — small flicker (tamed) + a few rising embers
    { speedMult: 0.95, flicker: { freq: 1.2, amp: 0.05 }, glow: { color: 'rgba(255,140,40,0.4)', blur: 10 }, decoration: { kind: 'embers', color: 'rgba(255,160,40,0.85)', intensity: 0.5 } },
    // 'warming up' — slow, desaturated, bottom-orange vignette
    { speedMult: 1.20, saturate: 0.6, vignette: { color: '#ff4020', direction: 'bottom', inner: 0.35, outer: 1, alpha: 0.6 }, pulse: { freq: 0.35, amp: 0.10, type: 'brightness' }, tint: { color: '#603020', alpha: 0.18 } },
    // 'ember glow' — strong orange + heavy embers
    { speedMult: 1.10, tint: { color: '#ff5020', alpha: 0.26 }, glow: { color: 'rgba(255,100,30,0.6)', blur: 18 }, pulse: { freq: 0.45, amp: 0.08, type: 'brightness' }, saturate: 1.3, decoration: { kind: 'embers', color: 'rgba(255,140,30,0.95)', intensity: 1 } },
    // '✦ flickering ✦' — fast tiny flickers (TAMED) + golden tint
    { speedMult: 0.88, flicker: { freq: 2.2, amp: 0.07 }, glow: { color: 'rgba(255,220,120,0.55)', blur: 14 }, tint: { color: '#ffd060', alpha: 0.14 } },
    // 'burning bright' — vivid + max embers
    { speedMult: 1.00, tint: { color: '#ffb030', alpha: 0.24 }, glow: { color: 'rgba(255,170,40,0.65)', blur: 20 }, saturate: 1.5, decoration: { kind: 'embers', color: 'rgba(255,200,60,1)', intensity: 1.3 } },
    // 'kindled' — gentle warm
    { speedMult: 1.10, glow: { color: 'rgba(255,150,60,0.45)', blur: 12 }, pulse: { freq: 0.3, amp: 0.06, type: 'brightness' }, tint: { color: '#ff8030', alpha: 0.14 } },
    // 'tongue of flame' — golden + subtle scale pulse + embers
    { speedMult: 1.00, pulse: { freq: 0.5, amp: 0.04, type: 'scale' }, glow: { color: 'rgba(255,180,60,0.5)', blur: 16 }, tint: { color: '#ffa040', alpha: 0.18 }, decoration: { kind: 'embers', color: 'rgba(255,170,50,0.8)', intensity: 0.7 } },
  ],

  // ---- SPECTRE ----
  spectre: [
    // '...whispering...' — slow blue + mist
    { speedMult: 1.25, tint: { color: '#6080ff', alpha: 0.18 }, glow: { color: 'rgba(120,160,255,0.4)', blur: 14 }, saturate: 0.7, decoration: { kind: 'mist', color: 'rgba(140,180,255,0.6)', intensity: 0.6, speed: 0.5 } },
    // 'static drift' — subtle flicker (TAMED) + mist
    { speedMult: 0.95, flicker: { freq: 1.6, amp: 0.05 }, tint: { color: '#a0c0ff', alpha: 0.14 }, decoration: { kind: 'mist', color: 'rgba(180,200,255,0.55)', intensity: 0.8, speed: 1.3 } },
    // '▓▒░ cold field ░▒▓' — strong blue + radial vignette
    { speedMult: 1.20, tint: { color: '#40a0ff', alpha: 0.30 }, vignette: { color: '#001830', direction: 'radial', inner: 0.55, outer: 1, alpha: 0.4 }, glow: { color: 'rgba(80,160,255,0.5)', blur: 18 }, saturate: 0.6 },
    // 'summoning...' — slow brightness pulse (tamed) + purple glow + mist
    { speedMult: 1.10, pulse: { freq: 0.25, amp: 0.18, type: 'brightness' }, glow: { color: 'rgba(180,140,255,0.55)', blur: 20 }, tint: { color: '#9070ff', alpha: 0.16 }, decoration: { kind: 'rings', color: 'rgba(200,160,255,0.95)', intensity: 1, speed: 0.7 } },
    // 'presence detected' — subtle flicker (TAMED) + violet
    { speedMult: 0.98, flicker: { freq: 0.9, amp: 0.06 }, hueRotate: 60, tint: { color: '#c060ff', alpha: 0.18 }, glow: { color: 'rgba(200,80,255,0.5)', blur: 16 } },
    // 'between channels' — purple
    { speedMult: 1.25, tint: { color: '#8060ff', alpha: 0.22 }, hueRotate: -15, saturate: 0.85, decoration: { kind: 'dust-motes', color: 'rgba(180,160,255,0.9)', intensity: 1, speed: 1 } },
    // '≡ ethereal ≡' — slowest, soft pulse, gentle mist
    { speedMult: 1.30, pulse: { freq: 0.3, amp: 0.15, type: 'brightness' }, blur: 0.5, saturate: 0.6, tint: { color: '#c0d0ff', alpha: 0.20 }, decoration: { kind: 'mist', color: 'rgba(220,230,255,0.5)', intensity: 0.6, speed: 0.4 } },
  ],
}

export function moodFor(avatar: AvatarKey, idx: number): MoodEffect {
  const arr = MOOD_EFFECTS[avatar]
  if (!arr || arr.length === 0) return NEUTRAL
  return arr[idx % arr.length] ?? NEUTRAL
}
