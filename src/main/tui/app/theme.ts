// ADF theme: semantic tokens only. Components never hard-code a color — they
// ask for a role (`accent`, `loop`, `warn`, …) so the mono/NO_COLOR theme and
// any future palette swap stay one-file changes.

import { createContext, useContext } from 'react'

export interface ThemeColors {
  /** Body text. */
  text: string | undefined
  /** Secondary text: labels, timestamps, hints. */
  muted: string | undefined
  /** Tertiary text: separators, disabled rows. */
  dim: string | undefined
  /** ADF brand accent (wordmark, focus, selection). */
  accent: string | undefined
  /** Live / mesh / umbilical accent. */
  live: string | undefined
  /** Cognition loops (loop names, loop badges). */
  loop: string | undefined
  /** The owner's messages. */
  user: string | undefined
  /** The agent's messages. */
  assistant: string | undefined
  thinking: string | undefined
  tool: string | undefined
  success: string | undefined
  warn: string | undefined
  error: string | undefined
  info: string | undefined
  border: string | undefined
  borderFocus: string | undefined
  /** Selected-row foreground/background. */
  selectionFg: string | undefined
  selectionBg: string | undefined
  /** Header / status bar / overlay surfaces. */
  surface: string | undefined
  overlay: string | undefined
}

export interface ThemeGlyphs {
  wordmark: string
  dot: string
  ring: string
  pointer: string
  bullet: string
  check: string
  cross: string
  warn: string
  arrow: string
  loop: string
  sep: string
  vbar: string
  hbar: string
  ellipsis: string
  collapsed: string
  expanded: string
  spinner: string[]
}

export interface Theme {
  name: string
  /** True when color is off (NO_COLOR, --mono, dumb terminal): use bold/inverse/underline for emphasis. */
  mono: boolean
  ascii: boolean
  color: ThemeColors
  glyph: ThemeGlyphs
}

/** "Ink & parchment": warm document accent, teal umbilical, violet loops. */
const ADF_COLORS: ThemeColors = {
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

const MONO_COLORS: ThemeColors = Object.fromEntries(
  Object.keys(ADF_COLORS).map(key => [key, undefined]),
) as unknown as ThemeColors

const UNICODE_GLYPHS: ThemeGlyphs = {
  wordmark: '◆',
  dot: '●',
  ring: '○',
  pointer: '›',
  bullet: '•',
  check: '✓',
  cross: '✗',
  warn: '!',
  arrow: '→',
  loop: '↻',
  sep: '·',
  vbar: '│',
  hbar: '─',
  ellipsis: '…',
  collapsed: '▸',
  expanded: '▾',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
}

const ASCII_GLYPHS: ThemeGlyphs = {
  wordmark: '#',
  dot: '*',
  ring: 'o',
  pointer: '>',
  bullet: '-',
  check: 'v',
  cross: 'x',
  warn: '!',
  arrow: '->',
  loop: '@',
  sep: '|',
  vbar: '|',
  hbar: '-',
  ellipsis: '...',
  collapsed: '+',
  expanded: '-',
  spinner: ['|', '/', '-', '\\'],
}

export interface ThemeOptions {
  mono?: boolean
  ascii?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the theme. Color is off when NO_COLOR is set (any value, per
 * no-color.org), when TERM=dumb, or with `mono`. ASCII glyphs with `ascii`
 * or ADF_TUI_ASCII=1 (legacy consoles without the box/braille glyphs).
 */
export function createTheme(options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env
  const mono = options.mono ?? (env.NO_COLOR !== undefined || env.TERM === 'dumb')
  const ascii = options.ascii ?? (env.ADF_TUI_ASCII === '1' || env.TERM === 'dumb')
  return {
    name: mono ? 'adf-mono' : 'adf',
    mono,
    ascii,
    color: mono ? MONO_COLORS : ADF_COLORS,
    glyph: ascii ? ASCII_GLYPHS : UNICODE_GLYPHS,
  }
}

export const ThemeContext = createContext<Theme>(createTheme({ mono: true }))

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

/** Color for an executor / display state. */
export function stateColor(theme: Theme, state: string | undefined): string | undefined {
  switch (state) {
    case 'thinking':
    case 'tool_use':
    case 'active':
      return theme.color.live
    case 'awaiting_approval':
    case 'awaiting_ask':
    case 'suspended':
      return theme.color.warn
    case 'error':
      return theme.color.error
    case 'stopped':
    case 'off':
    case 'hibernate':
      return theme.color.dim
    default:
      return theme.color.success
  }
}
