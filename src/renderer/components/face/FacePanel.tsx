import { useEffect, useRef, useState, useMemo } from 'react'
import { useAppStore, type AvatarKey } from '../../stores/app.store'
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

/** Resolve the avatar key to render: agent config wins, then user selection. */
function useResolvedAvatar(): AvatarKey {
  const { avatarKey: configKey } = useFaceConfig()
  const selected = useAppStore((s) => s.selectedAvatar)
  // Validate the config-supplied key against the bundled set; ignore unknowns.
  const known = AVATARS.some((a) => a.key === configKey)
  return known ? (configKey as AvatarKey) : selected
}

/** Per-avatar mood text that cycles below the avatar (~2.8s each). */
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

function baseSpeedForState(state: string): number {
  // Spectre is rendered at 4s natural cycle. State speeds adjust the playback rate.
  // Any positive value preserves the seamless loop since frame 0 == frame N.
  switch (state) {
    case 'active':    return 2.5
    case 'idle':      return 4.0
    case 'hibernate': return 7.0
    case 'suspended': return 10.0
    case 'error':     return 1.5
    case 'off':       return 5.5
    default:          return 4.0
  }
}

/** Inlines SVG, drives --avatar-speed from agent state. */
export function LiveAvatar({
  avatar,
  width,
  driveFromState = true
}: {
  avatar?: AvatarKey
  width?: number | string
  driveFromState?: boolean
}) {
  const selected = useAppStore((s) => s.selectedAvatar)
  const key = avatar ?? selected
  const agentState = useAgentStore((s) => s.state)
  const svg = useMemo(() => avatarSvg(key), [key])
  const speedSec = driveFromState ? baseSpeedForState(agentState) : 2.2

  return (
    <div
      className="artemis-avatar-wrap"
      style={{
        ['--avatar-speed' as any]: `${speedSec}s`,
        width: width ?? '100%',
        maxWidth: typeof width === 'number' ? `${width}px` : width ?? undefined,
        display: 'block',
        lineHeight: 0
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** Status line that fades through the avatar's mood texts every ~2.8s. */
function StatusLine({
  avatarKey,
  customLines,
}: {
  avatarKey: AvatarKey
  /** Per-agent override from config.face.status_lines. */
  customLines?: string[]
}) {
  const lines = (customLines && customLines.length > 0) ? customLines : (STATUS_LINES[avatarKey] ?? [])
  const [idx, setIdx] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (lines.length === 0) return
    let cancelled = false
    const cycle = () => {
      // fade out
      setVisible(false)
      setTimeout(() => {
        if (cancelled) return
        setIdx((i) => (i + 1) % lines.length)
        setVisible(true)
      }, 350)
    }
    const interval = setInterval(cycle, 2800)
    return () => { cancelled = true; clearInterval(interval) }
  }, [lines.length, avatarKey])

  // Reset index when avatar changes
  useEffect(() => { setIdx(0); setVisible(true) }, [avatarKey])

  if (lines.length === 0) return null

  return (
    <div
      className="mt-1 text-center text-[11px] text-neutral-500 dark:text-neutral-400 select-none transition-opacity duration-300"
      style={{
        opacity: visible ? 1 : 0,
        fontFamily: 'ui-monospace, Menlo, Consolas, Monaco, "Courier New", monospace',
        letterSpacing: '0.08em'
      }}
    >
      {lines[idx]}
    </div>
  )
}

/** Centered avatar header — rendered above the markdown editor for document.md only. */
export function AvatarHeader() {
  const { enabled, statusLines } = useFaceConfig()
  const resolved = useResolvedAvatar()
  if (!enabled) return null
  return (
    <div className="w-full flex flex-col items-center justify-center py-3 px-4 select-none flex-shrink-0">
      <div style={{ width: '100%', maxWidth: 360, aspectRatio: '788 / 530' }}>
        <LiveAvatar avatar={resolved} width="100%" />
      </div>
      <StatusLine avatarKey={resolved} customLines={statusLines} />
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
        <StatusLine avatarKey={selectedAvatar} customLines={statusLines} />
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
