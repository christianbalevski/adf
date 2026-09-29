// The shell's own keys, in one place: /help, the palette and docs/daemon/tui.md
// list exactly these. Views add theirs through `keyHints`.

export const SHELL_KEYS: Array<{ keys: string; label: string }> = [
  { keys: 'ctrl+k ctrl+p', label: 'Command palette (also : when the prompt is not focused)' },
  { keys: 'tab shift+tab', label: 'Cycle focus: sidebar → main → prompt (a hidden sidebar is skipped); from the tab bar Tab goes to the first pane' },
  { keys: 'ctrl+b', label: 'Hide / show the fleet sidebar: full-width chat (also /sidebar; remembered)' },
  { keys: '1-6 alt+1-6', label: 'Switch view: 1 Fleet 2 Chat 3 Files 4 Loops 5 Inspect (the selected agent) 6 Runtime (the daemon) (bare digits outside the prompt)' },
  { keys: 'shift+left shift+right', label: 'Previous / next loop of the selected agent, from anywhere (also Ctrl+←/→, except in a prompt with text)' },
  { keys: 'alt+left alt+right', label: 'In the prompt: word left / right (also Alt+B / Alt+F, and Ctrl+←/→ while there is text)' },
  { keys: 'home end', label: 'In the prompt: line start / end (also Ctrl+A / Ctrl+E, Cmd+← / Cmd+→)' },
  { keys: 'ctrl+backspace alt+backspace ctrl+w', label: 'In the prompt: delete the word before the caret (Option+Backspace on a Mac)' },
  { keys: 'ctrl+delete alt+d', label: 'In the prompt: delete the word after the caret' },
  { keys: 'cmd+backspace ctrl+u', label: 'In the prompt: delete to the line start (Terminal.app sends nothing for Cmd+Backspace: use Ctrl+U)' },
  { keys: '/', label: 'Slash command (focuses the prompt)' },
  { keys: '?', label: 'This help (when the prompt is not focused)' },
  { keys: 'esc', label: 'In order: close the dialog or completion menu · end a view’s own mode (filter, search, viewer, a selected chat item) · (chat) interrupt the running turn · then focus the tab bar (from the sidebar, the main pane, or an empty prompt)' },
  { keys: 'esc esc', label: 'Clear a prompt that has text (the next Esc goes to the tab bar)' },
  { keys: 'ctrl+c', label: 'Cancel dialog · clear the prompt · press twice to quit (agents keep running)' },
  { keys: 'enter', label: 'Send the prompt (to the selected agent › loop unless it starts with /)' },
  { keys: 'shift+enter alt+enter ctrl+j', label: 'Newline in the prompt (or end a line with \\). Shift+Enter needs a terminal that tells it apart: /terminal-setup' },
  { keys: 'ctrl+up ctrl+down', label: 'Prompt history (per agent › loop in Chat); ↑ ↓ too on the first / last line of text' },
  { keys: 'up down', label: 'Chat, empty prompt: select the previous / next transcript item (Enter expands, Esc lets go; PgUp PgDn Home End scroll) · otherwise move in the text / completion menu' },
  { keys: 'Mouse', label: 'Mouse mode (default): the wheel scrolls what is under the pointer; click selects / expands a tool call; drag selects + copies (double-click word, triple-click line); right-click pastes. Shift+drag (Option+drag iTerm2, Fn+drag Terminal.app): the terminal’s own selection. /mouse off: the terminal’s mouse' },
  { keys: 'w', label: 'Fleet, Inspect › Status, Chat transcript: open the agent’s website (W copies the URL) · on the tab bar: web server on / off' },
  { keys: 'tab', label: 'In the prompt with a menu open: complete /commands, their arguments, @files (Chat)' },
]

/** The header tab bar, focused with Esc. */
export const TAB_BAR_KEYS: Array<{ keys: string; label: string }> = [
  { keys: 'left right', label: 'Previous / next view: switches as you move (h l too; Home / End first / last)' },
  { keys: 'enter down', label: 'Into the view (Chat: its prompt)' },
  { keys: '1-6', label: 'Jump straight into a view' },
  { keys: 'tab shift+tab', label: 'Back into the panes (first / last)' },
  { keys: 'w', label: 'Web server on / off (stopping asks); also a click on the header’s web badge in mouse mode, /web on|off' },
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
  { glyph: '● web :7295 / ○ web off', label: 'Header: the web server that serves agent websites / APIs (w on the tab bar, /web on|off)' },
]

/** Confirm dialogs everywhere: y or Enter confirms, n or Esc cancels. */
export const CONFIRM_KEYS: Array<{ keys: string; label: string }> = [
  { keys: 'y enter', label: 'Confirm' },
  { keys: 'n esc', label: 'Cancel' },
]
