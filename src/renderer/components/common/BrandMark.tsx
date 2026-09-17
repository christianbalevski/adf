/**
 * BrandMark — a brand logo tile for providers and channels, with a monogram
 * fallback for brands Simple Icons does not carry (or removed over trademark
 * requests, e.g. OpenAI and Slack).
 *
 * Marks are third-party trademarks shown nominatively to identify the
 * service; no affiliation or endorsement implied. Each mark renders in its
 * official color on the light logo tile (legible in both themes). The
 * monogram fallback uses a hue derived from the key, so a grid of tiles stays
 * distinguishable without inventing brand colors.
 */

import {
  SiAlibabacloud,
  SiAnthropic,
  SiCloudflare,
  SiDeepseek,
  SiDiscord,
  SiGooglegemini,
  SiHuggingface,
  SiKimi,
  SiLmstudio,
  SiMinimax,
  SiMistralai,
  SiNvidia,
  SiOllama,
  SiOpenrouter,
  SiPerplexity,
  SiQwen,
  SiScaleway,
  SiTelegram,
  SiVercel,
  SiVllm,
  SiWhatsapp,
  SiX,
} from '@icons-pack/react-simple-icons'

type SimpleIcon = typeof SiAnthropic

const MARKS: Record<string, SimpleIcon> = {
  alibaba: SiAlibabacloud,
  anthropic: SiAnthropic,
  cloudflare: SiCloudflare,
  deepseek: SiDeepseek,
  discord: SiDiscord,
  gemini: SiGooglegemini,
  huggingface: SiHuggingface,
  kimi: SiKimi,
  lmstudio: SiLmstudio,
  minimax: SiMinimax,
  mistral: SiMistralai,
  nvidia: SiNvidia,
  ollama: SiOllama,
  openrouter: SiOpenrouter,
  perplexity: SiPerplexity,
  qwen: SiQwen,
  scaleway: SiScaleway,
  telegram: SiTelegram,
  vercel: SiVercel,
  vllm: SiVllm,
  whatsapp: SiWhatsapp,
  x: SiX,
}

/** Glyphs for concepts rather than brands. */
const GLYPHS: Record<string, () => React.ReactElement> = {
  email: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  ),
  plug: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5" />
    </svg>
  ),
}

function hueFor(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h % 360
}

interface BrandMarkProps {
  /** Mark key (Simple Icons brand or concept glyph). Unknown keys fall back to a monogram. */
  iconKey?: string
  /** Text the monogram is built from (first letter). */
  label: string
  size?: number
}

export function BrandMark({ iconKey, label, size = 28 }: BrandMarkProps) {
  const Brand = iconKey ? MARKS[iconKey] : undefined
  const tile = 'inline-flex shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] border'

  if (Brand) {
    return (
      <span
        className={tile}
        style={{ width: size, height: size, background: 'var(--adf-ui-logo-tile)', borderColor: 'var(--adf-ui-logo-tile-border)' }}
      >
        <Brand color="default" size={Math.round(size * 0.62)} />
      </span>
    )
  }

  const glyph = iconKey ? GLYPHS[iconKey] : undefined
  if (glyph) {
    return (
      <span
        className={`${tile} border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-hover)] text-[var(--adf-ui-text-muted)]`}
        style={{ width: size, height: size, padding: Math.round(size * 0.22) }}
      >
        {glyph()}
      </span>
    )
  }

  const hue = hueFor(iconKey ?? label)
  const initial = (label.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      className={`${tile} font-semibold`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background: `hsl(${hue} 55% 92%)`,
        borderColor: `hsl(${hue} 40% 80%)`,
        color: `hsl(${hue} 45% 32%)`,
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}
