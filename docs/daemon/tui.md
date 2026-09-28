# ADF TUI

The ADF TUI is an interactive terminal client for the [daemon](index.md). It
shows your whole fleet at once: every loaded agent, each agent's loops, their
live state, pending approvals and questions, and the umbilical event stream.
From it you set up your owner identity, create agents, chat with any loop of
any agent, approve tool calls, read and edit the agent document, mind and
files, create, schedule and manage loops, and look under the hood of one
agent (Inspect) or of the daemon itself (Runtime).

It is a client like the [CLI](cli.md): it talks to the daemon's
[HTTP API](http-api.md) and `/events` stream. Quitting the TUI leaves every
agent running in the daemon.

## Loops

An agent has several **loops**. Each loop is a separate chat session (a
thread) with its own history, goal and state:

- **`main`** is the agent itself. It talks to you.
- **Inner loops** (also called side loops) are declared in the agent's config
  (`AgentConfig.loops`). Each works on its own goal in parallel with main, for
  example:
  - a `consolidator` that tidies memory (`mind.md`, notes) every night;
  - a `researcher` that digs into whatever main or you hand it;
  - a `critic` that reviews drafts before main sends them;
  - a `reflector` that looks back over recent work every few hours.

An inner loop runs when a message arrives (from you, from main or from another
loop), when a **timer** whose `loop` targets it fires, or when a **trigger
target** with that `loop` matches. A timer on a loop is how you get "run this
side loop on a recurring basis".

The TUI treats loops as first class everywhere:

- The sidebar tree lists every agent with its loops, each with a running,
  idle or off marker and its next scheduled run (`in 1h`).
- Chat is per loop. Loop tabs sit above the transcript, and **Shift+← / Shift+→**
  switches loops from any view (also `Ctrl+←/→`, except in a prompt with text,
  where Ctrl+arrows jump words; stock macOS keeps `Ctrl+←/→` for Spaces). Each
  loop keeps its own transcript, scroll position, prompt draft and prompt
  history.
- The Loops view creates, edits, enables, disables, schedules and deletes
  inner loops. It also shows every timer and trigger with the loop it wakes.
- Approvals, questions, notices and wakes (for example "Woken by timer #1") are
  filed under the loop they belong to.

### Example: a nightly memory consolidator

1. Press `4` for the Loops view, then `n`.
2. Choose **Memory consolidator**. The form comes prefilled: name
   `consolidator`, a goal, a read/write file tool set, and a daily 03:00
   schedule with the wake message "Consolidate memory now."
3. Adjust anything you like (`Ctrl+O` edits the goal in your editor), then
   press `Ctrl+S` to review and `y` to create.
4. The result screen shows the loop created, the tools the daemon actually
   granted, and `Timer #n scheduled: daily at 03:00`.
5. Press `c` there (or Enter on the loop row) to chat with the new loop. Every
   night its timer wakes it, and the wake shows up in its transcript.

From the prompt the same thing is `/loop new consolidator` (template),
`/loop new <name> <goal…>` (blank loop) and `/timer add --loop <name>`.

## Launch

```bash
adf                      # the npm package: opens the TUI
npm run adf              # from a source checkout: same
npm run adf -- tui       # same
npm run tui              # same
npm run adf -- --view loops --agent agent-1 --loop consolidator
```

