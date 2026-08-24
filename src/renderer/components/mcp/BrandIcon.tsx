/**
 * BrandIcon — brand logos for MCP quick-add cards / server rows.
 *
 * Brand marks come from Simple Icons (@icons-pack/react-simple-icons) and are
 * third-party trademarks of their respective owners, shown nominatively to
 * identify the corresponding service — no affiliation or endorsement implied.
 *
 * Each mark renders in its OFFICIAL brand color (`color="default"`). Simple
 * Icons marks are single-color (e.g. GitHub is near-black #181717), so they sit
 * on a neutral light tile (--adf-ui-logo-tile, kept light in BOTH themes) that
 * keeps them legible in light and dark alike. Servers with no brand mark — or
 * brands not carried by Simple Icons (Slack/Twilio/Playwright were removed over
 * trademark requests) — fall back to a monochrome category glyph in currentColor.
 *
 * Imports are named (not a namespace/barrel import) so the sideEffect-free ESM
 * package tree-shakes to only the marks referenced below.
 */

import {
  SiAirtable,
  SiArxiv,
  SiAtlassian,
  SiBlender,
  SiBrave,
  SiCaldotcom,
  SiClickhouse,
  SiCloudflare,
  SiDiscord,
  SiDocker,
  SiDuckdb,
  SiDuckduckgo,
  SiElevenlabs,
  SiGithub,
  SiGitlab,
  SiGmail,
  SiGooglecalendar,
  SiGooglechrome,
  SiGoogledocs,
  SiGoogledrive,
  SiGooglesheets,
  SiGrafana,
  SiHubspot,
  SiHuggingface,
  SiKagi,
  SiKubernetes,
  SiLinear,
  SiMermaid,
  SiMongodb,
  SiMysql,
  SiN8n,
  SiNetlify,
  SiNotion,
  SiPagerduty,
  SiPandoc,
  SiPaypal,
  SiPerplexity,
  SiPostgresql,
  SiPrometheus,
  SiQdrant,
  SiRedis,
  SiSearxng,
  SiSentry,
  SiShopify,
  SiSqlite,
  SiStripe,
  SiSupabase,
  SiTelegram,
  SiTodoist,
  SiTrello,
  SiZapier,
} from '@icons-pack/react-simple-icons'
import type { McpRegistryEntry } from '../../../shared/constants/mcp-registry'

type Category = McpRegistryEntry['category']
type SimpleIcon = typeof SiGithub

/** Full-color (official brand color) marks, keyed by McpRegistryEntry.iconKey. */
const BRAND_ICONS: Record<string, SimpleIcon> = {
  airtable: SiAirtable,
  arxiv: SiArxiv,
  atlassian: SiAtlassian,
  blender: SiBlender,
  brave: SiBrave,
  'cal-com': SiCaldotcom,
  chrome: SiGooglechrome,
  clickhouse: SiClickhouse,
  cloudflare: SiCloudflare,
  discord: SiDiscord,
  docker: SiDocker,
  duckdb: SiDuckdb,
  duckduckgo: SiDuckduckgo,
  elevenlabs: SiElevenlabs,
  github: SiGithub,
  gitlab: SiGitlab,
  gmail: SiGmail,
  'google-calendar': SiGooglecalendar,
  'google-docs': SiGoogledocs,
  'google-drive': SiGoogledrive,
  'google-sheets': SiGooglesheets,
  grafana: SiGrafana,
  hubspot: SiHubspot,
  huggingface: SiHuggingface,
  kagi: SiKagi,
  kubernetes: SiKubernetes,
  linear: SiLinear,
  mermaid: SiMermaid,
  mongodb: SiMongodb,
  mysql: SiMysql,
  n8n: SiN8n,
  netlify: SiNetlify,
  notion: SiNotion,
  pagerduty: SiPagerduty,
  pandoc: SiPandoc,
  paypal: SiPaypal,
  perplexity: SiPerplexity,
  postgresql: SiPostgresql,
  prometheus: SiPrometheus,
  qdrant: SiQdrant,
  redis: SiRedis,
  searxng: SiSearxng,
  sentry: SiSentry,
  shopify: SiShopify,
  sqlite: SiSqlite,
  stripe: SiStripe,
  supabase: SiSupabase,
  telegram: SiTelegram,
  todoist: SiTodoist,
  trello: SiTrello,
  zapier: SiZapier,
}

/** iconKeys that map to a Simple Icons brand mark. */
export const BRAND_ICON_KEYS: readonly string[] = Object.keys(BRAND_ICONS)
const BRAND_ICON_KEY_SET = new Set(BRAND_ICON_KEYS)

export function isKnownBrandIcon(iconKey: string | undefined): boolean {
  return !!iconKey && BRAND_ICON_KEY_SET.has(iconKey)
}

/** Monochrome (currentColor) fallback glyphs, one per registry category. */
const CATEGORY_GLYPHS: Record<Category, () => React.ReactElement> = {
  dev: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
    </svg>
  ),
  data: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
      <path d="M5 5.5v13c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-13M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
    </svg>
  ),
  communication: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 0 1 4 11.5 8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  ),
  web: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" />
    </svg>
  ),
  tools: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L3 18l3 3 6.5-6.5a4 4 0 0 0 5.2-5.2l-2.9 2.9-2.1-2.1z" />
    </svg>
  ),
  search: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  ),
  productivity: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 10.5M3 18l1.5 1.5L7 16.5M11 6h10M11 12h10M11 18h10" />
    </svg>
  ),
  infra: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  ),
  ai: () => (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z" />
    </svg>
  ),
}

interface BrandIconProps {
  /** Brand key from the registry entry (Simple Icons mark when known). */
  iconKey?: string
  /** Registry category — selects the monochrome fallback glyph. */
  category?: Category
  /** Tile size in px. */
  size?: number
}

/**
 * Renders a brand logo (official color, on a light tile) or a category glyph
 * (monochrome currentColor). Always renders a consistent rounded tile so a
 * grid of cards aligns whether or not a given entry has a brand mark.
 */
export function BrandIcon({ iconKey, category = 'tools', size = 28 }: BrandIconProps) {
  const Brand = iconKey ? BRAND_ICONS[iconKey] : undefined

  if (Brand) {
    const inner = Math.round(size * 0.62)
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] border"
        style={{
          width: size,
          height: size,
          background: 'var(--adf-ui-logo-tile)',
          borderColor: 'var(--adf-ui-logo-tile-border)',
        }}
      >
        <Brand color="default" size={inner} />
      </span>
    )
  }

  const glyph = CATEGORY_GLYPHS[category] ?? CATEGORY_GLYPHS.tools
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-hover)] text-[var(--adf-ui-text-muted)]"
      style={{ width: size, height: size, padding: Math.round(size * 0.22) }}
    >
      {glyph()}
    </span>
  )
}
