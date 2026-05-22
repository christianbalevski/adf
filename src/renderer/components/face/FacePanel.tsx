import { useEffect, useRef, useState, useMemo } from 'react'
import { useAppStore, type AvatarKey } from '../../stores/app.store'
import { BakedAvatar } from './BakedAvatar'
import { moodFor } from './mood-effects'
import { useAgentStore } from '../../stores/agent.store'
import moonSvg from '../../assets/avatars/moon.svg?raw'
import eyeSvg from '../../assets/avatars/eye.svg?raw'
import ninjaSvg from '../../assets/avatars/ninja.svg?raw'
import flamieSvg from '../../assets/avatars/flamie.svg?raw'
import spectreSvg from '../../assets/avatars/spectre.svg?raw'
import moonStill from '../../assets/avatars/moon-still.svg?raw'
import eyeStill from '../../assets/avatars/eye-still.svg?raw'
import ninjaStill from '../../assets/avatars/ninja-still.svg?raw'
import flamieStill from '../../assets/avatars/flamie-still.svg?raw'
import spectreStill from '../../assets/avatars/spectre-still.svg?raw'

const STILLS: Record<AvatarKey, string> = {
  moon: moonStill,
  eye: eyeStill,
  ninja: ninjaStill,
  flamie: flamieStill,
  spectre: spectreStill,
}

/** Tiny non-animated thumbnail. Renders only frame 0; no CSS keyframes. */
function StaticAvatar({ avatar }: { avatar: AvatarKey }) {
  const svg = STILLS[avatar]
  const dataUrl = useMemo(
    () => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    [svg]
  )
  return (
    <img
      src={dataUrl}
      alt=""
      draggable={false}
      style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }}
    />
  )
}

export const AVATARS: { key: AvatarKey; label: string; svg: string }[] = [
  { key: 'moon',    label: 'Moon',    svg: moonSvg },
  { key: 'eye',     label: 'Eye',     svg: eyeSvg },
  { key: 'ninja',   label: 'Ninja',   svg: ninjaSvg },
  { key: 'flamie',  label: 'Flamie',  svg: flamieSvg },
  { key: 'spectre', label: 'Spectre', svg: spectreSvg }
]

export function avatarSvg(key: AvatarKey): string {
  return AVATARS.find((a) => a.key === key)?.svg ?? moonSvg
}


/**
 * Read the loaded agent's face config from the store.
 *
 * Faces are an opt-in per-ADF feature: the agent's config.face.enabled flag
 * controls whether ADF Studio renders any avatar UI for this agent. ADFs
 * without a `face` block (the common case) get no face UI at all.
 */
function useFaceConfig() {
  const face = useAgentStore((s) => s.config?.face)
  return {
    enabled: face?.enabled === true,
    avatarKey: (face?.avatar as AvatarKey | undefined) ?? undefined,
    statusLines: face?.status_lines,
  }
}

/** Resolve the avatar key to render: user selection wins; config is the initial default. */
function useResolvedAvatar(): AvatarKey {
  const selected = useAppStore((s) => s.selectedAvatar)
  // Validate against the bundled set; fall back to flamie if somehow unknown.
  const known = AVATARS.some((a) => a.key === selected)
  return known ? selected : 'flamie'
}

/** Per-avatar mood text that cycles below the avatar (~3.6s each). */
const STATUS_LINES: Record<AvatarKey, string[]> = {
  moon: [
    'lunar reflection',
    '◐ phases shifting ◑',
    'tidal pull',
    'soft luminance',
    'moonlit watch',
    '... in the pale light',
    '≈ orbiting ≈'
  ],
  eye: [
    'observing...',
    'pupil dilating',
    'tracking patterns',
    '◉ focused ◉',
    'iris adjusting',
    'watching the watcher',
    'pattern lock'
  ],
  ninja: [
    'SCANNING SECTOR',
    'TARGET ACQUIRED',
    'stealth protocol',
    '▣ tracking ▣',
    'thermal sweep',
    'ARTEMIS // online',
    'spectrum scan: clear'
  ],
  flamie: [
    'crackling...',
    'warming up',
    'ember glow',
    '✦ flickering ✦',
    'burning bright',
    'kindled',
    'tongue of flame'
  ],
  spectre: [
    '...whispering...',
    'static drift',
    '▓▒░ cold field ░▒▓',
    'summoning...',
    'presence detected',
    'between channels',
    '≡ ethereal ≡'
  ]
}

