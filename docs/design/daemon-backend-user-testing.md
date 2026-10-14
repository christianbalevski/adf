# Daemon backend: manual user-testing checklist

**Status: test plan for `feat/daemon-backend`.** Walked by the owner during the
one-week daily-driver period, before the Embedded backend code is deleted.

## How to use this checklist

Studio has three backend modes:

| Column | Mode | Agents run in |
|---|---|---|
| **E** | Embedded | Studio's main process (today's behaviour) |
| **L** | Local daemon | A daemon on this machine that Studio spawns or attaches to |
| **R** | Remote daemon | A daemon on another machine, reached by URL + token |

Rules:

- Walk every item once per column. Mark `[x]` on pass. On fail, leave `[ ]`
  and write the item ID in the daily-driver log (end of this document).
- **E and L MUST be indistinguishable.** Any visible difference between E and
  L is a failure, including wording, timing a user can notice, and ordering.
- **R MUST match E** except where the Expected column has a `Remote:` note.
  The note states the required remote behaviour; R is judged against it.
- `N/A` means the item cannot apply to that mode. The Expected column says why.
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
| Remote host | Second machine on LAN and tailnet. `ADF_DAEMON_TOKEN=<token> ADF_DAEMON_ALLOWED_HOSTS=<name> adf daemon --host 0.0.0.0`. Same `fixtures/` copied there. |
| Tools | `adf` CLI on both machines; Task Manager / `Get-Process node,electron`; a phone with Telegram; a screen recorder. |

Mode switch for every walk: **Settings → Backend** (mode, remote URL, token,
"Keep daemon running when Studio quits"). Before each column, confirm the mode
with `adf daemon status` (L/R: running, version) and `adf agents` (L/R: lists
the running agents; E: no daemon running).

---

## 1. First launch and mode switching (MODE)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MODE-01 | Launch with a fresh profile (`--instance=9`). | Home renders. Default backend mode is the documented default; Settings → Backend shows it. No daemon process exists unless the default is L. | [ ] | [ ] | N/A |
| MODE-02 | Settings → Backend. | Three modes listed; current mode selected. L shows daemon state (running, version, URL). R shows URL and a masked token. Keep-running toggle shown for L only. | [ ] | [ ] | [ ] |
| MODE-03 | E → L with no agents running. | Studio starts a daemon (or attaches to one already running). `adf daemon status` shows Studio's version. Sidebar, open tabs, tracked folders unchanged. | N/A | [ ] | N/A |
| MODE-04 | E → L with agent-1 mid-idle and agent-2 running. | Studio names the running agents before switching. After the switch they run in the daemon (`adf agents`), not in Studio. Each agent runs exactly once (Task Manager: no in-process work; daemon log shows one load each). | N/A | [ ] | N/A |
| MODE-05 | L → E with agents running. | Agents stop in the daemon and start in Studio. `adf agents` shows none of them. If keep-running is off and Studio spawned the daemon, the daemon exits. No agent runs in both. | [ ] | N/A | N/A |
| MODE-06 | Select R, enter URL + token, apply. | Connects; sidebar shows the remote host's tracked folders and agents. Daemon version shown. | N/A | N/A | [ ] |
| MODE-07 | R with an unreachable URL. | Clear error naming the URL. Studio does not fall back to E or L silently. Settings stay editable. | N/A | N/A | [ ] |
| MODE-08 | Relaunch Studio in each mode. | Comes back in the same mode, attaches, restores open agent and tabs. | [ ] | [ ] | [ ] |
| MODE-09 | `adf daemon start` first, then launch Studio in L. | Studio attaches to the existing daemon; no second daemon (`Get-Process node`). Running agents show live state on first paint. | N/A | [ ] | N/A |
| MODE-10 | Occupy port 7385 with another process, launch in L. | Clear error naming the port. No silent fallback to E. | N/A | [ ] | N/A |
| MODE-11 | R → L → R. | Each switch shows the target's agents only; no agent from one daemon appears under the other; no stale running dots. | N/A | [ ] | [ ] |
| MODE-12 | Toggle keep-running on/off in L. | Persists across relaunch. Takes effect at next quit (see QUIT). | N/A | [ ] | N/A |

