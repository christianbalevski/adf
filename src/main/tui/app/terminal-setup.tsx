// /terminal-setup: can this terminal send Shift+Enter, and how to make it.
// Terminals with the kitty keyboard protocol get it automatically (the TUI
// asks at start); others need one keybinding that sends `CSI 13;2 u`, which
// the TUI reads as Shift+Enter whether or not the protocol is on.

import { Box, Text } from 'ink'
import { useTheme } from './theme'
import { useKeys } from './keys'
import { terminalCaps, useTerminalCaps, type TerminalCaps } from './terminal'
import { Modal } from '../ui/Modal'
import type { OverlayProps } from '../views/types'
import { LinesView } from '../views/inspect/LinesView'
import { wrapLines } from './palette/help'
import { blank, heading, plain, type Line } from '../views/inspect/format'

export const TERMINAL_SETUP_OVERLAY = 'terminal-setup'

export type TerminalKind = 'windows-terminal' | 'vscode' | 'iterm2' | 'apple-terminal' | 'wezterm' | 'ghostty' | 'kitty' | 'alacritty' | 'tmux' | 'unknown'

/** Best guess from the environment (TERM_PROGRAM, WT_SESSION, …). */
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalKind {
  if (env.TMUX) return 'tmux'
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  if (program === 'vscode') return 'vscode'
  if (env.WT_SESSION) return 'windows-terminal'
  if (program === 'iterm.app') return 'iterm2'
  if (program === 'apple_terminal') return 'apple-terminal'
  if (program === 'wezterm') return 'wezterm'
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty'
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) return 'kitty'
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET || env.TERM === 'alacritty') return 'alacritty'
  return 'unknown'
}

const TERMINAL_NAMES: Record<TerminalKind, string> = {
  'windows-terminal': 'Windows Terminal',
  vscode: 'VS Code terminal',
  iterm2: 'iTerm2',
  'apple-terminal': 'macOS Terminal',
  wezterm: 'WezTerm',
  ghostty: 'Ghostty',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  tmux: 'tmux',
  unknown: 'this terminal',
}

const SEQUENCE = '\\u001b[13;2u'

/** The setup page: status, then the snippet for the detected terminal first. */
export function terminalSetupLines(kind: TerminalKind, caps: TerminalCaps = terminalCaps()): Line[] {
  const works = caps.kitty || caps.shiftEnterSeen || caps.shiftEnterForced
  const lines: Line[] = [heading(`Shift+Enter in ${TERMINAL_NAMES[kind]}`)]
  if (caps.kitty) lines.push(plain('  Works: the terminal speaks the kitty keyboard protocol and ADF turned it on.', 'success'))
  else if (caps.shiftEnterSeen) lines.push(plain('  Works: a Shift+Enter distinct from Enter arrived (a keybinding sends it).', 'success'))
  else if (caps.shiftEnterForced) lines.push(plain('  Assumed to work (ADF_TUI_SHIFT_ENTER=1).', 'success'))
  else lines.push(plain('  Not detected: this terminal sends Shift+Enter as a plain Enter, so it sends the message.', 'warn'))
  lines.push(plain('  Always available: Alt+Enter, Ctrl+J, or end the line with \\ and press Enter.', 'muted'))

  const sections: Array<{ kinds: TerminalKind[]; title: string; body: string[] }> = [
    {
      kinds: ['windows-terminal'],
      title: 'Windows Terminal',
      body: [
        '1.25 and later: works (kitty keyboard protocol). Older: add to settings.json (Ctrl+Shift+, opens it), in "actions":',
        `  { "command": { "action": "sendInput", "input": "${SEQUENCE}" }, "keys": "shift+enter" }`,
      ],
    },
    {
      kinds: ['vscode'],
      title: 'VS Code, Cursor (integrated terminal)',
      body: [
        'Add to keybindings.json (Ctrl+Shift+P → "Preferences: Open Keyboard Shortcuts (JSON)"):',
        `  { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "${SEQUENCE}" }, "when": "terminalFocus" }`,
      ],
    },
    {
      kinds: ['kitty', 'wezterm', 'ghostty', 'iterm2', 'alacritty'],
      title: 'kitty, WezTerm, Ghostty, foot, iTerm2 3.5+, recent Alacritty',
      body: ['Work without setup: they answer the kitty keyboard protocol query. Older Alacritty: bind Shift+Enter to send the same sequence (chars = "\\u001b[13;2u").'],
    },
    {
      kinds: ['apple-terminal'],
      title: 'macOS Terminal',
      body: ['No Shift+Enter. Use Option+Enter (Settings → Profiles → Keyboard → "Use Option as Meta key") or Ctrl+J.'],
    },
    {
      kinds: ['tmux'],
      title: 'tmux',
      body: ['Needs extended keys, in ~/.tmux.conf:', '  set -s extended-keys on', "  set -as terminal-features 'xterm*:extkeys'"],
    },
  ]
  const ordered = [...sections.filter(s => s.kinds.includes(kind)), ...sections.filter(s => !s.kinds.includes(kind))]
  for (const section of ordered) {
    lines.push(blank(), [{ text: `  ${section.title}`, tone: 'heading', bold: true }, { text: section.kinds.includes(kind) ? '  (detected)' : '', tone: 'muted' }])
    for (const text of section.body) lines.push(plain(`  ${text}`, text.startsWith('  ') ? 'accent' : undefined))
  }
  lines.push(blank(), plain('  The hint in the prompt switches to Shift+Enter as soon as one arrives. ADF_TUI_SHIFT_ENTER=1 shows it from the start; ADF_TUI_KITTY=0 (or --no-kitty) never turns the protocol on.', 'muted'))
  return lines
}

export function TerminalSetupDialog({ close, width, height }: OverlayProps) {
  const theme = useTheme()
  const caps = useTerminalCaps()
  useKeys((input, key) => {
    if (key.escape || input === 'q' || key.return || (key.ctrl && input === 'c')) { close(); return true }
    return false
  }, { layer: 'overlay' })
  const dialogWidth = Math.max(30, Math.min(width - 4, 110))
  const inner = dialogWidth - 4
  const lines = wrapLines(terminalSetupLines(detectTerminal(), caps), inner)
  const bodyHeight = Math.max(4, Math.min(lines.length + 1, height - 7))
  return (
    <Modal title="Terminal setup" width={dialogWidth} hints={[{ keys: 'up down', label: 'scroll' }, { keys: 'esc', label: 'close' }]}>
      <Box flexDirection="column" height={bodyHeight}>
        <LinesView lines={lines} width={inner} height={bodyHeight} keyLayer="overlay" />
      </Box>
      <Text color={theme.color.dim} wrap="truncate-end">Test it: press Shift+Enter in the prompt; the hint changes when it arrives.</Text>
    </Modal>
  )
}
