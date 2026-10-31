# Daemon backend: manual user-testing checklist

**Status: test plan for `feat/daemon-backend`.** Walked by the owner during the
one-week daily-driver period, before the Embedded backend code is deleted.
Corrected against what W0-W4 built (W4-C, 2026-10-14). R items describe remote
mode as built by W4-B and reconciled with W4-A's switch dialog. W5-D3 (2026-10-15) added the W5 fixes and the daily-driver gaps (FILE-25, CHAT-26, LOOP-11, TIME-15, TIME-16, CHAN-10, COMP-09, MESH-18, MESH-19, PROV-13, DMN-39..DMN-41); W5-D2 added FILE-26 and DMN-42 and set the wording of FILE-19, TIME-16, DMN-26, DMN-39 and DMN-40 to what it built. W5-I (2026-10-16) made Local daemon the default: it rewrote MODE-01 and added UPG-01..UPG-13. Multi-runtime phase 4 (2026-10-20, [multi-runtime.md](multi-runtime.md) §16) removed the switch-and-restart flow and remote mode: it rewrote MODE-02..MODE-06, MODE-11, §25 (SW), UPG-09, REM-02, REM-05, REM-19 and §32 (SCOPE), and added §33 (MRT). The user guide for these features is
[Studio backend](../guides/studio-backend.md); expected messages are quoted
from the code.

## How to use this checklist

Studio has two modes, and with This computer a runtime on each saved
connection:

| Column | Runtime | Agents run in |
|---|---|---|
| **E** | Inside Studio (legacy) | Studio's main process (the behaviour of 0.7.x) |
| **L** | This computer (the default) | A daemon (background service) on this machine that Studio spawns or attaches to |
| **R** | A saved connection, with This computer | A daemon on another machine, reached by URL + token, listed next to This computer |

An R item is walked on the server's agents, opened from the server's
sidebar group (or an agent window of the server), with Studio in L.

Rules:

- Walk every item once per column. Mark `[x]` on pass. On fail, leave `[ ]`
  and write the item ID in the daily-driver log (end of this document).
- **E and L MUST be indistinguishable.** Any visible difference between E and
  L is a failure, including wording, timing a user can notice, and ordering.
- **R MUST match E** except where the Expected column has a `Remote:` note.
  The note states the required remote behaviour; R is judged against it.
- `N/A` means the item cannot apply to that mode. The Expected column says why.
- "keep-running" is Settings → Connection → This computer → **Background**
  (L only, default off).
- An item whose steps change modes is walked in the column of the mode it
  changes to (MODE-03 and SW-01: L; MODE-05 and SW-02: E). UPG items start
  from 0.7.x and are walked in L.
- "Within 1 s" and similar bounds are perceptual, not measured, unless the
  item says to measure.
- Record the daemon version (`adf daemon status`) and Studio version (About)
  at the top of each day's log.

## Fixtures and setup

Prepare once; reuse across modes. All agents live in one tracked folder
`fixtures/` (for R: the same folder on the daemon host).

| Fixture | Setup |
|---|---|
| `agent-1` | Interactive. API-key provider (Anthropic or OpenAI). `shell`, `fs_*`, `sys_code` enabled. `sys_fetch` enabled + restricted (HIL). Reasoning on. |
| `agent-2` | Autonomous. Subscription provider (ChatGPT). One inner loop `researcher` (autostart). Interval timer, 1 min, system scope with lambda. Cron timer, agent scope. Autostart on. |
| `agent-3` | Telegram adapter connected to a test bot. `on_inbox` agent-scope trigger. Autostart on. |
| `agent-4` | Created on another owner's install (or claimed copy), share password set. Used for review/claim/password flows. |
| `agent-5` | Grok subscription provider; `limits.max_active_turns` = 2; `suspend_timeout_ms` = 120000. |
| `agent-6` | Claude subscription provider; one stdio MCP server (npm, e.g. filesystem) and one HTTP OAuth MCP server attached; one per-agent provider override with its own key. |
| MCP | One stdio npm server, one uvx server, one HTTP bearer server, one HTTP OAuth server registered in Settings. |
| Remote host | Second machine on the LAN and the tailnet with `adf` installed, an owner identity on it (`adf identity new` or `adf identity restore`, run there), and the same `fixtures/` copied there and tracked. Its daemon, as a service or in the foreground: `ADF_DAEMON_TOKEN=<token> ADF_DAEMON_ALLOWED_HOSTS=<lan-name>,<machine>.<tailnet>.ts.net ADF_DAEMON_BEHIND_PROXY=1 adf daemon --host 0.0.0.0` (token: `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='`). For DMN-19 also `tailscale serve --bg 7385` there. Owner identity actions run there, in a terminal (IDN-02, IDN-03). Setup guide: [Remote daemon](../cli/remote-daemon.md). |
| Tools | `adf` CLI on both machines; Task Manager / `Get-Process node,electron`; a phone with Telegram; a screen recorder. |

