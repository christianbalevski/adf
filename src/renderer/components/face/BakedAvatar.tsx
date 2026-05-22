import { useEffect, useMemo, useRef, useState } from 'react'
import type { AvatarKey } from '../../stores/app.store'
import { avatarSvg } from './FacePanel'
import type { MoodEffect, Decoration } from './mood-effects'

/**
 * BakedAvatar — single-canvas flipbook driven by RAF, with optional MoodEffect
 * overlay (CSS filters + canvas compositing) for per-caption variations.
 *
 * Why not CSS animations on the SVG: Chromium throttles SVGs containing many
 * concurrent CSS keyframe animations, causing per-frame opacity flicker to
 * stutter/restart. One canvas + one RAF is frame-perfect.
 */

const BAKE_WIDTH = 1080

type Baked = { frames: HTMLCanvasElement[]; vbW: number; vbH: number }
type BakeKey = `${AvatarKey}|${'light' | 'dark'}`
const bakeCache = new Map<BakeKey, Promise<Baked>>()

function buildFrameSvgs(sourceText: string, theme: 'light' | 'dark' = 'light'): { svgs: string[]; vbW: number; vbH: number } {
  const doc = new DOMParser().parseFromString(sourceText, 'image/svg+xml')
  const src = doc.documentElement
  // For dark theme: add `dark` class to the SVG root so `.dark .chrome_max{...}`
  // rules resolve when the SVG is rasterized as a standalone blob (no ancestor
  // .dark exists in that rendering context).
  if (theme === 'dark') {
    const cls = src.getAttribute('class') || ''
    if (!cls.split(/\s+/).includes('dark')) {
      src.setAttribute('class', (cls + ' dark').trim())
    }
  }
  const N = doc.querySelectorAll('g.frame').length
  const vb = src.getAttribute('viewBox') || '0 0 800 500'
  const parts = vb.split(/\s+/).map(Number)
  const vbW = parts[2] || 800
  const vbH = parts[3] || 500
  const out: string[] = []
  for (let i = 0; i < N; i++) {
    const clone = src.cloneNode(true) as Element
    const frames = Array.from(clone.querySelectorAll('g.frame'))
    frames.forEach((f, j) => {
      if (j === i) {
        f.removeAttribute('style')
        f.setAttribute('style', 'opacity:1 !important; animation:none !important; visibility:visible !important;')
      } else {
        f.remove()
      }
    })
    out.push(new XMLSerializer().serializeToString(clone))
  }
  return { svgs: out, vbW, vbH }
}

async function bake(avatar: AvatarKey, theme: 'light' | 'dark'): Promise<Baked> {
  const sourceText = avatarSvg(avatar)
  const { svgs, vbW, vbH } = buildFrameSvgs(sourceText, theme)
  const pixelW = BAKE_WIDTH
  const aspect = vbW / vbH
  const pixelH = Math.round(pixelW / aspect)
  const frames: HTMLCanvasElement[] = new Array(svgs.length)
  await Promise.all(svgs.map((svg, i) => new Promise<void>((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const cnv = document.createElement('canvas')
      cnv.width = pixelW; cnv.height = pixelH
      const ctx = cnv.getContext('2d')!
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, pixelW, pixelH)
      URL.revokeObjectURL(url)
      frames[i] = cnv
      resolve()
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`bake ${avatar} frame ${i} failed`)) }
    img.src = url
  })))
  return { frames, vbW, vbH }
}

function getBaked(avatar: AvatarKey, theme: 'light' | 'dark'): Promise<Baked> {
  const key: BakeKey = `${avatar}|${theme}`
  let p = bakeCache.get(key)
  if (!p) {
    p = bake(avatar, theme).catch((e) => { bakeCache.delete(key); throw e })
    bakeCache.set(key, p)
  }
  return p
}