## 2. Open, create, clone, rename, delete, share (FILE)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| FILE-01 | Sidebar New agent (or `Ctrl+N`), name `agent-7`. | File created in the agents folder from the default template, opened, listed with a status dot. Remote: created on the daemon host. | [ ] | [ ] | [ ] |
| FILE-02 | Home composer: type a task, pick provider, model, folder, template; press Enter. | New agent created with the chip name; the DID shown before creation equals the agent's DID after; the message runs as its first turn. | [ ] | [ ] | [ ] |
| FILE-03 | Home composer: start typing, then navigate away; return. | A fresh draft DID is shown; the earlier draft is discarded (no orphan file). | [ ] | [ ] | [ ] |
| FILE-04 | Home composer: use a taken name; then an unreviewed template. | "That name is taken." / "That template has not been reviewed, so no agent was created." No file written. | [ ] | [ ] | [ ] |
| FILE-05 | Home composer: Attach files (button and drag-drop). | Files land in the new agent's VFS and are referenced in the first message. Remote: local files are uploaded to the daemon host. | [ ] | [ ] | [ ] |
| FILE-06 | Open agent… (`Ctrl+O`). | Picker opens; chosen agent opens and loads. Remote: picker lists daemon-host paths, or the action states it opens files on the daemon host; it MUST NOT open a local file in-process. | [ ] | [ ] | [ ] |
| FILE-07 | File → Open Recent → item; then Clear Menu. | Opens the agent. Clear Menu empties the list. Remote: recent entries are daemon-host paths. | [ ] | [ ] | [ ] |
| FILE-08 | Studio closed. Double-click `agent-1.adf` in Explorer. | Studio launches and opens it. Remote: the file is local, not on the daemon; Studio shows a clear message (or the documented import). It MUST NOT run it in-process. | [ ] | [ ] | [ ] |
| FILE-09 | Studio open. Double-click another `.adf`. | Existing window focuses and opens it; no second Studio. | [ ] | [ ] | [ ] |
| FILE-10 | Close Agent (`Ctrl+Shift+W`) on a running agent. | Foreground closes; agent keeps running (sidebar dot stays, timers fire). | [ ] | [ ] | [ ] |
| FILE-11 | Clone… agent-1, deselect `local_*` tables. | Clone listed with a new DID; only selected tables copied; loop/files as chosen. | [ ] | [ ] | [ ] |
| FILE-12 | Rename… a stopped agent. | File renamed on disk; sidebar, open tabs, recent list follow. | [ ] | [ ] | [ ] |
| FILE-13 | Rename… a running agent. | Rename deferred until stop, then applied; one sidebar entry throughout. | [ ] | [ ] | [ ] |
| FILE-14 | Change name in Agent → Identity. | Same as FILE-12/13. | [ ] | [ ] | [ ] |
| FILE-15 | Delete… a running agent, confirm. | Agent stops, file (+ `-wal`/`-shm`) removed, sidebar entry gone, no error dialog. | [ ] | [ ] | [ ] |
| FILE-16 | Reveal in folder (agent row and folder row). | Explorer opens with the item selected. Remote: N/A — action is hidden or disabled with a note that the file is on the daemon host. | [ ] | [ ] | N/A |
| FILE-17 | Share… agent-1 → save a copy. | Dialog lists what travels (config, files, loop) and what does not (identity keys, app-level provider keys). Save dialog writes an identity-free copy locally. Remote: snapshot comes from the daemon host. | [ ] | [ ] | [ ] |
| FILE-18 | Drag agent-1 from the sidebar to the desktop while it runs. | A consistent `.adf` copy appears; opening it shows loop rows up to the drag time. | [ ] | [ ] | [ ] |
| FILE-19 | Track folder… (`Ctrl+Shift+O`); Untrack folder…; Rescan. | Folder added and scanned; untrack removes it from the list without touching files; Rescan picks up changes. Remote: daemon-host paths. | [ ] | [ ] | [ ] |
| FILE-20 | Copy a `.adf` into a tracked folder with Explorer. | Appears in the sidebar within seconds without Rescan. Remote: copy on the daemon host. | [ ] | [ ] | [ ] |
| FILE-21 | Sidebar search. | Filters agents by name. | [ ] | [ ] | [ ] |
| FILE-22 | Start/Stop from the row context menu and the status dot; folder Start all / Stop all. | Each agent starts/stops once; starting/stopping spinners clear; unreviewed agents prompt review first. | [ ] | [ ] | [ ] |
| FILE-23 | In agent-1, ask it to `sys_create_adf` a child with autostart. | Child listed and running; no review prompt. | [ ] | [ ] | [ ] |
| FILE-24 | View → Reload with agent-1 running and open. | Same agent reopens; running state, loop and tabs correct. | [ ] | [ ] | [ ] |

