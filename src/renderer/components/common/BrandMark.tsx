/**
 * BrandMark — a brand logo tile for providers and channels, with a monogram
 * fallback for brands Simple Icons does not carry (or removed over trademark
 * requests, e.g. Slack). OpenAI is one of those removals, so its mark is
 * drawn inline here instead.
 *
 * Marks are third-party trademarks shown nominatively to identify the
 * service; no affiliation or endorsement implied. Each mark renders in its
 * official color on the light logo tile (legible in both themes); the OpenAI
 * mark is monochrome and takes the tile's foreground. The monogram fallback
 * uses a hue derived from the key, so a grid of tiles stays distinguishable
 * without inventing brand colors.
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

/**
 * The logo tile is light in both themes, so a monochrome mark on it is drawn
 * near-black rather than in the theme's text color.
 */
const LOGO_TILE_FG = '#0b0b0c'

/**
 * Marks drawn inline because Simple Icons dropped them. Monochrome: the path
 * fills with currentColor and the logo tile sets the foreground.
 */
const INLINE_MARKS: Record<string, () => React.ReactElement> = {
  openai: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  ),
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

  const inlineMark = iconKey ? INLINE_MARKS[iconKey] : undefined
  if (inlineMark) {
    const inner = Math.round(size * 0.62)
    return (
      <span
        className={tile}
        style={{
          width: size,
          height: size,
          background: 'var(--adf-ui-logo-tile)',
          borderColor: 'var(--adf-ui-logo-tile-border)',
          color: LOGO_TILE_FG,
        }}
      >
        <span className="inline-flex" style={{ width: inner, height: inner }}>{inlineMark()}</span>
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