When no daemon answers at a local daemon URL, `adf` starts one in the
background first (`Starting the ADF daemon…`) and then opens the TUI.
Quitting the TUI leaves it running (`adf daemon stop` stops it); see
[Background daemon](cli.md#background-daemon). `--no-daemon` or
`ADF_NO_AUTOSTART=1` skip that: the TUI then shows the daemon as offline
and how to start it.

| Option | Description |
|--------|-------------|
| `--url`, `-u <url>` | Daemon URL (default `ADF_DAEMON_URL`, then `http://127.0.0.1:7385`) |
| `--token <token>` | Bearer token (default `ADF_DAEMON_TOKEN`) |
| `--view <id>` | Start view: `fleet` \| `chat` \| `files` \| `loops` \| `inspect` \| `runtime` |
| `--agent <id\|handle>` | Preselect an agent |
| `--loop <name>` | Preselect one of its loops (default `main`) |
| `--theme <name>` | `adf` (dark, default), `adf-light`, `adf-contrast`, `adf-mono` |
| `--mono`, `--no-color` | No color |
| `--ascii` | ASCII glyphs for consoles without box-drawing or braille characters |
| `--no-alt-screen` | Render in the main screen buffer instead of the alternate screen (mouse capture stays off there) |
| `--no-mouse` | No mouse capture: the terminal selects text and scrolls as usual (see [Mouse](#mouse)) |
| `--no-kitty` | Never turn on the kitty keyboard protocol (see [Shift+Enter](#shiftenter)) |
| `-h`, `--help` | Show the help |

| Environment | Effect |
|-------------|--------|
| `ADF_DAEMON_URL`, `ADF_DAEMON_TOKEN` | Daemon address and token, as for the CLI |
| `NO_COLOR` (any value), `TERM=dumb` | No color. Emphasis uses bold, inverse and underline. Always wins over `--theme` |
| `ADF_TUI_THEME` | Same as `--theme` |
| `ADF_TUI_ASCII=1` | Same as `--ascii` |
| `ADF_EDITOR`, `VISUAL`, `EDITOR` | External editor, in that order. Default: `notepad` on Windows, else `nano`, then `vi` |
| `ADF_TUI_FULL_HEIGHT=1` | Windows: use the bottom terminal row too (see [Windows](#windows)) |
| `ADF_TUI_MOUSE=0` / `=1` | Mouse capture off / on, over the saved `/mouse` choice |
| `ADF_TUI_KITTY=0` | Same as `--no-kitty` |
| `ADF_TUI_SHIFT_ENTER=1` | Show `Shift+Enter` in the hints from the start (your terminal sends it through a keybinding) |
| `ADF_TUI_PREFS=<path>` | Where the sidebar and mouse choices are kept (default `<config dir>/adf-studio/tui-prefs.json`; `off` keeps them for the session only) |

The TUI needs a terminal. When stdin or stdout is not a TTY (a pipe, a CI
log), it prints a hint to use the one-shot CLI commands and exits with code 1.
Every other `npm run adf -- <command>` is the unchanged one-shot [CLI](cli.md).

## Layout

```text
 ◆ ADF   1 Fleet   2 Chat   3 Files   4 Loops   5 Inspect   6 Runtime     !1 pending  ● live  127.0.0.1:7385
 FLEET                   2 │ agent-1 ›  ● main !  ○ consolidator  ○ researcher             Shift+←/→
 ▾ ⠹ agent-1 thinki… !1 «1 │ main loop: the agent itself, talks to you · 2 inner loops
   ⠹ ↻main        thinking │
   ○ ↻consolidator   in 1h │  › What did we decide about the standings API?
   ○ ↻researcher           │  ● We keep v2 and add a since cursor.
   ● agent-2 idle          │  ✓ fs_read {"path":"notes/api.md"}
   ○ ↻main                 │  │ ↻ from loop consolidator · inter-loop message
                           │  › hello from the TUI
                           │  ● Noted: "hello from the T
                           │ ╭───────────────────────────────────────────────────────────────────────╮
                           │ │ ! agent-1 wants to run msg_send                                       │
                           │ │ {"to":"agent-2","content":"hello"}                                    │
                           │ │ Tab to the transcript, then y approve (twice) · n deny · v details    │
                           │ ╰───────────────────────────────────────────────────────────────────────╯
                           │ ⠹ thinking… 0s · mock-model · esc to interrupt
                           │╭─────────────────────────────────────────────────────────────────────────╮
                           ││ › Message agent-1 · queued until the turn ends · Esc interrupts          │
                           │╰─────────────────────────────────────────────────────────────────────────╯
 agent-1 › ↻ main  ⠹ thinking  mock-model   Esc interrupt · Shift+Enter newline · Shift+←/Shift+→ loop · ↑/↓ scroll
```

- **Header:** the ADF wordmark, the views with their hotkeys, pending
  approvals and questions across the fleet, the live connection (`live`, or
  `offline` when the daemon does not answer) and the daemon URL. On narrow
  terminals the URL shrinks to its port and then goes before the view names
  shorten (`1 Flt 2 Chat 3 File 4 Loop 5 Insp 6 Rt`).
- **Daemon offline:** when nothing answers at the daemon URL, the Fleet view
  says so, with the URL it tried, how to start the daemon (`npm run daemon`),
  `ADF_DAEMON_URL` / `--url` / `/url`, and the retry countdown.
- **Sidebar (every view):** the fleet tree. Agents carry a state glyph, `!n`
  for pending approvals or questions and `«n` for unread inbox messages. Each
  agent expands into its loops. It collapses below 70 columns. **`Ctrl+B`**
  (or `/sidebar`, or the palette) hides it at any width for a full-width
  chat; the choice is remembered across launches. With it hidden, `Tab`
  skips it, the status bar still names the agent › loop, and the header adds
  the unread inbox count (`«2 unread`) next to the pending approvals.
- **Main pane:** the active view.
- **Prompt:** send a message to the selected agent › loop, or run a `/command`.
- **Toasts** above the status bar report the outcome of every action.
- **Status bar:** the selected agent › loop, its state, model and token tally,
  then the active view's keys.

Nothing happens silently. Every assistant message, thinking block, tool call,
approval, question, wake and notice is shown. Every action the TUI takes
(reconnect, resync, refetch, a daemon call) is reported in a toast or in the
transcript of the loop it concerns.

## Views

| Key | View | What it shows |
|-----|------|---------------|
| `1` | **Fleet** | A daemon line (pid, uptime, providers, mesh, WebSocket, compute), an agent table (state, loops running/total, approvals, inbox, model, tokens, timers, last activity, mesh) and the selected agent's loops with their schedule and goal. Start, stop, interrupt, load `.adf` files, autostart. |
| `2` | **Chat** | One conversation per agent › loop. Loop tabs, a virtualized transcript (history pages load as you scroll up; live events stream in), collapsible thinking and tool calls, inter-loop messages, wake markers, and an approval/question card. A turn footer shows elapsed time, tokens and the model. |
| `3` | **Files** | The agent document, mind and files as a tree with a viewer (syntax colouring, search, hex for binaries). Edit in your `$EDITOR` with a diff confirm and a concurrent-change check. Create, move, delete, protection, authorized. Read-only Inbox, Outbox and Meta tabs. A badge names the loop that last wrote a file. |
| `4` | **Loops** | Tabs: **Loops** (every loop with status, messages, tools, model, flags, what wakes it; create from templates, edit, enable/disable, send, schedule, clear, delete), **Timers** (this agent's or every agent's timers, with the loop each one wakes), **Triggers** (all trigger types, the loop each target wakes, enable/disable, edit targets), **History** (a loop's persisted entries with tokens, filters and paging). |
| `5` | **Inspect** | The selected agent only (the tab bar reads `agent-1 › …`). Tabs: **Status** (state, loops, triggers, WebSocket), **Config** (tree or JSON; edit in `$EDITOR` with schema validation and a confirm), **Usage** (by model), **MCP**, **Adapters**, **Identities** (metadata only), **Logs**, **Tables**, **Events** (this agent's live umbilical events). Secrets are redacted everywhere. |
| `6` | **Runtime** | The daemon, across every agent (`daemon › …`). Tabs: **Status** (health, version, uptime, pid, every agent's loops), **Identity** (owner identity; `Enter` opens its dialog), **Sign-in** (ChatGPT / Grok and API-key providers; `Enter` signs in), **Providers** (and which agents use them), **Usage** (all agents, by model), **Network** (mesh, LAN, WebSocket; `m` mesh on/off, `s` server start/stop, `R` restart, each asks), **Compute** (container runtime and containers), **MCP** and **Adapters** (registered with the daemon), **Settings** (redacted), **Events** (every agent's live umbilical events). |

## Keys

The same list is in the TUI: press `?` or type `/help`. `Ctrl+K` searches all
of it.

### Everywhere

| Keys | Action |
|------|--------|
| `Ctrl+K`, `Ctrl+P` | Command palette (also `:` when the prompt is not focused) |
| `Tab`, `Shift+Tab` | Cycle focus: sidebar → main → prompt (a hidden sidebar is skipped). Entering Chat focuses the prompt |
| `Ctrl+B` | Hide / show the fleet sidebar: full-width view (also `/sidebar`; remembered) |
| `1`–`6`, `Alt+1`–`Alt+6` | Switch view: 1 Fleet 2 Chat 3 Files 4 Loops 5 Inspect 6 Runtime (bare digits when the prompt is not focused) |
| `Shift+←`, `Shift+→` | Previous / next loop of the selected agent, from anywhere (also `Ctrl+←/→`, except in a prompt with text) |
| `Alt+←`, `Alt+→`, `Alt+B`, `Alt+F` | In the prompt: word left / right (also `Ctrl+←/→` while there is text) |
| `/` | Slash command (focuses the prompt). Inside a list or viewer `/` filters or searches instead |
| `?` | Full help (when the prompt is not focused) |
| `Esc` | Close a dialog or the completion menu · leave the sidebar · in Chat, interrupt the running turn. It never leaves the prompt (`Tab` does), so typing never turns into view shortcuts |
| `Esc Esc` | In Chat, clear the prompt |
| `Ctrl+C` | Cancel a dialog · clear a non-empty prompt · press twice to quit |
| `Enter` | Send the prompt to the selected agent › loop (or run the `/command`) |
| `Shift+Enter`, `Alt+Enter`, `Ctrl+J`, trailing `\` | Newline in the prompt. Shift+Enter needs a terminal that tells it from Enter: see [Shift+Enter](#shiftenter) |
| `Ctrl+↑`, `Ctrl+↓` in the prompt | Prompt history (per agent › loop in Chat). `↑` / `↓` also walk it from the first / last line of text |
| `↑`, `↓` in the prompt | Chat with an empty prompt: scroll the transcript (`Home` / `End`: top / follow). Otherwise move in the text or the completion menu |
| Mouse wheel | Scroll what is under the pointer (transcript, lists, viewer, events, help, palette). A click focuses a pane. See [Mouse](#mouse) |
| `Tab` in the prompt | Accept a completion: `/commands`, their arguments, `@file` paths in Chat |

### Dialogs

`y` or `Enter` confirms, `n` or `Esc` cancels, `Ctrl+C` cancels. Destructive
actions (stop, interrupt, abort, delete, clear, overwrite) always ask first.
Forms (new or edited loop, timer, trigger) ask before `Esc` throws edits
away; in the new-loop wizard `Esc` goes back to the templates.

### Legend

| Glyph | Meaning |
|-------|---------|
| `●` | Running: a turn is in progress (an agent: in any of its loops) |
| `○` | Idle: loaded and waiting for work |
| `✗` | Disabled loop, or an agent in error / stopped |
| `↻` | A loop: `↻main` is the agent itself, the rest are inner (side) loops |
| `!n` | Approvals or questions waiting for you |
| `«n` | Unread inbox messages |
| `in 1h` | Next timer wake of that loop |

The same legend is in `?` / `/help`.

### Sidebar (fleet tree)

| Keys | Action |
|------|--------|
| `↑`, `↓`, `PgUp`, `PgDn`, `Home`, `End` | Move. Moving selects that agent › loop in every view |
| `→`, `←` | Expand an agent into its loops · collapse, or go back to the agent |
| `Space` | Expand or collapse the agent |
| `Enter` | Open the agent › loop in Chat |
| letters | Type to filter agents and loops (`Backspace` edits, `Esc` clears) |

### Fleet

| Keys | Action |
|------|--------|
| `↑`, `↓` (`j`, `k`) | Select an agent |
| `←`, `→` (`h`, `l`) | Select one of its loops |
| `Enter` | Open the agent › loop in Chat |
| `s` | Start the agent |
| `x` | Stop and unload the agent (asks; the `.adf` file is kept) |
| `a` | Interrupt the turns running now (asks): each loop goes idle and keeps working |
| `n` | New agent from a template (sets up your owner identity first if needed) |
| `o` | Load an `.adf` (Tab completes paths, `Ctrl+R` require review, `Ctrl+S` start after load) |
| `i` | Owner identity: status and actions (`I` hides the identity banner) |
| `c`, `r`, `u` | With no agents and no ready identity: create, restore, unlock the owner identity |
| `A` | Autostart: scan the tracked directories (asks) |
| `r` | Refresh |

### Chat

| Keys | Action |
|------|--------|
| `Enter` | Send to the selected loop (queued while it runs) |
| `Shift+←`, `Shift+→` (`Ctrl+←/→` on an empty prompt; `[`, `]`, `←`, `→` in the transcript) | Previous / next loop tab |
| `↑`, `↓` with an empty prompt | Scroll the transcript line by line (`Home`, `End`: top, follow live). Once the prompt has text they edit it |
| `Ctrl+↑`, `Ctrl+↓` | Prompt history of this agent › loop |
| `↑`, `↓` (`j`, `k`) in the transcript | Select a transcript item (`Tab` from the prompt) |
| `Enter`, `Space` | Expand or collapse the selected item (thinking, tool call, notice) |
| `PgUp`, `PgDn`, mouse wheel | Scroll (also while typing) |
| `Home` (`g`), `End` (`G`) | Top, loading older history · follow live |
| `t` | Expand or collapse all thinking |
| `c` | Copy the selected item, else the last reply |
| `y` | Approve the pending tool call: press twice, or once with that approval selected in the transcript · resume a suspended agent |
| `n` | Deny, with an optional reason · shut a suspended agent down (asks) |
| `v` | Full details of the tool call |
| `a` | Answer the agent's question (the prompt then sends the answer) |
| `Esc` | Interrupt this loop's running turn: it ends and the loop goes idle (it is not stopped) |
| `@` in the prompt | Complete an agent file path (Tab) |

### Files

| Keys | Action |
|------|--------|
| `↑`, `↓` | Move. The viewer previews the highlighted entry |
| `Enter`, `→` (`l`) | Open in the viewer · expand a folder |
| `←` (`h`) | Collapse the folder · go to the parent |
| `Space` | Toggle a folder |
| `/` | Filter by path (fuzzy) |
| `e` | Edit in `$EDITOR`, then confirm the write (diff shown) |
| `n` | New file |
| `m` | Rename or move (a folder moves with its files) |
| `d`, `Delete` | Delete (asks) |
| `p` | Protection: none → read_only → no_delete |
| `a` | Toggle authorized |
| `r` | Reload |
| `[`, `]` | Tabs: Files · Inbox · Outbox · Meta |
| Viewer: `↑`, `↓`, `PgUp`, `PgDn`, `g`, `G` | Scroll |
| Viewer: `/`, then `n`, `N` | Search, next / previous hit |
| Viewer: `Esc` (`←`, `h`) | Back to the list |
| Inbox, Outbox: `f` | Status filter |

### Loops

| Keys | Action |
|------|--------|
| `←`, `→` (`[`, `]`) | Tabs: Loops · Timers · Triggers · History |
| Loops: `↑`, `↓` | Select a loop (also selects it for Chat) |
| Loops: `Enter` | Chat with the loop |
| Loops: `n` | New inner loop: memory consolidator, researcher, critic, reflector or blank |
| Loops: `e` | Edit goal, tools, model, flags (diff and confirm) |
| Loops: `x` | Enable or disable |
| Loops: `s` | Send a one-off message |
| Loops: `t` | Schedule: a timer that wakes this loop |
| Loops: `c` | Clear its history (asks) |
| Loops: `d`, `Delete` | Delete (asks; its history is archived to the audit log) |
| Loops: `h` | Its history |
| Timers: `n`, `Enter`/`e`, `d` | New, edit (including moving it to another loop), delete (asks) |
| Timers: `f` | This agent / all agents |
| Triggers: `x`, `Space` | Enable or disable (diff and confirm) |
| Triggers: `Enter`, `e` | Edit targets and the loop each target wakes |
| History: `/`, `f`, `<` `>`, `l` `L` | Filter text or tool, role filter, older / newer page, next / previous loop |
| Forms: `↑`, `↓` · `←`, `→` · `Ctrl+O` · `Ctrl+S` · `Esc` | Field · change a choice · goal in `$EDITOR` · review, then `y` applies · cancel |

### Inspect (the selected agent)

| Keys | Action |
|------|--------|
| `←`, `→` (`[`, `]`) | Tabs |
| Config: `e` | Edit in `$EDITOR` (validated, changed keys confirmed) |
| Logs: `f` · Tables: `Enter`, `n`, `p` | Follow · row detail, next / previous page |
| Events | As in Runtime › Events, locked to this agent (`l` still narrows to the selected loop) |
| `r` | Reload |

### Runtime (the daemon)

| Keys | Action |
|------|--------|
| `←`, `→` (`[`, `]`) | Tabs |
| `r` | Reload the page |
| Identity: `Enter` · `c`, `r`, `u` | Identity dialog · create, restore, unlock (when offered) |
| Sign-in: `Enter` | The sign-in dialog |
| Network: `m`, `s`, `R` | Mesh on/off, mesh server start/stop, restart the server (each asks) |
| Events: `↑`, `↓`, wheel · `End` (`G`) | Scroll (stops following) · follow the newest again |
| Events: `t`, `a`, `l`, `/` | Filter by type (e.g. `tool. -turn.delta`), agent, loop, text |
| Events: `Space`, `f`, `Enter`, `c`, `x` | Pause, follow, full event, clear, reset filters |

The event tail keeps the newest 5000 events. It redraws at most ten times a
second while a busy stream pours in, and the selection stays on its event
while older ones drop off.

## Slash commands

Type `/` and the prompt lists matching commands. `Tab` completes names and
arguments (agents, loops, files, paths). Unknown commands are reported, never
sent to an agent.

| Command | Description |
|---------|-------------|
| `/help` (`/?`) | Keys, commands and what loops are |
| `/quit` (`/exit`, `/q`) | Leave the TUI (agents keep running) |
| `/view <fleet\|chat\|files\|loops\|inspect\|runtime>` | Switch the main pane |
| `/agent <handle\|id> [loop]` (`/a`) | Select an agent, and optionally one of its loops |
| `/refresh` (`/r`) | Re-read agents, loops and approvals |
| `/theme [name\|next]` | Colour theme (no argument opens the picker) |
| `/url [daemon-url] [--token <token>]` | Show the daemon URL, or switch to another daemon live (it is health-checked first). The current token is only sent to the same origin; give another daemon's with `--token` or `ADF_DAEMON_TOKEN` |
| `/runtime [tab]` | Open the Runtime view (on a tab: `status`, `identity`, `auth`, `providers`, `usage`, `network`, `compute`, `mcp`, `adapters`, `settings`, `events`) |
| `/status`, `/usage`, `/providers`, `/network`, `/compute`, `/settings` | Open that Runtime tab (`r` refresh; secrets redacted) |
| `/auth` | Provider sign-in dialog: ChatGPT and Grok status, sign in, sign out |
| `/login [chatgpt\|grok]`, `/logout <chatgpt\|grok>` | Sign the daemon in (browser / device code) or out (asks) |
| `/json [on\|off]` | Raw JSON in Inspect and Runtime pages |
| `/sidebar [on\|off]` | Show or hide the fleet sidebar (`Ctrl+B`; remembered) |
| `/mouse [on\|off]` | Mouse capture (off: the terminal selects text as usual; remembered) |
| `/terminal-setup` (`/terminal`) | Whether this terminal sends Shift+Enter, and the keybinding that makes it |
| `/agents [interrupt\|abort <agent> [loop] \| refresh]` | Fleet overview; interrupt an agent's running turns (`abort` is the hard stop: that loop stays stopped until the agent is reloaded) |
| `/new [name]` | New agent: name, template, optional provider and model, start now. Opens its chat |
| `/identity [create\|restore\|unlock\|lock]` | Owner identity status and actions |
| `/start [agent]`, `/stop [agent]` (`/unload`) | Start; stop and unload (asks) |
| `/load [path.adf] [--review] [--start]` | Load an `.adf` (no path opens the dialog) |
| `/switch <agent>[/loop]` (`/sw`) | Jump to an agent or one of its loops (fuzzy) and open Chat |
| `/autostart [dir…]` | Scan tracked directories and start reviewed autostart agents (asks) |
| `/interrupt` (`/abort`) | Interrupt the selected loop's running turn; the loop goes idle and keeps working |
| `/clear` | Clear the selected loop's history (asks) |
| `/compact` | Summarize the selected loop's history now to free context (not mid-turn) |
| `/trigger <type> [json]` | Fire an ADF event into the selected loop |
| `/copy [n]` | Copy the last (or n-th last) reply of the selected loop |
| `/thinking` | Expand or collapse thinking blocks |
| `/files`, `/doc`, `/mind` | Browse files; show the document; show the mind |
| `/open <path>`, `/edit <path>` | Open in the viewer; edit in `$EDITOR` (fuzzy path; `document`, `mind` work too) |
| `/new-file [path]`, `/rm <path>`, `/mv <from> <to>` | Create (opens `$EDITOR`), delete (asks), rename or move a file |
| `/loop <name>` | Select one of the agent's loops |
| `/loop new [template]`, `/loop new <name> <goal…>` | Create an inner loop from a template (wizard) or directly |
| `/loop edit\|rm\|on\|off <name>` | Edit, delete (asks), enable, disable |
| `/loop send <name> <msg…>`, `/loop chat <name>`, `/loop schedule <name>` | Message a loop, open its chat, add a timer for it |
| `/main` | Back to the main loop |
| `/loops`, `/timers [all]`, `/triggers`, `/history [loop]` | Open the Loops view on that tab |
| `/timer add [--loop <name>] \| edit <id> \| rm <id>` | Create, edit or delete a timer (a timer with a loop runs that loop on a schedule) |
| `/events [types…] [--agent] [--loop] [--all]` | Every agent's live umbilical events (Runtime › Events), e.g. `/events tool. -turn.delta --loop` |
| `/inspect [tab]` | Inspect the selected agent on a tab (`status`, `config`, `usage`, `mcp`, `adapters`, `identity`, `logs`, `tables`, `events`) |

## Command palette

`Ctrl+K` (or `Ctrl+P`, or `:` outside the prompt) opens a fuzzy search over
views, agents, every loop of every agent (`agent-1 ↻ consolidator`), every
slash command and palette action, and recent files. Enter runs the entry; a
command that needs an argument fills the prompt instead. With an empty query,
recently run entries come first.

## Terminal

### Shift+Enter

`Enter` sends. A newline is `Shift+Enter` where the terminal can tell it from
`Enter`, and `Alt+Enter`, `Ctrl+J` or a trailing `\` everywhere. Most
terminals send the same `\r` for both, unless the program turns on the
[kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
The TUI asks the terminal at start (`CSI ? u`) and, when it answers, turns on
its "disambiguate" level; the terminal then sends Shift+Enter as `CSI 13;2 u`.
The mode is switched off again on quit, on a crash and while an editor has the
terminal. The prompt hint says `Shift+Enter newline` once it works, else
`Alt+Enter newline`, and `/terminal-setup` shows the state and the fix for the
terminal you are in.

| Terminal | Shift+Enter |
|----------|-------------|
| kitty, WezTerm, Ghostty, foot, iTerm2 3.5+, recent Alacritty | Works (kitty keyboard protocol) |
| Windows Terminal 1.25+ | Works (kitty keyboard protocol) |
| Windows Terminal before 1.25 | Add to `settings.json` → `"actions"`: `{ "command": { "action": "sendInput", "input": "\u001b[13;2u" }, "keys": "shift+enter" }` |
| VS Code / Cursor terminal | Add to `keybindings.json`: `{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\u001b[13;2u" }, "when": "terminalFocus" }` |
| macOS Terminal | Not available: `Option+Enter` (with "Use Option as Meta key") or `Ctrl+J` |
| tmux (inside any of these) | `set -s extended-keys on` and `set -as terminal-features 'xterm*:extkeys'` in `~/.tmux.conf` |

The keybindings send `CSI 13;2 u` themselves, which the TUI reads as
Shift+Enter whether the protocol is on or not. With the protocol on, the other
keys (`Esc`, `Ctrl+C`, `Ctrl+K`, `Shift+Tab`, `Alt+digit`, arrows, paste) work
as before. `--no-kitty` or `ADF_TUI_KITTY=0` never turns it on.

### Mouse

In the alternate screen (the default) the TUI turns on mouse reporting (button
and wheel events only, never pointer motion): the wheel scrolls the transcript,
list, viewer, event tail, help or palette under the pointer, and a click
focuses the sidebar, main pane or prompt. Capture is off whenever the TUI
does not own the terminal (quit, crash, `$EDITOR`).

While capture is on, the terminal's own selection needs **Shift+drag** (Windows
Terminal, VS Code, iTerm2 with Option, most Linux terminals). `/mouse off` (or
`--no-mouse`, `ADF_TUI_MOUSE=0`) hands the mouse back to the terminal; the
choice is remembered.

## Owner identity and new agents

Your **owner identity** proves the agents are yours. It is a 12-word seed
phrase: the same words restore it anywhere, in the terminal or in ADF Studio.
New agents are sealed under it, so the TUI sets it up before the first
`/new`.

On first run (no agents, no identity) the Fleet view explains this and offers
the next step:

- **No identity:** `c` creates one, `r` restores yours from its 12 words.
- **This machine already has an owner** (for example from Studio) but the
  daemon lacks its phrase: `r` restores it; the dialog names the owner DID the
  phrase must match.
- **Locked** (no OS keychain, so the identity sits in a passphrase-protected
  file): `u` unlocks it.

With agents loaded, a one-line banner says the same (`i` opens it, `I` hides
it). The header shows the owner: `owner z6Mk…2doK`, or `no owner`,
`owner locked`, `owner: restore`, and `not backed up` until you confirm the
words are written down.

Creating shows the 12 words once, numbered. Type `saved` and Enter once they
are written down (the daemon records the backup, as Studio's "I have written
it down" does). The words stay in that dialog only: never in a toast, the
transcript, a log or the clipboard, and the screen and scrollback are cleared
when it closes. Restoring accepts a pasted phrase (numbering, line breaks and
case are ignored) and shows the word count while you type, masked. When the
machine has no OS keychain, a new identity file takes a passphrase of 8+
characters, typed twice.

Create, restore and unlock only work when the TUI talks to a daemon on the
same machine (loopback); against a remote daemon the dialog says to run it
there.

`n` on the Fleet view (or `/new [name]`) opens the new-agent wizard: name
(empty = generated), template (the default preselected; a template's warning
is shown), optional provider and model overrides, and start now (default
yes). The agent is created in the daemon's agents folder, sealed and
reviewed, then selected with its chat open.

## Provider sign-in

Agents on a ChatGPT or Grok subscription need the daemon to be signed in.
`/auth` lists both with their status (account, token renewal); `Enter` signs
in, `o` signs out (asks). `/login chatgpt`, `/login grok` and `/logout
<provider>` go straight there. The daemon keeps its own sign-in, separate
from ADF Studio's; agents need no changes.

- **ChatGPT** opens your browser. The dialog also shows the URL (`c` copies
  it) in case the browser does not open, and waits until you finish there.
  When the daemon runs on another machine, the TUI receives the browser's
  callback itself and hands it to the daemon.
- **Grok** shows a device code in large type with its URL; approve it in any
  browser.

`Esc` cancels while waiting; success or failure is shown in the dialog. When
an agent's provider is not signed in, its Fleet row says `signed out`, its
details and its Chat say `ChatGPT not signed in — /login chatgpt`.

## Approvals and questions

A pending tool approval shows as a card under the transcript of the loop that
asked, and as `!n` in the header, sidebar and fleet table. `y` approves, `n`
denies with an optional reason, `v` shows the full call. A question from the
agent shows the same way; while one is pending, what you type in the prompt is
sent as the answer, to the loop that asked. A suspended agent offers `y` to
resume and `n` to shut down (asks first).

## Themes

`adf` (dark, the default), `adf-light` for light terminal backgrounds,
`adf-contrast`, and `adf-mono` (no colour). Pick one with `--theme`,
`ADF_TUI_THEME` or `/theme` (for the session). `NO_COLOR` always wins.

## Mock mode

`npm run tui:mock` runs the TUI against an in-memory mock daemon, with no real
daemon or LLM provider needed. It has two agents (`agent-1` with the loops
`main`, `consolidator` and `researcher`, and `agent-2`), a pending approval,
files, timers, triggers and scripted streaming replies, and the consolidator
wakes on a fake timer every 20 seconds. Every view works end to end. The mock
lives in `tests/tui/fixtures/` (`run-tui-mock.ts`, `mock-daemon.ts` and one
fetch layer per view).

The mock owner identity is ready by default. Try first run with
`ADF_MOCK_IDENTITY=none ADF_MOCK_FLEET=empty npm run tui:mock`
(`ADF_MOCK_IDENTITY` also takes `locked` and `restore-needed`;
`ADF_MOCK_STORAGE=file` uses a passphrase file, passphrase `correct horse`).
In the mock, `agent-2` runs on a ChatGPT subscription that is not signed in;
`/login` finishes by itself after a few seconds and never opens a browser.

## Windows

Windows Terminal with PowerShell or Git Bash is the primary target. Two
things differ there:

- The TUI leaves the bottom terminal row unused. Windows consoles scroll when
  the bottom-right cell is written, so a frame that fills the screen forces a
  full clear on every update. Set `ADF_TUI_FULL_HEIGHT=1` to use the row
  anyway.
- On every platform the rightmost column stays unused. The TUI redraws only
  the lines that changed, and clearing to the end of a full-width line would
  erase its last character.

Other notes:

- Use `--ascii` on legacy consoles without box-drawing or braille glyphs.
- Newlines in the prompt: `Shift+Enter` on Windows Terminal 1.25+ (older: the
  `sendInput` action in [Shift+Enter](#shiftenter)), `Alt+Enter`, `Ctrl+J` or
  a trailing `\`.
- Select text with `Shift+drag` while mouse capture is on (`/mouse off` turns
  it off).
- The external editor defaults to `notepad`.

## Known gaps

- **Seed phrase backup:** the daemon shows the 12 words once, at creation.
  It cannot reveal them again; ADF Studio on the same machine (keychain
  storage) can, under Settings → Back up seed phrase.
- **No per-agent autostart toggle:** `A` and `/autostart` only run the
  daemon's scan of the tracked directories.
- **Folder delete:** delete the files one by one.
- **Binary files** can be viewed (hex) but not edited.
- **Timer start/end times** are not in the timer form (max runs is).
- **Trigger state:** the Triggers tab shows on/off and target count. The
  daemon reports no last-fired time.
- **Loop "last activity"** costs one small request per loop, because the
  daemon has no such field.
- **Theme choice** from `/theme` lasts for the session only; persist it with
  `--theme` or `ADF_TUI_THEME`.
- **Older daemons:** against a daemon from before loop-aware asks and timers,
  the TUI falls back gracefully:
  - An ask is filed under the loop whose transcript shows it.
  - Moving a timer to another loop re-creates it with a new id.
  - `/compact` reports the missing endpoint.