## 3. Editor and document (EDIT)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| EDIT-01 | Open README.md, edit in the rich editor, `Ctrl+S`, reopen. | Persisted. L/R: `adf file agent-1 README.md` shows the new text. | [ ] | [ ] | [ ] |
| EDIT-02 | Toggle Raw mode; use toolbar (bold, heading, list, table). | Markdown round-trips without loss. | [ ] | [ ] | [ ] |
| EDIT-03 | Open a `.ts` and a `.json` file. | CodeMirror with highlighting; dirty dot on edit; `Ctrl+W` on a dirty tab prompts. | [ ] | [ ] | [ ] |
| EDIT-04 | With `notes.md` open and clean, ask agent-1 to `fs_write` it. | Tab updates in place without reload. | [ ] | [ ] | [ ] |
| EDIT-05 | Same as EDIT-04 with unsaved local edits. | Local edits are not clobbered silently; behaviour identical in all modes. | [ ] | [ ] | [ ] |
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
| HIL-14 | Window hidden to tray (macOS: closed); click a toast. | Window shows and reveals the request. | [ ] | [ ] | [ ] |
| HIL-15 | Settings → Notifications off. | No toasts; bell still updates. | [ ] | [ ] | [ ] |
| HIL-16 | Approval whose args contain headers/body/token. | Toast and bell preview redact them. | [ ] | [ ] | [ ] |
| HIL-17 | Pending approvals (macOS/Linux). | Dock badge = bell count; 0 clears. Windows: N/A (nothing shown). | [ ] | [ ] | [ ] |
| HIL-18 | Tray menu with pending items. | "Waiting on you" lists them; click reveals. | [ ] | [ ] | [ ] |
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
| IDN-02 | Back Up Seed Phrase → reveal → confirm. | Phrase shown; badge clears. Remote: refused from another machine with a message that names the server; works through an SSH tunnel. | [ ] | [ ] | [ ] |
| IDN-03 | Import identity (12 words). | Owner restored; restamped/attested counts shown. Remote: as IDN-02. | [ ] | [ ] | [ ] |
| IDN-04 | Owner created in the terminal first (`adf` welcome), then open Studio. | "Restore your identity" banner; restoring works. | [ ] | [ ] | [ ] |
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
| PROV-06 | ChatGPT: Sign in, run agent-2, Sign out. | Browser opens; status shows email; models listed; turn runs; sign-out clears status. Remote: relay flow (callback on this machine, code sent to daemon) or documented steps. | [ ] | [ ] | [ ] |
| PROV-07 | Grok: Sign in (device code), run agent-5, Sign out. | Code and URL shown; status updates when approved; turn runs. | [ ] | [ ] | [ ] |
| PROV-08 | Claude: status, Sign in (URL + paste code), Cancel, recheck after install, Sign out. | Status shows installed/version/plan; update-required message on old Claude Code; sign-out also signs Claude Code out. Remote: status is the daemon host's Claude Code. | [ ] | [ ] | [ ] |
| PROV-09 | Provider → Agent overrides: give agent-6 its own key, model, params; remove it. | Override attached; key-source label correct; "unchanged copy" collapse works; detach restores app key. | [ ] | [ ] | [ ] |
| PROV-10 | Subscription usage limit reached. | Error with reset time; no auto-retry. | [ ] | [ ] | [ ] |
| PROV-11 | Background agent blocked on a missing provider → setup sheet → pick provider. | Model set on the file; agent starts. | [ ] | [ ] | [ ] |
| PROV-12 | Settings → Privacy → provider checks off. | No provider test calls on Home. | [ ] | [ ] | [ ] |

