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
  /** The selected-item gutter (chat transcript): a half block, '>' in ASCII. */
  mark: string
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

/**
 * ADF brand, dark (brand/tokens.css dark values). Neutral ink on paper, one
 * blue for accent / focus / selection, status colors for state. Hex values;
 * Ink (chalk) downsamples them to 256 or 16 colors on terminals without
 * truecolor.
 */
const ADF_COLORS: ThemeColors = {
  text: '#ECEEF3', // ink
  muted: '#B0B5C2', // ink-muted
  dim: '#858B99', // ink-faint
  accent: '#7F9DFF', // blue
  live: '#A9BDFF', // blue-strong
  loop: '#C6A8E6', // status: experimental
  user: '#7F9DFF', // blue
  assistant: '#ECEEF3', // ink
  thinking: '#858B99', // ink-faint
  tool: '#B0B5C2', // ink-muted
  success: '#86CFAE', // status: stable
  warn: '#E7BF73', // status: draft
  error: '#EE9B92', // status: deprecated
  info: '#B0B5C2', // ink-muted
  border: '#333A49', // rule-strong
  borderFocus: '#7F9DFF', // blue
  selectionFg: '#0C0E13', // paper (on a blue fill)
  selectionBg: '#7F9DFF', // blue
  surface: '#151922', // paper-sunken
  overlay: '#151922', // paper-sunken
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
  mark: '▌',
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
  mark: '>',
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
