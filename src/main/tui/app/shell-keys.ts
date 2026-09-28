// The shell's own keys, in one place: /help, the palette and docs/daemon/tui.md
// list exactly these. Views add theirs through `keyHints`.

export const SHELL_KEYS: Array<{ keys: string; label: string }> = [
  { keys: 'ctrl+k ctrl+p', label: 'Command palette (also : when the prompt is not focused)' },
  { keys: 'tab shift+tab', label: 'Cycle focus: sidebar → main → prompt (a hidden sidebar is skipped)' },
  { keys: 'ctrl+b', label: 'Hide / show the fleet sidebar: full-width chat (also /sidebar; remembered)' },
  { keys: '1-6 alt+1-6', label: 'Switch view: 1 Fleet 2 Chat 3 Files 4 Loops 5 Inspect (the selected agent) 6 Runtime (the daemon) (bare digits outside the prompt)' },
  { keys: 'shift+left shift+right', label: 'Previous / next loop of the selected agent, from anywhere (also Ctrl+←/→, except in a prompt with text)' },
  { keys: 'alt+left alt+right', label: 'In the prompt: word left / right (also Alt+B / Alt+F, and Ctrl+←/→ while there is text)' },
  { keys: '/', label: 'Slash command (focuses the prompt)' },
  { keys: '?', label: 'This help (when the prompt is not focused)' },
  { keys: 'esc', label: 'Close dialog or completion menu · leave the sidebar · (chat) interrupt the running turn; never leaves the prompt (Tab does)' },
  { keys: 'esc esc', label: '(chat) Clear the prompt' },
  { keys: 'ctrl+c', label: 'Cancel dialog · clear the prompt · press twice to quit (agents keep running)' },
  { keys: 'enter', label: 'Send the prompt (to the selected agent › loop unless it starts with /)' },
  { keys: 'shift+enter alt+enter ctrl+j', label: 'Newline in the prompt (or end a line with \\). Shift+Enter needs a terminal that tells it apart: /terminal-setup' },
  { keys: 'ctrl+up ctrl+down', label: 'Prompt history (per agent › loop in Chat); ↑ ↓ too on the first / last line of text' },
  { keys: 'up down', label: 'Chat, empty prompt: scroll the transcript (PgUp PgDn Home End too) · otherwise move in the text / completion menu' },
  { keys: 'Wheel', label: 'Scroll what is under the pointer; click focuses a pane. Shift+drag selects text; /mouse off gives the terminal its mouse back' },
  { keys: 'tab', label: 'In the prompt with a menu open: complete /commands, their arguments, @files (Chat)' },
]

/** The fleet tree on the left (every view). */
export const SIDEBAR_KEYS: Array<{ keys: string; label: string }> = [
  { keys: 'up down', label: 'Move; selects that agent › loop everywhere (PgUp PgDn Home End too)' },
  { keys: 'right left', label: 'Expand an agent into its loops · collapse / back to the agent' },
  { keys: 'space', label: 'Expand or collapse the agent' },
  { keys: 'enter', label: 'Open the agent › loop in Chat' },
  { keys: 'a-z', label: 'Type to filter agents and loops (Backspace edits, Esc clears)' },
]

/** What the sidebar, loop tabs and header glyphs mean (ASCII theme in brackets). */
export const GLYPHS: Array<{ glyph: string; label: string }> = [
  { glyph: '● (*)', label: 'Running: a turn is in progress (agent: in any of its loops; loop: in that loop)' },
  { glyph: '○ (o)', label: 'Idle: loaded and waiting for work' },
  { glyph: '✗ (x)', label: 'Disabled loop, or an agent in error / stopped' },
  { glyph: '↻ (@)', label: 'A loop: ↻main is the agent itself, the rest are inner (side) loops' },
  { glyph: '!N', label: 'N approvals or questions waiting for you' },
  { glyph: '«N', label: 'N unread inbox messages' },
  { glyph: 'in 1h', label: 'Next timer wake of that loop' },
  { glyph: '● live / offline', label: 'Header: live event stream to the daemon, or the daemon is not answering' },
]

/** Confirm dialogs everywhere: y or Enter confirms, n or Esc cancels. */
export const CONFIRM_KEYS: Array<{ keys: string; label: string }> = [
  { keys: 'y enter', label: 'Confirm' },
  { keys: 'n esc', label: 'Cancel' },
]