Mode change for E and L: **Settings → Connection**, **Connect** on This
computer or Inside Studio (legacy), then **Restart** ([Studio
backend](../guides/studio-backend.md#switch-the-backend)). R needs no mode
change: **Add** the server once; it stays connected while it is saved. The
page also holds **Background** (L, under This computer). Before each column,
confirm the mode: Settings → Connection shows which row is Connected and the
status bar has one group per runtime once the server is saved; `adf daemon status` shows
L: running, `started   by studio` (or `cli`), Studio's version; E: not running
(exit code 3). R: run `adf daemon status` on the server, and
`adf --url <url> --token <token> agents` here. In E, `adf` refuses to start a
daemon while Studio runs (DMN-17).

---

## 1. First launch and mode switching (MODE)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MODE-01 | Launch with a fresh profile (`--instance=9`). | Home renders. No dialog at launch or after the window opens. Settings → Connection: This computer Connected, no "Default changed" row; Inside Studio (legacy) is in This computer's More menu. The instance's user data folder has `studio-backend.json` with `"mode": "local"` and no `studio-default-switch.json`. `adf daemon status` with that instance's settings: running, `started   by studio`. | N/A | [ ] | N/A |
| MODE-02 | Settings → Connection in each mode. | E: Inside Studio (legacy) Connected, This computer offers Connect, a saved server is listed with no state. L: This computer Connected; the saved server Connected (or its state), no Connect; under **This computer** an "ADF daemon" row "Connected · pid N · started by this Studio" (or "started by Studio", "started by the ADF CLI", "started by a service"), its **Details** the URL and version V, and **Background**. | [ ] | [ ] | N/A |
| MODE-03 | E → L with no agent running and no agent open: Connect on This computer, then Restart. | Connect: "Next launch: *name* (Local)." with Restart, and no other message; no dialog, nothing restarts. After Restart: summary "Agents now run on this computer." listing what moved; Settings → Connection "ADF daemon" row "Connected … started by this Studio"; `adf daemon status` shows Studio's version, `started   by studio`. Sidebar, tracked folders unchanged. | N/A | [ ] | N/A |
| MODE-04 | E → L with agent-1 idle and agent-2 running (autostart on), no turn in flight. | Restart stops them in Studio. After the launch the daemon starts agent-2 (autostart); agent-1 stays stopped. No "Running again after the switch" notification. Each runs once: one load each in the daemon log, none in Studio's main log, one Telegram poller (CHAN-08). | N/A | [ ] | N/A |
| MODE-05 | L → E with agent-2 running (autostart on); keep-running off; Studio started the daemon: Connect on Inside Studio (legacy), then Restart. | "Next launch: Inside Studio (legacy)." with Restart; no dialog. Restart quits Studio, which stops the daemon. After the launch Studio starts agent-2 itself (autostart); summary "Agents now run inside Studio." lists sign-ins moved back. `adf daemon status`: not running. No agent runs in both. Keep-running on or a CLI-started daemon: SW-02. | [ ] | N/A | N/A |
| MODE-06 | From L with agent-1 running: Add with the server's address and the code (or a token). | The connection is saved and connects at once: Done; no restart, no dialog. agent-1 keeps running here. The sidebar shows two groups, *name* (Local) and the server's name, the server's tracked folders and agents in its own; the status bar has a group for each (the server's address in its tooltip). | N/A | N/A | [ ] |
| MODE-07 | R with an unreachable URL (server off, or tunnel down), launch Studio. | No fallback to E or L. Settings → Connection and Help show "Waiting for the remote ADF daemon at <url> (attempt n; next in N s): Cannot reach the ADF daemon at <url> (…)…"; one notification "Waiting for the remote ADF daemon at <url>. Studio keeps trying."; the pause grows from 2 s to 30 s. Settings → Connection stays editable. Start the server's daemon: Studio connects without a restart. A wrong token is not retried: DMN-22. | N/A | N/A | [ ] |
| MODE-08 | Relaunch Studio in each mode. | Comes back in the same mode ("Agents run …"), attaches (L: to the running daemon or a new one), restores the open agent and tabs. | [ ] | [ ] | [ ] |
| MODE-09 | `adf daemon start` first, then launch Studio in L. | Studio attaches; no second daemon (`adf daemon status` names one pid; no second daemon process in Task Manager). Settings → Connection: "… started by the ADF CLI". Running agents show live state on first paint. | N/A | [ ] | N/A |
| MODE-10 | Occupy port 7385 with another program (e.g. `python -m http.server 7385`), launch in L. | Dialog "ADF daemon not available": "Studio could not connect to an ADF daemon." with "The ADF daemon exited during startup (code 1). Its log says: "Failed to start: port 7385 on 127.0.0.1 is already in use"." and the buttons Reconnect, Run Inside Studio for This Session, Open Daemon Log, OK. Open Daemon Log shows the same line. Help menu: "ADF daemon: not connected". No fallback to E. | N/A | [ ] | N/A |
| MODE-11 | L with the server saved: quit and launch again; Remove the server; Add it again. | Each launch shows both groups, *name* (Local) first; no agent from one daemon appears under the other; no stale running dots. Remove closes the server's group and its agent windows; the local daemon's agents are not touched. Add brings the group back without a restart. | N/A | [ ] | [ ] |
| MODE-12 | Toggle "Keep the daemon running when Studio quits" in L. | "Saved. Applies from now on." Persists across relaunch. Takes effect at the next quit (DMN-09, DMN-10) and at once for the crash case (CRASH-01). | N/A | [ ] | N/A |

## 2. Open, create, clone, rename, delete, share (FILE)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| FILE-01 | Sidebar New agent (or `Ctrl+N`), name `agent-7`. | File created in the agents folder from the default template, opened, listed with a status dot. Remote: created on the daemon host. | [ ] | [ ] | [ ] |
| FILE-02 | Home composer: type a task, pick provider, model, folder, template; press Enter. | New agent created with the chip name; the DID shown before creation equals the agent's DID after; the message runs as its first turn. | [ ] | [ ] | [ ] |
| FILE-03 | Home composer: start typing, then navigate away; return. | A fresh draft DID is shown; the earlier draft is discarded (no orphan file). | [ ] | [ ] | [ ] |
| FILE-04 | Home composer: use a taken name; then an unreviewed template. | "That name is taken." / "That template has not been reviewed, so no agent was created." No file written. | [ ] | [ ] | [ ] |
| FILE-05 | Home composer: Attach files (button and drag-drop). | Files land in the new agent's VFS and are referenced in the first message. Remote: local files are uploaded to the daemon host. | [ ] | [ ] | [ ] |
| FILE-06 | Open agent… (`Ctrl+O`). | Picker opens; chosen agent opens and loads. Remote: picker lists daemon-host paths, or the action states it opens files on the daemon host; it MUST NOT open a local file in-process. | [ ] | [ ] | [ ] |
| FILE-07 | File → Open Recent → item; then Clear Menu. | Opens the agent. Clear Menu empties the list. Remote: recent entries are daemon-host paths, and none is added to the OS recent documents (Windows jump list). | [ ] | [ ] | [ ] |
| FILE-08 | Studio closed. Double-click `agent-1.adf` in Explorer. | Studio launches and opens it. Remote: the file is on this computer, so Studio asks "agent-1.adf is on this computer, not on <host>." (Upload a copy… / Cancel). Cancel: nothing uploaded, nothing opened. Upload a copy…: a folder picker limited to the tracked folders and the agents folder on the server (other folders: "Choose a tracked folder or the agents folder, or a folder inside one."), task-bar progress, then the copy opens and asks for review. No `ADF_DAEMON_BROWSE_ROOTS` needed. The local file is unchanged. Nothing runs in Studio's process. | [ ] | [ ] | [ ] |
| FILE-09 | Studio open. Double-click another `.adf`. | Existing window focuses and opens it; no second Studio. | [ ] | [ ] | [ ] |
| FILE-10 | Close Agent (`Ctrl+Shift+W`) on a running agent. | Foreground closes; agent keeps running (sidebar dot stays, timers fire). | [ ] | [ ] | [ ] |
| FILE-11 | Clone… agent-1, deselect `local_*` tables. | Clone listed with a new DID; only selected tables copied; loop/files as chosen. | [ ] | [ ] | [ ] |
| FILE-12 | Rename… a stopped agent. | File renamed on disk; sidebar, open tabs, recent list follow. | [ ] | [ ] | [ ] |
| FILE-13 | Rename… a running agent. | Rename deferred until stop, then applied; one sidebar entry throughout. | [ ] | [ ] | [ ] |
| FILE-14 | Change name in Agent → Identity. | Same as FILE-12/13. | [ ] | [ ] | [ ] |
| FILE-15 | Delete… a running agent, confirm. | Agent stops, file (+ `-wal`/`-shm`) removed, sidebar entry gone, no error dialog. | [ ] | [ ] | [ ] |
| FILE-16 | Reveal in folder (agent row and folder row). | Explorer opens with the item selected. Remote: dialog "This file is on <host>." with the path on the server and Copy path (copies it); nothing opens on this computer. | [ ] | [ ] | [ ] |
| FILE-17 | Share… agent-1 → save a copy. | Dialog lists what travels (config, files, loop) and what does not (identity keys, app-level provider keys). Save dialog writes an identity-free copy locally. Remote: snapshot comes from the daemon host. | [ ] | [ ] | [ ] |
| FILE-18 | Drag agent-1 from the sidebar to the desktop while it runs. | A consistent `.adf` copy appears; opening it shows loop rows up to the drag time. | [ ] | [ ] | [ ] |
| FILE-19 | Track folder… (`Ctrl+Shift+O`) on a folder with an autostart agent; Untrack folder…; Rescan. | Folder added and scanned; none of its agents starts until the next start (L and R as in E, W5-D2); untrack removes it from the list without touching files; Rescan picks up changes. Remote: daemon-host paths. | [ ] | [ ] | [ ] |
| FILE-20 | Copy a `.adf` into a tracked folder with Explorer. | Appears in the sidebar within seconds without Rescan. Remote: copy on the daemon host. | [ ] | [ ] | [ ] |
| FILE-21 | Sidebar search. | Filters agents by name. | [ ] | [ ] | [ ] |
| FILE-22 | Start/Stop from the row context menu and the status dot; folder Start all / Stop all. | Each agent starts/stops once; starting/stopping spinners clear; unreviewed agents prompt review first. | [ ] | [ ] | [ ] |
| FILE-23 | In agent-1, ask it to `sys_create_adf` a child with autostart. | Child listed and running; no review prompt. | [ ] | [ ] | [ ] |
| FILE-24 | View → Reload with agent-1 running and open. | Same agent reopens; running state, loop and tabs correct. | [ ] | [ ] | [ ] |
| FILE-25 | In R, open two agents from the server (picker) so Open Recent lists them; switch to E; File → Open Recent; quit and relaunch E; switch back to R. | E's Open Recent lists only the agents opened in E or L before, none of the server's paths; `adf-settings.json` has no `remoteRecentFiles`; main.log at the E boot has no WAL sweep of a server path and Windows asks for no network credentials. Back in R, Open Recent lists the server's agents again (kept as `remoteRecentFiles` in `studio-client-settings.json`, W5-D3). | [ ] | N/A | [ ] |
| FILE-26 | Rename agent-2 (and, in a second try, name a new agent) `nul`, then `con.backup`; then a name of 100 characters. | E: the device names are left to the file system (on Windows the rename or create fails with its error). L and R: refused with `"nul" is a Windows device name (CON, NUL, COM1, …), which no file can be named on Windows. Choose another name.`, on every OS (deliberate, W5-D2: such a file cannot travel to Windows). The 100-character name works in all three. | [ ] | [ ] | [ ] |

## 3. Editor and document (EDIT)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| EDIT-01 | Open README.md, edit in the rich editor, `Ctrl+S`, reopen. | Persisted. L/R: `adf file agent-1 README.md` shows the new text. | [ ] | [ ] | [ ] |
| EDIT-02 | Toggle Raw mode; use toolbar (bold, heading, list, table). | Markdown round-trips without loss. | [ ] | [ ] | [ ] |
| EDIT-03 | Open a `.ts` and a `.json` file. | CodeMirror with highlighting; dirty dot on edit; `Ctrl+W` on a dirty tab prompts. | [ ] | [ ] | [ ] |
| EDIT-04 | With `notes.md` open and clean, ask agent-1 to `fs_write` it. | Tab updates in place without reload. | [ ] | [ ] | [ ] |
| EDIT-05 | Same as EDIT-04 with unsaved local edits: keep typing in `notes.md` while the agent's `fs_write` lands (autosave saves about 0.5 s after the last keystroke, so a pause saves your text first). | The edits stay; a strip over the editor says "notes.md was changed by the agent while you were editing. Your changes are not saved." with Reload and Keep mine. Reload shows the agent's text; Keep mine saves yours over it. Same in all modes (more cases: MULTI-01..MULTI-07). | [ ] | [ ] | [ ] |
| EDIT-06 | Open a file > 128k chars. | Opens in source view; forcing rich mode asks for confirmation. | [ ] | [ ] | [ ] |
| EDIT-07 | Open a PNG and a binary file. | Image viewer with download; binary placeholder. | [ ] | [ ] | [ ] |
| EDIT-08 | Edit mind.md and soul.md. | Saved; agent sees them after compaction/clear per snapshot rules. | [ ] | [ ] | [ ] |
| EDIT-09 | Markdown with `adf-file://` image and file link. | Image renders; link opens the target file. Remote: content comes from the daemon. | [ ] | [ ] | [ ] |
| EDIT-10 | Open 4 tabs, quit, relaunch. | Tabs restored in order. | [ ] | [ ] | [ ] |
| EDIT-11 | Loop panel → "Open chat in center stage". | Chat moves into the editor tab strip and back. | [ ] | [ ] | [ ] |

## 4. Agent configuration (AGT)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| AGT-01 | Agent → Identity: description, icon picker. | Saved; icon updates in sidebar, title bar, map. | [ ] | [ ] | [ ] |
| AGT-02 | Model: change provider and model (list loads), temperature, max tokens, reasoning effort/max tokens/exclude/preserve, custom params. | Saved; next turn uses them (model shown on row). | [ ] | [ ] | [ ] |
| AGT-03 | Instructions + System Prompt mode (Full / No base prompt / Bare). | Token-count preview updates per mode. | [ ] | [ ] | [ ] |
| AGT-04 | Start-in-state, Autostart, Loop mode, context/compaction, audit toggles. | Saved; effective on next start. | [ ] | [ ] | [ ] |
| AGT-05 | Tools panel: enable, visible, restricted, lock; descriptions shown. | Saved; a restricted tool now requires approval. | [ ] | [ ] | [ ] |
| AGT-06 | Triggers, Messaging (mode, visibility), Serving (public, shared, API, WS routes). | Saved; effects visible (MESH, TIME items). | [ ] | [ ] | [ ] |
| AGT-07 | Security sub-section guard toggles. | Owner can change; agent `sys_update_config` on them is refused or HIL-gated as documented. | [ ] | [ ] | [ ] |
| AGT-08 | Raw Config: edit JSON, save; then save invalid JSON. | Valid: applied. Invalid: rejected with a message; nothing written. | [ ] | [ ] | [ ] |
| AGT-09 | Edit config while agent-1 runs. | Applied live; no restart needed where documented. | [ ] | [ ] | [ ] |
| AGT-10 | Ask agent-1 to `sys_update_config` a visible field. | Config panel updates live without reload. | [ ] | [ ] | [ ] |
| AGT-11 | Clear loop, clear inbox, clear mind, delete identity prefix (config panel actions). | Each clears only its target; confirmations shown. | [ ] | [ ] | [ ] |
| AGT-12 | Code execution: declare a sandbox package not installed. | Missing-package notice; Install shows progress and completes. | [ ] | [ ] | [ ] |
| AGT-13 | Probe an MCP server from the agent's MCP section. | Tool list or the server's verbatim error. | [ ] | [ ] | [ ] |

## 5. Chat, turns, streaming, thinking, tools (CHAT)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| CHAT-01 | agent-1: send "hello". | idle → active → idle. Reply streams token by token. | [ ] | [ ] | [ ] |
| CHAT-02 | Prompt that triggers reasoning. | Amber Thinking block streams before text; token count shown; collapsible. | [ ] | [ ] | [ ] |
| CHAT-03 | Prompt that runs `fs_write`, `shell`, `sys_code`. | Chips show name + args inline; Tool Call modal shows diff, shell output, duration. | [ ] | [ ] | [ ] |
| CHAT-04 | Prompt that runs 3+ tools in one turn. | Chips in emission order; each result under its own call. | [ ] | [ ] | [ ] |
| CHAT-05 | Expand Context Injected, System Prompt, Dynamic Instructions rows. | Collapsible; content present. | [ ] | [ ] | [ ] |
| CHAT-06 | Send a second message mid-turn ("Queue message"). | Joins at the next model boundary as its own user row; "Delivered at the agent…" shown. | [ ] | [ ] | [ ] |
| CHAT-07 | Stop mid-stream (button and `/stop`). | Turn aborts within 1 s; partial content kept; state idle. | [ ] | [ ] | [ ] |
| CHAT-08 | Send a message while an approval is pending. | Wait ends; turn restarts with placeholders for the pending call. | [ ] | [ ] | [ ] |
| CHAT-09 | Attach image via button, drag-drop and paste. | Attachment chips; model describes the image; Remove attachment works. | [ ] | [ ] | [ ] |
| CHAT-10 | `/` palette: arrow, Enter, Tab, Esc; `/skills`, `/idle`, `/hibernate`, a skill command. | Same list and behaviour; skill command composes text only. | [ ] | [ ] | [ ] |
| CHAT-11 | `/compact` idle; then `/compact` mid-turn. | `[Loop Compacted]` row, gauge drops. Mid-turn: refused with a message. | [ ] | [ ] | [ ] |
| CHAT-12 | `/clear`. | Loop cleared after confirmation; audit row kept. | [ ] | [ ] | [ ] |
| CHAT-13 | Long loop: scroll to top → Load older. | Earlier rows page in; no jump, no duplicates. | [ ] | [ ] | [ ] |
| CHAT-14 | Scroll up while streaming; then Scroll to bottom. | No forced autoscroll while scrolled up; button returns to tail. | [ ] | [ ] | [ ] |
| CHAT-15 | Set an invalid API key; send. | Error row; "Click for full error details" and copy work; state idle, not error. | [ ] | [ ] | [ ] |
| CHAT-16 | Start an agent whose provider is deleted / has no key. | Provider setup dialog opens (missing vs unconfigured); fixing it starts the agent. | [ ] | [ ] | [ ] |
| CHAT-17 | agent-2 (autonomous) runs; reply text-only 4 times. | Keeps turning; narration breaker sets idle after 4. | [ ] | [ ] | [ ] |
| CHAT-18 | Prompt that calls `say` then `respond`. | `say` text appears mid-turn; turn ends on `respond`. | [ ] | [ ] | [ ] |
| CHAT-19 | Reply containing code block, table, link, `.adf` link. | Rendered; `.adf` link opens that agent. | [ ] | [ ] | [ ] |
| CHAT-20 | After a turn. | Per-row token counts; status-bar gauge updated. | [ ] | [ ] | [ ] |
| CHAT-21 | agent-1 streaming → select agent-2 → back. | Stream continued; no missing or duplicated rows. | [ ] | [ ] | [ ] |
| CHAT-22 | agent-2 runs turns while not open; open it. | Full history including turns that ran while closed; sidebar/title state was live. | [ ] | [ ] | [ ] |
| CHAT-23 | Agent sets `sys_set_meta status`. | Status text in header and sidebar. | [ ] | [ ] | [ ] |
| CHAT-24 | MCP tool returns an image (multimodal on). | Rendered inline; saved under `mcp/`. | [ ] | [ ] | [ ] |
| CHAT-25 | Transient provider error (429/5xx). | Auto-retry per recovery config; retries visible in logs; final outcome shown. | [ ] | [ ] | [ ] |
| CHAT-26 | Ask agent-1 to save an image in its files and reply with `![chart](adf-file://chart.png)` and a link `[notes](adf-file://notes.md)`; then attach a PDF in the composer and send; relaunch Studio and reopen agent-1. | The image renders inline in the reply; the link opens `notes.md` in the editor; the attachment chip is on the user row and opens the file. After the relaunch all three still render and open. Remote: content comes from the daemon. | [ ] | [ ] | [ ] |

## 6. Inner loops (LOOP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| LOOP-01 | Open agent-2. | Loop tab strip: main + `researcher`, colours, status dots. | [ ] | [ ] | [ ] |
| LOOP-02 | Send a message on the `researcher` tab. | Runs in that loop only. | [ ] | [ ] | [ ] |
| LOOP-03 | Ask main to `loop_manage create` a loop. | New tab appears live, no reload. | [ ] | [ ] | [ ] |
| LOOP-04 | Ask main to `loop_send` with wake to a busy loop. | Delivery card held mid-stream; lands at the next boundary. | [ ] | [ ] | [ ] |
| LOOP-05 | Restart agent-2. | Autostart loop receives its kickoff. | [ ] | [ ] | [ ] |
| LOOP-06 | Main and `researcher` stream at once. | Both render in their own tabs; no cross-tab rows. | [ ] | [ ] | [ ] |
| LOOP-07 | Clear one loop's history. | Only that loop cleared. | [ ] | [ ] | [ ] |
| LOOP-08 | Switch tabs. | Status-bar gauge and breakdown follow the viewed loop. | [ ] | [ ] | [ ] |
| LOOP-09 | Delete a loop via config edit. | Tab disappears; stream archived (audit row). | [ ] | [ ] | [ ] |
| LOOP-10 | Background loop logs while its tab is unfocused. | Unread dot on that tab. | [ ] | [ ] | [ ] |
| LOOP-11 | agent-2 `researcher` tab with a history longer than one page: scroll to the top → Load older. | Earlier `researcher` rows page in; no main-loop rows; no jump, no duplicates (as CHAT-13 for main). | [ ] | [ ] | [ ] |

## 7. HIL: approvals, asks, suspend, OS notifications (HIL)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| HIL-01 | agent-1 calls restricted `sys_fetch`. | In-chat card: Approve / Always approve / Reject-with-feedback; reason and args preview. | [ ] | [ ] | [ ] |
| HIL-02 | Approve. | Tool runs; result row. | [ ] | [ ] | [ ] |
| HIL-03 | Reject with feedback "use the cache". | Agent receives the text and adjusts. | [ ] | [ ] | [ ] |
| HIL-04 | Always approve. | Tool no longer restricted (Tools panel shows it); next call runs without a card. | [ ] | [ ] | [ ] |
| HIL-05 | Three pending gated calls → Approve all. | All approved; protection overrides excluded and counted. | [ ] | [ ] | [ ] |
| HIL-06 | Pending approvals on agent-1 (foreground), agent-2 `researcher` (background). | Bell lists both with agent and loop; badge count correct; resolved tail greyed. | [ ] | [ ] | [ ] |
| HIL-07 | Approve from the bell. | Chat card and map card clear within 1 s. | [ ] | [ ] | [ ] |
| HIL-08 | Ask tool on agent-1. | "Your answer" field; answering resumes the turn. Bell row opens the agent instead of approving. | [ ] | [ ] | [ ] |
| HIL-09 | Background agent ask/approval answered from a fleet-map tile and the map approval modal. | Resolves; full input loads in the modal. | [ ] | [ ] | [ ] |
| HIL-10 | agent-5 hits `max_active_turns`. | Suspend dialog. Resume continues; Stop sets off. | [ ] | [ ] | [ ] |
| HIL-11 | agent-5 suspended, wait past 120 s. | Auto-off; dialog clears. | [ ] | [ ] | [ ] |
| HIL-12 | Window unfocused; approval arrives. | OS toast; click focuses Studio and opens the agent. | [ ] | [ ] | [ ] |
| HIL-13 | 5 approvals within 2 s, window unfocused. | One summary toast; click opens the bell panel. | [ ] | [ ] | [ ] |
| HIL-14 | Window hidden to tray (macOS: closed); click a toast. | **Windows: N/A** (the tray and menu bar are macOS-only; mark N/A in every column on Windows). Window shows and reveals the request. | [ ] | [ ] | [ ] |
| HIL-15 | Settings → Notifications off. | No toasts; bell still updates. | [ ] | [ ] | [ ] |
| HIL-16 | Approval whose args contain headers/body/token. | Toast and bell preview redact them. | [ ] | [ ] | [ ] |
| HIL-17 | Pending approvals (macOS/Linux). | Dock badge = bell count; 0 clears. Windows: N/A (nothing shown). | [ ] | [ ] | [ ] |
| HIL-18 | Tray menu with pending items. | **Windows: N/A** (the tray and menu bar are macOS-only; mark N/A in every column on Windows). "Pending" lists them; click reveals. | [ ] | [ ] | [ ] |
| HIL-19 | agent-3 routes approval to Telegram (on_task_create); approve on phone. | Studio card and bell clear. | [ ] | [ ] | [ ] |
| HIL-20 | Agent requests change of a locked field. | One-time protection override card; no "Always approve". | [ ] | [ ] | [ ] |
| HIL-21 | L/R: approve the same request in `adf` TUI (`y`). | Studio card and bell clear within 1 s. E: N/A (CLI cannot attach). | N/A | [ ] | [ ] |

## 8. Timers and triggers (TIME)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| TIME-01 | agent-2 → Timers tab. | Lists timers with schedule, next fire, run count, scope. | [ ] | [ ] | [ ] |
| TIME-02 | Add Timer: once (at), delay 30 s, interval, cron; system and agent scope; lambda; warm; payload; target loop. | Each created; validation errors are specific. | [ ] | [ ] | [ ] |
| TIME-03 | Edit a timer; toggle locked. | Saved; agent cannot delete a locked timer. | [ ] | [ ] | [ ] |
| TIME-04 | Delete a timer. | Removed from list and runtime (does not fire). | [ ] | [ ] | [ ] |
| TIME-05 | Delay 30 s agent-scope timer. | "Timer Fired" row ≤ 5 s late; one turn. | [ ] | [ ] | [ ] |
| TIME-06 | Agent calls `sys_set_timer`. | Appears in Timers tab live. | [ ] | [ ] | [ ] |
| TIME-07 | Agent closed in Studio, still running. | Timers fire; sidebar shows activity. | [ ] | [ ] | [ ] |
| TIME-08 | Stop agent-2 for 3 interval periods; start. | Missed timer fires once, then reschedules. | [ ] | [ ] | [ ] |
| TIME-09 | `on_file_change` with glob; edit a matching file in the editor. | Trigger fires once. | [ ] | [ ] | [ ] |
| TIME-10 | `on_startup` system lambda. | Runs on start; logged with origin. | [ ] | [ ] | [ ] |
| TIME-11 | Hibernate agent-2. | Only agent-scope `on_timer` wakes it; backlog dropped (`trigger.dropped`). | [ ] | [ ] | [ ] |
| TIME-12 | Header/fleet state buttons: idle, hibernate, off. | State changes; dot updates in all surfaces. | [ ] | [ ] | [ ] |
| TIME-13 | Overview Next wakes. | Matches Timers tab. | [ ] | [ ] | [ ] |
| TIME-14 | Autostart agents with Studio relaunch. | agent-2, agent-3 start; password-protected and unreviewed agents skipped. L/R: started by the daemon, already running when Studio attaches. | [ ] | [ ] | [ ] |
| TIME-15 | Daily use: leave agent-2 running for an hour (1-minute interval timer with lambda, cron timer), opening and closing it in Studio and quitting and relaunching Studio once (L: keep-running on). | About 60 interval fires and each cron fire, each once (`Timer Fired` rows, Timers tab run count); none doubled after the relaunch; the lambda's log rows once per fire. | [ ] | [ ] | [ ] |
| TIME-16 | agent-1 has a system-scope `on_file_change` lambda on `notes/*` that acts only when `event.source` is `system:studio` (for example it writes `seen.txt`). Save `notes/a.md` in Studio, then write it from `adf` (L/R) or by the agent. | The lambda acts once, for the Studio save only, in L and R as in E (W5-D2: a write from Studio's client session runs as `system:studio`; the terminal app and `adf` stay `system:runtime-api`). Parity scenario `w5d2-studio-write-source`. | [ ] | [ ] | [ ] |

## 9. Files, tables, meta, inbox, outbox, logs, tasks (DATA)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| DATA-01 | Files tab. | Folder tree, counts, protection badges; preview modal metadata. | [ ] | [ ] | [ ] |
| DATA-02 | Drag 3 files (one unknown extension) into Files; use Import. | Written to VFS; unknown type stored as binary. Remote: uploaded to the daemon. | [ ] | [ ] | [ ] |
| DATA-03 | Rename a file; rename a folder. | Paths change; open tabs follow. | [ ] | [ ] | [ ] |
| DATA-04 | Cycle protection; try delete on `no_delete` and core files. | Badge changes; delete blocked with a message. | [ ] | [ ] | [ ] |
| DATA-05 | Set Authorized; agent writes the file. | Flag clears live. | [ ] | [ ] | [ ] |
| DATA-06 | Download a file. | Save dialog; file written locally. | [ ] | [ ] | [ ] |
| DATA-07 | Delete a file. | Removed; audit row if `audit.files` on. | [ ] | [ ] | [ ] |
| DATA-08 | Tables: list, page rows, drop a `local_*` table. | Row counts correct; drop confirmed and applied. | [ ] | [ ] | [ ] |
| DATA-09 | Agent inserts rows via `db_execute`. | Tables view refreshes without manual reload. | [ ] | [ ] | [ ] |
| DATA-10 | Meta: set, delete, cycle protection. | Applied; agent cannot write a `readonly` key. | [ ] | [ ] | [ ] |
| DATA-11 | agent-1 messages agent-2; open agent-2 Inbox. | Message appears live; filters all/unread/read/archived/outbox; detail dialog shows security fields. | [ ] | [ ] | [ ] |
| DATA-12 | agent-1 Inbox → Outbox filter. | Status delivered/failed with code. | [ ] | [ ] | [ ] |
| DATA-13 | Logs panel: level and origin filter, expand payload, auto-refresh, clear. | New rows tail in; clear empties. | [ ] | [ ] | [ ] |
| DATA-14 | Tasks panel with an `_async` call. | running → completed; status filter; AUTH badge on authorized tasks. | [ ] | [ ] | [ ] |

## 10. Identity, owner, passwords, envelopes, review (IDN)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| IDN-01 | Settings → Identity. | Owner DID, runtime DID, delegation-valid badge, agent directory URL. Remote: runtime DID and URL are the daemon host's. | [ ] | [ ] | [ ] |
| IDN-02 | Back up seed phrase → reveal → confirm. | Phrase shown; badge clears. Remote (through LAN, tailnet, TLS proxy and SSH tunnel alike): Back up seed phrase and Import identity are disabled, with "A remote ADF daemon never sends its owner seed phrase to another machine. …" and "The owner identity of a remote ADF daemon is changed on its machine: run `adf identity restore` … or `adf identity import` … there." Run those on the server. | [ ] | [ ] | [ ] |
| IDN-03 | Import identity (12 words). | Owner restored; restamped/attested counts shown. L: Studio also rewrites the runtime entry for the daemon (`adf identity`: runtime `studio (adopted)` after the import). Remote: disabled as IDN-02; `adf identity import` on the server works. | [ ] | [ ] | [ ] |
| IDN-04 | Owner created in the terminal first (`adf` welcome), then open Studio. | "Restore your identity" banner; restoring works. Remote: the banner and Restore identity say to restore on the daemon's machine ("Restore it on the daemon's machine: run `adf identity restore` there. …"); the button is disabled. | [ ] | [ ] | [ ] |
| IDN-05 | Agent → Identity tab: DID, entries, code-access toggle, reveal, delete entry. | Values reveal on demand; toggles persist. | [ ] | [ ] | [ ] |
| IDN-06 | Generate keys on an identity-less file; Wipe all (confirm). | DID minted / identity cleared. | [ ] | [ ] | [ ] |
| IDN-07 | Attestations list; Reissue. | Reissued with new timestamps. | [ ] | [ ] | [ ] |
| IDN-08 | Envelope status; set share password; remove it. | Status identity/credentials shown; password slot added/removed. | [ ] | [ ] | [ ] |
| IDN-09 | Open agent-4 (share password). | Password dialog; correct password unlocks and adopts; wrong password errors; forgot → wipe path. | [ ] | [ ] | [ ] |
| IDN-10 | Open a legacy whole-file-password agent. | Unlock converts; opens silently afterwards. | [ ] | [ ] | [ ] |
| IDN-11 | Open a foreign-owned agent. | Owner-mismatch dialog; Claim mints a new DID, old DID in history. | [ ] | [ ] | [ ] |
| IDN-12 | Open an unreviewed agent. | Review banner and dialog (config summary, model choice); start blocked until accepted; accept may move it to the agents folder. | [ ] | [ ] | [ ] |
| IDN-13 | Copy agent-1 with Explorer; open both. | Duplicate-DID warning with re-key action. | [ ] | [ ] | [ ] |

## 11. Providers and subscriptions (PROV)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| PROV-01 | Add provider (API tile), key, Fetch Models, default model, Save. | Row with status dot ok; Home Providers tile ok. Remote: key stored on the daemon host. | [ ] | [ ] | [ ] |
| PROV-02 | Test provider (forced). | ok / failed / unconfigured as appropriate. | [ ] | [ ] | [ ] |
| PROV-03 | Add the same type twice. | Auto-numbered names; both usable. | [ ] | [ ] | [ ] |
| PROV-04 | Request delay and custom parameters. | Applied to requests (observe delay; param effect). | [ ] | [ ] | [ ] |
| PROV-05 | Local provider (Ollama/LM Studio, `localhost`). | Works. Remote: `localhost` means the daemon host; UI says so or the model list reflects the server. | [ ] | [ ] | [ ] |
| PROV-06 | ChatGPT: Sign in, run agent-2, Sign out. | Browser opens; status shows email; models listed; turn runs; sign-out clears status. L: the session is the daemon's (`adf auth` shows it). Remote: the callback lands on this computer and is handed to the daemon; no port to tunnel. | [ ] | [ ] | [ ] |
| PROV-07 | Grok: Sign in (device code), run agent-5, Sign out. | Code and URL shown; status updates when approved; turn runs. | [ ] | [ ] | [ ] |
| PROV-08 | Claude: status, Sign in (URL + paste code), Cancel, recheck after install, Sign out. | Status shows installed/version/plan; update-required message on old Claude Code; sign-out also signs Claude Code out. Remote: status is the daemon host's Claude Code. | [ ] | [ ] | [ ] |
| PROV-09 | Provider → Agent overrides: give agent-6 its own key, model, params; remove it. | Override attached; key-source label correct; "unchanged copy" collapse works; detach restores app key. | [ ] | [ ] | [ ] |
| PROV-10 | Subscription usage limit reached. | Error with reset time; no auto-retry. | [ ] | [ ] | [ ] |
| PROV-11 | Background agent blocked on a missing provider → setup sheet → pick provider. | Model set on the file; agent starts. | [ ] | [ ] | [ ] |
| PROV-12 | Settings → Privacy → provider checks off. | No provider test calls on Home. | [ ] | [ ] | [ ] |
| PROV-13 | Settings → Providers → open a provider with a saved API key; delete the key's last character, then retype it; Done. | E and L: the field holds the stored key (dots of its length); the edit behaves as in any text field and the provider still tests ok. L reads it through the daemon's local-only reveal (W5-D3). R: a placeholder (dots); typing replaces it; the server's key never reaches this computer. | [ ] | [ ] | [ ] |

## 12. MCP (MCP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MCP-01 | Add a curated stdio npm server. | Install progress, then verify shows tool count. Remote: installed on the daemon host. | [ ] | [ ] | [ ] |
| MCP-02 | Add a uvx server; uninstall it. | uv/Python ensured; install and uninstall complete. | [ ] | [ ] | [ ] |
| MCP-03 | Custom stdio server with args and env. | Verify shows tools or the server's verbatim error. | [ ] | [ ] | [ ] |
| MCP-04 | Remote HTTP server with bearer token. | Connects; tools listed. | [ ] | [ ] | [ ] |
| MCP-05 | HTTP OAuth server: Sign in, Re-authorize, Sign out. | Browser sign-in; status signed in/out. Remote: a native question "Open a sign-in page on <page host>?" naming the daemon's host comes first (REM-14); the browser's callback lands on this computer and is handed to the daemon. | [ ] | [ ] | [ ] |
| MCP-06 | stdio server with auth preflight. | Browser opens; "Complete authorization, then click Continue"; tools connect. | [ ] | [ ] | [ ] |
| MCP-07 | Kill a running server process. | Status changes live; supervisor restarts; tools return. | [ ] | [ ] | [ ] |
| MCP-08 | Restart server; open Logs. | Restart completes; logs show connect and tool calls. | [ ] | [ ] | [ ] |
| MCP-09 | Remove a server; uninstall its package. | Gone from dashboard and agents' tool lists. | [ ] | [ ] | [ ] |
| MCP-10 | Credentials panel: app-wide vs per-agent value; credential files; Needs-keys badge. | Saved values work; saving attaches the server to the agent. | [ ] | [ ] | [ ] |
| MCP-11 | Attach/Detach a server on running agent-6. | Tools appear/disappear without agent restart. | [ ] | [ ] | [ ] |
| MCP-12 | Per-tool enable/visible/HIL; bulk header controls; schema viewer. | Saved; schema modal shows JSON. | [ ] | [ ] | [ ] |
| MCP-13 | Available-to-agents on; agent calls `mcp_install` for it (HIL). | Attaches the registered server instead of reinstalling. | [ ] | [ ] | [ ] |
| MCP-14 | Runs on: Host vs Container. | Server runs where selected. Remote: on the daemon host. | [ ] | [ ] | [ ] |
| MCP-15 | Offline: open Add MCP Server. | Registry loads from cache/bundle. | [ ] | [ ] | [ ] |

## 13. Channel adapters (CHAN)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| CHAN-01 | Settings → Channels. | One row per adapter; agent chips with live status. | [ ] | [ ] | [ ] |
| CHAN-02 | Connect agent-3 to Telegram (paste token). | Status connected; phone message gets exactly one reply. | [ ] | [ ] | [ ] |
| CHAN-03 | Edit the token; view last error; disconnect. | Applied; disconnect stops polling. | [ ] | [ ] | [ ] |
| CHAN-04 | Restart adapter; open adapter logs; logs on a stopped agent. | Restart works; logs list entries; stopped agent shows "not running" state. | [ ] | [ ] | [ ] |
| CHAN-05 | Uninstall an adapter package. | Removed; dependent agents show the adapter unavailable. | [ ] | [ ] | [ ] |
| CHAN-06 | Stop agent-3, send 3 phone messages, start. | One wake; all 3 ingested; replies once. | [ ] | [ ] | [ ] |
| CHAN-07 | Agent sends a form/poll to Telegram; answer on phone. | Native keyboard/poll; answer arrives threaded. | [ ] | [ ] | [ ] |
| CHAN-08 | Adapter logs over a 1-hour run. | No `409 Conflict` (duplicate poller). | [ ] | [ ] | [ ] |
| CHAN-09 | Smoke Email, Discord, Slack if configured; WhatsApp QR pairing file. | Connect, receive, reply. WhatsApp session dir on the agent's host. | [ ] | [ ] | [ ] |
| CHAN-10 | Telegram receiving: from the phone send agent-3 a text, a photo and a document while Studio shows another agent; then while agent-3 is open. | Each arrives once in agent-3's inbox (photo and document as attachments that open); `on_inbox` fires once per message; one reply each; the sidebar shows activity while agent-3 is not open. | [ ] | [ ] | [ ] |

## 14. Compute, sandbox, browser (COMP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| COMP-01 | Settings → Compute: status; setup steps (install, machine init/start, check). | Each step reports outcome. Remote: the daemon host's Podman. | [ ] | [ ] | [ ] |
| COMP-02 | Container list (all/running/stopped); details tabs Summary, Activity, Logs, Processes, Workspace, Packages, Inspect. | Data loads; refresh works. | [ ] | [ ] | [ ] |
| COMP-03 | Start, stop, rebuild, destroy a container; shared compute init and destroy. | Destroy dialog warns about active agents; phases shown live. | [ ] | [ ] | [ ] |
| COMP-04 | Test an external container target. | Probe result shown. | [ ] | [ ] | [ ] |
| COMP-05 | Host access on; agent runs `compute_exec` `hostname`. | Runs. Remote: prints the daemon host's name. | [ ] | [ ] | [ ] |
| COMP-06 | Computer tab / browser viewer for an isolated agent; start/stop/resume Chromium. | noVNC desktop loads; browser controls work. Remote: the same desktop loads, relayed through the remote daemon (no tunnel); when the agent opens a browser, the Computer tab opens. A remote daemon without the desktop routes (older version): the viewer says "Open on <name>, or update ADF there to see this desktop here." Never a blank viewer. | [ ] | [ ] | [ ] |
| COMP-07 | Settings → Packages: add, list, remove; agent Promote. | Install progress; listed with size and installer. | [ ] | [ ] | [ ] |
| COMP-08 | Container base image, system packages, VM CPUs/memory, max sandbox workers. | Saved; effective after the documented restart. | [ ] | [ ] | [ ] |
| COMP-09 | Two runtimes on this machine use one container: Studio (E) with agent-6's MCP server in a container, plus a daemon on other settings (`$env:ADF_DAEMON_SETTINGS='<other>\adf-settings.json'; $env:ADF_DAEMON_PORT='7395'; adf daemon start`) running an agent with an MCP server in a container. In L the second runtime is an embedded Studio `--instance=2`. Settings → Compute; Stop `adf-mcp`, Cancel; Rebuild, Cancel. | The `adf-mcp` row says "Also used by daemon pid N" (L: "studio-embedded pid N"). Stop asks "Stop adf-mcp? daemon pid N also uses this container; its agents lose it until it starts again."; Cancel leaves it running. The Rebuild dialog names the other runtime too (W5-D3). Stop the second runtime: the row loses the line. | [ ] | [ ] | N/A |

## 15. Mesh, fleet, LAN, tailnet (MESH)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MESH-01 | Enable/disable mesh. | Status updates; fleet map shows Enable Mesh prompt when off. | [ ] | [ ] | [ ] |
| MESH-02 | Mesh server start, stop, restart; change port. | Status card host:port; URL opens. Remote: server runs on the daemon host. | [ ] | [ ] | [ ] |
| MESH-03 | LAN access toggle; LAN IP list. | Binds 0.0.0.0 with restart notice; IPs listed. Remote: daemon host's IPs. | [ ] | [ ] | [ ] |
| MESH-04 | Settings → Networking → Advanced → Firewall: the check, and the commands to run when a rule is missing. | Rule state shown; the commands, with Copy, add the rule in an administrator shell; Studio never adds it. Remote: "Change on *name*." | [ ] | [ ] | [ ] |
| MESH-05 | Discovered runtimes; Recheck; add/remove manual peer; tailnet toggle. | Peers listed with source badges; manual peer appears within seconds. | [ ] | [ ] | [ ] |
| MESH-06 | Agent endpoints table. | Handles, URLs, Public/API/Shared badges. | [ ] | [ ] | [ ] |
| MESH-07 | agent-1 `msg_send` to agent-2. | Delivered; mesh traffic bar ripple. | [ ] | [ ] | [ ] |
| MESH-08 | Message an agent on a peer runtime. | Delivered; outbox delivered. | [ ] | [ ] | [ ] |
| MESH-09 | Fleet map: loading veil, lenses (`L`), select, marquee, control groups. | Renders; poll updates every 5 s. | [ ] | [ ] | [ ] |
| MESH-10 | Command bar: Start, Stop, Hold/Resume, Message (N agents), Hibernate, Wake, Restart, Halt. | Each applies to all selected; results per agent. | [ ] | [ ] | [ ] |
| MESH-11 | Double-click open ground → found agent. | Agent created in the implied folder. | [ ] | [ ] | [ ] |
| MESH-12 | Drag tiles; Reset layout; relaunch. | Layout persists; reset re-packs. | [ ] | [ ] | [ ] |
| MESH-13 | Peer station → peer agent readout: shared file, health. | File renders/downloads; health shown. | [ ] | [ ] | [ ] |
| MESH-14 | Alert bar, needs-you queue, inline pending cards, recent tools, burn, mesh log drawer. | Live values; cards resolve. | [ ] | [ ] | [ ] |
| MESH-15 | `F` fullscreen and edge-scroll. | Enters/leaves fullscreen; title bar reacts. | [ ] | [ ] | [ ] |
| MESH-16 | Serving agent: click 🌐 badge. | Page opens in the browser. Remote: URL is the daemon host's; reachable only if LAN-bound. | [ ] | [ ] | [ ] |
| MESH-17 | Stewards, voice chips (`V`), say bubbles. | Shown and updated. | [ ] | [ ] | [ ] |
| MESH-18 | agent-1 serves an API route handled by a lambda (`serving.api`, e.g. `GET /hello` → `api.ts:hello`); open `http://127.0.0.1:<mesh port>/agents/agent-1/api/hello` in a browser, then change the lambda's file. | The lambda's answer is returned; after the edit the next request returns the new answer without restarting agent-1. Remote: the URL is the daemon host's (reachable from here only if LAN-bound). | [ ] | [ ] | [ ] |
| MESH-19 | Mesh between machines: this machine and the remote host both on the LAN (or tailnet) with mesh on and LAN access on; each sees the other in Discovered runtimes; agent-1 here `msg_send`s an agent on the other machine, which replies. | Both runtimes listed with their source badge; the message is delivered once and the reply lands in agent-1's inbox once; both outboxes show delivered. L: the daemon is the runtime here. R: N/A (the remote daemon is the other machine). | [ ] | [ ] | N/A |

## 16. Templates, registry, skills (TMPL)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| TMPL-01 | Settings → Agent templates. | Shipped three seeded; default marked. Migration notice shown once. | [ ] | [ ] | [ ] |
| TMPL-02 | Create blank; duplicate; rename; set default; delete; reset shipped. | Each applied; settings that pointed at a renamed id follow it. | [ ] | [ ] | [ ] |
| TMPL-03 | Edit template config, README/mind/soul, description/warning; add and remove files. | Saved; new agents from it carry them. | [ ] | [ ] | [ ] |
| TMPL-04 | Reveal template. | Explorer opens. Remote: dialog "The templates folder is on <host>." with its path on the server and Copy path. | [ ] | [ ] | [ ] |
| TMPL-05 | Drop a template `.adf` into the templates folder. | List updates. | [ ] | [ ] | [ ] |
| TMPL-06 | Foreign template → review → accept. | Claimed; usable in the composer. | [ ] | [ ] | [ ] |
| TMPL-07 | Skills panel: list, mute checkbox, open SKILL.md. | Mute writes `skills-state.json`; registry updates. | [ ] | [ ] | [ ] |
| TMPL-08 | Catalog browser: open card (preview), Install. | Preview renders; installed skill indexed; its slash command appears. | [ ] | [ ] | [ ] |
| TMPL-09 | Settings → Skills: add/remove a source; Live catalogs off. | Sources persist; off → no remote fetch. | [ ] | [ ] | [ ] |

## 17. Settings (SET)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| SET-01 | Theme light/dark/system. | Applies; system follows OS. | [ ] | [ ] | [ ] |
| SET-02 | Font family, custom font, UI scale, chat width, agent avatars (orbital/emoji). | Applies immediately; orbitals cached (fast on relaunch). | [ ] | [ ] | [ ] |
| SET-03 | Notifications: system notifications; menu bar icon. | **Windows: N/A** (the tray and menu bar are macOS-only; mark N/A in every column on Windows). Toggles toasts and tray icon (toasts alone: HIL-15). | [ ] | [ ] | [ ] |
| SET-04 | Studio → Updates → Automatic checks; Runtime → Providers → Models; Runtime → MCP servers → Live catalogs; Studio → Privacy → Spell-check dictionaries (Linux). | Each disables its network calls. | [ ] | [ ] | [ ] |
| SET-05 | Runtime → Files: agents folder (picker), max scan depth. | Saved; composer default folder follows. Remote: daemon-host path. | [ ] | [ ] | [ ] |
| SET-06 | Prompts: global system prompt, compaction prompt, tool instructions (modified badge, reset), apply updates automatically, dynamic instructions. | Auto-saved; running agents use it next turn. | [ ] | [ ] | [ ] |
| SET-07 | Settings search. | Finds sections by keyword. | [ ] | [ ] | [ ] |
| SET-08 | Change a setting, quit within 1 s, relaunch. | Persisted. | [ ] | [ ] | [ ] |
| SET-09 | Change a provider in Studio; run `adf providers`. | L: the CLI shows it (one settings file). Remote: shows on the server's `adf providers`. E: N/A (`adf` refuses to start a daemon while a Studio in E runs). | N/A | [ ] | [ ] |
| SET-10 | Auto-compact threshold default. | New agents use it. | [ ] | [ ] | [ ] |
| SET-11 | Docs links and info hints. | Open the matching guide. | [ ] | [ ] | [ ] |

## 18. Dashboard, usage, vitals (DASH)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| DASH-01 | Home. | Tiles load progressively with status dots; click deep-links to the Settings section. Remote: values are the daemon host's. | [ ] | [ ] | [ ] |
| DASH-02 | Getting started, Networking panel, tracked folders on Home. | Correct counts and states. | [ ] | [ ] | [ ] |
| DASH-03 | Home status line: running agents; stop one. | Stops; count updates. | [ ] | [ ] | [ ] |
| DASH-04 | Agent Overview: orbital, vitals, next wakes, 14-day activity, contents. | Correct; refresh after a turn. | [ ] | [ ] | [ ] |
| DASH-05 | Settings → Usage: chart, metric switcher, Export, Clear All. | Matches turns run; export saves locally; clear empties. | [ ] | [ ] | [ ] |
| DASH-06 | Status bar: state, gauge, tokens, version, Logs/Tasks toggles. | Correct; panels toggle. | [ ] | [ ] | [ ] |
| DASH-07 | Context breakdown modal. | Categories and USD. | [ ] | [ ] | [ ] |
| DASH-08 | Emergency stop: the status bar's Kill button (tooltip "Stop all agents and disable mesh"). | Every agent stops, mesh off. L/R: daemon agents stop (`adf agents`). | [ ] | [ ] | [ ] |
| DASH-09 | Tray "Today: … tokens". | **Windows: N/A** (the tray and menu bar are macOS-only; mark N/A in every column on Windows). Matches Usage today. | [ ] | [ ] | [ ] |

## 19. Tray, menu, updater, window, zoom, spellcheck, drag-drop, deep links (APP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| APP-01 | Tray click. | **Windows: N/A** (the tray and menu bar are macOS-only; mark N/A in every column on Windows). Summary, Pending, Running (click opens agent), Open, Settings…, Quit. | [ ] | [ ] | [ ] |
| APP-02 | Menus: File, Edit, View, Window, Help (docs link). | Every item works; accelerators shown. | [ ] | [ ] | [ ] |
| APP-03 | Shortcuts `Ctrl+,` `Ctrl+N` `Ctrl+O` `Ctrl+Shift+O` `Ctrl+S` `Ctrl+W` `Ctrl+Shift+W`. | Each performs its action. | [ ] | [ ] | [ ] |
| APP-04 | Zoom in/out/reset with UI scale set. | Combine; persist. | [ ] | [ ] | [ ] |
| APP-05 | Fullscreen from menu. | Title bar adapts. | [ ] | [ ] | [ ] |
| APP-06 | Misspell in composer and editor. | Underlined; suggestions. Linux: dictionary download from Privacy. | [ ] | [ ] | [ ] |
| APP-07 | About → Check for updates; status-bar badge; download; restart-and-install (packaged build). | States shown; installs. Daemon follow-up: DMN-15. | [ ] | [ ] | [ ] |
| APP-08 | Drag-drop: files onto composer, chat, Files; agent out of sidebar. | Covered by FILE-05, CHAT-09, DATA-02, FILE-18; all work. | [ ] | [ ] | [ ] |
| APP-09 | Deep links: toast click, `adf-file://` link, `.adf` double-click, second instance. | Covered by HIL-12, EDIT-09, FILE-08, FILE-09. | [ ] | [ ] | [ ] |
| APP-10 | `--instance=2`. | Separate settings and data; does not affect instance 1. L: while instance 1's daemon holds port 7385, instance 2 refuses with "The ADF daemon running on this machine (pid N) uses <instance 1 settings>, not <instance 2 settings>."; started with `ADF_DAEMON_PORT=7395` it runs its own daemon (its mesh port still clashes unless set apart in Settings → Networking). | [ ] | [ ] | [ ] |
| APP-11 | Studio → Updates; About; Settings → Connection. | Updates: Studio version, Check for updates. About: concepts, links. L: the daemon's version is under **Details** on the ADF daemon row of Settings → Connection (not in About). | [ ] | [ ] | [ ] |

## 20. Quitting and restarting (QUIT)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| QUIT-01 | Quit (menu, tray) with idle agents. | "Shutting down" overlay; exit within the budget; no orphan processes (MCP servers, `node.exe`, `electron.exe`) except the daemon when keep-running is on. | [ ] | [ ] | [ ] |
| QUIT-02 | Quit while agent-1 streams. | E: turn interrupted; recovery notice on next open. L keep-running on: turn completes in the daemon; reopen shows it. L keep-running off: daemon stops gracefully; recovery notice on next open. R: turn completes; daemon untouched. | [ ] | [ ] | [ ] |
| QUIT-03 | Close the window (Windows ✕). | Quits (or hides to tray if documented); same in all modes. | [ ] | [ ] | [ ] |
| QUIT-04 | Windows sign-out with Studio open. | Orderly teardown; next sign-in state consistent. L keep-running: daemon dies with the session; agents recover on next start. | [ ] | [ ] | [ ] |
| QUIT-05 | Restart for update. | "Restarting…" overlay; relaunch into the same mode. | [ ] | [ ] | [ ] |
| QUIT-06 | Relaunch. | Previous agent and tabs restored; autostart agents running. | [ ] | [ ] | [ ] |
| QUIT-07 | Quit in R. | Remote daemon and its agents keep running (`adf --url … agents`). | N/A | N/A | [ ] |

## 21. Crash and recovery (CRASH)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| CRASH-01 | Kill Studio (`taskkill /F /IM "ADF Studio.exe"`) mid-turn. | E: next launch shows the crash-recovery notice with timestamps; running tasks → failed; pending approvals → cancelled. L keep-running on, and R: agents unaffected; relaunch attaches, turn completed. L keep-running off: the turn completes; if Studio is not back within 60 s the daemon stops (its log: "Stopping the daemon: client session … expired …"); relaunched within 60 s, Studio attaches (and MULTI-13 applies). | [ ] | [ ] | [ ] |
| CRASH-02 | View → Force Reload mid-stream. | Renderer resyncs; stream continues or completed rows shown; no duplicates. | [ ] | [ ] | [ ] |
| CRASH-03 | Corrupt `adf-settings.json` (truncate), launch. | File quarantined, defaults loaded, message shown. L: daemon also survives (no clobber of the quarantined copy). | [ ] | [ ] | [ ] |
| CRASH-04 | After any unexplained exit. | `Get-MpThreatDetection` checked (Defender behaviour kill); `main.log` and crashes dir record the exit. L: daemon log records its own exit. | [ ] | [ ] | [ ] |
| CRASH-05 | Disable network 60 s with agent-3 connected. | Adapter reconnects with backoff; catch-up ingests missed messages once. | [ ] | [ ] | [ ] |

## 22. Mode-specific tests (DMN)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| DMN-01 | Same agents E → L → E → L. After each switch compare agent-1 and agent-2: loop rows, files, timers (ids, next fire), inbox, meta, tasks. | Identical. No lost turn, no duplicate timer, no duplicate loop rows. | N/A | [ ] | N/A |
| DMN-02 | Change modes while agent-1 streams: E → L and L → E with a Studio-started daemon and keep-running off; then L → E with keep-running on (or a CLI-started daemon). | Connect saves the mode and interrupts nothing: the turn finishes (SW-01). Restart quits Studio as any quit does: with a Studio-started daemon and keep-running off, the turn stops with the daemon; with a daemon that keeps running, the turn finishes there. A saved server's turns are never interrupted (REM-19). The typed message and the turn are never lost or run twice. | [ ] | [ ] | N/A |
| DMN-03 | Studio (L) + `adf` TUI on the same daemon. Chat from TUI. | Studio shows the user row and stream live. | N/A | [ ] | [ ] |
| DMN-04 | As DMN-03, chat from Studio. | TUI shows it live. | N/A | [ ] | [ ] |
| DMN-05 | Approve in TUI; approve in Studio (separate requests). | Each clears in the other surface within 1 s. | N/A | [ ] | [ ] |
| DMN-06 | Start/stop, state change, config edit, timer add, file edit in one surface. | Reflected in the other within 1 s (TUI Fleet/Inspect; Studio sidebar/panels). | N/A | [ ] | [ ] |
| DMN-07 | `adf chat agent-1 "hi"` while Studio shows agent-1. | Turn appears in Studio. | N/A | [ ] | [ ] |
| DMN-08 | Two Studio machines attached to one remote daemon. | Both see the same state; approval on one clears on the other. | N/A | N/A | [ ] |
| DMN-09 | Keep-running ON; quit Studio. Wait for agent-2 timer; send agent-3 a Telegram message. | Timer fires; phone gets one reply; `adf agents` lists them running. Relaunch: Studio attaches; loops show those turns; bell shows approvals raised while closed. | N/A | [ ] | N/A |
| DMN-10 | Keep-running OFF, Studio started the daemon, no other client; quit Studio. | Agents stop gracefully; the daemon exits (`adf daemon status`: not running, exit code 3); no daemon process left in Task Manager. main.log: "Quit: client session ended; the ADF daemon is stopping: …". Relaunch spawns a daemon; autostart agents start. With the TUI connected: MULTI-11. | N/A | [ ] | N/A |
| DMN-11 | Daemon started by `adf daemon start` before Studio; quit Studio with keep-running OFF. | Studio does not stop it: `adf daemon status` running, agents keep running. main.log: "Quit: client session ended; the ADF daemon keeps running: this daemon run was started by cli, not Studio; Studio never stops it". Matches the guide (Studio backend › Quit Studio: "A daemon started with `adf daemon start` (or a service manager) is never stopped by Studio"). | N/A | [ ] | N/A |
| DMN-12 | Kill the daemon (`taskkill /T /F /PID <pid>`) while agent-1 streams. Repeat at least 60 s apart (the dialog is not shown again within 60 s). R: stop the server's daemon. | Within 5 s: Help menu "ADF daemon: not connected (<url>), retrying" and Reconnect to the ADF Daemon; after 3 s the dialog "Studio lost its connection to the ADF daemon." (Reconnect Now / Open Daemon Log / Dismiss; R: no Open Daemon Log). No fake idle. Studio does not restart the daemon itself: L: run `adf daemon start` (or restart Studio, which starts one); R: start it on the server. Studio then reconnects by itself and notifies "Reconnected to the ADF daemon." The loop shows the interrupted turn; no missing or duplicate rows versus `adf` loop listing. A chat waiting for its answer ends after 15 s without the daemon. | N/A | [ ] | [ ] |
| DMN-13 | During the DMN-12 outage, send a message; click an approval; press Stop all agents. | Each is refused visibly: "Cannot reach daemon at <url>: …" where the action was taken (a message typed to an idle agent: an error row "Not sent: Cannot reach daemon at <url>: …"); emergency stop shows "Emergency stop did not reach the ADF daemon. … Agents may still be running." A message that was waiting in the queue stays there marked "Not sent" with that reason, and is sent again at the agent's next turn end after the reconnect, up to 3 attempts in a row; after that it waits for Send now or the next message. Approvals and Stop are not replayed; nothing is dropped silently. | N/A | [ ] | [ ] |
| DMN-14 | L: `adf daemon restart` while Studio is idle (Studio started the daemon). R: restart the server's daemon the way it was started (the same foreground command or service; `adf daemon restart` would rebind it to 127.0.0.1 without its `ADF_DAEMON_TOKEN`). | Studio reconnects without user action (a "Studio lost its connection" dialog may appear while the daemon restarts; dismiss it), re-holds the open agent and resyncs; state intact. L: afterwards the "ADF daemon" row says "started by the ADF CLI" (Studio reads it again on reconnect), `adf daemon status` shows `started   by cli`, and Studio's quit no longer stops it. | N/A | [ ] | [ ] |
| DMN-15 | Version mismatch. Setup: a daemon of another client API version on Studio's settings: a source checkout with `CLIENT_API_VERSION` in `src/main/daemon/routes/meta-routes.ts` changed, started with `npm run daemon` (it counts as started by cli); or, after a Studio update that changes the client API version, the old Studio-started daemon kept running (keep-running on). Launch Studio in L. | Dialog "The running ADF daemon is version X; this Studio is Y." For the source-checkout daemon it names "This daemon was started by the ADF CLI (adf daemon start), not Studio; …", the buttons are "Restart It Anyway" and "Run Inside Studio for This Session", and Run Inside Studio for This Session is the default. For the Studio-started daemon with no other client the buttons are "Restart the Daemon with Studio's Version" (default) and "Run Inside Studio for This Session". Restart: the old daemon stops, Studio's starts and attaches; it keeps the old run's "started by". Run Inside Studio for This Session: DMN-37. A daemon of another release with the same client API version attaches without a dialog. R: the connection fails with "The ADF daemon at <url> (version V) speaks client API N; this Studio needs M. Update the daemon on the server (or Studio) so both are the same version." No silent protocol errors. | N/A | [ ] | [ ] |
| DMN-16 | Daemon running agent-2 and agent-3. Launch Studio in E. | Studio does not start agent-2/agent-3 in-process: autostart skips them, and Start shows "agent-2 is already running in the ADF daemon (pid N). Stop it there with "adf stop agent-2", or stop that daemon with "adf daemon stop", then start it here." Telegram message → exactly one reply. Timer → one "Timer Fired" row per period. No `409` in adapter logs. | [ ] | N/A | N/A |
| DMN-17 | Studio in E running; run `adf`. | `adf` refuses to start a daemon: "ADF Studio (pid N) is running agents from the same settings file (<path>)." followed by "Studio and the daemon would run the same agents from the same files at once. Quit ADF Studio, then run adf again. Or keep using Studio." In L the same command attaches (Studio is a client). | [ ] | N/A | N/A |
| DMN-18 | Remote over the LAN, by IP (`http://192.168.x.y:7385`) and by a host name in `ADF_DAEMON_ALLOWED_HOSTS` (`http://<lan-name>:7385`), with Add connection. Both need "I trust this network; the token is sent unencrypted." Run CHAT-01..07, HIL-01..07, TIME-05, DATA-02, DATA-06, EDIT-01. | Without the box checked Next is disabled. With it, the connection is saved and all items pass. A host name not in the list: DMN-23. | N/A | N/A | [ ] |
| DMN-19 | Remote over the tailnet: `https://<machine>.<tailnet>.ts.net` (through `tailscale serve`), then `http://100.x.y.z:7385`. Same set as DMN-18. | https: no confirmation; all pass. `http://100.x.y.z`: accepted without the confirmation (tailnet range). `http://<machine>.<tailnet>.ts.net:7385` (MagicDNS over plain http) asks for the confirmation. All pass. | N/A | N/A | [ ] |
| DMN-20 | Remote via SSH tunnel (`ssh -N -L 7386:127.0.0.1:7385 …`, URL `http://127.0.0.1:7386`, the server's token). Same set as DMN-18. | No confirmation (loopback). All pass. Owner identity actions in Studio stay disabled (IDN-02); `adf identity …` run on the server works. Open Daemon Log is disabled. | N/A | N/A | [ ] |
| DMN-21 | Remote via a TLS proxy (`https://…`), with Add connection. | The connection is saved; events stream live (not buffered). A certificate this computer does not trust: "The TLS connection to <url> failed (…). Studio checks certificates and has no option to skip that: …". | N/A | N/A | [ ] |
| DMN-22 | Wrong token: Add connection with it; then make R use a connection whose token the server revoked. Then fix the token. | Add connection: "The ADF daemon at <url> refused the token; choose Add device on <host> and pair again." The launch fails once with the same sentence in "Studio could not connect to an ADF daemon.", which offers Reconnect and Run Inside Studio for This Session (the Help menu offers both too); no retries (one 401 in the daemon log). Pair again (Add device on the host), then Reconnect (dialog or Help menu): Studio restarts and connects. Run Inside Studio for This Session instead restarts Studio in E for this launch; the next launch is R again. | N/A | N/A | [ ] |
| DMN-23 | Host name not in `ADF_DAEMON_ALLOWED_HOSTS`. | "The ADF daemon at <url> does not accept the host name <name>. On the server, add it to ADF_DAEMON_ALLOWED_HOSTS and restart the daemon (docs: Remote daemon)." | N/A | N/A | [ ] |
| DMN-24 | Network drop 30 s, idle and mid-stream (disable Wi-Fi or kill the tunnel). | Help menu status line and, after 3 s, the "Studio lost its connection" dialog; on restore, reconnects, missed events replayed, no duplicates; input during the drop handled per DMN-13. | N/A | N/A | [ ] |
| DMN-25 | Network drop longer than the event replay window (busy agent, 10 min). | Studio re-snapshots (loop reloads); no gap in rows. | N/A | [ ] | [ ] |
| DMN-26 | Laptop sleep 10 min with agent-2 and agent-3 running, resume. | Within seconds of the resume (not the 75 s stream watchdog) main.log says "The computer resumed: checking the ADF daemon and re-dialing the client stream" (W5-D2). L: Studio and the daemon resume together; Settings → Connection shows the same daemon pid; the open agent and tabs are as left; each agent-2 timer due during the sleep fires once (TIME-08); one Telegram poller (CHAN-08); a phone message sent during the sleep is answered once. R: reconnects; state current. | N/A | [ ] | [ ] |
| DMN-27 | First switch E → L: run agent-1 (API key), agent-2 (ChatGPT), agent-5 (Grok), agent-6 (Claude, per-agent key, MCP creds, HTTP OAuth MCP), agent-3 (Telegram token). | All work without re-entering secrets: the summary lists the ChatGPT and Grok sessions and MCP sign-ins as moved; Claude Code is shared and needs nothing. Per-agent credentials unlock in the daemon because it adopted Studio's runtime identity (`adf identity`: runtime `studio (adopted)`). Review shows the agents as yours. | N/A | [ ] | N/A |
| DMN-28 | Switch back L → E; run the same agents. | All work; no re-login: the summary lists the sessions and MCP sign-ins as moved back, and `auth.daemon.json` is gone. ChatGPT still signed in after 24 h (one session moved, not two copies). | [ ] | N/A | N/A |
| DMN-29 | R: enter an app-level provider key in Studio. | Stored on the daemon host; local keys never sent to the remote daemon. | N/A | N/A | [ ] |
| DMN-30 | Password-protected agent in L. | Autostart skips it; unlocking in Studio runs it in the daemon. | N/A | [ ] | [ ] |
| DMN-31 | Run 3 turns in L, switch to E. | Usage counts each turn once; no double count across modes. | N/A | [ ] | N/A |
| DMN-32 | In L: `netstat -ano` for the mesh port. | Only the daemon binds it; Studio binds no mesh port. | N/A | [ ] | N/A |
| DMN-33 | After 5 mode switches: count MCP server and adapter processes. | One per configured server/adapter; no leaks. | N/A | [ ] | N/A |
| DMN-34 | Agent with `umbilical_taps`. | Taps fire in L/R as in E (daemon profile historically excluded them). | [ ] | [ ] | [ ] |
| DMN-35 | `on_file_change` for writes from the editor, the agent and a lambda. | Same firing in L/R as in E (headless gap historically). | [ ] | [ ] | [ ] |
| DMN-36 | Remote daemon host in another time zone. | Timestamps shown in local time; usage bucketed by documented day. | N/A | N/A | [ ] |
| DMN-37 | DMN-15 → Run Inside Studio for This Session. | Studio restarts in E for this launch only. Settings → Connection: "Inside Studio (legacy) for this session only." (no Restart now banner). The old daemon and its agents keep running; Studio does not start them (agent_leased, DMN-16); sign-ins and the runtime identity stay with the daemon. The next launch asks again. | N/A | [ ] | N/A |
| DMN-38 | DMN-15 with the source-checkout daemon and a TUI from that same checkout connected (`npm run tui`, or its `adf`; a TUI from Studio's build speaks the other client API, falls back to /events and is not listed) → Restart It Anyway. | The dialog adds "This daemon was started by the ADF CLI (adf daemon start), not Studio; its replacement keeps that, so quitting Studio does not stop it." and "Connected to it now: tui …. A restart disconnects them."; "Run Inside Studio for This Session" is the default button. After the restart the "ADF daemon" row says "started by the ADF CLI"; the old checkout's TUI cannot use the new daemon's client sessions and falls back to /events. | N/A | [ ] | N/A |
| DMN-39 | During an outage (L: kill the daemon with `taskkill /T /F /PID <pid>`, CLI-started so Studio does not start it again; R: stop the tunnel), type a message in agent-1's composer and send. | The chat ends the message with an error row giving the reason (for example "Cannot reach daemon at http://127.0.0.1:7385: …"; a message already waiting when the daemon exits: "The ADF daemon exited while the message waited for its turn; …"; a dropped connection to a daemon that is still running shows no error, and the working state follows the agent's real state after the reconnect) and the working state ends, as a failed turn does in E (W5-D2); the message is not queued and not sent later. A message over 128 MB with its attachments: "This message is too large to send: … the ADF daemon accepts at most 128 MB per chat message …". After reconnecting, sending again runs one turn. | N/A | [ ] | [ ] |
| DMN-40 | L, Studio started the daemon (`started   by studio`), agent-1 open and running, agent-3 running in the background: kill the daemon (`taskkill /T /F /PID <pid>`). | A notice "The ADF daemon (pid N) exited; agents are stopped. Studio is starting it again.", about 2 s later "Studio started the ADF daemon again (pid M). Agents running again: 2 of 2." (W5-D2); no dialog. Settings → Connection shows pid M, started by studio; agent-1 open with its tabs and running; agent-3 running; one Telegram poller. Kill it again within 10 minutes: no automatic start this time, the dialog of DMN-42 instead, saying Studio already started it again. | N/A | [ ] | N/A |
| DMN-41 | Copy `agent-3.adf` (Telegram) into another tracked folder while agent-3 runs (or restore an older copy of it there); Rescan; start the copy; relaunch Studio. | The start is refused: "agent-3 was not started: <copy path> has the agent id <id>, and <original path> with the same id is already running in the ADF daemon (pid N). The two files are copies of one agent; …" (E: "… in this ADF Studio"). Autostart skips the copy. Adapter logs: no `409 Conflict`; the phone gets one reply per message. Stop agent-3: the copy starts (W5-D3). | [ ] | [ ] | [ ] |
| DMN-42 | L, a daemon started from the terminal (`adf daemon start`, `started   by cli`): kill it (`taskkill /T /F /PID <pid>`). | A dialog "The ADF daemon (pid N) exited; agents are stopped." saying it was started by cli, not by Studio, with Start the ADF Daemon / Open Daemon Log / Dismiss; the Help menu line reads "ADF daemon: exited (pid N); agents are stopped". Studio starts nothing by itself. Start the ADF Daemon: a new daemon (started by studio), the open agent re-held, the agents that ran started again, and a notice saying so. A second outage shows the dialog again even within a minute. | N/A | [ ] | N/A |

## 23. Side-by-side parity (PAR)

Method: clone agent-1 to `agent-1b`. Run Studio instance 1 in L with agent-1
and `--instance=2` in E with agent-1b (agent-1b is not loaded by the daemon;
give instance 2 another mesh port in Settings → Networking, or one of the two
mesh servers fails to bind).
Screen-record both with the same scripted prompts. Where two instances are not
possible, record each mode in turn and compare recordings.

| ID | Compare | Expected | E | L | R |
|---|---|---|---|---|---|
| PAR-01 | Streaming smoothness. | Text arrives in small increments in both; no visible batching (> 250 ms bursts) in daemon modes. | [ ] | [ ] | [ ] |
| PAR-02 | First-token latency from Enter. | L within ~200 ms of E. R: record the delta. | [ ] | [ ] | [ ] |
| PAR-03 | Tool-call ordering and chip timing. | Same order; chips appear at the same point of the turn. | [ ] | [ ] | [ ] |
| PAR-04 | Thinking blocks. | Present, streamed, same placement and collapse state. | [ ] | [ ] | [ ] |
| PAR-05 | Open the same agent in E then L with no new turns: per-row tokens, gauge, breakdown. | Identical numbers. | [ ] | [ ] | [ ] |
| PAR-06 | Historical loop rendering of the same file. | Identical rows, order, timestamps, collapsed blocks. | [ ] | [ ] | [ ] |
| PAR-07 | Error messages: invalid key, 429, tool error, MCP server down, provider missing, unreviewed agent. | Same text and placement. | [ ] | [ ] | [ ] |
| PAR-08 | Approval prompts in chat, bell, map, toast. | Same layout, reason, args preview, buttons. | [ ] | [ ] | [ ] |
| PAR-09 | Unread badges: sidebar unread, loop-tab dot, bell count, Dock badge, tray tooltip. | Same counts at the same moments. | [ ] | [ ] | [ ] |
| PAR-10 | State dots and transitions (start → idle, active → idle). | Same sequence; start latency within 1 s. | [ ] | [ ] | [ ] |
| PAR-11 | Files, Inbox, Meta, Tables, Logs, Tasks for the same file. | Same content and ordering. | [ ] | [ ] | [ ] |
| PAR-12 | Fleet map and Overview for the same fleet. | Same tiles, vitals, next wakes, burn. | [ ] | [ ] | [ ] |
| PAR-13 | Home tiles and Settings pages. | Same values for the same machine (R: same values as the server's L). | [ ] | [ ] | [ ] |

## 24. Bridge methods with no UI entry point (API)

Run in DevTools (View → Toggle Developer Tools → Console) on agent-1. Compare
the result shape across modes. Read-only calls only, unless stated.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| API-01 | `await adfApi.getAgentStatus()` | Same shape and values for the open agent. | [ ] | [ ] | [ ] |
| API-02 | `setChat` has no renderer caller. Do not call. | Code review: routed to the backend or removed. | [ ] | [ ] | [ ] |
| API-03 | `await adfApi.getMeshFleetStatus()`, `getMeshTokenBurn()`, `getMeshDebug()`, `getMeshPendingInteractions()` | Same data the fleet map poll shows. | [ ] | [ ] | [ ] |
| API-04 | `await adfApi.startAllInDirectory('<fixtures>')`, then `stopAllInDirectory` | All agents in the folder start/stop once. | [ ] | [ ] | [ ] |
| API-05 | `await adfApi.countTokens('hello')`, `countTokensBatch(['a','b'])` | Same counts in all modes. | [ ] | [ ] | [ ] |
| API-06 | `await adfApi.getDashboardContainers()` | Same shape; R: server's containers. | [ ] | [ ] | [ ] |
| API-07 | `await adfApi.importPaths(['<local file>'])` | File imported into the open agent. R: uploaded. | [ ] | [ ] | [ ] |
| API-08 | `await adfApi.listMcpInstalled()`, `ensurePythonRuntime()`, `pickAdfFile()` | Same results; picker opens (R: as FILE-06). | [ ] | [ ] | [ ] |
| API-09 | `await adfApi.listAdapterInstalled()`; `installAdapterPackage({package})` with `onAdapterInstallProgress` subscribed | Lists; install emits progress. | [ ] | [ ] | [ ] |
| API-10 | `await adfApi.setPassword('x')`, `changePassword('x')` | Both fail (deprecated) with the same error in all modes. | [ ] | [ ] | [ ] |
| API-11 | `await adfApi.getAgentRegistry()`, `refreshAgentRegistry()`, `bringHomeRegistryAgent('<id>')` | Registry lists; bring-home copies into the agents folder (R: daemon host). | [ ] | [ ] | [ ] |
| API-12 | `installUpdate` (only after a downloaded update) | Restarts into the update, as APP-07. | [ ] | [ ] | [ ] |
| API-13 | `await adfApi.computeStop()` | Shared compute stops; Settings → Compute reflects it. | [ ] | [ ] | [ ] |

## 25. Choosing the mode (SW)

Guide: [Studio backend › Switch the backend](../guides/studio-backend.md#switch-the-backend).
There is no switch dialog: a mode chosen applies at the next launch
([multi-runtime.md](multi-runtime.md) §7.1, §7.2). The items of the former
switch-and-restart flow (Wait for Them to Finish, Stop Them Now, Finish
switch now, Cancel switch, resuming agents after a switch) are gone.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| SW-01 | In E, agent-1 runs a long turn; Connect on This computer. | No dialog; the turn completes in Studio. "Next launch: *name* (Local)." with Restart at the top of the page. `studio-backend.json` mode `local`. | N/A | [ ] | N/A |
| SW-02 | L with the daemon kept running (keep-running on, or started by `adf daemon start`), agent-2 running in it: Connect on Inside Studio (legacy), then Restart. | After the launch agent-2 still runs in the daemon (`adf agents`); Studio does not start it ("agent-2 is already running in the ADF daemon (pid N). …" on Start); the summary says sign-ins were not moved back (HAND-08). | [ ] | N/A | N/A |
| SW-03 | SW-01, then Connect on Inside Studio (legacy), the mode this launch runs. | "Saved."; the "Next launch" line is gone; `studio-backend.json` mode `embedded`. | [ ] | N/A | N/A |
| SW-04 | With L configured, launch Studio with `ADF_STUDIO_BACKEND=embedded` (PowerShell: `$env:ADF_STUDIO_BACKEND='embedded'; & "<install dir>\ADF Studio.exe"`). | Studio runs E: Settings → Connection "Inside Studio (legacy) because ADF_STUDIO_BACKEND is set." Only client settings move; ChatGPT, Grok and MCP sign-ins and the runtime identity stay with the daemon (agents using them show signed out); agents the daemon runs cannot start here (agent_leased). A saved server is listed with no state. The next launch without the variable runs the saved mode. | [ ] | N/A | N/A |
| SW-05 | macOS only: E → L (SW-01, then Restart). | The first-launch notice or summary says "macOS asks once whether the ADF daemon may read Studio's runtime key from the keychain."; macOS asks once; after Always Allow no prompt at later starts. Windows and Linux: N/A. | N/A | [ ] | N/A |
| SW-06 | Launch with `ADF_STUDIO_BACKEND=remote`. | Studio runs L, with every saved connection listed; main.log has "ADF_STUDIO_BACKEND=remote is read as local". | N/A | [ ] | N/A |

## 26. Credential handover (HAND)

Guide: [Studio backend › What moves during a switch](../guides/studio-backend.md#what-moves-during-a-switch).
Paths are in Studio's user data folder (`%APPDATA%\ADF Studio`).

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| HAND-01 | First E → L with ChatGPT and Grok signed in, one app-level HTTP OAuth MCP server signed in, and an owner phrase not yet in the keychain. | Summary "Agents now run on this computer." lists Client settings moved, Runtime identity written ("keychain entry studio-runtime:<scope> written"), Owner phrase written ("mirrored into the keychain entry ADF / owner-mnemonic, as embedded Studio does"), ChatGPT session and Grok session moved (from …\auth.json to …\auth.daemon.json), MCP sign-ins moved ("1 server sign-in(s) moved into the daemon's secret store"). On disk: `chatgpt-subscription\auth.json` gone, `auth.daemon.json` present, `studio-handover.json` present. `adf auth` shows the ChatGPT account. | N/A | [ ] | N/A |
| HAND-02 | After HAND-01: `adf identity`; Settings → Identity; agent-1's review and Identity panels; create agent-8 in L. | `adf identity` shows runtime `studio (adopted)`. The runtime DID in Settings → Identity equals the one in E. agent-1 shows as yours. Credential Manager (Windows Credentials) has an `ADF` entry `studio-runtime:<12 hex>`. agent-8 later opens in E (HAND-03) as yours, credentials unlocked, no review. | N/A | [ ] | N/A |
| HAND-03 | L → E (Studio started the daemon, keep-running off). | Summary "Agents now run inside Studio." lists the ChatGPT and Grok sessions and MCP sign-ins moved back and Runtime identity deleted. `auth.json` back, `auth.daemon.json` gone, no `studio-runtime:` entry in Credential Manager. ChatGPT and Grok agents run without signing in. | [ ] | N/A | N/A |
| HAND-04 | Accounts conflict. Setup: Studio in E signed in to ChatGPT as account A; quit Studio; `adf daemon start`; `adf auth login chatgpt` as account B; `adf daemon stop`; launch Studio, switch to L. | At the boot after the switch: dialog "ChatGPT session: two accounts" / "Studio and the ADF daemon are signed in to ChatGPT with different accounts." naming both, buttons "Keep A (Studio)" and "Keep B (daemon)". Keep A: `adf auth` shows A; B is saved, encrypted, as `chatgpt-subscription\auth.replaced.<time>.json` (the dialog names the folder, the summary the file); a later conflict over another account writes a second file, the same account again reuses its file. | N/A | [ ] | N/A |
| HAND-05 | After HAND-04: quit Studio, `adf daemon stop`, in `chatgpt-subscription` run `Move-Item -Force auth.replaced.<time>.json auth.daemon.json` (a plain rename fails: `auth.daemon.json` exists), `adf daemon start`, `adf auth`. | The daemon is signed in as B. | N/A | [ ] | N/A |
| HAND-06 | Same as HAND-04 with account A on both sides. | No accounts dialog (the summary dialog still appears). Both sessions are kept, each on its side (no `auth.replaced.*.json`). After switching back to E, Studio's ChatGPT agents run signed in. | N/A | [ ] | N/A |
| HAND-07 | Replace the contents of `studio-handover.json` with `{`; change modes (either direction) and Restart. | After the restart the summary says "Studio runs <mode>, but part of the handover is not done." with "Sign-ins: kept, retried at the next start (not moved: …studio-handover.json cannot be read (…). Fix or delete it, then restart Studio; until then ChatGPT, Grok and MCP sign-ins stay where they are)". | [ ] | [ ] | N/A |
| HAND-08 | L with a daemon started by `adf daemon start`; switch to E. | Summary: "Sign-ins: kept, retried at the next start (not moved back: the ADF daemon pid N (started by cli) still runs on these settings and could refresh a token while Studio moves it. Stop it (adf daemon stop) and restart Studio; …)". After `adf daemon stop` and a restart, the next summary lists them moved back. | [ ] | N/A | N/A |
| HAND-09 | In L, delete `studio-handover.json`; switch to E. | The summary: "…studio-handover.json is missing, so Studio cannot tell its sign-ins from the daemon's own; ChatGPT, Grok and MCP sign-ins stay with the daemon. Sign in again in Studio where needed". The `studio-runtime:` keychain entry is deleted. | [ ] | N/A | N/A |
| HAND-10 | Quit Studio (E); `adf daemon start`; launch Studio (E) and switch to L. | Studio attaches to the CLI daemon (no restart of it). The moved ChatGPT session works in the daemon at once: agent-2's next turn runs, no "signed out". The daemon log shows the credential reload. | N/A | [ ] | N/A |
| HAND-11 | Linux without a Secret Service only: with an app-level MCP sign-in held by Studio, E → L. | The summary after the restart lists "MCP sign-ins: stay in Studio (…); agents use their own sealed copies" and "Runtime identity: not shared: …. The daemon runs as its own runtime, and files it stamps show as "recognized" in Studio's review". Windows and macOS: N/A. | N/A | [ ] | N/A |

## 27. Several clients on one daemon (MULTI)

Studio in L (or R) and the terminal app (`adf`) on the same daemon. Guide:
[Studio backend › Studio and the terminal app together](../guides/studio-backend.md#studio-and-the-terminal-app-together).
E items use agent-1 (`fs_write`) as the other writer.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MULTI-01 | Open agent-1 `notes.md` in Studio and keep typing (no pause of 0.5 s, or autosave saves first) while in the TUI (Files) you edit and save the same file. | Studio keeps your text. Strip: "notes.md was changed by the terminal app while you were editing. Your changes are not saved." with Reload and Keep mine. (An `adf` command or script as the writer reads "the CLI or another API client".) | N/A | [ ] | [ ] |
| MULTI-02 | MULTI-01 → Reload. | Studio shows the TUI's text; your text is discarded; nothing is written. | N/A | [ ] | [ ] |
| MULTI-03 | MULTI-01 → Keep mine. | Your text is saved over theirs; `adf file agent-1 notes.md` shows it. | N/A | [ ] | [ ] |
| MULTI-04 | With the strip up: Ctrl+S; close the tab; switch to agent-2. | Ctrl+S saves nothing and focuses Reload. Close and switch ask "Discard your unsaved changes to notes.md? Someone else changed it while you were editing. OK discards your version. Cancel keeps it open." ("them" for several files); Cancel keeps the tab and the agent. | [ ] | [ ] | [ ] |
| MULTI-05 | Keep typing in agent-1's config panel (no pause of 0.3 s, or autosave saves first) while in the TUI `/config edit` saves a change. | Config panel strip: "The config was changed by the terminal app while you were editing. Your changes are not saved." Reload / Keep mine as MULTI-02/03. | N/A | [ ] | [ ] |
| MULTI-06 | With the strip up, quit Studio (menu Quit); relaunch. | Notice: "Studio kept your unsaved version of agent-1/notes.md from the last session, which ended while someone else's change was waiting for your answer." with Show folder and Dismiss. Show folder opens `<userData>\recovered`, which holds `agent-1-<hash>\notes.md` with your text. Dismiss: the notice goes; the copy moves to `recovered\archive\<time>\`; the next launch shows no notice. | [ ] | [ ] | [ ] |
| MULTI-07 | As MULTI-06, but kill Studio (`taskkill /F /IM "ADF Studio.exe"`) instead of quitting. | Same notice and copy at the next launch. | [ ] | [ ] | [ ] |
| MULTI-08 | In the TUI open `notes.md` in the external editor (Files → `e`); in Studio edit and save it; save and close the external editor. | TUI: "Concurrent change: notes.md" with "WARNING: notes.md changed while you were editing (their change: …). Writing replaces that version." and Overwrite / Discard. Overwrite saves yours; Discard writes nothing ("Not written. Your edited copy is kept at <path>"). Only if Studio saves again between that check and the write: "notes.md was changed by another Studio window after you opened it. Overwrite replaces their version with yours. Reload keeps theirs (…)." with Overwrite / Reload theirs. | N/A | [ ] | [ ] |
| MULTI-09 | Set agent-1 `umbilical.stream_deltas` to false. In the TUI open agent-1's chat view and send a long prompt; watch agent-2 in the fleet sidebar (stay in the chat view: only the chat view's agent streams tokens). | agent-1's reply streams token by token in the TUI (and in Studio, which has it open); the TUI's Events tab and activity log are not flooded with `turn.delta`; agent-2's state and turns update in the sidebar. | N/A | [ ] | [ ] |
| MULTI-10 | Keep-running off, Studio started the daemon, TUI connected. Quit Studio; then quit the TUI. | After the Studio quit the TUI shows "The daemon stays up because this app is connected: Studio quit; the daemon it started keeps running while you are connected and stops when the last client disconnects"; `adf daemon status`: running. After the TUI quits the daemon stops (`adf daemon status`: not running). | N/A | [ ] | N/A |
| MULTI-11 | As MULTI-10, but relaunch Studio before quitting the TUI. | The TUI shows "The daemon is no longer waiting for this app to close". Quitting the TUI leaves the daemon running; quitting Studio afterwards stops it. | N/A | [ ] | N/A |
| MULTI-12 | As MULTI-10, but kill Studio instead of quitting, and wait 60 s. | About 60 s after the kill the TUI shows "The daemon stays up because this app is connected: studio closed; …"; the daemon stops when the TUI quits. | N/A | [ ] | N/A |
| MULTI-13 | Keep-running off, no TUI: kill Studio and relaunch it within 60 s. | Studio attaches to the running daemon. About 60 s after the kill (the crashed session expires) Studio shows the notification "The ADF daemon keeps running while 1 other client is connected, and stops when the last one closes. (studio closed; …)". The daemon stops when this Studio quits. (As built; log it if the notice is confusing.) | N/A | [ ] | N/A |

## 28. Daemon status and outages (STAT)

Guide: [Studio backend › Local server status](../guides/studio-backend.md#local-server-status)
and [When the daemon is not reachable](../guides/studio-backend.md#when-the-daemon-is-not-reachable).

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| STAT-01 | Settings → Connection → This computer → ADF daemon row (L), the status bar (R); `adf daemon status`. | L, Studio started it: "Connected · pid N · started by this Studio", and **Details** shows "URL: http://127.0.0.1:7385" and "Version: V"; `adf daemon status` shows `started   by studio`. L, after `adf daemon start` first: "… started by the ADF CLI", `started   by cli`. R: the status bar names the connection, its address in the tooltip; no daemon row. | N/A | [ ] | [ ] |
| STAT-02 | Help menu while connected; then kill the daemon. | Connected: Open Daemon Log opens `logs\adf-daemon.log` in the default viewer; no status line. Disconnected: a disabled line "ADF daemon: not connected (http://127.0.0.1:7385), retrying" and Reconnect to the ADF Daemon. R: Open Daemon Log is disabled (the log is on the server: `adf daemon logs`). | N/A | [ ] | [ ] |
| STAT-03 | Run `adf daemon stop` and launch Studio in L at once, while the daemon is still stopping. | Task-bar progress; Settings → Connection and Help show "Waiting for the ADF daemon (pid N)…"; one notification "Waiting for the ADF daemon (pid N)… Studio connects when it answers."; once the old daemon is gone Studio starts one ("Starting the ADF daemon…") and shows Connected, "started by this Studio". | N/A | [ ] | N/A |
| STAT-04 | L: with a daemon running, launch Studio with `ADF_DAEMON_TOKEN=wrong` in its environment. | Dialog "ADF daemon not available": "Studio could not connect to an ADF daemon." with "A daemon is running on port 7385 but Studio cannot authenticate to it (token from ADF_DAEMON_TOKEN)." and the recovery sentence. Settings → Connection: "Not connected". No fallback to E. | N/A | [ ] | N/A |
| STAT-05 | L: a daemon on other settings holds port 7385: copy Studio's `daemon-token` into `<folder>` (or Studio gets the 401 sentence of STAT-04 instead), then `$env:ADF_DAEMON_SETTINGS='<folder>\adf-settings.json'; adf daemon start`; launch Studio in L. | The failure dialog says "The ADF daemon running on this machine (pid N) uses <folder>\adf-settings.json, not <Studio's settings>." | N/A | [ ] | N/A |
| STAT-06 | Kill the daemon; press the status bar's Kill button (tooltip "Stop all agents and disable mesh"). | Dialog "Emergency stop did not reach the ADF daemon." with "Cannot reach daemon at …" and "Agents may still be running."; the status bar keeps its state. Nothing restarts the daemon; after you start it, its agents are listed as they are. | N/A | [ ] | [ ] |

## 29. Remote computer (REM)

Guide: [Studio backend › Remote computer](../guides/studio-backend.md#remote-computer).
`<host>` is the daemon URL's host.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| REM-01 | Settings → Connection → Add connection → Address: try `http://192.168.x.y:7385`, `http://100.x.y.z:7385` (an address in 100.64.0.0/10), `http://<machine>.<tailnet>.ts.net:7385`, `http://127.0.0.1:7386`, `https://<name>`, `ftp://x`. | LAN IP and MagicDNS over http show "I trust this network; the token is sent unencrypted."; Next stays disabled until it is checked. `100.x.y.z`, loopback and https need no confirmation. `ftp://x` shows why it is refused. | N/A | N/A | [ ] |
| REM-02 | Add with the right address, Use a token instead, the server's token, Save. | "Saved <name>." (or, with remote access off on the server, "Saved without a fingerprint; identity not checked."); Done. The connection connects at once. The token is checked before it is saved. | N/A | N/A | [ ] |
| REM-03 | Add connection with a token against: the server's daemon stopped; a proxy whose daemon is stopped; an https URL with an untrusted certificate; a URL that redirects; a non-ADF web server. | In order: "Cannot reach the ADF daemon at <url> (…). Check the address, …"; "<url> answered HTTP 502: a proxy answers there, but the ADF daemon behind it does not. …"; "The TLS connection to <url> failed (…). Studio checks certificates and has no option to skip that: …"; "<url> answered a redirect (HTTP 30x …). Studio does not follow redirects, …"; "<url> does not answer as an ADF daemon (…). Check the address and port." | N/A | N/A | [ ] |
| REM-04 | Add connection with a token to a daemon without remote access (no fingerprint); then another such address. | The second asks "Replace connection": "Replaces <first>."; Cancel keeps the first. The token is never shown again anywhere. | N/A | N/A | [ ] |
| REM-05 | A saved connection whose plain-http LAN address was paired with `adf pair` (not confirmed in Studio). | Its runtime is not connected, with "<url> is plain http to an address that is not loopback or a tailnet address; pair <name> in Studio to confirm the network, or use https://." in a notification and its state in its group. This computer is not affected. No fallback to E. | N/A | N/A | [ ] |
| REM-06 | While connected, change the server's token (restart its daemon with another `ADF_DAEMON_TOKEN`). | The next request ends the connection: "The ADF daemon at <url> refused the token; choose Add device on <host> and pair again." One 401 in the server's log, no retry storm. | N/A | N/A | [ ] |
| REM-07 | Open agent… (Ctrl+O). | A picker titled "Open an agent on <host>": Locations (Home folder, each Tracked folder, Agents folder), Up, a path field ("type a folder path on the daemon host and press Enter"), Hidden, folders and `.adf` files of the server. Arrow keys and Enter move and open. Open loads the agent from the server. | N/A | N/A | [ ] |
| REM-08 | New agent (sidebar or File → New ADF Agent); type `agent-1` in the fixtures folder and press Create. | A picker titled "New agent on <host>" with a name field. After Create, an existing name shows "agent-1.adf already exists in this folder. Replace it?" and the button reads Replace. A new name creates the agent on the server and opens it. | N/A | N/A | [ ] |
| REM-09 | In a picker: New folder, type a name, Create folder; then the name `..`. | The folder is created on the server and listed. `..` is refused: "The name contains characters not allowed in file names." | N/A | N/A | [ ] |
| REM-10 | Track Folder… (Ctrl+Shift+O); Settings → General → Files → Agents folder; Home composer folder. | Each opens the server-side picker ("Track a folder on <host>", "Choose a folder on <host>"); the chosen path is a server path. | N/A | N/A | [ ] |
| REM-11 | On the server set `ADF_DAEMON_BROWSE_ROOTS=<folder>` and restart its daemon; open a picker. | Locations list that folder ("Daemon browse root") plus tracked folders and the agents folder; the home folder is not listed. | N/A | N/A | [ ] |
| REM-12 | Open Recent → an entry whose file was deleted on the server. | "No agent file at <path> on <host> (…)." with no advice to use Open Recent. Nothing on this computer is read. | N/A | N/A | [ ] |
| REM-13 | Studio running in R: double-click a local `.adf` in Explorer (second instance hand-off). | The upload question of FILE-08 ("<name>.adf is on this computer, not on <host>."); Cancel uploads nothing; Upload a copy… offers the tracked folders and the agents folder. | N/A | N/A | [ ] |
| REM-14 | agent-6 calls a tool of its HTTP OAuth MCP server that is not signed in. | A native question "Open a sign-in page on <page host>?" with "The ADF daemon at <host> asks to open <page host> in your browser (…). Open it only if you started this sign-in." Cancel: nothing opens, and no further dialog. Open page: the browser signs in, the callback is handed to the daemon, the tool call continues. | N/A | N/A | [ ] |
| REM-15 | Settings → MCP servers: add the HTTP OAuth server and Test it. | The same question before the page opens; after sign-in the test lists the tools. | N/A | N/A | [ ] |
| REM-16 | REM-14 with the callback port in use on this computer (another program listening on it). | The page opens without the relay, and a dialog "agent-6: sign-in to "<server>"" says "Port N on this computer is in use, so Studio cannot take the sign-in callback for the daemon. …". | N/A | N/A | [ ] |
| REM-17 | agent-6: Identity tab Reveal; provider override key field (Settings → Providers → agent overrides); Settings → MCP servers credential panel; save untouched; then edit one character of a placeholder and save, in the override key field and in the MCP panel. | Reveal and the provider key field say "Stored credential values stay on the daemon's machine: a remote daemon never sends them to Studio." The MCP panel shows a placeholder. Saving untouched keeps the stored values (the server still connects). An edited placeholder is refused in both places and the error is shown: "… was shown as a placeholder (…), so an edit of it cannot be saved. Clear the field and type the whole value." | N/A | N/A | [ ] |
| REM-18 | On an agent whose credentials are locked on the server, save a per-agent provider key (Settings → Providers → agent overrides) or an Identity tab value. | The question says "This agent's credentials are locked on the daemon's machine." (for a sealed value: "The saved <purpose> of this agent is sealed, and its credentials are locked on the daemon's machine."); L and E say "on this machine". Replace / Cancel. | N/A | N/A | [ ] |
| REM-19 | L with the server saved and agent-2 running on it: quit Studio; Remove the server; Connect on Inside Studio (legacy) and Restart. | Studio never stops the server's daemon or its agents (`adf --url … agents` lists agent-2 running after each step). Nothing moves to or from the server. Inside Studio lists the server with no state. | N/A | N/A | [ ] |

## 30. Upgrading from 0.7.x (UPG)

Guide: [Studio backend › Upgrading from 0.7.x](../guides/studio-backend.md#upgrading-from-07x).
Setup for each item: Studio 0.7.8 installed and used (it ran agents inside Studio, E: no
`studio-backend.json`), quit; then install this build and launch it. Paths are
in Studio's user data folder (`%APPDATA%\ADF Studio`). Keep a copy of the
folder to repeat an item.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| UPG-01 | 0.7.8 with ChatGPT and Grok signed in, one app-level HTTP OAuth MCP server signed in, theme dark, agent-2 and agent-3 set to autostart, an owner identity, and no `ADF` entries in Credential Manager (or Keychain Access). Upgrade, launch. | The window opens first; no dialog before it. Once Studio connected to the daemon, one dialog over the window: "Agents now run in a background service on this computer (the ADF daemon)." with "Moved: Client settings, Owner phrase, Runtime identity, ChatGPT session, Grok session, MCP sign-ins." (the items that applied), "Agents set to start automatically now start in the daemon.", ""Inside Studio (legacy)" stays in Settings → Connection for this release only, as a fallback." and "Settings → Connection has the details.", buttons OK and Open the Guide. Theme still dark. `studio-backend.json` says `"mode": "local"`. agent-2 and agent-3 run (`adf agents`), each once (one Telegram poller for agent-3, CHAN-08). ChatGPT and Grok agents run without signing in. | N/A | [ ] | N/A |
| UPG-02 | After UPG-01: the notice's Open the Guide. | The browser opens the guide at "Upgrading from 0.7.x". | N/A | [ ] | N/A |
| UPG-03 | After UPG-01: Settings → Connection; then quit and launch again. | A "Default changed" row: "On *date*, Studio *version* moved agents from inside Studio to this computer.", with "Moved: …." under **Details**. The second launch shows no notice and no summary dialog; the row is still there. | N/A | [ ] | N/A |
| UPG-04 | After UPG-01: `adf identity`; Credential Manager; agent-1's review panel. | As HAND-02: runtime `studio (adopted)`, an `ADF` entry `studio-runtime:<12 hex>` and `ADF / owner-mnemonic`, agent-1 shows as yours. macOS: one keychain question for the daemon ("Always Allow"), and the notice says "macOS asks once whether the ADF daemon may read Studio's runtime key from the keychain." | N/A | [ ] | N/A |
| UPG-05 | Fresh install of this build on a machine that never ran Studio (or `--instance=9` with an empty folder). | No dialog at all (MODE-01). | N/A | [ ] | N/A |
| UPG-06 | Setup as HAND-04 on 0.7.8: Studio signed in to ChatGPT as A; quit; `adf daemon start`; `adf auth login chatgpt` as B; `adf daemon stop`. Upgrade, launch; choose **Keep A (Studio)**. | The accounts dialog of HAND-04 on the "ADF Studio is starting" window, in front (macOS: a sheet, also with another app full screen). Then the notice lists the ChatGPT session moved; `adf auth` shows A; B is in `chatgpt-subscription\auth.replaced.<time>.json`. | N/A | [ ] | N/A |
| UPG-07 | Upgrade with 0.7.8's `adf` from npm running its daemon (`adf daemon start` with the 0.7.8 CLI). Launch. | Over the window: "An older ADF daemon (adf 0.7.8, started by the npm CLI) is running and uses the same settings." (or "An ADF daemon that Studio cannot identify is running on port 7385 …") with "Stop it with `adf daemon stop`, update the CLI (`npm i -g @agentdocumentformat/cli@latest`), then restart Studio." Settings → Connection: "Agents run inside Studio for this session only: …". The dialog says "Studio did not autostart your agents: that daemon may be running them." and how to start one ("To run one here, stop it there (`adf stop <name>`), then press Start in Studio."). No `studio-backend.json`; `chatgpt-subscription\auth.json` still there; no agent started by Studio (each runs once, in the old daemon); main.log has "[autostart] Boot autostart skipped: …". After doing what it says and restarting: UPG-01. | N/A | [ ] | N/A |
| UPG-08 | Linux without a Secret Service only: UPG-01. | The notice says "Stays in Studio: Runtime identity (…); MCP sign-ins (left in Studio: …)." and "The daemon runs as its own runtime: agents made in Studio unlock there only after adf identity restore or adf identity trust-daemon." Windows and macOS: N/A. | N/A | [ ] | N/A |
| UPG-09 | After UPG-01: Settings → Connection → Inside Studio (legacy) → Connect, then Restart. | "Next launch: Inside Studio (legacy)." with Restart first; no dialog. After the restart the summary lists the sign-ins moved back (MODE-05, HAND-03); `studio-backend.json` says `"mode": "embedded"`; the next launch stays in E and shows no upgrade notice. | [ ] | N/A | N/A |
| UPG-10 | After UPG-09: quit, `adf daemon stop`, install 0.7.8, launch. | 0.7.8 runs the agents, signed in to ChatGPT, Grok and the MCP server, theme kept. (Installing 0.7.8 straight after UPG-01, without UPG-09: the sign-ins and the theme are missing; the guide says so.) | [ ] | N/A | N/A |
| UPG-11 | Before UPG-01's launch, put `{` in `studio-backend.json` (as if a write broke it). Launch; choose **Run Inside Studio (Legacy)**. | Before anything moves, on the "ADF Studio is starting" window: "Studio cannot use its backend settings file." naming the path and "could not be parsed and was moved to …corrupt-…", with Run on This Computer (Recommended) and Run Inside Studio (Legacy). Then agents run inside Studio; `studio-backend.json` says `"mode": "embedded"`; sign-ins are still in Studio. | [ ] | N/A | N/A |
| UPG-12 | Windows: replace `studio-backend.json` with a folder of that name (or deny your account read access to the file). Launch. | "Studio cannot use or replace its backend settings file." with the path, the error (EISDIR or EACCES) and "Fix its permissions or delete it, then restart Studio.", buttons … for This Launch. The chosen backend runs for this launch only ("Agents run … for this session only: …"); no sign-in moves; the next launch asks again. | N/A | [ ] | N/A |
| UPG-13 | UPG-01, but quit Studio (or kill it) before the daemon connects, so the notice is not shown; launch again. | The second launch moves nothing more and shows the notice once, listing what the first launch moved. A third launch shows none. | N/A | [ ] | N/A |

## 31. Remote access (REMOTE-ACCESS)

Guide: [Studio backend › Remote access](../guides/studio-backend.md#remote-access).
Design: [remote-access.md](remote-access.md). Two computers: the host
(Studio in L, runtime alias `agent-1-pc`) and the laptop (runtime alias
`agent-2 laptop`), on one LAN and one tailnet. Host items are walked in L,
in Settings → Networking. Laptop items are walked in the laptop's mode
before it switches (L), and again after **Connect** (R).

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| RA-01 | Host: Settings → Networking → Remote access → toggle **Remote access**. Cancel; then turn it on. | One dialog, title "Turn on remote access": "Devices you pair or add get full control of this computer's agents. A device token is as powerful as your seed phrase." (Windows: also "Choose Allow on private networks."), buttons Turn on / Cancel. Cancel: still off. Turn on: under the toggle "Listening on 192.168.x.y, 100.x.y.z."; agents keep running (same pid in `adf daemon status`). | N/A | [ ] | N/A |
| RA-02 | Host, first time on: Windows Defender Firewall prompt; macOS 15 Local Network prompt on the laptop at its first discovery. | Windows asks for ADF Studio; Allow on private networks. macOS asks "ADF Studio would like to find and connect to devices on your local network". Studio adds no firewall rule itself. | N/A | [ ] | [ ] |
| RA-03 | Host, remote access on, joins a network it never joined (a phone hotspot; on Windows one marked Private); **Not now**; then **Allow on this network**; then back home. | Within 10 s a strip under the title bar (no dialog; the window stays usable): "Remote access paused on *network*.", **Allow on this network** / **Not now** (on a Public or macOS/Linux network also "Public network. The token is sent unencrypted."). Wi-Fi off and on: no new strip until Studio restarts. Status line "Network: *network* (not allowed) · LAN …, not listening"; under the toggle "Paused on *network*."; `netstat -ano \| findstr 7385` and the mesh port show only 127.0.0.1. **Allow on this network** in the status line: both listen within 10 s and **Allowed networks** lists it. Back home (allowed before): listening again without a question. | N/A | [ ] | N/A |
| RA-21 | Host: **Allowed networks** → **Remove** on the current network; then `adf daemon remote status`, `adf daemon remote allow-network`, `forget-network <name>`. E (no daemon): **Allow LAN access** on a new network. | Remove: listeners close at once (`netstat` shows only 127.0.0.1), the row goes, the status line offers **Allow on this network** again. CLI: "Networks now:" with "paused (allow: adf daemon remote allow-network lan-…)", "Allowed networks (N):"; allow-network listens; forget-network closes. E: the same dialog; Allow opens the mesh's LAN listener. A device token never changes the list (403). | [ ] | [ ] | N/A |
| RA-04 | Host: Addresses with Tailscale running; **Enable Tailscale https**; Copy each. | Order: Tailscale https (after enabling), tailnet, LAN, `.local`. Tailnet and https say Encrypted; LAN and `.local` say Not encrypted with "Anyone on this network can read the token." The dialog "Enable Tailscale https" shows `tailscale serve --bg 7385` and runs nothing on Cancel. | N/A | [ ] | N/A |
| RA-05 | Host: **Add device** → **Use a token instead**, name `agent-2 laptop`, **Create token**; Copy; Done; leave and reopen Settings. Laptop: Settings → Connection → Add connection, the LAN address, Use a token instead, the token, Save. | One dialog "Add device"; the pairing window closes on Use a token instead. The token (`adfd_…`) shows once with Copy and Done and "On the device: Settings → Connection → Add connection."; after Done nothing shows it again. Notice "Device added: agent-2 laptop." Laptop: "Saved agent-1-pc." and a Paired row. The host's own token (`adf daemon token`) is refused from the laptop. | N/A | [ ] | [ ] |
| RA-06 | Host: **Add device**. Laptop: Settings → Connection → agent-1-pc (Not paired) → **Pair**, enter the code. Host: Allow. Laptop: Connect. | Host dialog "Add device" opens on the code in large digits, "Expires in 2:00 · 20 wrong codes left · Fingerprint …", with Use a token instead. Laptop dialog "Pair": "Waiting for agent-1-pc to allow this device…". Host dialog titled "Allow device" naming the laptop's address, "this network" or "your tailnet", ADF Studio, and the seed-phrase sentence. After Allow: the host dialog "Added agent-2 laptop." with Done, notice "Device added: agent-2 laptop."; laptop "Saved agent-1-pc." with Done and Connect; the row is Paired with Connect, never Pair; `adf remotes` on the laptop lists it; the saved URL is the tailnet one when both are offered. Connect connects. | N/A | [ ] | [ ] |
| RA-07 | RA-06 with Studio on the host minimised behind another app. | An OS notification "Allow device"; clicking it brings Studio forward with the dialog. | N/A | [ ] | N/A |
| RA-08 | RA-06, but Deny on the host. | Laptop: "agent-1-pc denied this device."; nothing saved; no new device and no notice on the host. | N/A | [ ] | [ ] |
| RA-09 | Laptop: enter a wrong code five times; then the right one. | Laptop: "Wrong code. 4 tries left." … then "Wrong code and no tries left; choose Add device on agent-1-pc for a new code."; the right code then gets "Too many wrong codes from this computer for this pairing window. Ask the host to open a new one." Host: the notice "Pairing: a device was locked out after 5 wrong codes."; the window stays open and shows "1 device locked out after 5 wrong codes."; another device can still pair in it. 20 wrong codes in all close the window ("Pairing closed after too many wrong codes."). | N/A | [ ] | [ ] |
| RA-10 | Host: **Add device**, then Cancel (or wait 2 minutes). Laptop: enter the old code. | Laptop: "The pairing window on agent-1-pc is closed; choose Add device there for a new code." | N/A | [ ] | [ ] |
| RA-11 | Windows host: block ADF Studio in Windows Security (or Cancel its firewall prompt). Laptop: Pair on the LAN address. | Laptop: "Studio could not reach agent-1-pc at http://192.168.x.y:7385. The host's firewall may block port 7385." Host status line: "Firewall blocked" and the sentence how to allow it. | N/A | [ ] | [ ] |
| RA-12 | Laptop, both computers on one LAN and one tailnet: open Settings → Connection with the host on; leave Settings. | agent-1-pc is one row (the host's LAN record names its tailnet address, TXT `ts`), at its tailnet address, with its fingerprint, "Pairing open" while the host's window is open, Not paired with Pair before RA-06 and Paired with Connect after it (never Pair). A plain-http row's Pair dialog keeps **Code** disabled until "I trust this network; the token is sent unencrypted." is checked. | N/A | [ ] | [ ] |
| RA-13 | Host: **Devices** while the laptop is connected; **Revoke**; Cancel; Revoke again. | "agent-2 laptop", "Paired · Connected now" (a token-added one: "Token · Never connected" until used). Dialog "Revoke device": "agent-2 laptop is disconnected now and its token stops working."; Cancel keeps it. Revoke: notice "Device revoked: agent-2 laptop."; the laptop loses the connection at once. | N/A | [ ] | N/A |
| RA-14 | Host, keep-running off, Studio started the daemon, the laptop connected: menu Quit; Cancel; Quit again; Keep running. Repeat with Stop daemon. | Dialog "Quit": "1 device connected", "Keep the daemon running for them, or stop it. …", buttons Keep running, Stop daemon, Cancel. Cancel: Studio stays open. The next quit asks again. Keep running: Studio quits, `adf daemon status` shows it running, the laptop stays connected, keep-running is still off. Stop daemon: the daemon stops and the laptop loses it. | N/A | [ ] | N/A |
| RA-15 | As RA-14 by closing the window (Windows ✕) and by the tray's Quit. With nobody connected, or keep-running on, or a CLI-started daemon: quit. | Same dialog in both paths. Without connected devices, with keep-running on, or with `adf daemon start`: no dialog. | N/A | [ ] | N/A |
| RA-16 | Host, keep-running off, remote access on: the **On quit** row; **Keep running**. Then Settings → Connection. | "Devices lose the connection when Studio quits." The button turns keep-running on and the row goes. Settings → Connection → This computer → Keep running after quit is On. | N/A | [ ] | N/A |
| RA-17 | Host: turn remote access off with the laptop connected; then look at the toggle in E and R. | Off: "Off." under the toggle; the laptop loses the connection; Devices is kept. E: the toggle is disabled with "Remote access needs Local as the connection (Settings → Connections)." R: Remote access shows only "Change on <name>." (no toggle, addresses, devices or Allowed networks), and no status line at the top of Networking. | [ ] | [ ] | [ ] |
| RA-18 | Laptop on Linux without a Secret Service keyring: Pair; Cancel in the dialog; Pair again and choose Save to file. Then `adf pair` the same way. | A dialog titled "Keychain unavailable": "The token can be saved in a file only you can read." with the reason, buttons Save to file / Cancel. Cancel: "The token was not saved (…)", nothing saved. Save to file: the token is in `cli-remote-tokens.json` (user-only). `adf pair` prints the same line and asks "Save to file? [y/N]". | N/A | [ ] | N/A |
| RA-19 | Host: set the runtime alias (Settings → Identity) to `agent-1 desk`; wait 10 s. Laptop: Settings → Connection, Pair. | The row, the Pair dialog and the host's own Add device dialog use "agent-1 desk"; the laptop's device appears on the host under its runtime alias. | N/A | [ ] | [ ] |
| RA-20 | Host, Networking: mesh with "Allow LAN access" on, three agents with visibility lan, public and localhost. | Mesh shows "1 agent visible on LAN · 1 public · 1 private". With an agent public the server line says "all interfaces"; without it, "127.0.0.1, 192.168.x.y, 100.x.y.z". | [ ] | [ ] | N/A |

## 32. Settings scopes (SCOPE)

Guide: [Studio backend › Connection](../guides/studio-backend.md#connection).
Design: [settings-scopes.md](settings-scopes.md). The host and laptop of §31;
`box-1` is the host's saved connection name on the laptop.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| SCOPE-01 | Open Settings, without and with a saved server. | Two groups: **Studio** (Connection, Appearance, Notifications, Updates, Privacy, About) and the runtime pages, Prompts … Usage. Without a saved server the runtime group has no heading. With one, it is headed **Runtime** with a picker (*name* (Local), box-1). No question marks; at most one short sentence under each title. | [ ] | [ ] | [ ] |
| SCOPE-02 | Studio → Connection with the host saved, and a third ADF computer found but not saved. | Rows: *name* (Local) (Connected in L, Connect in E), box-1 (its state in L; no state in E; no action), the third (Not paired, Add). No Mode control, Daemon URL, Token or Test connection anywhere. | [ ] | [ ] | N/A |
| SCOPE-03 | Laptop: `adf pair agent-1-pc` in a terminal while Studio runs; then open Studio → Connection. Then Add a computer in Studio and run `adf remotes`. | The CLI-paired host is a row and connects at once, without Connect; the Studio-added one is in `adf remotes`. One list, one keychain entry per fingerprint (`remote-token:<fingerprint>`). | N/A | [ ] | [ ] |
| SCOPE-04 | macOS laptop: pair with `adf pair` while Studio runs (first read of that keychain item by ADF Studio); deny the keychain prompt; then Help → Reconnect and allow. | The prompt appears; Studio stays responsive. Deny: that runtime is not connected, with "The OS keychain did not give the token for box-1; allow ADF Studio to use it, or pair again."; no restart. Allow: it connects. | N/A | [ ] | N/A |
| SCOPE-05 | A saved row's More (⋯) → Remove; Cancel; Remove again, with an agent window of box-1 open. | Native dialog "Remove box-1": "Removes the address and token from Studio and adf.", "Closes 1 agent window." and, on its own line, "Still listed on box-1; revoke it there." Cancel keeps it. Remove: "Removed box-1."; the window closes; gone from `adf remotes`. This computer has no Remove (a stray call: "In use."). | [ ] | [ ] | [ ] |
| SCOPE-06 | Add with the host's address: Next, enter the code shown by Add device on the host. | "Check that agent-1-pc shows fingerprint <fingerprint>."; Pair; after Allow: Done; the host connects. | N/A | [ ] | [ ] |
| SCOPE-07 | R: Runtime picker box-1 → Networking, Identity, Compute; an agent's Identity tab Reveal; the browser viewer. | Networking: no status line, no Allowed networks, Remote access says "Change on box-1.", firewall line "Change on box-1.", no Agent endpoints. Identity: Owner Identity says "Change on box-1." (no Back up, Import or Restore), no Agent directory URL. Reveal: "Stored on box-1." Browser viewer: "Open on box-1." | N/A | N/A | [ ] |
| SCOPE-08 | Status bar in L without, then with the host saved; stop the host's daemon; start it again. | Without: nothing next to the version. With: one group for *name* (Local) (no icon) and one for box-1 (remote icon, the address in the tooltip); stopped: "box-1 · Not connected, retrying" in its group, its Kill disabled, and its pages "Not connected to box-1."; back: "box-1". A click on a name opens Studio → Connection. | N/A | [ ] | [ ] |
| SCOPE-09 | Older deep links: Home's token count; the daemon failure dialog. | The token count opens Runtime → Usage; the failure dialog offers Reconnect, Run Inside Studio for This Session and Open Daemon Log (no Settings link). | [ ] | [ ] | N/A |
| SCOPE-10 | Host on an older ADF (no TXT `ts`) on one LAN and one tailnet with the laptop. | Not saved: two Not paired rows, one per address (the merge needs the host's own word); saved: one row; no fingerprint warning. After updating the host, one row. | N/A | [ ] | [ ] |

## 33. Multi-runtime (MRT)

Guide: [Studio backend › Connection](../guides/studio-backend.md#connection),
[Upgrading from remote mode](../guides/studio-backend.md#upgrading-from-remote-mode).
Design: [multi-runtime.md](multi-runtime.md) §9.3. On a packaged build; the
host and laptop of §31, `box-1` the host's saved name on the laptop.

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MRT-01 | Laptop with no saved connection: copy `studio-backend.json` and `studio-client-settings.json`, launch, open an agent, quit; compare. | Both files keep their bytes. Sidebar, Go to Agent, the Mesh view, the status bar, Settings, the bell, toasts and agent window titles show no runtime name, picker, group heading or **Runtimes** button. Connections is the one line **Remotes** with **Add**. | N/A | [ ] | N/A |
| MRT-02 | Add box-1 (code). | Done; nothing restarts. Sidebar: *name* (Local), then box-1, each a group; status bar: one group each, This computer first; Settings: **Runtime** picker; `studio-backend.json` gains `runtimeOrder: ["remote:box-1"]`. | N/A | [ ] | [ ] |
| MRT-03 | Chat with agent-1 on This computer and agent-2 on box-1 at once (agent-2 in an agent window). | Both stream; the agent window's title is "agent-2 · box-1". Approvals from both arrive in one bell, each row named ("*name* (Local) · agent-1", "box-1 · agent-2"), and answer on their own computer. | N/A | [ ] | [ ] |
| MRT-04 | Stop box-1's daemon (or its network) mid-turn; then start it. | Only box-1's group says "Not connected, retrying" and greys; its chats end after 15 s; agent-1's turn completes. No modal dialog; one notification. Help: "box-1: …" and **Reconnect**. Back: it connects without a restart. | N/A | [ ] | [ ] |
| MRT-05 | box-1 fails (REM-06, a refused token); Help → Reconnect after pairing again. | Reconnect connects it without restarting Studio; its agent windows keep their unsaved text as recovery copies, close, and reopen once it connects. | N/A | [ ] | [ ] |
| MRT-06 | **Kill** in box-1's group. | "Stops all agents and mesh on box-1"; agents on This computer keep running. | N/A | [ ] | [ ] |
| MRT-07 | An install an older Studio left on box-1 in remote mode (`"mode": "remote"`, `remote.name: "box-1"`), with an agent window of the server open at its last quit. Launch this build. | One dialog over the window: "box-1 is in Settings → Connections." This computer's daemon starts and its autostart agents run (no hold). `studio-backend.json`: `"mode": "local"`, no `remote.name`, `runtimeOrder` with `remote:box-1` first. The server's agent window reopens once it connects; its Open Recent entries are under "box-1". The second launch shows no dialog. | N/A | [ ] | [ ] |
| MRT-08 | MRT-07 with box-1 forgotten first (`adf remotes forget box-1`). | "box-1 is no longer saved; add it again in Settings → Connections."; Studio runs This computer only. | N/A | [ ] | N/A |
| MRT-09 | Inside Studio with box-1 saved. | Connections lists box-1 with no state; nothing connects to it; no runtime groups. Connect on This computer, Restart: box-1 connects. | [ ] | N/A | N/A |
| MRT-10 | Add a second computer; quit; launch. | Order stays *name* (Local), box-1, the second (the order added), in the sidebar, the status bar, the picker and Help. | N/A | [ ] | [ ] |
| MRT-11 | `adf remotes forget box-1` while Studio runs, with an agent window of box-1 open. | Its group and its window close; This computer is not touched; `adf --remote` and `ADF_REMOTE` work as before. | N/A | [ ] | [ ] |
| MRT-12 | Quit with box-1 unreachable. | Studio quits within its budget (about 1.5 s for box-1); box-1's daemon is never stopped. | N/A | [ ] | [ ] |

---

## Appendix A. Bridge method → checklist ID

Every method of `AdfApi` (`src/preload/api.ts`). `node
scripts/check-user-testing-coverage.mjs` checks this table: every member named,
no unknown name, every cited ID present. Extra arguments name other copies of
`api.ts` (another branch's, via `git show`), checked as one bridge. IPC channels in
`src/shared/constants/ipc-channels.ts` map 1:1 to these methods, with two
exceptions: `setZoomFactor` and `platform` use no channel (renderer-local), and
`MESH_DEBUG` is defined but unused (`getMeshDebug` invokes `MESH_STATUS` with
`debug: true`).

| Bridge methods | Checklist IDs |
|---|---|
| `getAppVersion` | APP-11, DASH-06 |
| `setBadgeCount` | HIL-17 |
| `openFile` | FILE-06, FILE-07 |
| `saveFile` | EDIT-01, AGT-08 |
| `createFile` | FILE-01 |
| `createQuickAgent`, `mintIdentityDraft`, `discardIdentityDraft`, `getDefaultAgentsFolder` | FILE-02, FILE-03, FILE-04 |
| `closeFile` | FILE-10 |
| `deleteFile` | FILE-15 |
| `listTables`, `cloneFile` | FILE-11 |
| `renameFile`, `onFileRenamed` | FILE-12, FILE-13, FILE-14 |
| `getCurrentFile` | FILE-24, CRASH-02 |
| `revealInFolder` | FILE-16 |
| `getDocument`, `setDocument` | EDIT-01, EDIT-08 |
| `getAgentConfig`, `setAgentConfig` | AGT-01..AGT-09, MULTI-05 |
| `getAgentConfigWithRevision` | AGT-01, MULTI-05 |
| `onAgentConfigChanged` | AGT-10, LOOP-03 |
| `getChat`, `getChatOlder` | CHAT-13, CHAT-22, LOOP-01 |
| `setChat` | API-02 |
| `clearChat` | CHAT-12, LOOP-07, AGT-11 |
| `getInbox`, `getOutbox` | DATA-11, DATA-12 |
| `clearInbox` | AGT-11 |
| `getBatch`, `getHeader` | FILE-06, CHAT-23, PAR-06 |
| `startAgent` | FILE-22, CHAT-16 |
| `stopAgent` | CHAT-07, FILE-22 |
| `invokeAgent` | CHAT-01, LOOP-02 |
| `compactLoop` | CHAT-11 |
| `getAgentStatus` | API-01 |
| `respondToolApproval`, `alwaysApproveTool` | HIL-01..HIL-04 |
| `approveAllGatedTools` | HIL-05 |
| `respondAsk` | HIL-08 |
| `respondSuspend` | HIL-10 |
| `listPendingNotifications`, `onPendingNotificationsChanged`, `resolvePendingApproval` | HIL-06, HIL-07 |
| `getApprovalInput` | HIL-09 |
| `onApprovalReveal`, `getPendingApprovalReveal` | HIL-12, HIL-13, HIL-14 |
| `listModels` | AGT-02, PROV-01 |
| `onAgentEvent` | CHAT-01..CHAT-04, PAR-01 |
| `getSettings`, `setSettings` | SET-01..SET-11, MODE-02 |
| `listTemplates`, `onTemplatesChanged`, `templatesMigrationSeen` | TMPL-01, TMPL-05 |
| `createTemplate`, `deleteTemplate`, `resetShippedTemplate`, `setDefaultTemplate`, `renameTemplate` | TMPL-02 |
| `revealTemplate` | TMPL-04 |
| `setTemplateMeta`, `getTemplateContents`, `setTemplateConfig`, `setTemplateFile`, `addTemplateFiles`, `removeTemplateFile` | TMPL-03 |
| `checkTemplateReview`, `acceptTemplateReview` | TMPL-06, FILE-04 |
| `setZoomFactor` | APP-04, SET-02 |
| `computeStatus`, `computeInit`, `computeDestroy`, `computeSetup` | COMP-01, COMP-03 |
| `computeStop` | API-13 |
| `computeListContainers`, `computeContainerDetail`, `computeExecLog` | COMP-02 |
| `computeStopContainer`, `computeStartContainer`, `computeDestroyContainer`, `computeRebuildContainer`, `onContainerPhase` | COMP-03 |
| `computeTestExecutionTarget` | COMP-04 |
| `onBrowserSession`, `getBrowserSessionInfo` | COMP-06 |
| `getTrackedDirectories`, `addTrackedDirectory`, `removeTrackedDirectory`, `scanTrackedDirectory` | FILE-19 |
| `onTrackedDirsChanged` | FILE-20 |
| `enableMesh`, `disableMesh`, `getMeshStatus` | MESH-01 |
| `getMeshFleetStatus`, `getMeshTokenBurn`, `getMeshDebug`, `getMeshPendingInteractions` | API-03 |
| `getAgentVitals`, `getAgentActivity` | DASH-04, TIME-13 |
| `onMeshEvent` | MESH-07, MESH-14 |
| `getMeshMapPoll`, `getMeshRecentTools` | MESH-09, MESH-14 |
| `getMeshServerStatus`, `restartMeshServer`, `startMeshServer`, `stopMeshServer` | MESH-02 |
| `getMeshServerLanIps` | MESH-03 |
| `getDiscoveredRuntimes` | MESH-05 |
| `getPeerSharedFile`, `getPeerAgentHealth` | MESH-13 |
| `checkLanFirewall` | MESH-04 |
| `messageFleetAgents`, `setFleetAgentState` | MESH-10, TIME-12 |
| `foundFleetAgent` | MESH-11 |
| `startBackgroundAgent`, `stopBackgroundAgent`, `getBackgroundAgentStatus`, `onBackgroundAgentEvents` | FILE-22, CHAT-22, MESH-10 |
| `respondBackgroundAgentAsk`, `respondBackgroundAgentToolApproval`, `alwaysApproveBackgroundAgentTool` | HIL-09 |
| `startAllInDirectory`, `stopAllInDirectory` | API-04 |
| `getToolDescriptions` | AGT-05 |
| `getTokenUsage`, `clearTokenUsage`, `saveTokenUsageExport` | DASH-05, DMN-31 |
| `countTokens`, `countTokensBatch` | API-05 |
| `getContextBreakdown` | DASH-07, LOOP-08 |
| `getDashboardQuickStats`, `getDashboardProviderTests`, `getDashboardAgentStats` | DASH-01, DASH-02 |
| `testProvider` | PROV-02 |
| `getDashboardContainers` | API-06 |
| `getTimers`, `addTimer` | TIME-01, TIME-02 |
| `updateTimer` | TIME-03 |
| `deleteTimer` | TIME-04 |
| `getInternalFiles` | DATA-01 |
| `uploadFile`, `pickAndImport` | DATA-02, CHAT-09 |
| `importPaths` | API-07 |
| `deleteInternalFile` | DATA-07 |
| `renameInternalFile`, `renameFolder` | DATA-03 |
| `setFileProtection` | DATA-04 |
| `setFileAuthorized` | DATA-05 |
| `readInternalFile`, `writeInternalFile` | EDIT-01, EDIT-07, TMPL-07, MULTI-01, MULTI-03 |
| `downloadInternalFile` | DATA-06, EDIT-07 |
| `getAllMeta`, `setMeta`, `deleteMeta`, `setMetaProtection` | DATA-10 |
| `listLocalTables`, `queryLocalTable`, `dropLocalTable` | DATA-08 |
| `getLogs`, `getLogsAfterId`, `clearLogs` | DATA-13 |
| `getTasks` | DATA-14 |
| `onInboxUpdated` | DATA-11 |
| `onWorkspaceDataChanged` | DATA-09, DATA-11 |
| `probeMcpServer` | AGT-13, MCP-03 |
| `testMcpRegistration` | MCP-01, MCP-03, MCP-04 |
| `installMcpPackage`, `uninstallMcpPackage`, `onMcpInstallProgress` | MCP-01, MCP-09 |
| `listMcpInstalled`, `ensurePythonRuntime`, `pickAdfFile` | API-08 |
| `getMcpServerStatus`, `onMcpServerStatusChanged` | MCP-07 |
| `restartMcpServer`, `getMcpServerLogs` | MCP-08 |
| `getMcpRegistry` | MCP-15 |
| `mcpOAuthSignOut`, `mcpOAuthStatus` | MCP-05 |
| `getSkillsCatalog`, `getSkillPackage` | TMPL-08 |
| `installPythonMcpPackage`, `uninstallPythonMcpPackage` | MCP-02 |
| `checkMissingSandboxPackages`, `installSandboxPackages`, `onSandboxInstallProgress` | AGT-12, COMP-07 |
| `listInstalledSandboxPackages` | COMP-07 |
| `setMcpCredential`, `getMcpCredentials`, `listMcpCredentialFiles` | MCP-10 |
| `attachMcpServer`, `detachMcpServer` | MCP-10, MCP-11 |
| `installAdapterPackage`, `listAdapterInstalled`, `onAdapterInstallProgress` | API-09 |
| `uninstallAdapterPackage` | CHAN-05 |
| `getAdapterStatus`, `onAdapterStatusChanged` | CHAN-01 |
| `restartAdapter`, `getAdapterLogs` | CHAN-04, CHAN-08 |
| `setAdapterCredential`, `getAdapterCredentials`, `listAdapterCredentialFiles`, `attachAdapter`, `detachAdapter` | CHAN-02, CHAN-03 |
| `setProviderCredential`, `getProviderCredentials`, `listProviderCredentialFiles`, `attachProvider`, `detachProvider`, `getAgentProviderKeySources` | PROV-09 |
| `setIdentity`, `getIdentity`, `deleteIdentity`, `listIdentityPurposes` | IDN-05 |
| `deleteIdentityByPrefix` | AGT-11 |
| `checkPassword`, `unlockPassword` | IDN-09, IDN-10 |
| `setPassword`, `changePassword` | API-10 |
| `removePassword` | IDN-08 |
| `listIdentityEntries`, `setIdentityCodeAccess`, `revealIdentity` | IDN-05 |
| `wipeAllIdentity`, `generateIdentityKeys` | IDN-06 |
| `getDid` | IDN-05, DASH-04 |
| `claimAgent` | IDN-11 |
| `getOwnerIdentityStatus` | IDN-01, IDN-04 |
| `revealOwnerMnemonic`, `confirmOwnerBackup` | IDN-02 |
| `importOwnerMnemonic` | IDN-03, IDN-04 |
| `getAgentAttestations`, `reissueAgentAttestations` | IDN-07 |
| `getEnvelopeStatus`, `setSharePassword`, `removeSharePassword` | IDN-08 |
| `unlockEnvelopeWithPassword` | IDN-09, IDN-12 |
| `getAgentRegistry`, `refreshAgentRegistry`, `bringHomeRegistryAgent` | API-11 |
| `setAgentModelForFile` | PROV-11 |
| `prepareShareFile`, `startShareDrag`, `discardShareFile` | FILE-18 |
| `saveShareCopy` | FILE-17 |
| `checkAgentReview`, `acceptAgentReview` | IDN-12, FILE-22 |
| `chatgptAuthStart`, `chatgptAuthStatus`, `chatgptAuthLogout` | PROV-06, DMN-27 |
| `grokAuthStart`, `grokAuthStatus`, `grokAuthLogout` | PROV-07, DMN-27 |
| `claudeAuthStart`, `claudeAuthStatus`, `claudeAuthSubmitCode`, `claudeAuthCancel`, `claudeAuthLogout` | PROV-08, DMN-27 |
| `onOpenFileRequest`, `getPendingOpenFile` | FILE-08, FILE-09 |
| `pickDirectory` | SET-05, FILE-02 |
| `onMenuAction` | APP-02, APP-03 |
| `onShuttingDown` | QUIT-01, QUIT-05 |
| `getUpdateState`, `checkForUpdates`, `downloadUpdate`, `onUpdateState` | APP-07 |
| `installUpdate` | API-12 |
| `downloadSpellcheckDictionaries` | APP-06, SET-04 |
| `getFullscreenState`, `setFullscreen`, `onFullscreenChanged` | APP-05, MESH-15 |
| `orbitalCacheGet`, `orbitalCachePut` | SET-02, DASH-04 |
| `emergencyStop` | DASH-08 |
| `platform` | HIL-17 (platform-specific badge), APP-02 |
| `getBackendSettings`, `setBackendSettings` | MODE-02, MODE-03, MODE-12, SW-01, SW-03, REM-04, REM-05 |
| `listConnections`, `onConnectionChanged` | SCOPE-01, SCOPE-02, SCOPE-03, SCOPE-08 |
| `useConnection` | SCOPE-02, SCOPE-04, REM-05, RA-06 |
| `addConnection` | REM-02, REM-03, REM-04, RA-05 |
| `removeConnection` | SCOPE-05 |
| `restartStudio` | DMN-37 |
| `getRemoteAccess`, `setRemoteAccess`, `shareRemoteAccess`, `onRemoteAccessChanged` | RA-01, RA-03, RA-16, RA-17 |
| `getNetworkStatus` | RA-03, RA-11, RA-17, RA-21 |
| `allowNetwork`, `forgetNetwork` | RA-03, RA-21 |
| `getNetworkNotices`, `dismissNetworkNotice`, `onNetworkNoticesChanged` | RA-03 |
| `addRemoteDevice`, `removeRemoteDevice` | RA-05, RA-13 |
| `openRemotePairing`, `closeRemotePairing` | RA-06, RA-09, RA-10 |
| `setRemoteTailscaleServe` | RA-04 |
| `startRemoteDiscovery`, `stopRemoteDiscovery`, `onRemoteDiscoveryUpdate` | RA-12, SCOPE-02 |
| `startRemotePairing`, `submitRemotePairingCode`, `cancelRemotePairing`, `onRemotePairingState` | RA-06, RA-08, RA-09, RA-10, RA-11, RA-18, SCOPE-06 |
| `onRemotePickerRequest`, `respondRemotePicker`, `browseRemoteFolder`, `createRemoteFolder` | REM-07, REM-08, REM-09, REM-10, REM-11 |
| `recoveryStash`, `recoveryList`, `recoveryReveal`, `recoveryArchive` | MULTI-06, MULTI-07 |

---

## Appendix B. Daily-driver log

One block per day. Copy the template.

```text
Date:            2026-__-__
Studio version:  ______   Daemon version: ______
Mode(s) used:    E / L / R   (R host: ______, via LAN / tailnet / tunnel / TLS)
Keep-running:    on / off
Agents active:   agent-1 … agent-6, other: ______
Hours in use:    __

Issues seen
| # | Item ID | Mode | What happened | Expected | Repro (y/n) | Logs (main.log / daemon log / screenshot) | Filed |
|---|---------|------|---------------|----------|-------------|-------------------------------------------|-------|
| 1 |         |      |               |          |             |                                           |       |

Noticed differences between modes (even if not a bug):
-

Restarts / crashes / reconnects (time, cause):
-
```

Exit criterion for deleting the Embedded backend: every L and R box checked
or marked N/A, no open issue against a MODE, SW, HAND, MULTI, STAT, REM, DMN
or PAR item, and seven consecutive daily-driver days in L with no unexplained
difference from E.