## 12. MCP (MCP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MCP-01 | Add a curated stdio npm server. | Install progress, then verify shows tool count. Remote: installed on the daemon host. | [ ] | [ ] | [ ] |
| MCP-02 | Add a uvx server; uninstall it. | uv/Python ensured; install and uninstall complete. | [ ] | [ ] | [ ] |
| MCP-03 | Custom stdio server with args and env. | Verify shows tools or the server's verbatim error. | [ ] | [ ] | [ ] |
| MCP-04 | Remote HTTP server with bearer token. | Connects; tools listed. | [ ] | [ ] | [ ] |
| MCP-05 | HTTP OAuth server: Sign in, Re-authorize, Sign out. | Browser sign-in; status signed in/out. Remote: works via a callback on this machine, or a clear message with the documented workaround. | [ ] | [ ] | [ ] |
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

## 14. Compute, sandbox, browser (COMP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| COMP-01 | Settings → Compute: status; setup steps (install, machine init/start, check). | Each step reports outcome. Remote: the daemon host's Podman. | [ ] | [ ] | [ ] |
| COMP-02 | Container list (all/running/stopped); details tabs Summary, Activity, Logs, Processes, Workspace, Packages, Inspect. | Data loads; refresh works. | [ ] | [ ] | [ ] |
| COMP-03 | Start, stop, rebuild, destroy a container; shared compute init and destroy. | Destroy dialog warns about active agents; phases shown live. | [ ] | [ ] | [ ] |
| COMP-04 | Test an external container target. | Probe result shown. | [ ] | [ ] | [ ] |
| COMP-05 | Host access on; agent runs `compute_exec` `hostname`. | Runs. Remote: prints the daemon host's name. | [ ] | [ ] | [ ] |
| COMP-06 | Computer tab / browser viewer for an isolated agent; start/stop/resume Chromium. | noVNC desktop loads; browser controls work. Remote: viewer port is loopback on the server; Studio shows a clear "not reachable" message or uses a tunnel. MUST NOT render blank. | [ ] | [ ] | [ ] |
| COMP-07 | Settings → Packages: add, list, remove; agent Make Runtime. | Install progress; listed with size and installer. | [ ] | [ ] | [ ] |
| COMP-08 | Container base image, system packages, VM CPUs/memory, max sandbox workers. | Saved; effective after the documented restart. | [ ] | [ ] | [ ] |

## 15. Mesh, fleet, LAN, tailnet (MESH)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| MESH-01 | Enable/disable mesh. | Status updates; fleet map shows Enable Mesh prompt when off. | [ ] | [ ] | [ ] |
| MESH-02 | Mesh server start, stop, restart; change port. | Status card host:port; URL opens. Remote: server runs on the daemon host. | [ ] | [ ] | [ ] |
| MESH-03 | LAN access toggle; LAN IP list. | Binds 0.0.0.0 with restart notice; IPs listed. Remote: daemon host's IPs. | [ ] | [ ] | [ ] |
| MESH-04 | Firewall check; Repair (UAC). | Rule state shown; repair creates it. Remote: N/A — disabled or labelled as the server's responsibility. | [ ] | [ ] | N/A |
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