/**
 * Frame count per avatar. Each SVG is a flipbook with hard `steps(1, end)`
 * frame cuts, so the perceived frame rate is (frames / cycle-duration). We
 * scale duration per-avatar so all avatars play at the same perceived FPS
 * regardless of how many frames the artist rendered.
 */
const AVATAR_FRAMES: Record<AvatarKey, number> = {
  moon: 30,
  eye: 30,
  ninja: 30,
  flamie: 30,  // seamless parametric, restored to 30 to match old DOM weight
  spectre: 40,  // subsampled from 80 to halve DOM weight & eliminate GC stutter
}

/** Per-avatar speed multiplier. <1 = faster, >1 = slower. */
const AVATAR_SPEED_MULT: Record<AvatarKey, number> = {
  moon: 1,
  eye: 1,
  ninja: 0.65,   // shooting-star scanline reads faster
  flamie: 1,
  spectre: 1,
}

/**
 * Target FPS per agent state. Picked to feel smooth (20fps minimum for
 * idle) rather than stutter-y. Each value is converted to a cycle
 * duration via `frames / targetFps` per-avatar.
 *
 * The flipbook loops seamlessly (frame 0 == frame N for every avatar)
 * so any duration is a clean repeat — no clipping, no jump-cut.
 */
const TARGET_FPS: Record<string, number> = {
  active:    30,
  idle:      20,
  hibernate: 12,
  suspended:  8,
  error:     40,
  off:       15,
}

function baseSpeedForState(state: string, avatar: AvatarKey): number {
  const fps = TARGET_FPS[state] ?? TARGET_FPS.idle
  const frames = AVATAR_FRAMES[avatar] ?? 30
  const mult = AVATAR_SPEED_MULT[avatar] ?? 1
  return (frames / fps) * mult
}

/** Inlines SVG, drives --avatar-speed from agent state. */
/**
 * Per-token micro-blink. Returns a number that briefly spikes on every
 * logVersion change (i.e. on every streaming delta from the agent) and
 * decays in ~150ms. Drives a single fast brightness flash on the avatar —
 * subliminal, never strobing. No blur, no overlay, no caption text.
 *
 * The base SMIL animation is *not* retimed; the blink is a CSS-filter
 * layer on top, so the underlying face never skips frames.
 */
function useStreamBlink(): number {
  const logVersion = useAgentStore((s) => s.logVersion)
  const [blink, setBlink] = useState(0)
  const lastSpikeRef = useRef<number>(0)
  const rafRef = useRef<number>(0)

  // Spike on every logVersion change.
  useEffect(() => {
    if (logVersion === 0) return
    lastSpikeRef.current = performance.now()
    setBlink(1)
  }, [logVersion])

  // Decay rAF — short window (150ms) so the visual is a tick, not a fade.
  // Stops scheduling new frames once blink is back at 0 to keep CPU idle.
  useEffect(() => {
    const tick = () => {
      const elapsed = performance.now() - lastSpikeRef.current
      const next = elapsed > 150 ? 0 : Math.max(0, 1 - elapsed / 150)
      setBlink((prev) => (Math.abs(prev - next) > 0.02 ? next : prev))
      if (next > 0) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = 0
      }
    }
    if (blink > 0 && rafRef.current === 0) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [blink])

  return blink
}


/**
 * Idle micro-blink. Even with no agent activity the face needs to feel
 * alive — a real face flutters, twitches, blinks. This hook emits a brief
 * brightness spike at irregular intervals (3.5s–9s, randomized) so the
 * avatar never sits perfectly still.
 *
 * Combined with the breath keyframe and (when streaming) the per-token
 * blink, the result is a face whose visible motion is non-cyclic at every
 * timescale — short, medium, and long. No "I see the loop point" moment.
 */
