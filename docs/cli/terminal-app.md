# Terminal app

`adf` with no command opens the terminal app: every loaded agent, each
agent's loops, their live state, approvals, files and events, in one screen.
It is a client of the daemon; quitting leaves every agent running.

```bash
adf                                   # open it (starts the daemon if needed)
adf --view loops --agent agent-1 --loop consolidator
adf --theme adf-light                 # adf | adf-light | adf-contrast | parchment | adf-mono
```

All options: [reference](reference.md#terminal-app-options). The app needs a
real terminal; in a pipe or CI log it exits and points at the one-shot
commands.

## Layout

```text
 ◆ ADF  agent-1 ›  1 Chat   2 Files   3 Loops   4 Inspect │ 5 Fleet   6 Runtime   ● web :7295  !1 pending  ● live
 FLEET                   2 │ agent-1 ›  ● main !  ○ consolidator  ○ researcher             Shift+←/→
 ▾ ⠹ agent-1 thinki… !1 «1 │ host ✓ · web 127.0.0.1:7295/agents/agent-1/
   ⠹ ↻main        thinking │
   ○ ↻consolidator   in 1h │  › What did we decide about the standings API?
   ○ ↻researcher           │  ● We keep v2 and add a since cursor.
   ● agent-2 idle          │  ✓ fs_read {"path":"notes/api.md"}
                           │ ╭──────────────────────────────────────────────────────────╮
                           │ │ ! agent-1 wants to run msg_send                          │
                           │ │ y approve · a always · n reject · f feedback · v details │
                           │ ╰──────────────────────────────────────────────────────────╯
                           │╭────────────────────────── Merging API notes into mind.md ─╮
                           ││ › Message agent-1 · queued until the turn ends             │
                           │╰────────────────────────────────────────────────────────────╯
 agent-1 › ↻ main  ⠹ thinking  model   Shift+←/→ loop · Alt+1-6 views · Tab focus · Ctrl+K palette
```

- **Header (tab bar):** the selected agent (and its loop, when not main)
  followed by its views, **1 Chat · 2 Files · 3 Loops · 4 Inspect**; after
  the `│`, the app's own views, **5 Fleet** (every agent) and **6 Runtime**
  (the daemon). Then the web server (`● web :7295` or `○ web off`), pending
  approvals across the fleet, the connection (`live` or `offline`) and the
  daemon URL. With no agent selected the label reads `no agent`. Click the
  agent label (or `Enter` on it from the tab bar) to switch agent or loop.
  Narrow terminals shorten the view names and drop the badges first; the
  agent label and the `│` stay.
- **Sidebar:** the fleet tree. Each agent with its state, `!n` approvals or
  questions waiting, `«n` unread inbox messages; expand it (`→`) for its
  loops and their next timer (`in 1h`).
- **Main pane:** the active view.
- **Prompt:** a message to the selected agent › loop, or a `/command`. The
  agent's status line (what it set with `sys_set_meta` `status`) sits on the
  prompt's top border, on the right; click it for Inspect › Status. An inner
  loop shows its agent's status.
- **Toasts** report the outcome of every action; **status bar**: the
  selection, its state and model, and the view's main keys.

Nothing happens silently: every reply, thinking block, tool call, approval,
wake and notice is shown, and every action the app takes is reported.

## Views

Press the digit (outside the prompt) or `Alt+digit` (anywhere). On macOS,
where Option does not send Alt by default, press `Esc` then the digit.

The selected agent's views:

| Key | View | For |
|---|---|---|
| `1` | Chat | One conversation per agent › loop, with loop tabs, approvals and questions. |
| `2` | Files | The agent's document, mind and files; Inbox, Outbox, Meta. See [Files](files.md). |
| `3` | Loops | Inner loops, timers, triggers, loop history. See [Loops and timers](loops-and-timers.md). |
| `4` | Inspect | The selected agent: status, [settings](agent-settings.md), config, usage, MCP, channels, identities, logs, tables, tasks, events. |

The app's views:

| Key | View | For |
|---|---|---|
| `5` | Fleet | All agents: state, loops, approvals, inbox, model, tokens. Start (`s`), stop (`x`), interrupt (`a`), new (`n`), load (`o`), track a folder (`f`). |
| `6` | Runtime | The daemon: status, tracked folders, owner identity, sign-in, providers, usage, network, compute, MCP, channels, settings, every agent's events. |

The app opens on Fleet.

### Tabs, lists and details

Files, Loops, Inspect and Runtime work the same way:

| Keys | Action |
|---|---|
| `←` `→` | The view's tabs (Files · Inbox · Outbox · Meta, Loops · Timers · …) |
| `↑` `↓` | Move in the list |
| `Enter` | Open the item: a file, a message, a history entry, a task, a table row, an event. On a folder: open or close it |
| `Backspace` | Back one level: the viewer or detail to its list (the item stays selected); in the Files tree, close the folder, then go to the parent folder. It never deletes (`d` / `Delete` do, and ask) |
| `Esc` | Back one level like `Backspace` (it does not close folders); from a list it goes on to the tab bar |
| `/` | Filter the list. While typing, `Backspace` edits the filter and `←` `→` stay put |

## Moving around

- **`Tab` / `Shift+Tab`** cycle focus: sidebar → main pane → prompt.
- **`Esc`** backs out one step at a time: closes a dialog or menu, ends a
  view's own mode (a filter, the file viewer, a selected chat item),
  interrupts a running chat turn, and finally moves focus up to the **tab
  bar**. There `←`/`→` switch views as you move, `Enter` or `↓` goes into
  the view, `w` turns the web server on or off. Left of `1 Chat` is the
  agent label: `Enter` on it switches agent or loop.
- **`Ctrl+B`** hides the sidebar for a full-width view (also `/sidebar`;
  remembered across launches).
- **`Ctrl+K`** (or `Ctrl+P`, or `:` outside the prompt) opens the **command
  palette**: a fuzzy search over views, agents, every loop of every agent,
  slash commands, actions and recent files. `Enter` runs the entry.
- **`?`** or **`/help`**: every key and command, searchable (type to filter).
- **`Shift+←` / `Shift+→`**: previous / next loop of the selected agent,
  from anywhere.
- **`/agent <handle> [loop]`**, **`/switch <agent>[/loop]`**: jump by name.
- **`Ctrl+C`** cancels a dialog or clears the prompt; twice quits.

Every key: [reference › Keys](reference.md#keys).

## Stopped agents

The sidebar and Fleet list every agent in your tracked folders, not only the
ones running. Agents that are not loaded show dimmed under their folder with
their state:

| State | `s` or `Enter` |
|---|---|
| `stopped` | Load it into the daemon and start it |
| `needs review` | Open its review (what it can do); `y` accepts, loads and starts it |
| `load error` | Try again (the error is shown) |
| `locked` | Password-protected: load it with `/load <file>` and unlock it |
| `unreadable` | Not a loadable `.adf` |

A stopped agent can be selected like any other; sending it a chat message
starts it first. `H` on the Fleet (or `/agents running|all`) hides or shows
stopped agents. Track a folder with `f` on the Fleet or `/track [dir]`;
`/untrack <dir>` stops tracking (files are never touched).

## Chat

- **Send:** `Enter`. While the loop is running your message shows
  `[queued]`. Send several and none is lost: the first interrupts the turn,
  then they all go to the agent together, in order, and each loses `[queued]`
  as the new turn takes it. If the agent is stopped first, the ones it never
  got show `[not delivered]` with a notice. `Esc` (interrupt) keeps them.
- **Loops:** the tabs above the transcript. `Shift+←/→` switches; each loop
  keeps its own transcript, scroll position, draft and prompt history
  (`Ctrl+↑/↓`).
- **Select an item:** with an empty prompt, `↑`/`↓` select the previous /
  next transcript item (your message, a reply, thinking, a tool call, a
  notice, an approval). The selected item gets a bar on its left edge.
  `Enter` or `Space` expands or collapses it (tool input and result,
  thinking), `c` copies it, `Esc` lets go. `↓` past the newest item follows
  live again.
- **Scroll:** `PgUp`/`PgDn` (also while typing), the mouse wheel, `Home`
  (top, loading older history) and `End` (follow live).
- **Thinking:** `t` expands or collapses all of it.
- **Files:** `@` in the prompt completes an agent file path (`Tab` or `Enter`).

### Approvals and questions

A tool call that needs your approval shows as a card under the transcript
of the loop that asked, and as `!n` in the header, sidebar and Fleet.

| Key | Action |
|---|---|
| `y` | Approve. Press twice, or once when that approval is selected in the transcript, so typed text never approves by accident |
| `a` | Always approve this tool for this agent (twice, then confirm). Not offered for protection overrides and other one-time approvals |
| `n` | Reject |
| `f` | Reject with feedback: the agent sees your text |
| `v` | Full details of the call |

`/approve [all|always]` and `/reject [feedback]` do the same from the prompt.
When the agent asks you a question, the card shows it and what you type next
is sent as the answer. Inspect › Tasks (`/tasks`) lists every pending and
past approval. One-shot: `adf tasks`, `adf approve`, `adf deny`, `adf asks`,
`adf answer`.

### Interrupt vs stop

| Action | What happens | How |
|---|---|---|
| **Interrupt** | The running turn ends; the loop goes idle and keeps accepting chat, timers and triggers | `Esc` in Chat, `/interrupt` (alias `/abort`), `a` on the Fleet; `adf interrupt <agent> [--loop <name>]` |
| **Stop** | The agent is unloaded from the daemon (its `.adf` file is kept) | `x` on the Fleet, `/stop [agent]`; `adf stop <agent>` |
| **Hard abort** | The turn is aborted and that loop runs nothing more until the agent is reloaded | `/agents abort <agent> [loop]`, the palette; `adf abort <agent> [--loop <name>]` |

Use interrupt; keep the hard abort for a loop that must not run again this
session. In the terminal app `/abort` is an alias of `/interrupt`.

## The prompt

| Keys | Action |
|---|---|
| `Enter` | Send (or run the `/command`). With the completion menu open: take the highlighted item; a `/command` with all its required arguments runs, one that needs arguments is inserted with a space so you can type them, an `@file` is inserted |
| `↑` `↓`, `Esc` | Move in the completion menu, close it |
| `Shift+Enter`, `Alt+Enter`, `Ctrl+J`, a trailing `\` | Newline |
| `Ctrl+↑`, `Ctrl+↓` | Prompt history (per agent › loop in Chat) |
| `Tab` | Complete without running: `/commands`, their arguments, `@files` |
| `Alt+←/→`, `Alt+B/F` | Word left / right |
| `Home`, `End`, `Ctrl+A`, `Ctrl+E` | Line start / end |
| `Ctrl+W`, `Ctrl+Backspace`, `Alt+Backspace` | Delete the word before the caret |
| `Ctrl+U` | Delete to the line start |
| `Esc Esc` | Clear the prompt |

### Shift+Enter

Most terminals send the same key for `Enter` and `Shift+Enter`. The app asks
the terminal for the kitty keyboard protocol at start and uses it when the
terminal answers; otherwise use `Alt+Enter` or `Ctrl+J`. `/terminal-setup`
shows whether Shift+Enter works in the terminal you are in, and the fix.

| Terminal | Shift+Enter |
|---|---|
| kitty, WezTerm, Ghostty, foot, iTerm2 3.5+, recent Alacritty | Works |
| Windows Terminal 1.25+ | Works |
| Windows Terminal before 1.25 | `settings.json` → `"actions"`: `{ "command": { "action": "sendInput", "input": "\u001b[13;2u" }, "keys": "shift+enter" }` |
| VS Code / Cursor terminal | `keybindings.json`: `{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\u001b[13;2u" }, "when": "terminalFocus" }` |
| macOS Terminal | Not available: `Option+Enter` (with Settings → Profiles → Keyboard → "Use Option as Meta key") or `Ctrl+J` |
| tmux | In `~/.tmux.conf`: `set -s extended-keys on` and `set -as terminal-features 'xterm*:extkeys'` |

`--no-kitty` (or `ADF_TUI_KITTY=0`) never turns the protocol on.

## Mouse, selection, copy and paste

Mouse mode is on by default. The app does its own selection, so copy and
paste work without a modifier:

- **Drag** selects text inside one pane and copies it on release
  (`Copied N chars`). **Double-click** takes a word, **triple-click** a line.
- **Click** a transcript item to select it; a tool call or thinking block
  expands or collapses. Clicks on tabs switch views, on the agent label
  switch agent, on the prompt's status note open Inspect › Status; the
  approval card's actions are buttons.
- **Right-click** pastes into the prompt or the open dialog. `Ctrl+V`,
  `Ctrl+Shift+V` and `Cmd+V` paste as usual.
- **The wheel** scrolls whatever is under the pointer.
- The terminal's own selection is still there: **Shift+drag** (Windows
  Terminal, VS Code, most terminals), **Option+drag** in iTerm2,
  **Fn+drag** in Terminal.app.

Copying uses the system clipboard (`pbcopy`, `clip.exe`, `wl-copy`, `xclip`,
`xsel`) and falls back to the terminal (OSC 52, which also reaches your local
clipboard over SSH). `ADF_TUI_CLIPBOARD=osc52` always uses OSC 52.

**`/mouse off`** (or `--no-mouse`, `ADF_TUI_MOUSE=0`; remembered) hands the
mouse back to the terminal: its own drag-select, copy and right-click paste.
The wheel then scrolls the focused pane. `/mouse on` turns mouse mode back on.

## Agent websites

Agents can serve pages and APIs through the daemon's web server
(`http://127.0.0.1:7295/agents/<handle>/` by default). `w` opens the selected
agent's site (Fleet, Chat, Inspect › Status), `W` copies the URL,
`/open-site` and `/copy-site` work from anywhere. `/web on|off` (or `w` on
the tab bar) starts or stops the server; stopping asks, since it takes every
agent site offline.

## Themes and terminals

- Themes: `adf` (dark, default) and `adf-light` use the ADF brand colors;
  `adf-contrast` is `adf` with brighter text and borders; `parchment` is
  the earlier warm palette; `adf-mono` has no color.
  `/theme` picks one for the session; `--theme` or `ADF_TUI_THEME` makes it
  stick. `NO_COLOR` always wins.
- `--ascii` for consoles without box-drawing or braille glyphs.
- **Windows:** Windows Terminal is the primary target. The bottom row stays
  unused (a full frame would force a full redraw there; `ADF_TUI_FULL_HEIGHT=1`
  uses it anyway). The external editor defaults to `notepad`.
- **External editor** (`e` in Files, Config, instructions): `ADF_EDITOR`,
  then `VISUAL`, then `EDITOR`, else `nano` / `vi`.

## Known gaps

- Remote MCP servers that sign in with OAuth in the browser, and servers
  with a one-time sign-in step, are set up in ADF Studio.
- The WhatsApp pairing QR is not drawn; open
  `imported/whatsapp/pairing-qr.png` from the agent's files, or use Studio.
- The seed phrase is shown once, at creation. Studio on the same machine can
  reveal it again (Settings → Back up seed phrase); the daemon cannot.
- Saved credentials are write-only: forms can replace a value, never show it.
- `/theme` lasts for the session; use `--theme` or `ADF_TUI_THEME` to keep it.