## 16. Templates, registry, skills (TMPL)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| TMPL-01 | Settings → Agent templates. | Shipped three seeded; default marked. Migration notice shown once. | [ ] | [ ] | [ ] |
| TMPL-02 | Create blank; duplicate; rename; set default; delete; reset shipped. | Each applied; settings that pointed at a renamed id follow it. | [ ] | [ ] | [ ] |
| TMPL-03 | Edit template config, README/mind/soul, description/warning; add and remove files. | Saved; new agents from it carry them. | [ ] | [ ] | [ ] |
| TMPL-04 | Reveal template. | Explorer opens. Remote: N/A, as FILE-16. | [ ] | [ ] | N/A |
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
| SET-03 | Notifications: system notifications; menu bar icon. | Toggles toasts and tray icon. | [ ] | [ ] | [ ] |
| SET-04 | Privacy: update checks, provider checks, live catalogs, spell-check dictionaries. | Each disables its network calls. | [ ] | [ ] | [ ] |
| SET-05 | Files: agents folder (picker), max scan depth. | Saved; composer default folder follows. Remote: daemon-host path. | [ ] | [ ] | [ ] |
| SET-06 | Prompts: global system prompt, compaction prompt, tool instructions (modified badge, reset), apply updates automatically, dynamic instructions. | Auto-saved; running agents use it next turn. | [ ] | [ ] | [ ] |
| SET-07 | Settings search. | Finds sections by keyword. | [ ] | [ ] | [ ] |
| SET-08 | Change a setting, quit within 1 s, relaunch. | Persisted. | [ ] | [ ] | [ ] |
| SET-09 | Change a provider in Studio; run `adf providers`. | CLI shows it (shared settings). Remote: shows on the server's `adf providers`. E: CLI reads the same file. | [ ] | [ ] | [ ] |
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
| DASH-08 | Emergency stop ("Stop all agents and disable mesh"). | Every agent stops, mesh off. L/R: daemon agents stop (`adf agents`). | [ ] | [ ] | [ ] |
| DASH-09 | Tray "Today: … tokens". | Matches Usage today. | [ ] | [ ] | [ ] |

## 19. Tray, menu, updater, window, zoom, spellcheck, drag-drop, deep links (APP)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| APP-01 | Tray click. | Summary, Waiting on you, Running (click opens agent), Open, Settings…, Quit. | [ ] | [ ] | [ ] |
| APP-02 | Menus: File, Edit, View, Window, Help (docs link). | Every item works; accelerators shown. | [ ] | [ ] | [ ] |
| APP-03 | Shortcuts `Ctrl+,` `Ctrl+N` `Ctrl+O` `Ctrl+Shift+O` `Ctrl+S` `Ctrl+W` `Ctrl+Shift+W`. | Each performs its action. | [ ] | [ ] | [ ] |
| APP-04 | Zoom in/out/reset with UI scale set. | Combine; persist. | [ ] | [ ] | [ ] |
| APP-05 | Fullscreen from menu. | Title bar adapts. | [ ] | [ ] | [ ] |
| APP-06 | Misspell in composer and editor. | Underlined; suggestions. Linux: dictionary download from Privacy. | [ ] | [ ] | [ ] |
| APP-07 | About → Check for updates; status-bar badge; download; restart-and-install (packaged build). | States shown; installs. Daemon follow-up: DMN-15. | [ ] | [ ] | [ ] |
| APP-08 | Drag-drop: files onto composer, chat, Files; agent out of sidebar. | Covered by FILE-05, CHAT-09, DATA-02, FILE-18; all work. | [ ] | [ ] | [ ] |
| APP-09 | Deep links: toast click, `adf-file://` link, `.adf` double-click, second instance. | Covered by HIL-12, EDIT-09, FILE-08, FILE-09. | [ ] | [ ] | [ ] |
| APP-10 | `--instance=2`. | Separate settings and data; does not affect instance 1. L: record whether it attaches to its own daemon. | [ ] | [ ] | [ ] |
| APP-11 | About tab. | Version, links. L/R: daemon version also visible. | [ ] | [ ] | [ ] |

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
| CRASH-01 | Kill Studio (`taskkill /F /IM "ADF Studio.exe"`) mid-turn. | E: next launch shows the crash-recovery notice with timestamps; running tasks → failed; pending approvals → cancelled. L/R: agents unaffected; relaunch attaches, turn completed. | [ ] | [ ] | [ ] |
| CRASH-02 | View → Force Reload mid-stream. | Renderer resyncs; stream continues or completed rows shown; no duplicates. | [ ] | [ ] | [ ] |
| CRASH-03 | Corrupt `adf-settings.json` (truncate), launch. | File quarantined, defaults loaded, message shown. L: daemon also survives (no clobber of the quarantined copy). | [ ] | [ ] | [ ] |
| CRASH-04 | After any unexplained exit. | `Get-MpThreatDetection` checked (Defender behaviour kill); `main.log` and crashes dir record the exit. L: daemon log records its own exit. | [ ] | [ ] | [ ] |
| CRASH-05 | Disable network 60 s with agent-3 connected. | Adapter reconnects with backoff; catch-up ingests missed messages once. | [ ] | [ ] | [ ] |