/** Apply mood overlays onto the canvas AFTER the base flipbook frames. */
/**
 * Cycle-window envelope: instead of holding each mood for the full 2.8s
 * caption duration, ramp the mood IN, hold briefly, ramp OUT to the default
 * (no-effect) state, then rest. The avatar lives in its baseline most of the
 * time and only "blooms" each caption — gives breath between moods.
 *
 * Phases over [0, 1]:
 *   0.00 - 0.18 : bloom (default → curr)
 *   0.18 - 0.65 : hold curr
 *   0.65 - 0.85 : decay (curr → default)
 *   0.85 - 1.00 : rest at default
 *
 * Returns the "blend amount" — how much of `curr` is mixed against default.
 */
function envelopeAmount(cyclePhase: number): number {
  // Long rest in the default state so the avatar mostly sits idle.
  // 0.00-0.10 : bloom (default → curr)        [10%]
  // 0.10-0.45 : hold curr                     [35%]
  // 0.45-0.60 : decay (curr → default)        [15%]
  // 0.60-1.00 : REST at default               [40%]
  const t = ((cyclePhase % 1) + 1) % 1
  if (t < 0.10) return easeInOut(t / 0.10)
  if (t < 0.45) return 1
  if (t < 0.60) return easeInOut(1 - (t - 0.45) / 0.15)
  return 0
}

const NEUTRAL: MoodEffect = {}

// ---- decorations ----
type DecorCtx = { w: number; h: number; tSec: number; intensity: number; color: string; speed: number }

