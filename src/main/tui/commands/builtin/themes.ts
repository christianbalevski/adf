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

/** Ink on paper: for light terminal backgrounds. */
const ADF_LIGHT: ThemeColors = {
  text: '#2B2925',
  muted: '#6B6456',
  dim: '#A39C8E',
  accent: '#A8641A',
  live: '#1F7A70',
  loop: '#6A4BB0',
  user: '#A8641A',
  assistant: '#2B2925',
  thinking: '#8A8476',
  tool: '#2F6DA8',
  success: '#3F7F3A',
  warn: '#9A6A00',
  error: '#B83232',
  info: '#2F6DA8',
  border: '#C9C2B2',
  borderFocus: '#A8641A',
  selectionFg: '#FFFDF7',
  selectionBg: '#A8641A',
  surface: '#EFEADF',
  overlay: '#F7F3EA',
}

/** Stronger contrast on dark backgrounds (dim text readable on low-quality displays). */
const ADF_CONTRAST: ThemeColors = {
  ...ADF_DARK,
  text: '#F2EEE4',
  muted: '#C4BDAE',
  dim: '#8C8577',
  border: '#7A7466',
  thinking: '#A8A294',
}

export const THEMES: ThemeChoice[] = [
  { name: 'adf', label: 'ADF dark', description: 'Ink & parchment on a dark terminal (default)', colors: ADF_DARK },
  { name: 'adf-light', label: 'ADF light', description: 'Ink on paper, for light terminal backgrounds', colors: ADF_LIGHT },
  { name: 'adf-contrast', label: 'ADF high contrast', description: 'Brighter text and borders on dark backgrounds', colors: ADF_CONTRAST },
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