## 22. Mode-specific tests (DMN)

| ID | Steps | Expected | E | L | R |
|---|---|---|---|---|---|
| DMN-01 | Same agents E → L → E → L. After each switch compare agent-1 and agent-2: loop rows, files, timers (ids, next fire), inbox, meta, tasks. | Identical. No lost turn, no duplicate timer, no duplicate loop rows. | N/A | [ ] | N/A |
| DMN-02 | Switch modes while agent-1 streams. | Documented behaviour (refuse, or finish then hand over). The typed message and the turn MUST NOT be lost or run twice. | N/A | [ ] | N/A |
| DMN-03 | Studio (L) + `adf` TUI on the same daemon. Chat from TUI. | Studio shows the user row and stream live. | N/A | [ ] | [ ] |
| DMN-04 | As DMN-03, chat from Studio. | TUI shows it live. | N/A | [ ] | [ ] |
| DMN-05 | Approve in TUI; approve in Studio (separate requests). | Each clears in the other surface within 1 s. | N/A | [ ] | [ ] |
| DMN-06 | Start/stop, state change, config edit, timer add, file edit in one surface. | Reflected in the other within 1 s (TUI Fleet/Inspect; Studio sidebar/panels). | N/A | [ ] | [ ] |
| DMN-07 | `adf chat agent-1 "hi"` while Studio shows agent-1. | Turn appears in Studio. | N/A | [ ] | [ ] |
| DMN-08 | Two Studio machines attached to one remote daemon. | Both see the same state; approval on one clears on the other. | N/A | N/A | [ ] |
| DMN-09 | Keep-running ON; quit Studio. Wait for agent-2 timer; send agent-3 a Telegram message. | Timer fires; phone gets one reply; `adf agents` lists them running. Relaunch: Studio attaches; loops show those turns; bell shows approvals raised while closed. | N/A | [ ] | N/A |
| DMN-10 | Keep-running OFF; quit Studio. | Agents stop gracefully; daemon exits (`adf daemon status` not running); no orphan `node.exe`. Relaunch spawns a daemon; autostart agents start. | N/A | [ ] | N/A |
| DMN-11 | Daemon started by `adf daemon start` before Studio; quit Studio with keep-running OFF. | Documented behaviour (record: Studio stops only a daemon it spawned, or stops any). Matches the settings label. | N/A | [ ] | N/A |
| DMN-12 | Kill the daemon (`taskkill /F /PID <pid>`) while agent-1 streams. | Within 5 s Studio shows disconnected state; no fake idle. L: Studio restarts the daemon (or offers to); reconnects. Loop shows the recovery notice; no missing or duplicate rows versus `adf` loop listing. | N/A | [ ] | [ ] |
| DMN-13 | During DMN-12 outage, type and send a message; click an approval. | Either delivered after reconnect or refused visibly. Never dropped silently. | N/A | [ ] | [ ] |
| DMN-14 | `adf daemon restart` while Studio idle. | Reconnects without user action; state intact. | N/A | [ ] | [ ] |
| DMN-15 | Version mismatch: run a daemon of another version (older and newer CLI), then Studio. Also after a Studio update with keep-running daemon from the old version. | Message names both versions. L: offers restart into Studio's version; restart is clean. R: incompatible operations refused with a message. No silent protocol errors. | N/A | [ ] | [ ] |
| DMN-16 | Daemon running agent-2 and agent-3. Launch Studio in E. | Studio MUST NOT start agent-2/agent-3 in-process (skip or warn naming the daemon). Telegram message → exactly one reply. Timer → one "Timer Fired" row per period (check loop and logs count). No `409` in adapter logs. | [ ] | N/A | N/A |
| DMN-17 | Studio in E with agents running; run `adf`. | CLI refuses to start a daemon while Studio runs, with its message. | [ ] | N/A | N/A |
| DMN-18 | Remote over LAN by IP and by host name in `ADF_DAEMON_ALLOWED_HOSTS`. Run CHAT-01..07, HIL-01..07, TIME-05, DATA-02, DATA-06, EDIT-01. | All pass. | N/A | N/A | [ ] |
| DMN-19 | Remote over tailnet (MagicDNS name). Same set as DMN-18. | All pass. | N/A | N/A | [ ] |
| DMN-20 | Remote via SSH tunnel (`127.0.0.1:7386`). Same set. | All pass; owner routes (IDN-02/03) work. | N/A | N/A | [ ] |
| DMN-21 | Remote via TLS proxy (`https://…`). | Connects; events stream live (not buffered). | N/A | N/A | [ ] |
| DMN-22 | Wrong token; then correct token. | `401` reported clearly (mentions `adf daemon token`); no retry storm in the daemon log; correct token connects without restarting Studio. | N/A | N/A | [ ] |
| DMN-23 | Host name not in `ADF_DAEMON_ALLOWED_HOSTS`. | Clear error naming the host. | N/A | N/A | [ ] |
| DMN-24 | Network drop 30 s, idle and mid-stream (disable Wi-Fi or kill the tunnel). | Offline indicator; on restore, reconnects, missed events replayed, no duplicates; offline input handled per DMN-13. | N/A | N/A | [ ] |
| DMN-25 | Network drop longer than the event replay window (busy agent, 10 min). | Studio re-snapshots (loop reloads); no gap in rows. | N/A | [ ] | [ ] |
| DMN-26 | Laptop sleep 10 min, resume (R). | Reconnects; state current. | N/A | N/A | [ ] |
| DMN-27 | First switch E → L: run agent-1 (API key), agent-2 (ChatGPT), agent-5 (Grok), agent-6 (Claude, per-agent key, MCP creds, HTTP OAuth MCP), agent-3 (Telegram token). | All work without re-entering secrets. Any re-login MUST be one the release notes document, with a clear prompt. Per-agent credentials unlock in the daemon (daemon key trusted). | N/A | [ ] | N/A |
| DMN-28 | Switch back L → E; run the same agents. | All work; no re-login; ChatGPT refresh token not clobbered (both surfaces still signed in after 24 h). | [ ] | N/A | N/A |
| DMN-29 | R: enter an app-level provider key in Studio. | Stored on the daemon host; local keys never sent to the remote daemon. | N/A | N/A | [ ] |
| DMN-30 | Password-protected agent in L. | Autostart skips it; unlocking in Studio runs it in the daemon. | N/A | [ ] | [ ] |
| DMN-31 | Run 3 turns in L, switch to E. | Usage counts each turn once; no double count across modes. | N/A | [ ] | N/A |
| DMN-32 | In L: `netstat -ano` for the mesh port. | Only the daemon binds it; Studio binds no mesh port. | N/A | [ ] | N/A |
| DMN-33 | After 5 mode switches: count MCP server and adapter processes. | One per configured server/adapter; no leaks. | N/A | [ ] | N/A |
| DMN-34 | Agent with `umbilical_taps`. | Taps fire in L/R as in E (daemon profile historically excluded them). | [ ] | [ ] | [ ] |
| DMN-35 | `on_file_change` for writes from the editor, the agent and a lambda. | Same firing in L/R as in E (headless gap historically). | [ ] | [ ] | [ ] |
| DMN-36 | Remote daemon host in another time zone. | Timestamps shown in local time; usage bucketed by documented day. | N/A | N/A | [ ] |

## 23. Side-by-side parity (PAR)

Method: clone agent-1 to `agent-1b`. Run Studio instance 1 in L with agent-1
and `--instance=2` in E with agent-1b (agent-1b is not loaded by the daemon).
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

---

## Appendix A. Bridge method → checklist ID

Every method of `AdfApi` (`src/preload/api.ts`). IPC channels in
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
| `getAgentConfig`, `setAgentConfig` | AGT-01..AGT-09 |
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
| `checkLanFirewall`, `applyLanFirewall` | MESH-04 |
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
| `readInternalFile`, `writeInternalFile` | EDIT-01, EDIT-07, TMPL-07 |
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
or marked N/A, no open issue against a MODE, DMN or PAR item, and seven
consecutive daily-driver days in L with no unexplained difference from E.