function drawSparkles(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // 8 stable sparkle seeds across the canvas; each twinkles independently.
  // Uses source-atop so sparkles only appear ON the character pixels.
  const COUNT = Math.round(8 * d.intensity)
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  for (let i = 0; i < COUNT; i++) {
    const seed = i * 17.31
    const x = ((Math.sin(seed) * 43758.5453) % 1 + 1) % 1 * d.w
    const y = ((Math.sin(seed * 2.1) * 43758.5453) % 1 + 1) % 1 * d.h
    const phase = (d.tSec * d.speed + seed * 0.5) % 2
    const tw = phase < 1 ? phase : 2 - phase
    const sz = Math.max(2, d.w * 0.008) * (0.5 + tw * 0.8)
    const alpha = tw * 0.95
    ctx.globalAlpha = alpha * d.intensity
    ctx.fillStyle = d.color
    // 4-point star: two crossed thin rects
    ctx.fillRect(x - sz, y - 0.5, sz * 2, 1)
    ctx.fillRect(x - 0.5, y - sz, 1, sz * 2)
    // tiny center dot
    ctx.beginPath()
    ctx.arc(x, y, sz * 0.35, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawCrescent(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Dark crescent overlay: draws a large opaque circle offset to the side,
  // masked by source-atop so it only erases the right side of the moon.
  const cx = d.w * 0.5
  const cy = d.h * 0.5
  const r = Math.min(d.w, d.h) * 0.55
  // animate the crescent angle slowly
  const angle = d.tSec * d.speed * 0.05
  const offX = Math.cos(angle) * r * 0.7
  const offY = Math.sin(angle) * r * 0.05
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = d.intensity
  ctx.fillStyle = d.color
  ctx.beginPath()
  ctx.arc(cx + offX, cy + offY, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawOrbit(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Small dot circling the center of the canvas. Drawn outside source-atop
  // so it appears on the background too (this is the only decoration that's
  // allowed to live in the negative space — sparkles in orbit).
  const cx = d.w * 0.5
  const cy = d.h * 0.5
  const rx = d.w * 0.42
  const ry = d.h * 0.4
  const angle = d.tSec * d.speed * 0.7
  const x = cx + Math.cos(angle) * rx
  const y = cy + Math.sin(angle) * ry
  const sz = Math.max(3, d.w * 0.012)
  ctx.save()
  ctx.globalAlpha = d.intensity
  ctx.fillStyle = d.color
  // trailing glow
  ctx.shadowColor = d.color
  ctx.shadowBlur = sz * 3
  ctx.beginPath()
  ctx.arc(x, y, sz, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawEmbers(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Dots rising from bottom to top, looping. Stable seeds, independent phases.
  const COUNT = Math.round(12 * d.intensity)
  ctx.save()
  for (let i = 0; i < COUNT; i++) {
    const seed = i * 9.7
    const xJitter = (Math.sin(seed) * 0.5 + 0.5)
    const x = xJitter * d.w
    const phase = ((d.tSec * d.speed * 0.18 + xJitter * 1.3) % 1)
    const y = d.h * (1 - phase)
    const sz = Math.max(2, d.w * 0.007) * (1 + Math.sin(seed * 3) * 0.4)
    // fade in at bottom, fade out at top
    const fade = Math.sin(phase * Math.PI)
    ctx.globalAlpha = fade * d.intensity * 0.9
    ctx.fillStyle = d.color
    ctx.beginPath()
    ctx.arc(x, y, sz, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawMist(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // 3 horizontal smoke streaks at different vertical positions, drifting.
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  for (let i = 0; i < 3; i++) {
    const y = d.h * (0.25 + i * 0.25)
    const offset = (d.tSec * d.speed * 30 + i * 80) % (d.w * 2) - d.w
    const grad = ctx.createLinearGradient(offset, y, offset + d.w, y)
    grad.addColorStop(0,    'rgba(0,0,0,0)')
    grad.addColorStop(0.5,  d.color)
    grad.addColorStop(1,    'rgba(0,0,0,0)')
    ctx.globalAlpha = d.intensity * 0.55
    ctx.fillStyle = grad
    ctx.fillRect(offset, y - d.h * 0.04, d.w, d.h * 0.08)
  }
  ctx.restore()
}

function drawScanline(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Horizontal line that sweeps top-to-bottom over the character.
  const phase = (d.tSec * d.speed * 0.45) % 1
  const y = phase * d.h
  const thickness = Math.max(2, d.h * 0.012)
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  // gradient feathered edges
  const grad = ctx.createLinearGradient(0, y - thickness * 3, 0, y + thickness * 3)
  grad.addColorStop(0,   'rgba(0,0,0,0)')
  grad.addColorStop(0.5, d.color)
  grad.addColorStop(1,   'rgba(0,0,0,0)')
  ctx.globalAlpha = d.intensity
  ctx.fillStyle = grad
  ctx.fillRect(0, y - thickness * 3, d.w, thickness * 6)
  ctx.restore()
}


function drawRings(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // 3 expanding concentric rings; each grows from center → past edge then loops.
  const cx = d.w * 0.5, cy = d.h * 0.5
  const maxR = Math.hypot(d.w, d.h) * 0.55
  const period = 2.6 / d.speed
  ctx.save()
  for (let i = 0; i < 3; i++) {
    const phase = ((d.tSec / period) + i / 3) % 1
    const r = phase * maxR
    const alpha = (1 - phase) * d.intensity
    ctx.globalAlpha = alpha * 0.85
    ctx.strokeStyle = d.color
    ctx.lineWidth = Math.max(1.5, d.w * 0.004)
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function drawDustMotes(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Slow floating dust particles drifting diagonally upward, looping.
  const COUNT = Math.round(20 * d.intensity)
  ctx.save()
  for (let i = 0; i < COUNT; i++) {
    const seed = i * 12.345
    const baseX = ((Math.sin(seed) * 43758.5453) % 1 + 1) % 1
    const driftY = ((d.tSec * d.speed * 0.04 + seed * 0.137) % 1)
    const wobble = Math.sin(d.tSec * 0.3 * d.speed + seed) * 0.04
    const x = (baseX + wobble) * d.w
    const y = d.h * (1 - driftY)
    const sz = Math.max(1, d.w * 0.003) * (0.6 + Math.sin(seed * 7) * 0.4)
    const fade = Math.sin(driftY * Math.PI) // fade in/out at edges
    ctx.globalAlpha = fade * d.intensity * 0.7
    ctx.fillStyle = d.color
    ctx.beginPath()
    ctx.arc(x, y, sz, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawDriftStars(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Distant tiny stars drifting horizontally across the negative space.
  // Twinkle independently, drift slowly right-to-left.
  const COUNT = Math.round(15 * d.intensity)
  ctx.save()
  for (let i = 0; i < COUNT; i++) {
    const seed = i * 23.97
    const yBase = ((Math.sin(seed * 1.7) * 43758.5453) % 1 + 1) % 1
    const driftX = ((d.tSec * d.speed * 0.025 + seed * 0.21) % 1)
    const x = (1 - driftX) * d.w
    const y = yBase * d.h
    const twPhase = (d.tSec * 0.8 + seed) % (Math.PI * 2)
    const tw = (Math.sin(twPhase) * 0.5 + 0.5)
    const sz = Math.max(1, d.w * 0.0025) * (0.5 + tw * 0.6)
    ctx.globalAlpha = tw * d.intensity * 0.85
    ctx.fillStyle = d.color
    ctx.beginPath()
    ctx.arc(x, y, sz, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawGlitchSlice(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Every ~1.5s, a horizontal slice of the avatar is redrawn shifted by a few px,
  // creating a brief digital-glitch jolt. Deterministic via floor(t/period).
  const period = 1.4 / d.speed
  const phase = (d.tSec / period) % 1
  // glitch only flashes during the first 12% of each period
  if (phase > 0.12) {
    ctx.save()
    ctx.restore()
    return
  }
  // Use the period-bucket as seed so each glitch picks a different slice
  const bucket = Math.floor(d.tSec / period)
  const rand = (n: number) => ((Math.sin(n) * 43758.5453) % 1 + 1) % 1
  const sliceY = rand(bucket * 3.1) * d.h
  const sliceH = Math.max(6, d.h * (0.04 + rand(bucket * 5.7) * 0.08))
  const offsetX = (rand(bucket * 9.3) - 0.5) * d.w * 0.08
  const alpha = (1 - phase / 0.12) * d.intensity
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  // bright slice in glitch color (cyan/magenta typically)
  ctx.globalAlpha = alpha * 0.5
  ctx.fillStyle = d.color
  ctx.fillRect(0, sliceY, d.w, sliceH)
  // shifted "tear" line
  ctx.globalAlpha = alpha * 0.9
  ctx.fillStyle = d.color
  ctx.fillRect(offsetX, sliceY + sliceH * 0.4, d.w, 1.5)
  ctx.restore()
}

function drawBreathGlow(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Slow inhale/exhale: a soft radial glow centered on the avatar that
  // expands and contracts on a ~4s breathing cadence.
  const cx = d.w * 0.5, cy = d.h * 0.5
  const period = 4.0 / d.speed
  const phase = (d.tSec / period) % 1
  // smooth bell over the period (inhale 0-0.5, exhale 0.5-1)
  const breath = Math.sin(phase * Math.PI)
  const r = Math.min(d.w, d.h) * (0.35 + breath * 0.18)
  const grad = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r)
  grad.addColorStop(0, d.color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = breath * d.intensity * 0.85
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, d.w, d.h)
  ctx.restore()
}

function drawLightningArc(ctx: CanvasRenderingContext2D, d: DecorCtx) {
  // Quick zap arc — flashes briefly every period, traces a jagged line across the avatar.
  const period = 1.8 / d.speed
  const phase = (d.tSec / period) % 1
  if (phase > 0.10) return
  const bucket = Math.floor(d.tSec / period)
  const rand = (n: number) => ((Math.sin(n) * 43758.5453) % 1 + 1) % 1
  // Random start/end pair on opposite edges
  const startY = rand(bucket * 2.1) * d.h
  const endY = rand(bucket * 4.7) * d.h
  const segments = 6
  const fade = 1 - phase / 0.10
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = fade * d.intensity
  ctx.strokeStyle = d.color
  ctx.lineWidth = Math.max(2, d.w * 0.005)
  ctx.shadowColor = d.color
  ctx.shadowBlur = d.w * 0.025
  ctx.beginPath()
  ctx.moveTo(0, startY)
  for (let i = 1; i < segments; i++) {
    const x = (i / segments) * d.w
    const baseY = startY + (endY - startY) * (i / segments)
    const jitter = (rand(bucket * 13 + i * 7.3) - 0.5) * d.h * 0.18
    ctx.lineTo(x, baseY + jitter)
  }
  ctx.lineTo(d.w, endY)
  ctx.stroke()
  ctx.restore()
}


function drawDecoration(ctx: CanvasRenderingContext2D, dec: Decoration, w: number, h: number, tSec: number) {
  const intensity = dec.intensity ?? 1
  const speed = dec.speed ?? 1
  const d: DecorCtx = { w, h, tSec, intensity, speed, color: dec.color ?? 'rgba(255,255,255,0.9)' }
  switch (dec.kind) {
    case 'sparkles': return drawSparkles(ctx, d)
    case 'crescent': return drawCrescent(ctx, d)
    case 'orbit':    return drawOrbit(ctx, d)
    case 'embers':   return drawEmbers(ctx, d)
    case 'mist':     return drawMist(ctx, d)
    case 'scanline': return drawScanline(ctx, d)
    case 'rings': return drawRings(ctx, d)
    case 'dust-motes': return drawDustMotes(ctx, d)
    case 'drift-stars': return drawDriftStars(ctx, d)
    case 'glitch-slice': return drawGlitchSlice(ctx, d)
    case 'breath-glow': return drawBreathGlow(ctx, d)
    case 'lightning-arc': return drawLightningArc(ctx, d)
  }
}

function drawOverlays(ctx: CanvasRenderingContext2D, w: number, h: number, effect: MoodEffect) {
  if (effect.tint) {
    // `source-atop` stains only existing (character) pixels — the transparent
    // background remains untouched so the avatar reads as a character on the
    // document, not a colored card.
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.globalAlpha = effect.tint.alpha
    ctx.fillStyle = effect.tint.color
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
  if (effect.vignette) {
    ctx.save()
    // source-atop = only stain existing pixels (the avatar art), leave bg transparent
    ctx.globalCompositeOperation = 'source-atop'
    let grad: CanvasGradient
    const v = effect.vignette
    if (v.direction === 'radial') {
      const cx = w / 2, cy = h / 2, r = Math.max(w, h) / 2
      grad = ctx.createRadialGradient(cx, cy, r * v.inner, cx, cy, r * v.outer)
    } else if (v.direction === 'top') {
      grad = ctx.createLinearGradient(0, 0, 0, h)
      // top→bottom: outer at 0, inner at 1 (reverse)
      grad.addColorStop(Math.min(v.inner, v.outer), withAlpha(v.color, 0))
      grad.addColorStop(Math.max(v.inner, v.outer), withAlpha(v.color, v.alpha))
    } else if (v.direction === 'bottom') {
      grad = ctx.createLinearGradient(0, h, 0, 0)
    } else if (v.direction === 'left') {
      grad = ctx.createLinearGradient(0, 0, w, 0)
    } else {
      grad = ctx.createLinearGradient(w, 0, 0, 0)
    }
    if (v.direction === 'radial' || (v.direction !== 'top')) {
      // For radial + directional (other than top), build standard stops
      try {
        grad.addColorStop(0, withAlpha(v.color, 0))
      } catch {}
      try {
        grad.addColorStop(1, withAlpha(v.color, v.alpha))
      } catch {}
    }
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
}

function withAlpha(color: string, alpha: number): string {
  // Accept '#rgb' '#rrggbb' 'rgb(...)' 'rgba(...)'.
  if (color.startsWith('#')) {
    let r = 0, g = 0, b = 0
    if (color.length === 4) {
      r = parseInt(color[1] + color[1], 16)
      g = parseInt(color[2] + color[2], 16)
      b = parseInt(color[3] + color[3], 16)
    } else if (color.length === 7) {
      r = parseInt(color.slice(1, 3), 16)
      g = parseInt(color.slice(3, 5), 16)
      b = parseInt(color.slice(5, 7), 16)
    }
    return `rgba(${r},${g},${b},${alpha})`
  }
  if (color.startsWith('rgba')) {
    return color.replace(/,[^,)]+\)$/, `,${alpha})`)
  }
  if (color.startsWith('rgb(')) {
    return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`)
  }
  return color
}

const TRANSITION_MS = 700

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

function parseColor(c: string): [number, number, number, number] {
  if (!c) return [0, 0, 0, 1]
  if (c.startsWith('#')) {
    let s = c
    if (s.length === 4) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1]
  }
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x.trim()))
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] == null ? 1 : p[3]]
  }
  return [0, 0, 0, 1]
}

function lerpColor(a: string, b: string, t: number): string {
  const A = parseColor(a), B = parseColor(b)
  const r = Math.round(lerp(A[0], B[0], t))
  const g = Math.round(lerp(A[1], B[1], t))
  const bl = Math.round(lerp(A[2], B[2], t))
  const al = lerp(A[3], B[3], t)
  return `rgba(${r},${g},${bl},${al.toFixed(3)})`
}

function easeInOut(t: number) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2 }

/**
 * Blend two effects with eased-cubic interpolation. Missing sub-effects on
 * one side are treated as "same sub-effect at alpha 0" so they fade smoothly
 * in/out instead of popping.
 */
function blendEffects(prev: MoodEffect, curr: MoodEffect, t: number): MoodEffect {
  const out: MoodEffect = {}
  out.speedMult = lerp(prev.speedMult ?? 1, curr.speedMult ?? 1, t)
  if (prev.tint || curr.tint) {
    const pc = prev.tint?.color ?? curr.tint!.color
    const cc = curr.tint?.color ?? prev.tint!.color
    out.tint = {
      color: lerpColor(pc, cc, t),
      alpha: lerp(prev.tint?.alpha ?? 0, curr.tint?.alpha ?? 0, t),
    }
  }
  if (prev.glow || curr.glow) {
    const pc = prev.glow?.color ?? curr.glow!.color
    const cc = curr.glow?.color ?? prev.glow!.color
    out.glow = {
      color: lerpColor(pc, cc, t),
      blur:  lerp(prev.glow?.blur ?? 0, curr.glow?.blur ?? 0, t),
    }
  }
  if (prev.hueRotate != null || curr.hueRotate != null)
    out.hueRotate = lerp(prev.hueRotate ?? 0, curr.hueRotate ?? 0, t)
  if (prev.saturate != null || curr.saturate != null)
    out.saturate = lerp(prev.saturate ?? 1, curr.saturate ?? 1, t)
  if (prev.blur || curr.blur)
    out.blur = lerp(prev.blur ?? 0, curr.blur ?? 0, t)
  if (prev.pulse || curr.pulse) {
    out.pulse = {
      type: ((t < 0.5 ? prev.pulse?.type : curr.pulse?.type)
        ?? prev.pulse?.type ?? curr.pulse?.type ?? 'brightness') as 'brightness' | 'scale',
      freq: lerp(prev.pulse?.freq ?? 0, curr.pulse?.freq ?? 0, t),
      amp:  lerp(prev.pulse?.amp  ?? 0, curr.pulse?.amp  ?? 0, t),
    }
  }
  if (prev.flicker || curr.flicker) {
    out.flicker = {
      freq: lerp(prev.flicker?.freq ?? 0, curr.flicker?.freq ?? 0, t),
      amp:  lerp(prev.flicker?.amp  ?? 0, curr.flicker?.amp  ?? 0, t),
    }
  }
  if (prev.vignette || curr.vignette) {
    const dir = ((t < 0.5 ? prev.vignette?.direction : curr.vignette?.direction)
      ?? prev.vignette?.direction ?? curr.vignette?.direction) as MoodEffect['vignette'] extends infer V
        ? V extends { direction: infer D } ? D : never
        : never
    const pc = prev.vignette?.color ?? curr.vignette!.color
    const cc = curr.vignette?.color ?? prev.vignette!.color
    out.vignette = {
      direction: dir as any,
      color: lerpColor(pc, cc, t),
      inner: lerp(prev.vignette?.inner ?? 0, curr.vignette?.inner ?? 0, t),
      outer: lerp(prev.vignette?.outer ?? 1, curr.vignette?.outer ?? 1, t),
      alpha: lerp(prev.vignette?.alpha ?? 0, curr.vignette?.alpha ?? 0, t),
    }
  }
  return out
}

/** Build a CSS `filter:` string from a MoodEffect at time t (sec). */
/**
 * Smooth, deterministic "flicker" — three sine waves at irrational-ratio
 * frequencies summed together. No Math.random per frame (which was strobing).
 * Reads as a gentle organic wobble. `freq` is now Hz of the base oscillator.
 */
function organicWobble(tSec: number, freq: number): number {
  return (
    Math.sin(2 * Math.PI * freq * tSec) * 0.55 +
    Math.sin(2 * Math.PI * freq * 1.73 * tSec + 1.3) * 0.30 +
    Math.sin(2 * Math.PI * freq * 0.41 * tSec + 2.7) * 0.15
  )
}

function buildFilter(effect: MoodEffect, tSec: number, baseBrightness: number): string {
  const parts: string[] = []
  let brightness = baseBrightness
  if (effect.pulse?.type === 'brightness') {
    brightness *= 1 + effect.pulse.amp * Math.sin(2 * Math.PI * effect.pulse.freq * tSec)
  }
  if (effect.flicker) {
    brightness *= 1 + effect.flicker.amp * organicWobble(tSec, effect.flicker.freq)
  }
  if (brightness !== 1) parts.push(`brightness(${brightness.toFixed(3)})`)
  if (effect.hueRotate) parts.push(`hue-rotate(${effect.hueRotate}deg)`)
  if (effect.saturate != null) parts.push(`saturate(${effect.saturate})`)
  if (effect.blur) parts.push(`blur(${effect.blur}px)`)
  if (effect.glow) parts.push(`drop-shadow(0 0 ${effect.glow.blur}px ${effect.glow.color})`)
  return parts.join(' ')
}

export function BakedAvatar({
  avatar,
  cycleSec,
  brightness = 1,
  effect,
  cycleDurationMs,
}: {
  avatar: AvatarKey
  cycleSec: number
  brightness?: number
  effect?: MoodEffect
  /** Caption cycle duration in ms (drives the envelope window). Default 3600. */
  cycleDurationMs?: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [aspect, setAspect] = useState(800 / 500)

  // Refs the RAF loop reads each tick. The mood "envelope" blends NEUTRAL → curr
  // over the caption cycle so the avatar mostly sits in its baseline and only
  // blooms briefly into each mood. The cycle duration is dynamic — the parent
  // picks a new random duration each caption swap, and we read it via this ref
  // so the envelope window matches.
  const cycleSecRef = useRef(cycleSec)
  const targetEffectRef = useRef<MoodEffect | undefined>(effect)
  const moodStartRef = useRef<number>(performance.now())
  const brightnessRef = useRef(brightness)
  const cycleDurationMsRef = useRef<number>(cycleDurationMs ?? 3600)
  useEffect(() => { cycleDurationMsRef.current = cycleDurationMs ?? 3600 }, [cycleDurationMs])
  // Phase accumulator — integrated from per-frame dt so changes in speedMult
  // smoothly modulate the GROWTH RATE rather than warping the absolute frame
  // index (which is what `elapsedSec % speed` used to do, causing jumps).
  const phaseRef = useRef<number>(0)
  const lastTickMsRef = useRef<number>(-1)
  cycleSecRef.current = cycleSec
  brightnessRef.current = brightness

  // When the parent's `effect` changes, restart the envelope window from now.
  useEffect(() => {
    targetEffectRef.current = effect
    moodStartRef.current = performance.now()
  }, [effect])

  const bakedRef = useRef<Baked | null>(null)

  // Track app theme so the bake matches (light vs dark SVG fill rules).
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const obs = new MutationObserver(() => {
      const next: 'light' | 'dark' = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      setTheme((cur) => (cur === next ? cur : next))
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    setReady(false)
    bakedRef.current = null
    getBaked(avatar, theme).then((b) => {
      if (!alive) return
      bakedRef.current = b
      setAspect(b.vbW / b.vbH)
      setReady(true)
    }).catch((e) => console.error('[BakedAvatar]', avatar, e))
    return () => { alive = false }
  }, [avatar, theme])

  useEffect(() => {
    if (!ready) return
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    if (!wrap || !canvas || !overlay) return
    const dpr = window.devicePixelRatio || 1
    const size = () => {
      const rect = wrap.getBoundingClientRect()
      const cssW = Math.max(1, rect.width)
      const cssH = cssW / aspect
      const pxW = Math.round(cssW * dpr)
      const pxH = Math.round(cssH * dpr)
      canvas.width = pxW; canvas.height = pxH
      overlay.width = pxW; overlay.height = pxH
      canvas.style.height = `${cssH}px`
      overlay.style.height = `${cssH}px`
    }
    size()
    const ro = new ResizeObserver(size)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [ready, aspect])

  useEffect(() => {
    if (!ready) return
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    const baked = bakedRef.current
    if (!canvas || !overlay || !baked) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const N = baked.frames.length
    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const nowMs = performance.now()
      const elapsedSec = (nowMs - t0) / 1000

      // ---- envelope-blended effect: NEUTRAL → target → NEUTRAL each caption window
      const target = targetEffectRef.current ?? NEUTRAL
      const moodElapsed = nowMs - moodStartRef.current
      const phase = moodElapsed / cycleDurationMsRef.current
      const amount = envelopeAmount(phase)
      const eff = amount <= 0
        ? NEUTRAL
        : amount >= 1
          ? target
          : blendEffects(NEUTRAL, target, amount)

      const speed = Math.max(0.05, cycleSecRef.current * (eff.speedMult ?? 1))
      // Integrate phase: dt seconds / cycle seconds = fraction of a full loop advanced.
      const dt = lastTickMsRef.current < 0 ? 0 : (nowMs - lastTickMsRef.current) / 1000
      lastTickMsRef.current = nowMs
      phaseRef.current = (phaseRef.current + dt / speed) % 1
      const pos = phaseRef.current * N
      const i = Math.floor(pos) % N
      const j = (i + 1) % N
      const blend = pos - Math.floor(pos)
      const w = canvas.width, h = canvas.height
      // 1) base flipbook with cross-fade
      ctx.clearRect(0, 0, w, h)
      ctx.globalAlpha = 1 - blend
      ctx.drawImage(baked.frames[i], 0, 0, w, h)
      ctx.globalAlpha = blend
      ctx.drawImage(baked.frames[j], 0, 0, w, h)
      ctx.globalAlpha = 1
      // 2) mood color overlays (tint / vignette)
      drawOverlays(ctx, w, h, eff)
      // 3) decoration overlay (sparkles, embers, mist, scanline, etc.) — fades
      //    with the envelope via its own intensity multiplier.
      if (target.decoration && amount > 0.01) {
        const dec: Decoration = {
          ...target.decoration,
          intensity: (target.decoration.intensity ?? 1) * amount,
        }
        drawDecoration(ctx, dec, w, h, elapsedSec)
      }
      // 4) CSS filter (brightness/hue/saturate/blur/drop-shadow)
      const filterStr = buildFilter(eff, elapsedSec, brightnessRef.current)
      if (canvas.style.filter !== filterStr) canvas.style.filter = filterStr
      // 5) scale pulse via CSS transform
      if (eff.pulse?.type === 'scale') {
        const s = 1 + (eff.pulse.amp ?? 0) * Math.sin(2 * Math.PI * eff.pulse.freq * elapsedSec)
        canvas.style.transform = `scale(${s.toFixed(4)})`
        canvas.style.transformOrigin = 'center center'
      } else if (canvas.style.transform) {
        canvas.style.transform = ''
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready])

  // Memoize aspect-style so React doesn't re-render the wrapper unnecessarily
  const wrapStyle = useMemo<React.CSSProperties>(() => ({
    position: 'relative',
    width: '100%',
    display: 'block',
    lineHeight: 0,
    aspectRatio: `${aspect}`,
  }), [aspect])

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: 'auto',
          opacity: ready ? 1 : 0,
          transition: 'opacity 200ms ease-out, filter 350ms ease-out',
          willChange: 'filter, transform',
        }}
      />
      <canvas ref={overlayRef} style={{ display: 'none' }} />
    </div>
  )
}
