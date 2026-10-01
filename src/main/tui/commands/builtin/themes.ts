// Named palettes for /theme. The shell creates one Theme object per process
// and hands it down through ThemeContext; `applyTheme` swaps its colors in
// place so every component picks the new palette up on the next render.

import { createTheme, type Theme, type ThemeColors } from '../../app/theme'

export interface ThemeChoice {
  name: string
  label: string
  description: string
  /** undefined = colorless (bold / inverse / underline carry emphasis). */
  colors: ThemeColors | undefined
}

const ADF_DARK: ThemeColors = { ...createTheme({ mono: false, env: {} }).color }

/** ADF brand, light (brand/tokens.css light values): for light terminal backgrounds. */
const ADF_LIGHT: ThemeColors = {
  text: '#111111', // ink
  muted: '#474B54', // ink-muted
  dim: '#6B707C', // ink-faint
  accent: '#2F5BEA', // blue
  live: '#1F44BF', // blue-strong
  loop: '#6A4A8C', // status: experimental
  user: '#2F5BEA', // blue
  assistant: '#111111', // ink
  thinking: '#6B707C', // ink-faint
  tool: '#474B54', // ink-muted
  success: '#1F6A52', // status: stable
  warn: '#8A5A0B', // status: draft
  error: '#A12F29', // status: deprecated
  info: '#474B54', // ink-muted
  border: '#C9CED8', // rule-strong
  borderFocus: '#2F5BEA', // blue
  selectionFg: '#FFFFFF', // paper (on a blue fill)
  selectionBg: '#2F5BEA', // blue
  surface: '#F6F7FA', // paper-sunken
  overlay: '#F6F7FA', // paper-sunken
}

/** Brand dark with brighter text and borders (dim text readable on low-quality displays). */
const ADF_CONTRAST: ThemeColors = {
  ...ADF_DARK,
  text: '#FFFFFF',
  assistant: '#FFFFFF',
  muted: '#D4D8E1',
  dim: '#B0B5C2',
  thinking: '#B0B5C2',
  tool: '#D4D8E1',
  info: '#D4D8E1',
  border: '#858B99',
}

/** The pre-brand warm palette: amber accent, teal live, violet loops. */
const PARCHMENT: ThemeColors = {
  text: '#D9D4C7',
  muted: '#9A9384',
  dim: '#5F5A50',
  accent: '#E3A857',
  live: '#4DB6AC',
  loop: '#A98BE3',
  user: '#E3A857',
  assistant: '#D9D4C7',
  thinking: '#7F7A6E',
  tool: '#6FA8DC',
  success: '#8CC084',
  warn: '#E0B050',
  error: '#E06C6C',
  info: '#6FA8DC',
  border: '#4A463E',
  borderFocus: '#E3A857',
  selectionFg: '#1B1A17',
  selectionBg: '#E3A857',
  surface: '#23211D',
  overlay: '#2B2823',
}

export const THEMES: ThemeChoice[] = [
  { name: 'adf', label: 'ADF dark', description: 'ADF brand colors on a dark terminal (default)', colors: ADF_DARK },
  { name: 'adf-light', label: 'ADF light', description: 'ADF brand colors on a light terminal', colors: ADF_LIGHT },
  { name: 'adf-contrast', label: 'ADF high contrast', description: 'Brighter text and borders on dark backgrounds', colors: ADF_CONTRAST },
  { name: 'parchment', label: 'Parchment', description: 'The earlier warm palette: amber accent on a dark terminal', colors: PARCHMENT },
  { name: 'adf-mono', label: 'Mono', description: 'No color (like NO_COLOR): bold and inverse carry emphasis', colors: undefined },
]

const ALIASES: Record<string, string> = { dark: 'adf', default: 'adf', light: 'adf-light', contrast: 'adf-contrast', mono: 'adf-mono', 'no-color': 'adf-mono' }

export function findTheme(name: string): ThemeChoice | undefined {
  const wanted = name.trim().toLowerCase()
  return THEMES.find(t => t.name === (ALIASES[wanted] ?? wanted))
}

export function nextThemeName(current: string): string {
  const at = THEMES.findIndex(t => t.name === current)
  return THEMES[(at + 1) % THEMES.length].name
}

const MONO_COLORS = Object.fromEntries(Object.keys(ADF_DARK).map(k => [k, undefined])) as unknown as ThemeColors

/** Swap the palette of a live Theme object. Glyphs (--ascii) are left alone. */
export function applyTheme(theme: Theme, choice: ThemeChoice): void {
  theme.name = choice.name
  theme.mono = choice.colors === undefined
  theme.color = { ...(choice.colors ?? MONO_COLORS) }
}

export function themeNames(): string[] {
  return THEMES.map(t => t.name)
}