function useIdleBlink(): number {
  const [blink, setBlink] = useState(0)
  const rafRef = useRef<number>(0)
  const nextSpikeRef = useRef<number>(performance.now() + 3500 + Math.random() * 5500)
  const lastSpikeRef = useRef<number>(0)

  useEffect(() => {
    const tick = () => {
      const now = performance.now()
      if (now >= nextSpikeRef.current) {
        lastSpikeRef.current = now
        nextSpikeRef.current = now + 3500 + Math.random() * 5500
      }
      const elapsed = now - lastSpikeRef.current
      const next = lastSpikeRef.current === 0 || elapsed > 220
        ? 0
        : Math.max(0, 1 - elapsed / 220)
      setBlink((prev) => (Math.abs(prev - next) > 0.02 ? next : prev))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return blink
}
export function LiveAvatar({
  avatar,
  width,
  driveFromState = true,
  moodIdx,
  cycleDurationMs,
}: {
  avatar?: AvatarKey
  width?: number | string
  driveFromState?: boolean
  moodIdx?: number
  cycleDurationMs?: number
}) {
  const selected = useAppStore((s) => s.selectedAvatar)
  const key = avatar ?? selected
  const agentState = useAgentStore((s) => s.state)
    const speedSec = driveFromState ? baseSpeedForState(agentState, key) : AVATAR_FRAMES[key] / 20
  const streamBlink = driveFromState ? useStreamBlink() : 0
  // Idle blink runs always — keeps the face alive even with no agent activity.
  const idleBlink = useIdleBlink()
  const blink = Math.max(streamBlink, idleBlink)

  // Token-driven micro-flash + ambient blinks. 6% brightness, decays in ~150-220ms.
  // Subliminal — feels like a heartbeat tick, never a strobe.
  const blinkBrightness = 1 + blink * 0.06

  return (
    /*
     * Canvas flipbook (BakedAvatar) replaces 30+ concurrent CSS animations
     * with a single RAF loop. Frame-perfect, immune to Chromium SVG-animation
     * throttling that previously caused the "spin a few seconds then clip
     * and restart" jitter in production.
     */
    <div
      className={[
        'artemis-avatar-wrap',
        key === 'moon' ? 'avatar-moon-dimensions' : '',
      ].filter(Boolean).join(' ')}
      style={{
        position: 'relative',
        width: width ?? '100%',
        maxWidth: typeof width === 'number' ? `${width}px` : width ?? undefined,
        display: 'block',
        lineHeight: 0,
      }}
    >
      <BakedAvatar avatar={key} cycleSec={speedSec} brightness={blinkBrightness} effect={moodIdx != null ? moodFor(key, moodIdx) : undefined} cycleDurationMs={cycleDurationMs} />
    </div>
  )
}

/** Status line that fades through the avatar's mood texts every ~3.6s. */
/**
 * Pulls a live caption from the agent's current activity. When the agent is
 * streaming (state === 'active' and the latest log entry is assistant text),
 * we surface the tail of that text — feels like the avatar is *saying* the
 * words. Otherwise we fall back to whatever the renderer set as statusText
 * (often a short label like "thinking" or "running tool"), or null to let
 * the caller cycle through the idle status_lines.
 */
/**
 * Cycle through caption lines on a 3.6s cadence with a 350ms fade. Returns
 * the shared index so the avatar's mood overlay can sync to the caption.
 */
function useStatusCycle(avatarKey: AvatarKey, customLines?: string[]) {
  const lines = (customLines && customLines.length > 0)
    ? customLines
    : (STATUS_LINES[avatarKey] ?? [])
  const [idx, setIdx] = useState(() => (lines.length > 0 ? Math.floor(Math.random() * lines.length) : 0))
  const [visible, setVisible] = useState(true)
  // The current cycle's duration in ms. Each tick picks a new random duration
  // so the rest period varies, giving the avatar a more "alive" feel.
  const [cycleMs, setCycleMs] = useState<number>(3600)

  useEffect(() => {
    if (lines.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const pickNextDuration = () => 3000 + Math.random() * 3500 // 3.0s - 6.5s

    const tick = () => {
      // Fade caption out, then swap idx + cycle duration, then fade in.
      setVisible(false)
      setTimeout(() => {
        if (cancelled) return
        const next = pickNextDuration()
        setCycleMs(next)
        setIdx((prev) => {
          if (lines.length <= 1) return prev
          // pick a different random index than the current one
          let r = Math.floor(Math.random() * (lines.length - 1))
          if (r >= prev) r += 1
          return r
        })
        setVisible(true)
        timer = setTimeout(tick, next)
      }, 350)
    }
    timer = setTimeout(tick, cycleMs)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // intentionally exclude cycleMs from deps — we restart only on avatar/line change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, avatarKey])

  useEffect(() => {
    setIdx(lines.length > 0 ? Math.floor(Math.random() * lines.length) : 0)
    setVisible(true)
  }, [avatarKey, lines.length])

  return { lines, idx, visible, cycleMs }
}

/** Presentational caption — receives line+visibility, renders the row. */
function StatusLine({ text, visible }: { text: string; visible: boolean }) {
  if (!text) return null
  return (
    <div
      className="mt-1 text-center text-[11px] text-neutral-500 dark:text-neutral-400 select-none transition-opacity duration-300"
      style={{
        opacity: visible ? 1 : 0,
        fontFamily: 'ui-monospace, Menlo, Consolas, Monaco, "Courier New", monospace',
        letterSpacing: '0.08em',
        minHeight: '1.2em',
      }}
    >
      {text}
    </div>
  )
}
/** Centered avatar header — rendered above the markdown editor for document.md only. */

/** Self-contained cycler+caption for the FacePanel popover (not synced with header). */
function FacePanelStatus({ avatarKey, customLines }: { avatarKey: AvatarKey; customLines?: string[] }) {
  const { lines, idx, visible } = useStatusCycle(avatarKey, customLines)
  return <StatusLine text={lines[idx] ?? ''} visible={visible} />
}

export function AvatarHeader() {
  const { enabled, statusLines } = useFaceConfig()
  const resolved = useResolvedAvatar()
  const { lines, idx, visible, cycleMs } = useStatusCycle(resolved, statusLines)
  if (!enabled) return null
  return (
    <div className="w-full flex flex-col items-center justify-center py-3 px-4 select-none flex-shrink-0">
      <div style={{ width: '100%', maxWidth: 360, aspectRatio: '788 / 530' }}>
        <LiveAvatar avatar={resolved} width="100%" moodIdx={idx} cycleDurationMs={cycleMs} />
      </div>
      <StatusLine text={lines[idx] ?? ''} visible={visible} />
    </div>
  )
}

/** Floating popover anchored top-right with current avatar + 5 thumbnails. */
export function FacePanel() {
  const showFace = useAppStore((s) => s.showFace)
  const setShowFace = useAppStore((s) => s.setShowFace)
  const selectedAvatar = useAppStore((s) => s.selectedAvatar)
  const setSelectedAvatar = useAppStore((s) => s.setSelectedAvatar)
  const { enabled: faceEnabled, statusLines } = useFaceConfig()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showFace) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest('[data-face-toggle]')) return
        setShowFace(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowFace(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [showFace, setShowFace])

  if (!showFace || !faceEnabled) return null

  return (
    <div
      ref={ref}
      className="fixed top-20 right-6 z-50 w-[440px] bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200 uppercase tracking-wider">Face</span>
        <button onClick={() => setShowFace(false)} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="p-4 flex flex-col items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <div style={{ width: '100%', maxWidth: 400 }}>
          <LiveAvatar avatar={selectedAvatar} width="100%" />
        </div>
        <FacePanelStatus avatarKey={selectedAvatar} customLines={statusLines} />
      </div>
      <div className="grid grid-cols-5 gap-1 p-2 border-t border-neutral-200 dark:border-neutral-700">
        {AVATARS.map((a) => (
          <button
            key={a.key}
            onClick={() => setSelectedAvatar(a.key)}
            title={a.label}
            className={`aspect-square rounded-md overflow-hidden flex items-center justify-center transition-all p-1 ${
              selectedAvatar === a.key
                ? 'ring-2 ring-blue-500 bg-neutral-100 dark:bg-neutral-800'
                : 'border border-neutral-200 dark:border-neutral-700 hover:border-blue-400 dark:hover:border-blue-500'
            }`}
          >
            <StaticAvatar avatar={a.key} />
          </button>
        ))}
      </div>
      <div className="px-3 py-1.5 text-[10px] text-neutral-400 dark:text-neutral-500 border-t border-neutral-200 dark:border-neutral-700 text-center">
        live · light/dark aware · subtle state response
      </div>
    </div>
  )
}
