# Terminal app

The ADF terminal app (`adf` with no command) is an interactive terminal client for the [daemon](index.md). It
shows your whole fleet at once: every loaded agent, each agent's loops, their
live state, pending approvals and questions, and the umbilical event stream.
From it you set up your owner identity, create agents, chat with any loop of
any agent, approve tool calls, read and edit the agent document, mind and
files, create, schedule and manage loops, and look under the hood of one
agent (Inspect) or of the daemon itself (Runtime).

It is a client like the [CLI](cli.md): it talks to the daemon's
[HTTP API](http-api.md) and `/events` stream. Quitting the app leaves every
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

The app treats loops as first class everywhere:

- The sidebar tree lists every agent with its loops, each with a running,
  idle or off marker and its next scheduled run (`in 1h`).
- Chat is per loop. Loop tabs sit above the transcript, and **Shift+← / Shift+→**
  switches loops from any view (also `Ctrl+←/→`, except in a prompt with text,
  where Ctrl+arrows jump words; stock macOS keeps `Ctrl+←/→` for Spaces). Each
  loop keeps its own transcript, scroll position, prompt draft and prompt
  history.
- The Loops view creates, edits, enables, disables, schedules and deletes
  inner loops. It also shows every timer and trigger with the loop it wakes.
- Approvals, questions, notices and wakes (for example "Woken by timer (every
  1h) · run 3") are filed under the loop they belong to.

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
adf                      # the npm package: opens the app
npm run adf              # from a source checkout: same
npm run adf -- tui       # same
npm run tui              # same
npm run adf -- --view loops --agent agent-1 --loop consolidator
```

When no daemon answers at a local daemon URL, `adf` starts one in the
background first (`Starting the ADF daemon…`) and then opens the app.
Quitting the app leaves it running (`adf daemon stop` stops it); see
[Background daemon](cli.md#background-daemon). `--no-daemon` or
`ADF_NO_AUTOSTART=1` skip that: the app then shows the daemon as offline
and how to start it.

The daemon requires its access token on every request. For a daemon on this
machine (a loopback URL) the app reads `<settings dir>/daemon-token` by
itself, and re-reads it once when the daemon answers `401` (a daemon that
just started for the first time); the local token is never sent to another
host. For a remote daemon pass `--token` or set `ADF_DAEMON_TOKEN` (print the
token on the daemon host with `adf daemon token`). See
[Authentication](http-api.md#authentication-and-cross-site-protection).

| Option | Description |
|--------|-------------|
| `--url`, `-u <url>` | Daemon URL (default `ADF_DAEMON_URL`, then `http://127.0.0.1:7385`) |
| `--token <token>` | Daemon access token (default `ADF_DAEMON_TOKEN`; on the daemon's machine the app reads it by itself) |
| `--view <id>` | Start view: `fleet` \| `chat` \| `files` \| `loops` \| `inspect` \| `runtime` |
| `--agent <id\|handle>` | Preselect an agent |
| `--loop <name>` | Preselect one of its loops (default `main`) |
| `--theme <name>` | `adf` (dark, default), `adf-light`, `adf-contrast`, `adf-mono` |
| `--mono`, `--no-color` | No color |
| `--ascii` | ASCII glyphs for consoles without box-drawing or braille characters |
| `--no-alt-screen` | Render in the main screen buffer instead of the alternate screen (mouse mode stays off there) |
| `--mouse` | Mouse mode, the default: a click expands, drag selects and copies, right-click pastes, the wheel scrolls what is under the pointer (see [Mouse](#mouse)) |
| `--no-mouse` | The terminal's own mouse (its selection; the wheel scrolls the focused pane) |
| `--no-kitty` | Never turn on the kitty keyboard protocol (see [Shift+Enter](#shiftenter)) |
| `-h`, `--help` | Show the help |

| Environment | Effect |
|-------------|--------|
| `ADF_DAEMON_URL`, `ADF_DAEMON_TOKEN` | Daemon address and token, as for the CLI |
| `ADF_DAEMON_SETTINGS`, `ADF_USER_DATA_DIR` | Where the local daemon's token file (`daemon-token`) is found, as for the daemon |
| `NO_COLOR` (any value), `TERM=dumb` | No color. Emphasis uses bold, inverse and underline. Always wins over `--theme` |
| `ADF_TUI_THEME` | Same as `--theme` |
| `ADF_TUI_ASCII=1` | Same as `--ascii` |
| `ADF_EDITOR`, `VISUAL`, `EDITOR` | External editor, in that order. Default: `notepad` on Windows, else `nano`, then `vi` |
| `ADF_TUI_FULL_HEIGHT=1` | Windows: use the bottom terminal row too (see [Windows](#windows)) |
| `ADF_TUI_MOUSE=0` / `=1` | The terminal's own mouse / mouse mode, over the saved `/mouse` choice |
| `ADF_TUI_CLIPBOARD=osc52` | Copy only through the terminal (OSC 52), not pbcopy / clip / wl-copy / xclip (WSL, containers, nested sessions; over SSH OSC 52 is used anyway) |
| `ADF_TUI_KITTY=0` | Same as `--no-kitty` |
| `ADF_TUI_SHIFT_ENTER=1` | Show `Shift+Enter` in the hints from the start (your terminal sends it through a keybinding) |
| `ADF_TUI_PREFS=<path>` | Where the sidebar, stopped-agents filter and mouse choices and the welcome count are kept (default `<config dir>/adf-studio/tui-prefs.json`; `off` keeps them for the session only) |

The app needs a terminal. When stdin or stdout is not a TTY (a pipe, a CI
log), it prints a hint to use the one-shot CLI commands and exits with code 1.
Every other `npm run adf -- <command>` is the unchanged one-shot [CLI](cli.md).

## Layout

```text
 ◆ ADF   1 Fleet   2 Chat   3 Files   4 Loops   5 Inspect   6 Runtime  ● web :7295  !1 pending  ● live  127.0.0.1:7385
 FLEET                   2 │ agent-1 ›  ● main !  ○ consolidator  ○ researcher             Shift+←/→
 ▾ ⠹ agent-1 thinki… !1 «1 │ host ✓ · Merging API notes into mind.md · web 127.0.0.1:7295/agents/agent-1/
   ⠹ ↻main        thinking │
   ○ ↻consolidator   in 1h │  › What did we decide about the standings API?
   ○ ↻researcher           │  ● We keep v2 and add a since cursor.
   ● agent-2 idle          │  ✓ fs_read {"path":"notes/api.md"}
   ○ ↻main                 │  │ ↻ from loop consolidator · inter-loop message
                           │  › hello from the terminal
                           │  ● Noted: "hello from the T
                           │ ╭───────────────────────────────────────────────────────────────────────╮
                           │ │ ! agent-1 wants to run msg_send                                       │
                           │ │ {"to":"agent-2","content":"hello"}                                    │
                           │ │ Shift+Tab: y approve · a always · n reject · f feedback · v details   │
                           │ ╰───────────────────────────────────────────────────────────────────────╯
                           │ ⠹ thinking… 0s · mock-model · esc to interrupt
                           │╭─────────────────────────────────────────────────────────────────────────╮
                           ││ › Message agent-1 · queued until the turn ends · Esc interrupts          │
                           │╰─────────────────────────────────────────────────────────────────────────╯
 agent-1 › ↻ main  ⠹ thinking  mock-model   Shift+←/→ loop · Alt+1-6 views · Ctrl+↑/↓ history · Tab focus · Ctrl+K palette
```

- **Header:** the ADF wordmark, the views with their hotkeys (the tab bar:
  `Esc` focuses it, see [Tab bar](#tab-bar)), the web server (`● web :7295`
  running, `○ web off` stopped; see [Agent websites](#agent-websites)),
  pending approvals and questions across the fleet, the live connection
  (`live`, or `offline` when the daemon does not answer) and the daemon URL.
  On narrow terminals the URL shrinks to its port and goes, then a plain owner
  badge, then the web badge, before the view names shorten
  (`1 Flt 2 Chat 3 File 4 Loop 5 Insp 6 Rt`).
- **Chat info line** (under the loop tabs): a sign-in warning, a disabled
  loop, `host ✓` when the agent has host access, the agent's own status line
  (its `adf_meta` `status`, live), an inner loop's goal, its schedule (`wakes
  every 1h · next 14:30`), the agent's website and `autonomous`. When the pane
  is narrow the least important pieces drop off and the status line is cut.
- **Daemon offline:** when nothing answers at the daemon URL, the Fleet view
  says so, with the URL it tried, how to start the daemon (`npm run daemon`),
  `ADF_DAEMON_URL` / `--url` / `/url`, and the retry countdown.
- **Sidebar (every view):** the fleet tree. Agents carry a state glyph, `!n`
  for pending approvals or questions and `«n` for unread inbox messages. Each
  agent expands into its loops. Below the running agents, each tracked folder
  lists its agents that are not running, dimmed (see
  [Stopped agents](#stopped-agents)). It collapses below 70 columns. **`Ctrl+B`**
  (or `/sidebar`, or the palette) hides it at any width for a full-width
  chat; the choice is remembered across launches. With it hidden, `Tab`
  skips it, the status bar still names the agent › loop, and the header adds
  the unread inbox count (`«2 unread`) next to the pending approvals.
- **Main pane:** the active view.
- **Prompt:** send a message to the selected agent › loop, or run a `/command`.
- **Toasts** above the status bar report the outcome of every action.
- **Status bar:** the selected agent › loop, its state, model and token tally,
  then a few keys: the active view's main ones (at most five), `Tab` focus and
  `Ctrl+K` palette. Everything else is in `/help` (`?`). In Chat's prompt:
  loop, views (`Alt+1-6`; on macOS, where Option does not send Alt by
  default, `Esc` then a digit), prompt history, `Tab`, `Ctrl+K`.

Nothing happens silently. Every assistant message, thinking block, tool call,
approval, question, wake and notice is shown. Every action the app takes
(reconnect, resync, refetch, a daemon call) is reported in a toast or in the
transcript of the loop it concerns.

## Views

| Key | View | What it shows |
|-----|------|---------------|
| `1` | **Fleet** | A daemon line (pid, uptime, providers, mesh, WebSocket, compute), an agent table (state, loops running/total, approvals, inbox, model, tokens, timers, last activity, mesh, web) and the selected agent's status line, website and loops with their schedule and goal. Start, stop, interrupt, open the website, load `.adf` files, autostart. |
| `2` | **Chat** | One conversation per agent › loop. Loop tabs, a virtualized transcript (history pages load as you scroll up; live events stream in), collapsible thinking and tool calls, inter-loop messages, wake markers, and an approval/question card. A turn footer shows elapsed time, tokens and the model. |
| `3` | **Files** | The agent document, mind and files as a tree with a viewer (syntax colouring, search, hex for binaries). Edit in your `$EDITOR` with a diff confirm and a concurrent-change check. Create, move, delete, protection, authorized. Read-only Inbox, Outbox and Meta tabs. A badge names the loop that last wrote a file. |
| `4` | **Loops** | Tabs: **Loops** (every loop with status, messages, tools, model, flags, what wakes it; create from templates, edit, enable/disable, send, schedule, clear, delete), **Timers** (this agent's or every agent's timers, with the loop each one wakes), **Triggers** (all trigger types, the loop each target wakes, enable/disable, edit targets), **History** (a loop's persisted entries with tokens, filters and paging). |
| `5` | **Inspect** | The selected agent only (the tab bar reads `agent-1 › …`). Tabs: **Status** (the website first when the agent serves one, then state, loops, triggers, WebSocket), **Settings** (instructions, tools, compaction, autonomous, autostart, messaging and mesh visibility, host access: switches flip in place, risky ones ask; see [Agent settings](#agent-settings)), **Config** (tree or JSON; edit in `$EDITOR` with schema validation and a confirm), **Usage** (by model), **MCP**, **Channels** (Telegram, Discord, Slack, email, WhatsApp: configured and live; `/channels` adds and removes), **Identities** (metadata only), **Logs**, **Tables**, **Events** (this agent's live umbilical events). Secrets are redacted everywhere. |
| `6` | **Runtime** | The daemon, across every agent (`daemon › …`). Tabs: **Status** (health, version, uptime, pid, every agent's loops), **Identity** (owner identity; `Enter` opens its dialog), **Sign-in** (ChatGPT / Grok and API-key providers; `Enter` signs in), **Providers** (and which agents use them), **Usage** (all agents, by model), **Network** (mesh, the web server, agent websites, LAN, WebSocket; `m` mesh on/off (asks), `s` web server start / stop (stopping asks), `R` restart (asks)), **Compute** (container runtime and containers), **MCP** and **Channels** (available to agents), **Settings** (redacted), **Events** (every agent's live umbilical events). |

## Keys

The same list is in the app: press `?` or type `/help`. `Ctrl+K` searches all
of it.

### Everywhere

| Keys | Action |
|------|--------|
| `Ctrl+K`, `Ctrl+P` | Command palette (also `:` when the prompt is not focused) |
| `Tab`, `Shift+Tab` | Cycle focus: sidebar → main → prompt (a hidden sidebar is skipped). Entering Chat focuses the prompt. From the tab bar, `Tab` goes to the first pane |
| `Ctrl+B` | Hide / show the fleet sidebar: full-width view (also `/sidebar`; remembered) |
| `1`–`6`, `Alt+1`–`Alt+6` | Switch view: 1 Fleet 2 Chat 3 Files 4 Loops 5 Inspect 6 Runtime (bare digits when the prompt is not focused) |
| `Shift+←`, `Shift+→` | Previous / next loop of the selected agent, from anywhere (also `Ctrl+←/→`, except in a prompt with text) |
| `Alt+←`, `Alt+→`, `Alt+B`, `Alt+F` | In the prompt: word left / right (also `Ctrl+←/→` while there is text) |
| `Home`, `End`, `Ctrl+A`, `Ctrl+E`, `Cmd+←`, `Cmd+→` | In the prompt: start / end of the line |
| `Ctrl+Backspace`, `Alt+Backspace` (`Option+Backspace`), `Ctrl+W` | In the prompt: delete the word before the caret |
| `Ctrl+Delete`, `Alt+D` | In the prompt: delete the word after the caret |
| `Cmd+Backspace`, `Ctrl+U` | In the prompt: delete to the start of the line (the whole line with the caret at its end; at a line start it joins the previous line). Terminal.app sends nothing for `Cmd+Backspace`: use `Ctrl+U` there |
| `/` | Slash command (focuses the prompt). Inside a list or viewer `/` filters or searches instead |
| `?` | Full help (when the prompt is not focused) |
| `Esc` | In this order, the first that applies: close a dialog or the completion menu · end a view's own mode (a filter, search, the file viewer, a table row, a selected chat item) · in Chat, interrupt the running turn · then focus the [tab bar](#tab-bar) (from the sidebar, the main pane, or an empty prompt) |
| `Esc Esc` | Clear a prompt that has text (a third `Esc` then goes to the tab bar) |
| `Ctrl+C` | Cancel a dialog · clear a non-empty prompt · press twice to quit |
| `Enter` | Send the prompt to the selected agent › loop (or run the `/command`) |
| `Shift+Enter`, `Alt+Enter`, `Ctrl+J`, trailing `\` | Newline in the prompt. Shift+Enter needs a terminal that tells it from Enter: see [Shift+Enter](#shiftenter) |
| `Ctrl+↑`, `Ctrl+↓` in the prompt | Prompt history (per agent › loop in Chat). `↑` / `↓` also walk it from the first / last line of text |
| `↑`, `↓` in the prompt | Chat with an empty prompt: select the previous / next transcript item (`Enter` expands it, `Home` / `End`: top / follow). Otherwise move in the text or the completion menu |
| Mouse | Mouse mode (default): the wheel scrolls what is under the pointer, a click selects (and expands a tool call or thinking), drag selects and copies, double-click a word, triple-click a line, right-click pastes. `Shift+drag` (`Option+drag` in iTerm2, `Fn+drag` in Terminal.app) is the terminal's own selection; `/mouse off` hands the mouse back. See [Mouse](#mouse) |
| `Tab` in the prompt | Accept a completion: `/commands`, their arguments, `@file` paths in Chat |

### Tab bar

`Esc` moves focus up to the view tabs in the header once nothing else takes
it: dialogs, menus and a view's own modes (a filter, the file viewer, a
running chat turn) come first. In a prompt with text, `Esc` twice clears it
and the next `Esc` goes up. The tab under the cursor turns teal and
underlined, and the status bar shows the tab keys.

| Keys | Action |
|------|--------|
| `←`, `→` (`h`, `l`) | Previous / next view; the view switches as the cursor moves, like any tab strip (`Home`, `End`: first, last) |
| `Enter`, `↓` | Into the view (Chat: its prompt) |
| `1`–`6` | Jump straight into a view |
| `Tab`, `Shift+Tab` | Back into the panes (first / last) |
| `w` | Web server on / off (stopping asks) |
| `?`, `:`, `/`, `Ctrl+K` | As everywhere |

In mouse mode a click on a tab switches views and a click on the web badge
turns the server on or off.

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
| `Enter` | Open the agent › loop in Chat. On a stopped agent: start it (review first when it needs it) |
| letters | Type to filter agents and loops (`Backspace` edits, `Esc` clears) |

### Fleet

| Keys | Action |
|------|--------|
| `↑`, `↓` (`j`, `k`) | Select an agent |
| `←`, `→` (`h`, `l`) | Select one of its loops |
| `Enter` | Open the agent › loop in Chat |
| `s` | Start the agent. A stopped one is loaded into the daemon, then started (`Enter` too); one that needs review opens its review |
| `x` | Stop and unload the agent (asks; the `.adf` file is kept) |
| `H` | Hide / show stopped agents (also `/agents running\|all`; remembered) |
| `a` | Interrupt the turns running now (asks): each loop goes idle and keeps working |
| `w`, `W` | Open the agent's website in the browser (starts the web server first if it is stopped) · copy its URL |
| `n` | New agent from a template (sets up your owner identity first if needed) |
| `o` | Load an `.adf` (Tab completes paths, `Ctrl+R` require review, `Ctrl+S` start after load) |
| `i` | Owner identity: status and actions (`I` hides the identity banner) |
| `c`, `r`, `u` | With no agents and no ready identity: create, restore, unlock the owner identity |
| `A` | Autostart: scan the tracked directories (asks) |
| `f` | Track a folder of agents (see [Tracked folders](#tracked-folders)) |
| `r` | Refresh |

### Chat

| Keys | Action |
|------|--------|
| `Enter` | Send to the selected loop (queued while it runs) |
| `Shift+←`, `Shift+→` (`Ctrl+←/→` on an empty prompt; `[`, `]`, `←`, `→` in the transcript) | Previous / next loop tab |
| `↑`, `↓` with an empty prompt, or (`j`, `k`) in the transcript | Select the previous / next item: your message, a reply, thinking, a tool call, a notice, an approval, a question, an inter-loop message, a wake marker. The selected item gets a bar down its left edge (`▌`, `>` in ASCII) and stays in view; one taller than the view scrolls inside itself first, then the selection moves on. `↓` past the newest item follows live again. Once the prompt has text a single `↑`/`↓` edits it |
| `Enter`, `Space` | Expand or collapse the selected item (tool call input and result, thinking, context, approval, wake) |
| `Esc` | Let go of the selected item (before interrupting) |
| `Ctrl+↑`, `Ctrl+↓` | Prompt history of this agent › loop |
| `PgUp`, `PgDn`, mouse wheel | Scroll by lines (also while typing); a wheel burst never moves the selection |
| `Home` (`g`), `End` (`G`) | Top, loading older history · follow live |
| `t` | Expand or collapse all thinking |
| `c` | Copy the selected item, else the last reply |
| `w` | Open the agent's website (when it serves one) |
| `y` | Approve the pending tool call: press twice, or once with that approval selected in the transcript (or click `approve` on the card) · resume a suspended agent |
| `a` | Always approve that tool for this agent: press twice (or once on a selected approval), then confirm; it won't ask again (undo in Inspect › Config). Not offered for protection overrides or other one-time approvals (greyed `always: one-time only`; the daemon refuses them too) · on a question card: answer it (the prompt then sends the answer) |
| `n` | Reject the call · shut a suspended agent down (asks) |
| `f` | Reject with feedback: a text box; the agent sees your text |
| `v` | Full details of the tool call |
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
| Status: `w`, `W` | Open the agent's website · copy its URL |
| Settings: `Enter`, `Space` | Open the dialog or flip the switch (Autonomous, Host access and LAN/public visibility ask) |
| Settings: `e` · `l` | Instructions in `$EDITOR` · lock the section for the agent (`locked_fields`) |
| Config: `e` | Edit in `$EDITOR` (validated, changed keys confirmed; also `/config edit`) |
| MCP: `a` · `m`, `Enter` | Add a server · manage them (restart, credentials, tools, logs, remove) |
| Channels: `a`, `m`, `Enter` | Channels: add, remove |
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
| Network: `m`, `s`, `R` | Mesh on/off (asks), web server start / stop (stopping asks), restart it (asks) |
| Folders: `Enter` · `a`, `d` | A folder's agents and what each needs (review, load) · track, untrack (asks) |
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
| `/welcome` | What ADF is, and the getting-started checklist (see [Welcome](#welcome)) |
| `/channels [add [telegram\|discord\|slack\|email\|whatsapp] \| remove <channel>]` | The selected agent's channels: state, add one (credentials sealed in the agent), remove one (asks). See [Channels](#channels) |
| `/mcp [add [name \| npm:pkg \| python:pkg \| url] \| restart <name> \| logs <name> \| remove <name>]` | The selected agent's MCP servers: state, add (catalog, npm, Python, remote URL), restart, credentials, tools on/off, logs, remove (asks). See [MCP servers](#mcp-servers) |
| `/provider [add [preset] \| list \| remove <id>]` | Connect a model provider with an API key (kept in the daemon's secret store), list them (Runtime › Providers), remove one (asks). Subscriptions: `/login`. See [Model providers](#model-providers) |
| `/quit` (`/exit`, `/q`) | Leave the app (agents keep running) |
| `/view <fleet\|chat\|files\|loops\|inspect\|runtime>` | Switch the main pane |
| `/agent <handle\|id> [loop]` (`/a`) | Select an agent, and optionally one of its loops |
| `/refresh` (`/r`) | Re-read agents, loops and approvals |
| `/theme [name\|next]` | Colour theme (no argument opens the picker) |
| `/url [daemon-url] [--token <token>]` | Show the daemon URL, or switch to another daemon live (it is health-checked first). The current token is only sent to the same origin; another daemon on this machine gets the local token file, a remote one needs `--token` or `ADF_DAEMON_TOKEN` |
| `/runtime [tab]` | Open the Runtime view (on a tab: `status`, `identity`, `auth`, `providers`, `usage`, `network`, `compute`, `mcp`, `channels`, `settings`, `events`) |
| `/status`, `/usage`, `/providers`, `/network`, `/compute`, `/settings` | Open that Runtime tab (`r` refresh; secrets redacted) |
| `/auth` | Provider sign-in dialog: ChatGPT and Grok status, sign in, sign out |
| `/login [chatgpt\|grok]`, `/logout <chatgpt\|grok>` | Sign the daemon in (browser / device code) or out (asks) |
| `/json [on\|off]` | Raw JSON in Inspect and Runtime pages |
| `/sidebar [on\|off]` | Show or hide the fleet sidebar (`Ctrl+B`; remembered) |
| `/mouse [on\|off]` | Mouse mode (on, the default: click expands, drag selects and copies, right-click pastes, the wheel scrolls under the pointer; off: the terminal's own mouse; remembered) |
| `/web [on\|off]` | The web server that serves agent websites and APIs: status, start, stop (asks) |
| `/open-site [agent]` (`/site`), `/copy-site [agent]` | Open an agent's website in the browser (starts the web server if stopped) · copy its URL |
| `/model [[provider/]model \| inherit]` | Change the selected agent › loop's model: main changes the agent config, an inner loop gets its own override (`inherit` clears it). No argument: a picker (provider with sign-in state, then model, type to filter) |
| `/config [edit]` | The selected agent's config (Inspect › Config); `edit` opens it in `$EDITOR` |
| `/instructions [edit]` | Edit the selected agent's instructions in the app (`edit`: in `$EDITOR`) |
| `/tools [filter]` | The agent's tools, grouped like Studio (built-in and MCP): enable, show, require approval, lock |
| `/compaction [tokens\|default]` | Compaction threshold of the selected agent › loop; no argument: every loop with its context in use |
| `/skills [add [name\|url\|path] \| mute\|unmute\|remove <name> \| sources [add\|remove <url>]]` | The agent's skills: preview, mute, edit, remove; add from the catalog, a URL or disk (see [Skills](#skills)) |
| `/context [loop]` | What fills the selected loop's context against its auto-compact threshold (see [Context](#context)) |
| `/templates [id]` | Agent templates: details, new, duplicate, rename, notes, default, review, reset, delete, edit (see [Templates](#templates)) |
| `/terminal-setup` (`/terminal`) | Whether this terminal sends Shift+Enter, and the keybinding that makes it |
| `/agents [running\|all \| interrupt\|abort <agent> [loop] \| refresh]` | Fleet overview; `running` / `all` hides or shows [stopped agents](#stopped-agents) (remembered); interrupt an agent's running turns (`abort` is the hard stop: that loop stays stopped until the agent is reloaded) |
| `/new [name]` | New agent: name, template, optional provider and model, start now. Opens its chat |
| `/identity [create\|restore\|unlock\|lock]` | Owner identity status and actions |
| `/start [agent]`, `/stop [agent]` (`/unload`) | Start (a stopped tracked agent is loaded first; Tab completes stopped names too); stop and unload (asks) |
| `/load [path.adf] [--review] [--start]` | Load an `.adf` (no path opens the dialog) |
| `/switch <agent>[/loop]` (`/sw`) | Jump to an agent or one of its loops (fuzzy) and open Chat |
| `/autostart [dir…]` | Scan tracked directories and start reviewed autostart agents (asks) |
| `/track [dir]`, `/untrack <dir>` | Track a folder of agents (no argument: the dialog) · stop tracking it (asks; files untouched, `u` also unloads its agents) |
| `/interrupt` (`/abort`) | Interrupt the selected loop's running turn; the loop goes idle and keeps working |
| `/clear` | Clear the selected loop's history (asks) |
| `/compact` | Summarize the selected loop's history now to free context (not mid-turn) |
| `/trigger <type> [json]` | Fire an ADF event into the selected loop |
| `/copy [n]` | Copy the last (or n-th last) reply of the selected loop |
| `/thinking` | Expand or collapse thinking blocks |
| `/approve [all\|always]` | Approve the selected loop's pending tool call · `all`: every gated call (never protection overrides) · `always`: always approve that tool (asks) |
| `/reject [feedback]` | Reject the selected loop's pending tool call; the agent sees the feedback |
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
| `/inspect [tab]` | Inspect the selected agent on a tab (`status`, `settings`, `config`, `usage`, `mcp`, `channels`, `identity`, `logs`, `tables`, `tasks`, `events`) |
| `/tasks [pending\|active\|all]` | Inspect › Tasks with that filter (see [Tasks](#tasks)) |

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
The app asks the terminal at start (`CSI ? u`) and, when it answers, turns on
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

The keybindings send `CSI 13;2 u` themselves, which the app reads as
Shift+Enter whether the protocol is on or not. With the protocol on, the other
keys (`Esc`, `Ctrl+C`, `Ctrl+K`, `Shift+Tab`, `Alt+digit`, arrows, paste) work
as before. `--no-kitty` or `ADF_TUI_KITTY=0` never turns it on.

### Mouse

**Mouse mode is the default** (mouse reporting: buttons, drags and the
wheel, never bare pointer motion). The app does its own text selection, so
copy and paste keep working without a modifier:

- **Drag** highlights text (reverse video) inside the pane where the drag
  started, so the sidebar never sneaks into a chat selection. Releasing
  copies it and shows `Copied N chars`. **Double-click** takes a word,
  **triple-click** the line. The highlight goes with the next key or click,
  or when the text under it moves.
- **Click** a transcript item to select it; a tool call, thinking, context or
  approval also expands or collapses. The prompt keeps focus. A click on
  another pane focuses it; clicks on the header switch views or toggle the
  web server; the approval card's actions are buttons.
- **Right-click** pastes the clipboard into the prompt (or the open dialog's
  text box). `Cmd+V` / `Ctrl+V` / `Ctrl+Shift+V` paste as always (the
  terminal sends the text itself, whatever the mouse mode).
- **The wheel** scrolls the transcript, list, viewer, event tail, help or
  palette under the pointer.
- The terminal's own selection is still there: **Shift+drag** (Windows
  Terminal, VS Code, most xterm-likes), **Option+drag** in iTerm2,
  **Fn+drag** in Terminal.app (or turn off View › Allow Mouse Reporting,
  `Cmd+R`).

Copying uses the system clipboard (`pbcopy`, `clip.exe`, `wl-copy` / `xclip`
/ `xsel`) and falls back to the terminal's own (OSC 52, which also reaches
your local clipboard over SSH; iTerm2 needs "Applications in terminal may
access clipboard"). `ADF_TUI_CLIPBOARD=osc52` always uses OSC 52. Pasting
reads `pbpaste`, `Get-Clipboard` or `wl-paste` / `xclip -o`.

**`/mouse off`** (`--no-mouse`, `ADF_TUI_MOUSE=0`; remembered) hands the
mouse back to the terminal: its own drag-select, copy (`Ctrl+C` /
`Ctrl+Shift+C`; Windows Terminal and VS Code copy on `Ctrl+C` with a
selection and do not pass the key on) and right-click paste. The app then
turns on alternate scroll mode (`DECSET 1007`) in the alternate screen: the
wheel sends `↑`/`↓`, so it scrolls the focused pane; in Chat a burst of arrows
scrolls the transcript even while the prompt has text, and never moves the
item selection (a single `↑` still selects or edits). No clicks to expand.

Both modes are off whenever the app does not own the terminal (quit, crash,
`$EDITOR`).

## Agent websites

Agents can serve web pages and APIs through the daemon's **web server** (the
mesh HTTP server, default `127.0.0.1:7295`; it takes the next free port when
that one is busy, and the app always shows the port it is bound to). An agent
with `serving.public` (its `public/` folder, `index.html` by default),
`serving.shared` patterns or `serving.api` routes (lambdas, WebSocket too) is
at `http://<host>:<port>/agents/<handle>/`. Agents that serve nothing show
nothing.

- **Fleet:** a `WEB` column (`site`, `api`, `files`) when the table is wide
  enough, and a line under the selected agent: the link, the LAN link when the
  server listens on every interface, and what it serves (`public/
  (index.html) · 2 API routes incl. 1 WS`). `w` opens it, `W` copies it.
- **Inspect › Status** starts with a Website block (url, LAN urls, server,
  what it serves); `w` / `W` there too.
- **Chat:** the info line carries `web 127.0.0.1:7295/agents/<handle>/`; `w`
  in the transcript opens it.
- `/open-site [agent]`, `/copy-site [agent]` and the palette ("Open agent
  website", "Copy agent website URL") work from anywhere.

When the server is stopped the same places say `web server stopped — start
it`, and `w` starts it (no confirm) and then opens the site. The header shows
`● web :7295` or `○ web off`; `w` on the [tab bar](#tab-bar), `/web on|off`,
the palette ("Start web server", "Stop web server…") and Runtime › Network `s`
turn it on or off. Stopping always asks: it takes every agent site and API
offline and stops mesh delivery over HTTP. The app re-reads the server state
on connect, when agents load or their config changes, and every 20 seconds
(Studio or the CLI may change it).

## Owner identity and new agents

Your **owner identity** proves the agents are yours. It is a 12-word seed
phrase: the same words restore it anywhere, in the terminal or in ADF Studio.
New agents are sealed under it, so the app sets it up before the first
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

Create, restore and unlock only work when the app talks to a daemon on the
same machine (loopback); against a remote daemon the dialog says to run it
there.

`n` on the Fleet view (or `/new [name]`) opens the new-agent wizard: name
(empty = generated), template (the default preselected; a template's warning
is shown), optional provider and model overrides, and start now (default
yes). The agent is created in the daemon's agents folder, sealed and
reviewed, then selected with its chat open.

## Welcome

The first three times the app starts, a welcome opens over it: what ADF
agents are, and a getting-started checklist. It never blocks: `Esc` closes
it, `d` hides it for good, and `/welcome` (or the palette) brings it back.

```text
 Welcome to ADF
 ADF agents are a new kind of agent: portable and self-contained. Each is a
 single .adf file that carries its own mind, memory, files and history. Move it
 anywhere and it picks up where it left off.
 Agents work in their own virtual files. They only touch your machine if you
 give them host access (compute_exec) or MCP tools that do.

 Get started
 › ○ Set up your identity   /identity
   ○ Connect a model        /login chatgpt · /provider add
   ○ Create an agent        /new
   ○ Connect a channel      /channels add  Telegram · Discord · Slack · Email · WhatsApp
   ○ Give it tasks          chat with it, or schedule a loop  /loop new

 Enter start next step · ↑/↓ pick · d don't show again · Esc close
```

Steps tick themselves (`✓`) from the daemon: the owner identity is ready
(the step only shows while it is not), a subscription is signed in or a
provider has a key, an agent is loaded, an agent has a channel, an agent has
an inner loop, a timer or a conversation. `Enter` runs the selected step's
command (the first open one is selected).

## Channels

Channels bring outside messages into an agent: Telegram, Discord, Slack,
email and WhatsApp (channel adapters in the API). As in ADF Studio (Settings
→ Channels), the channel types are built in and everything else is per
agent: the credentials live in that agent's identity store, sealed under your
owner identity, and switching a channel on writes the agent's config.

`/channels` lists the selected agent's channels with their live state
(`● connected`, `○ connecting`, `✗ error`, `off`). `Enter` opens one (its
state and error, `e` new credentials, `d` remove, `i` Inspect › Channels) or
starts adding it; `a` adds, `d` removes (asks; its stored credentials are
deleted). `/channels add telegram` goes straight to the form:

1. The steps from Studio's setup guide say where the credentials come from
   (Telegram: create a bot with @BotFather and paste its token).
2. Paste each credential. It shows as dots with its length, never as text.
   Obvious mistakes (a token of the wrong shape, a Slack token in the other
   field) are caught before anything is sent.
3. `Enter` stores the credentials in the agent, then switches the channel on.
   The dialog then shows the channel coming up (`connecting` → `connected`,
   or the adapter's error). A stopped agent says `/start <agent>` brings it
   up.

Editing (`e`) never shows stored values: each field says `set • (hidden) ·
type to replace` (`set • locked · type to replace` when the agent's
credentials are locked on this daemon) or `not set`; an empty field keeps
what is stored.

Without a ready owner identity the identity dialog opens first; the channel
setup follows once it is ready.

When the agent's saved credentials are locked (its credentials envelope
cannot be opened on this daemon: identity not unlocked), saving says so:
"This agent's saved <name> is locked and can't be read (identity not
unlocked). Unlock first (/identity), or replace it — the old value is
discarded." **Unlock** (`u`) opens the identity dialog and resumes the setup after;
**Replace** (`r`) asks once more (`y`/`Enter`), then stores the typed values anyway (the old
sealed value is discarded unread, the new one is sealed once the identity is
unlocked, and the agent's log records the replace); **Cancel** (`c`/`Esc`) returns to the
form. The same dialog appears for MCP server keys. WhatsApp needs no credentials: `Enter`
switches it on, and the phone pairs by QR code. The app cannot draw the QR:
open `imported/whatsapp/pairing-qr.png` from the agent's files (or use ADF
Studio, which shows it) and scan it in WhatsApp → Linked Devices.

## MCP servers

`/mcp` lists the selected agent's MCP servers with their live state (`●
connected`, `✗ error`, `not running`), tool count and where each runs.
`Enter` opens one: its state and error, source, where it runs, its tools
(`t`: `Space` turns a tool on or off), credential names (`e` replaces the
values; each shows `set • (hidden)` or `not set`, never the value), recent logs (`l`: all of them), `r` restart, `d` remove (asks; its
stored credentials are deleted). Inspect › MCP has the same: `a` adds, `m`
manages.

`a` (or `/mcp add`) adds one, from:

- **the catalog**, ADF Studio's curated list (`/` filters: `github`,
  `search`, `data`, …), or straight away with `/mcp add brave-search`;
- **an npm package** (`/mcp add npm:@scope/server`);
- **a Python package** run with uvx (`/mcp add python:mcp-server-fetch`);
- **a remote server** by URL (`/mcp add https://…/mcp`), with an optional
  token.

The form asks for a name (its tools are `mcp_<name>_<tool>`), arguments when
the server takes them, where it runs, and the keys it needs, as dots. Keys
are stored in the agent's identity store, sealed under your owner identity
(the identity dialog opens first when it is not ready), never in its config.
Locked credentials get the same Unlock / Replace / Cancel choice as
[channels](#channels).
Where it runs: a container by default (the shared one, or the agent's own
when it has one), isolated from your machine; the host only for agents with
host access, for servers that need your files, apps or login state.

Then each step shows as it happens: installing the package on the daemon
(it can take a minute), sealing the keys, attaching the server, connecting
it. The last step shows the tools found, or the error with the server's
last stderr lines (`l` for all its logs, `r` to retry). New tools start
restricted: the agent asks before using them. A stopped agent connects the
server when it starts.

Remote servers that sign in with OAuth in the browser, and servers with a
one-time sign-in step (they write a credential file), are set up in ADF
Studio (Settings → MCP): the daemon cannot run that browser flow yet. The
dialog says so instead of adding a half-working server.

## Model providers

`/provider add` (or the welcome's "Connect a model", or the palette) lists
every provider Studio knows: subscriptions first (ChatGPT, Grok: they open
the sign-in dialog), then APIs (Anthropic, OpenAI, OpenRouter, Gemini, Groq,
…), local servers (Ollama, LM Studio, …) and any OpenAI-compatible URL. `/`
filters. The form asks for a name (default: the provider's), the base URL
when it needs one, the API key (dots, with where to get one) and an optional
default model.

The key is sent once to the daemon, which keeps it in its secret store: the
OS keychain, or the owner's passphrase-protected secret file on machines
without one. It is never written to the settings file, never shown again and
never returned by the daemon (`hasApiKey` only). When that store is locked
the identity dialog opens first. The new provider shows up in `/model`'s
picker (`m` opens it) and in the new-agent wizard. `/provider list` opens
Runtime › Providers, `/provider remove <id>` removes one and its key (asks).

ADF Studio reads keys added here from the same OS-keychain entry, so the
provider works in both apps; a key changed in Studio goes back to the
keychain, never to the settings file. Where Studio cannot open the keychain
(or the daemon keeps keys in its passphrase file), Studio's provider settings
say so: manage that key with `/provider`. Keys added in Studio stay in
Studio's settings file as before.

## Provider sign-in

Agents on a ChatGPT or Grok subscription need the daemon to be signed in.
`/auth` lists both with their status (account, token renewal); `Enter` signs
in, `o` signs out (asks). `/login chatgpt`, `/login grok` and `/logout
<provider>` go straight there. The daemon keeps its own sign-in, separate
from ADF Studio's; agents need no changes.

- **ChatGPT** opens your browser. The dialog also shows the URL (`c` copies
  it) in case the browser does not open, and waits until you finish there.
  When the daemon runs on another machine, the app receives the browser's
  callback itself and hands it to the daemon.
- **Grok** shows a device code in large type with its URL; approve it in any
  browser.

`Esc` cancels while waiting; success or failure is shown in the dialog. When
an agent's provider is not signed in, its Fleet row says `signed out`, its
details and its Chat say `ChatGPT not signed in — /login chatgpt`.

## Approvals and questions

A pending tool approval shows as a card under the transcript of the loop that
asked, and as `!n` in the header, sidebar and fleet table. As in ADF Studio:
`y` approves, `a` always approves (the tool stops asking for this agent; it
confirms first), `n` rejects, `f` rejects with feedback the agent sees, `v`
shows the full call. `y` and `a` need a second press unless that approval is
selected in the transcript, so typed text never approves; in mouse mode the
card's actions are buttons. "Always approve" is never offered for protection
overrides and other one-time approvals (the card shows `always: one-time
only`), and the daemon refuses it too. `/approve [all|always]` and `/reject
[feedback]` do the same from the prompt. A question from the
agent shows the same way; while one is pending, what you type in the prompt is
sent as the answer, to the loop that asked. A suspended agent offers `y` to
resume and `n` to shut down (asks first).

## Tasks

Inspect › Tasks (`/tasks [pending|active|all]`, palette "Show tasks") lists
the selected agent's tasks (tool calls waiting for your approval, async tool
calls and their outcomes) newest first, with status, tool, loop, age, origin
and the agent's `_reason`. It updates live as approvals arrive and resolve
(`r` reloads). `f` cycles the filter: pending (pending + awaiting approval) ·
active (+ running) · all; `/` searches; Enter opens the full call (arguments,
result or error, timestamps, approval rule) and Esc goes back. On a
highlighted row waiting for approval: `y` approves, `n` rejects, `N` rejects
with feedback the agent sees, `a` always approves its tool (confirmed; not
offered for protection overrides or one-time approvals). `A` approves every
waiting call except protection overrides (confirmed).

## Tracked folders

Track a folder of agents: on the Fleet press `f` (or `/track [dir]`, or the
palette's "Track a folder…"). Tab completes folders. The daemon remembers the
folder and loads its reviewed autostart agents right away and at every start,
the same as Studio's tracked directories. When some of its agents did not
load, the folder's agents are listed next: loaded, needs review, not
autostart, failed to load (with the daemon's error) or unreadable. `Enter`
does the next step for the selected agent: open its chat, review it (what it
can do: owner, compute, powerful tools, MCP servers, channels; `y` accepts and
loads it, starting it if it autostarts), or load it. `r` rescans. Already-tracked
folders, and folders inside a tracked parent, are refused with the reason.

Stop tracking with `/untrack <dir>` (Tab lists tracked folders) or `d` on
Runtime › Folders. It asks first and never touches files. Press `u` in the
dialog to also unload that folder's agents; by default they keep running.

Runtime › Folders (`/runtime folders`) lists every tracked folder: whether it
exists, agents found, and agents loaded. `Enter` lists a folder's agents (the
same list), `a` adds, `d` removes, `r` rescans.

## Stopped agents

The sidebar and the Fleet list every agent in your tracked folders, like
Studio's sidebar, not only the ones running in the daemon. Running agents come
first. Then each tracked folder that has agents which are not running gets a
header with its name and `running/total`, and those agents are listed under
it, dimmed, with where each stands:

```text
 FLEET          2 +3 off
 ▾ ● agent-1 idle
   ○ ↻main
 ● agent-2 idle
 lab                 0/3
   ○ agent-3 stopped
   ! agent-4 needs review
   ✗ agent-5 load error
```

| State | Meaning | `s` / `Enter` |
|-------|---------|---------------|
| `stopped` | Not running (not set to autostart, or stopped) | Load it into the daemon and start it |
| `needs review` | Never reviewed on this daemon | Open its review (what it can do); `y` accepts, loads and starts it |
| `load error` | The last load failed (the error is shown; kept until it loads) | Try again |
| `locked` | Password-protected identity | Load it with `/load <file>` and unlock it |
| `unreadable` | Not a loadable `.adf` | — |

Selecting a stopped agent works like any other: Chat, Files, Loops and
Inspect show what it is, why it is not running and `s` / `Enter` to start it
(focus the pane first) instead of an error. In Chat, sending a message starts
it and then delivers the message. `/start <name>` and the palette find stopped
agents by name. When a selected agent is loaded (here, from Studio, or by the
autostart) the selection moves to it; when it stops it stays selected as a
stopped agent.

`H` on the Fleet, `/agents running` or the palette ("Hide / show stopped
agents") shows running agents only; `/agents all` brings the rest back. The
choice is remembered. The list is read from the daemon (`GET
/tracked-dirs/agents/all`) at start, after every agent load or unload, after
tracking or untracking a folder, and every 15 seconds; the daemon only opens
an `.adf` that changed since its last read, read-only.

## Agent settings

Inspect › Settings (`/inspect settings`, palette "Agent settings") is Studio's
agent config as rows: Instructions, Tools and Compaction open dialogs;
Autonomous, Autostart, Receive messages, Host access, Visibility, Send mode,
Inbox mode and "New MCP tools need approval" flip in place. Turning
autonomous or host access on, and LAN or public visibility, ask first with
Studio's warnings. `l` locks the highlighted section for the agent
(`locked_fields`: the agent cannot change it). Every change re-reads the
config, changes only the edited fields, saves and reports the result.

- **Instructions** (`/instructions`): an in-app editor (`Enter` newline,
  `Ctrl+S` save, `Ctrl+O` continue in `$EDITOR`, `Esc` cancel, asking when
  there are unsaved changes); `e` or `/instructions edit` goes straight to
  `$EDITOR`. If the daemon's copy changed meanwhile it asks before
  overwriting.
- **Tools** (`/tools [filter]`): Studio's groups plus one per MCP server,
  each tool with enabled, shown, approval required and lock. `Space` enables,
  `v` shows/hides, `r` requires approval, `l` locks (built-in tools), `/`
  filters; on a group header they act on the whole group (locked tools
  skipped). Studio's rules apply: a locked tool cannot be enabled or shown,
  turn tools (say, ask, sys_set_state) have no approval toggle, hidden needs
  enabled. Refusals show as warnings.
- **Compaction** (`/compaction [tokens|default]`): main and every inner loop
  with its threshold (default / inherits main / set) and context in use.
  `Enter` sets (`80000`, `80k`, `default`, `inherit`), `d` resets, `c`
  compacts now (asks). `/context` shows the breakdown.

## Context

`/context [loop]` (palette "Context usage") shows what fills the selected
loop's context, like Studio's context breakdown: the total against the
auto-compact threshold (and where that comes from: the loop, the agent, the
model or the default), then categories biggest first (system prompt,
injected files, built-in tools, each MCP server, dynamic instructions,
conversation). `Enter` lists a category's biggest items, `c` compacts now
(asks), `r` re-measures, `←`/`→` other loops, `Esc` closes. A loop that is
not running has nothing to measure. The Chat footer shows `ctx 42%`: the
loop's latest call input against its threshold (amber from 70%, red from
90%), after a call completes while the app is open; it clears on compact or
clear.

## Skills

`/skills` lists the selected agent's skills, the same as Studio's Skills
panel: name, description, `~N tok` (the cost of reading its SKILL.md) and
whether it is muted; the header shows the catalog's cost in the prompt, and
packages the indexer skipped are listed with its reason. `Enter` previews
SKILL.md, `Space` mutes / unmutes (a muted skill's description leaves the
prompt), `e` edits SKILL.md in `$EDITOR`, `d` removes `skills/<name>/`
(asks), `a` adds, `r` refreshes.

`/skills add` (or `a`) browses the merged catalog (the sources set in Studio
Settings › Skills, or the first-party registry): type to filter, `Enter`
previews, `Enter` in the preview installs. `/skills add <name>` jumps to an
entry, `/skills add https://…/registry.json` browses that catalog,
`/skills add https://…/SKILL.md`, `/skills add ./my-skill` (a folder) or
`./SKILL.md` install one package. Also `/skills mute|unmute|remove <name>`
and `/skills sources [add|remove <https-url>]` (shared with Studio). Skills
are instructions, never authority: installing writes files under
`skills/<name>/` and grants no tools, files or approvals.

## Templates

`/templates [id]` (palette "Agent templates"): the templates new agents start
from, as in Studio's Settings › Agent templates. Shipped templates first, then
yours, tagged default / shipped / not reviewed / has run, with notes and
warning. `Enter` shows details (model, tools, compute, instructions, files).
`n` new, `u` duplicate, `m` rename, `t` notes (description, warning), `s`
make default, `a` review someone else's template (the review summary; `Enter`
claims it, asking for a password when the file has one), `x` reset a shipped
template (asks), `d` delete your own (asks; the file moves to the daemon's
`templates-trash` folder). In details: `e` edits the instructions and `c` the
config (schema-checked, changed keys shown) in `$EDITOR`; `f` lists the seed
files (`Enter` edits one, `d` removes an extra file). Needs the owner
identity: when it is locked or missing, `i` opens the identity dialog.
Studio only: revealing the folder, adding files from disk.

## Themes

`adf` (dark, the default), `adf-light` for light terminal backgrounds,
`adf-contrast`, and `adf-mono` (no colour). Pick one with `--theme`,
`ADF_TUI_THEME` or `/theme` (for the session). `NO_COLOR` always wins.

## Mock mode

`npm run tui:mock` runs the app against an in-memory mock daemon, with no real
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

The welcome opens on the first three launches (the mock keeps them in your
usual prefs file; `ADF_TUI_PREFS=off` forgets them). `/channels add` works
against a fake channel that comes up after a second; a Telegram token
containing `revoked` ends in an error. `/provider add` keeps keys in the
mock's memory.

## Windows

Windows Terminal with PowerShell or Git Bash is the primary target. Two
things differ there:

- The app leaves the bottom terminal row unused. Windows consoles scroll when
  the bottom-right cell is written, so a frame that fills the screen forces a
  full clear on every update. Set `ADF_TUI_FULL_HEIGHT=1` to use the row
  anyway.
- On every platform the rightmost column stays unused. The app redraws only
  the lines that changed, and clearing to the end of a full-width line would
  erase its last character.

Other notes:

- Use `--ascii` on legacy consoles without box-drawing or braille glyphs.
- Newlines in the prompt: `Shift+Enter` on Windows Terminal 1.25+ (older: the
  `sendInput` action in [Shift+Enter](#shiftenter)), `Alt+Enter`, `Ctrl+J` or
  a trailing `\`.
- Drag selects and copies, right-click pastes (mouse mode, the default);
  `Shift+drag` is Windows Terminal's own selection. `Ctrl+Backspace` deletes a
  word in the prompt.
- The external editor defaults to `notepad`.

## Known gaps

- **MCP OAuth sign-in:** remote MCP servers that sign in with OAuth, and
  servers with a one-time sign-in step, are set up in ADF Studio.
- **WhatsApp pairing QR:** the app points at the QR image in the agent's
  files; ADF Studio shows it.
- **Provider keys added here** live in the daemon's secret store; ADF Studio
  lists the provider but does not read that store, so Studio-hosted agents
  on it have no key (daemon-hosted agents do).

- **Seed phrase backup:** the daemon shows the 12 words once, at creation.
  It cannot reveal them again; ADF Studio on the same machine (keychain
  storage) can, under Settings → Back up seed phrase.
- **No per-agent autostart toggle:** `A` and `/autostart` only run the
  daemon's scan of the tracked directories.
- **Folder delete:** delete the files one by one.
- **Binary files** can be viewed (hex) but not edited.
- **Timer start/end times** are not in the timer form (max runs is).
- **Stored credentials are write-only:** the daemon never returns a saved
  channel, MCP or provider value (only whether it is set, sealed or locked),
  so forms can replace a value but not show or reveal it.
- **Trigger state:** the Triggers tab shows on/off and target count. The
  daemon reports no last-fired time.
- **Loop "last activity"** costs one small request per loop, because the
  daemon has no such field.
- **Theme choice** from `/theme` lasts for the session only; persist it with
  `--theme` or `ADF_TUI_THEME`.
- **Older daemons:** against a daemon from before loop-aware asks and timers,
  the app falls back gracefully:
  - An ask is filed under the loop whose transcript shows it.
  - Moving a timer to another loop re-creates it with a new id.
  - `/compact` reports the missing endpoint.
