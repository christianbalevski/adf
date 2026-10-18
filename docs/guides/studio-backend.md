---
type: guide
description: Where ADF Studio runs agents (This computer, the default; Remote computer; Inside Studio, legacy), upgrading from 0.7.x, switching between them, what moves, quitting, Studio and the terminal app together, version mismatch, recovery, and every message these features show
see_also:
  - ../cli/remote-daemon.md — setting up a daemon on another machine (SSH tunnel, LAN, TLS proxy, tailscale serve)
  - ../daemon/operations.md — running the daemon itself: start, stop, data directory, ports, token
  - settings.md — the other app-wide settings
---

# Studio backend

ADF Studio runs agents in one of three backends. You choose it in
**Settings → Backend → Run agents in**; Studio reads the choice at launch, so
a change applies after a restart.

| Backend | Agents run in | Typical use |
|---|---|---|
| **This computer** | A background service on this computer, with the same settings file and agent files as Studio | The default. Studio and the terminal app (`adf`) show the same agents at the same time; with **Keep the daemon running** on, agents keep running when Studio is closed |
| **Remote computer** | A background service on another computer, reached by URL and token | Agents on a server; Studio on a laptop |
| **Inside Studio (legacy)** | Studio's own process | A fallback for this release only, if the background service does not work for you; the next release removes it. Agents stop when you quit Studio |

The background service is the ADF daemon (`adf daemon`). The rest of this
guide calls it the daemon.

Without a `studio-backend.json` in Studio's user data folder, Studio runs
This computer and writes that choice into the file at its first launch, so a
later release reads an explicit choice. The file names the modes `local`
(This computer), `remote` (Remote computer) and `embedded` (Inside Studio); a
file that says `"mode": "embedded"` keeps Inside Studio. The file holds the
mode, `keepDaemonRunning`, the remote URL
and the remote token, encrypted with Electron's safeStorage (DPAPI on
Windows, the Keychain on macOS, the Secret Service on Linux).

Inside Studio and This computer look and behave the same. Remote computer
differs where the machine boundary forces it; [Remote
computer](#remote-computer) lists each difference.

## Upgrading from 0.7.x

Studio 0.7.x ran agents itself (Inside Studio). From this release on, every
install runs This computer, including an install that ran 0.7.x. The first
launch after the upgrade does what a switch from Inside Studio to This
computer in Settings → Backend does (see [What moves](#what-moves-during-a-switch)):

1. Studio moves your client settings, ChatGPT and Grok sessions, app-level MCP
   sign-ins and the runtime identity into the daemon's stores, before it
   starts the daemon. Agent files, tracked folders, providers and every other
   setting stay where they are; the daemon uses the same settings file.
2. It saves `"mode": "local"` to `studio-backend.json`.
3. It starts the daemon, which starts the agents set to start automatically,
   from the same tracked folders as Studio did.
4. Once the window is open and Studio has connected to the daemon, one
   dialog says "Agents now run in a background service on this computer (the
   ADF daemon)." and lists what moved
   ("Moved: Client settings, Owner phrase, Runtime identity, ChatGPT session,
   MCP sign-ins."). **Open the Guide** opens this section. If Studio could not
   connect, the dialog says "… but Studio could not connect to it." and that no agent
   runs yet. The dialog appears once: if Studio quits or restarts before it
   was shown, the next launch shows it, together with what that launch moved
   and what is still not done. Settings → Backend keeps a **Default changed** row
   with the date and the version; its **Details** lists what moved.

The dialog also says, when it applies:

| Text | Meaning |
|---|---|
| "Not done yet, retried at the next start: …" | An item did not move; it stays where it was and Studio retries at each start. See [When a move is not done](#when-a-move-is-not-done) |
| "Stays in Studio: Runtime identity (…)" and "The daemon runs as its own runtime: …" | This computer has no keychain the daemon can read (Linux without a Secret Service). Agents made in Studio unlock in the daemon only with the owner phrase (`adf identity restore`) or after `adf identity trust-daemon`. Files the daemon stamps show as "recognized" in Studio's review |
| "macOS asks once whether the ADF daemon may read Studio's runtime key from the keychain." | macOS shows that question when the daemon first reads the key. Choose **Always Allow** |

A fresh install has nothing to move: no dialog appears.

If the daemon was signed in to another account before the upgrade
(`adf auth login`), the accounts dialog of [Two accounts](#two-accounts-the-conflict-dialog)
appears during the first launch, on the small "ADF Studio is starting" window.

Two cases stop the first launch from moving anything:

| Dialog | Meaning | What to do |
|---|---|---|
| "An older ADF daemon (adf *X.Y*, started by the npm CLI) is running and uses the same settings." (or "An ADF daemon that Studio cannot identify is running on port *N* …") | An `adf` installed from npm before this release runs a daemon on Studio's settings. Agents run inside Studio for this launch only: nothing moves, the default is not saved, and Studio does not start your agents set to start automatically, since that daemon may run them | Stop it with `adf daemon stop`, update the CLI (`npm i -g @agentdocumentformat/cli@latest`), then restart Studio. To run one agent in Studio before that, stop it in the daemon (`adf stop <name>`), then open it in Studio and press Start |
| "Studio cannot use its backend settings file." with **Run on This Computer (Recommended)** and **Run Inside Studio (Legacy)** | `studio-backend.json` could not be parsed (Studio moved it aside as `studio-backend.json.corrupt-*`) or names an unknown mode | Choose one. Studio saves it, then moves your sign-ins to that side |
| "Studio cannot use or replace its backend settings file." with **… for This Launch** | The file cannot be read (for example `EACCES`); the dialog names the path and the error | Fix its permissions or delete it, then restart Studio. Until then the choice applies to one launch, and no sign-in moves |

To keep running agents in Studio for this release, choose **Settings →
Backend → Inside Studio (legacy)**. That is the real
switch: the switch dialog lists what moves back, and Studio restarts and moves
your sign-ins back into Studio. Do not use `ADF_STUDIO_BACKEND=embedded` for
this; it runs agents inside Studio for one launch without moving anything back.

To go back to 0.7.x, first switch to Inside Studio as above, check that the summary
after the restart lists no pending item, quit Studio, stop the daemon
(`adf daemon stop`) and install 0.7.x. Installing 0.7.x without that switch
leaves the ChatGPT, Grok and MCP sign-ins with the daemon, and the theme,
recent files and fleet layout in `studio-client-settings.json`, where 0.7.x
does not read them: sign in again in 0.7.x. Agent files, providers and the
owner identity are not affected.

## Before your daily-driver week

For the week of daily use on a pre-release build of this branch
(`0.8.0-daemon.N`). The checklist walked during that week is
[daemon-backend-user-testing.md](../design/daemon-backend-user-testing.md).

1. **Only this branch's builds on the machine.** Quit the release Studio, or
   uninstall it, and stop the daemon of an `adf` installed from npm
   (`adf daemon stop`), then uninstall that package. Then check:
   - `adf daemon status` reports no daemon (exit code 3), or one whose version
     is this build's;
   - `<config>/adf/leases/hosts/` (Windows: `%LOCALAPPDATA%\adf\leases\hosts\`)
     holds no `<pid>.json` of a process that is not this build's Studio or
     daemon. Each file names its `kind`, `pid`, `version` and `settingsPath`.
     A runtime of another build there runs agents from the same files.
2. **After the first switch to This computer**, confirm the daemon took over
   Studio's identity and can prove it is local:
   - `adf identity` shows the runtime as `studio (adopted)`. Anything else
     means agents made by Studio stay locked in the daemon.
   - `adf daemon status` has no `proof     unavailable` line. With that line,
     owner import and the stored-value reveal (Settings → Providers keys,
     Identity panel Reveal) refuse until the daemon restarts.
3. **No owner switch from the terminal during the week.** Do not run
   `adf identity import` with a phrase of another owner (the import that asks
   you to type "switch"), unless you restart Studio in This computer mode right
   after it. Studio re-signs its runtime entry for the new owner only at a
   local-mode boot; until then, agents Studio made do not open in the daemon.
   An owner import in Studio itself does this at once.
4. **Watchdogs that look for Studio by process name do not see a dead
   Studio.** The daemon Studio starts is `ADF Studio.exe` (or `ADF Studio` on
   macOS) too, so a check for the process name passes while only the daemon
   runs. Check for the window, or for Studio's pid, instead.
5. **The way back**, in this order:
   1. Settings → Backend → Inside Studio (legacy), then restart Studio as asked.
   2. After the restart, check the handover summary: no item may be pending.
      A pending item means a credential is still with the daemon. Fix what it
      names and restart again before going on.
   3. Stop the daemon: `adf daemon stop`.
   4. Reinstall the release (v0.7.8).

   Do not use `ADF_STUDIO_BACKEND=embedded` as the way back. It runs agents
   inside Studio without running the handover, so credentials moved to the daemon
   stay there.

## Switch the backend

1. Open **Settings → Backend** and choose the mode under **Run agents in**.
2. Studio shows the switch dialog, "Run agents *on B* instead of *on A*?"
   (for example "Run agents on this computer instead of inside Studio?"). It
   lists what moves at the restart (see [What moves](#what-moves-during-a-switch)),
   which agents run now and what happens to them, and, on macOS for Local
   daemon, the keychain question you will see once.
3. Choose **Switch and Restart**. Studio restarts in the new backend.
4. After the restart, if something moved or is not done, a summary dialog
   says "Agents now run *on B*." (or "Agents now run *on B*, but part of the
   handover is not done.") and lists each item with its outcome.

**Cancel** in the switch dialog keeps the current backend: "Switch
cancelled. Nothing changed."

If `ADF_STUDIO_BACKEND` is set in Studio's environment, it overrides the
saved mode; the dialog says so and Settings → Backend shows "Agents run
*on mode* because ADF_STUDIO_BACKEND is set."

### Messages on the Backend page

| Message | Meaning |
|---|---|
| "Saved. Applies at the next launch." / "Saved." | The choice is stored in `studio-backend.json` |
| "Studio restarts now." | A confirmed switch |
| "Studio already runs this mode; no restart is needed." | You chose the mode this launch already runs (after a session-only launch) |
| "Agents run *on A*. Restart Studio to run them *on B*." with **Restart now** | The saved mode differs from the one this launch runs (for example after "Run Inside Studio for This Session") |
| "Could not save *path*." / "Could not save the backend settings." / "Could not read the backend settings." | `studio-backend.json` could not be written or read; check the user data folder |
| "studio-backend.json: …" / "studio-backend.json: ignored …" | The file has a problem or fields this Studio does not use; Studio says what it ignored |
| "The remote daemon cannot be used: …" | The saved remote settings break the transport rule (an unconfirmed plain-http URL); see [Remote computer](#remote-computer) |

### Running agents and turns in flight

Agents that run before the switch run after it, on the other side. Studio
records them in `studio-switch-resume.json` and, after the restart, starts
each one through the new backend's usual start (review, password and lease
rules apply). One notification lists the result: "Running again after the
switch: agent-1, agent-2." and, if any failed, "Not started: agent-3
(reason)."

When the restart would interrupt an agent's turn, the dialog says "A turn is
in flight in: *agents*." and offers the buttons below. That is the case in
Inside Studio mode, and in This computer mode with a daemon Studio started and
**Keep the daemon running** off. A local daemon that keeps running (started
with `adf daemon start`, or the setting on) keeps its turns going, so the
dialog does not ask. Neither does a switch away from Remote computer.

| Button | What happens |
|---|---|
| **Wait for Them to Finish** | Studio restarts once those turns end ("Studio restarts once the turns in flight finish (*agents*)."). Settings → Backend shows "Switching to *B*" with **Finish Switch Now** (restart now; the quit stops the turns) and **Cancel Switch** (stay in the current backend) |
| **Stop Them Now** | Studio restarts at once; the quit interrupts the turns |
| **Cancel** | Nothing changes |

Nothing is interrupted without one of these choices. If the turns are still
running after 30 minutes, Studio stops waiting and notifies you: "The switch
to *B* is waiting: *agents* still has a turn in flight. Settings → Backend:
Finish Switch Now (stops the turns) or Cancel Switch."

While a switch waits, the latest choice wins: choosing another backend
replaces the waiting switch (after its own switch dialog), and choosing the
backend Studio runs now cancels it, as **Cancel Switch** does. The switch
dialog says "This replaces the waiting switch to "*B*"." Once the restart has
started, a mode change or a switch button is refused with "Studio is already
restarting for the switch to "*B*". Nothing changed." If a launch then runs another backend
than the switch's (for example with `ADF_STUDIO_BACKEND` set), one
notification names the agents not started: "Not started after the switch: …".

Switching from This computer back to Inside Studio while the daemon keeps running
(it was started with `adf daemon start`, or **Keep the daemon running** is
on): its agents stay in the daemon. The dialog says "The ADF daemon on this
computer keeps running (…), and so do its agents (…) there. Studio does not
start an agent the daemon runs; stop it there first (adf daemon stop) to run
it in Studio."

Agents are not carried across machines. Switching to Remote computer: "Running
agents stop: … stop here and are not started on the remote daemon, which runs
its own agents." (or, from This computer with a daemon that keeps running,
"… They are not started on the remote daemon."). Switching away from Remote
computer: "The
remote daemon keeps running its agents (…). Studio does not start them …", and
Studio does not wait for their turns.

## What moves during a switch

Some state cannot be shared between Studio and the daemon, so it moves with
the backend. Studio performs each move at its next start, before it starts or
attaches to the daemon. Each move writes the destination, reads it back, then
deletes the source, so a crash in the middle leaves two copies, never none;
the next start finishes the move.

| State | Inside Studio → This computer | This computer → Inside Studio |
|---|---|---|
| Running agents | Stopped by Studio at the restart, started by the daemon after it | Started by Studio after the restart, unless the daemon keeps running them |
| Client settings (theme, fonts, recent files, fleet map layout, notifications, menu bar, update and spellcheck choices) | Moved from `adf-settings.json` into `studio-client-settings.json` | Moved back |
| Runtime identity | Studio's runtime key is written to the OS keychain (account `studio-runtime:<scope>`), so the daemon signs as the same runtime and your agents show as yours in review | The keychain copy is deleted |
| ChatGPT and Grok sessions | `<provider>/auth.json` moves to `<provider>/auth.daemon.json` | Moved back |
| App-level MCP sign-ins | Moved into the daemon's keychain entries. They stay in Studio when the keychain cannot be opened or is locked; agents keep their own sealed copies | Moved back into Studio's settings: the ones Studio moved and the ones signed in while on This computer. Sign-ins the daemon had before the first switch stay with it. When that first switch did not read the daemon's keychain entries (Studio had nothing to put there, or the keychain was unavailable or locked) and a daemon had already run on these settings, only the ones Studio moved come back; sign in again in Studio for the others. When the keychain cannot be opened or is locked at the switch back, none move |
| Owner seed phrase | Mirrored into the keychain entry `ADF / owner-mnemonic` when it is not there | Nothing |
| Open agent and tabs | Reopened after the restart | Reopened after the restart |

Agent files, tracked folders, providers and every other setting stay where
they are: in This computer mode the daemon uses Studio's settings file and
agent files. The switch dialog lists what moves in its direction:

- To Remote computer: client settings only.
- From Remote computer to Inside Studio: nothing moves back; Studio already
  holds its sign-ins and keys.
- From Remote computer to This computer: what moves from Studio into the local
  daemon (the sessions, MCP sign-ins and runtime identity in the table above).

It also says what stays: "Stays on this computer: ChatGPT, Grok
and MCP sign-ins, provider keys, the owner phrase and the runtime identity.
The remote daemon uses its own; nothing is sent to it." (to Remote computer), or
"Nothing comes from the remote daemon: its agents, sign-ins and keys stay on
it." (from Remote computer). See [§5.5](../design/daemon-backend.md#55-remote-mode).

Rationale: sessions move instead of being copied because ChatGPT and MCP
refresh tokens rotate. A copy left behind stops working the first time the other side
refreshes it, which would sign you out after you switch back.

The record of what moved is `studio-handover.json` in Studio's user data
folder. Do not edit it.

### Two accounts: the conflict dialog

If Studio and the daemon are signed in to the same provider with different
accounts, Studio asks "Studio and the ADF daemon are signed in to ChatGPT with
different accounts." (or Grok). Choose **Keep *account* (Studio)** or **Keep
*account* (daemon)**.

The dialog opens during the start, before the main window, on a small "ADF
Studio is starting" window in front. The other account's session is signed out here and saved,
encrypted with the daemon's key, as `<provider>/auth.replaced.<time>.json` in
Studio's user data folder (the dialog names the folder, the summary the file).
Each account set aside has its own file: a later conflict over another account
never overwrites it, and setting the same account aside again replaces its
file. To use that account
in the daemon instead: stop the daemon and replace `auth.daemon.json` with it
(Windows PowerShell: `Move-Item -Force auth.replaced.<time>.json auth.daemon.json`
in that provider's folder; `auth.daemon.json` already exists, so a plain rename
fails). Studio deletes each `auth.replaced.*.json` 30 days after it was written
(at its next start), or as soon as its account signs in again on either side;
the log names each file it deleted.

The same account signed in on both sides independently (the daemon signed in
before your first switch) keeps both sessions, each on its side; no accounts
dialog appears (the summary dialog still lists the switch).

### When a move is not done

The summary dialog names each item that did not move, and Studio retries at
the next start. Common reasons:

| Summary text | What to do |
|---|---|
| "not moved back: the ADF daemon pid N (started by cli) still runs on these settings …" | Stop it (`adf daemon stop`) and restart Studio |
| "not moved: `studio-handover.json` cannot be read …" / "is not a handover record this Studio reads" | Fix or delete the file, then restart Studio. Until then sign-ins stay where they are |
| "`studio-handover.json` is missing, so Studio cannot tell its sign-ins from the daemon's own …" | Sign in again in Studio where needed |
| MCP sign-ins "stay in Studio (…)" / Runtime identity "not shared: …" | This computer has no keychain the daemon can read (Linux without a Secret Service). The daemon runs as its own runtime; files it stamps show as "recognized" in Studio's review |

A launch in a session-only backend (`ADF_STUDIO_BACKEND`, or "Run Inside
Studio for This Session") moves client settings only; sign-ins and the runtime
identity stay where the saved backend keeps them.

## Quit Studio

**Settings → Backend → Keep the daemon running when Studio quits**
(`keepDaemonRunning`, This computer only, default off):

| Setting | When you quit Studio | After a Studio crash |
|---|---|---|
| Off | Studio stops a daemon it started, as quitting stops agents in Inside Studio mode | The daemon stops 60 seconds later |
| On | The daemon keeps running your agents; manage it with the ADF CLI (`adf daemon stop`) | The daemon keeps running |

A change applies from then on, also to the crash case ("Saved. Applies from
now on.").

A daemon started with `adf daemon start` (or a service manager) is never
stopped by Studio, whatever the setting says. Settings → Backend shows who
started the daemon.

If another client (the terminal app, another Studio) is connected when Studio
would stop the daemon, the daemon keeps running until the last client
disconnects, then stops. The clients that stay connected are told so:

- Studio shows a notification: "The ADF daemon keeps running while 1 other
  client is connected, and stops when the last one closes. (*reason*)" (or
  "*N* other clients are connected").
- The terminal app shows a notice: "The daemon stays up because this app is
  connected: …"

A Studio that connects again in the meantime clears the pending stop.

Remote computer: quitting Studio never stops the remote daemon.

When devices are connected to this computer, quitting asks first:
[Quit with devices connected](#quit-with-devices-connected).

## Studio and the terminal app together

In This computer and Remote computer mode, Studio, the terminal app (`adf`) and
other `adf` commands are clients of the same daemon. Each sees the same
agents:

- A chat sent from one appears live in the others, with streamed tokens in
  the agent you have open.
- Starting, stopping, state changes, config edits, timers and file edits in
  one show in the others within a second.
- An approval or question resolved in one clears in all of them.
- Two Studios on different machines, both in Remote computer mode on one daemon, see the same state.

In Inside Studio mode the terminal app cannot connect: `adf` refuses to start a
daemon while a Studio that runs agents inside itself uses the same settings ("ADF Studio (pid N)
is running agents from the same settings file (…)"). See
[Troubleshooting › Studio at the same time](../cli/troubleshooting.md#studio-at-the-same-time).

### Changed elsewhere

When an agent, another client or the CLI changes a file, the document or the
config while you have unsaved edits to it, Studio keeps your text and shows a
strip over the editor: "*File* was changed by *the agent* while you were
editing. Your changes are not saved." The writer is "the agent", "the
terminal app", "another Studio window", "the CLI or another API client" (an
`adf` command or a script), or "another client (*name*)".

| Button | What happens |
|---|---|
| **Reload** | Shows their version; your unsaved text is discarded |
| **Keep mine** | Saves your version over theirs |

While the strip is up, Ctrl+S saves nothing and moves focus to Reload.
Closing the tab, closing the agent or switching agents asks first: "Discard
your unsaved changes to …? Someone else changed it while you were editing."
("them" for several files).
A tab without unsaved edits updates in place, as before.

If Studio quits or crashes while the strip is up, your version is kept in
`<userData>/recovered/<agent>-<hash>/<path>`. The next launch shows "Studio
kept your unsaved version of *agent/path* from the last session, which ended
while someone else's change was waiting for your answer." with **Show
folder** and **Dismiss**. Dismiss moves the copies to
`recovered/archive/<time>/` (kept 30 days, at most 50 dismissals).

The terminal app checks before it writes. If the file changed since you
opened it, it shows "Concurrent change: *file*" ("WARNING: *file* changed
while you were editing (their change: …). Writing replaces that version.")
with **Overwrite** and **Discard** ("Not written. Your edited copy is kept at
*path*"). If another write lands between that check and the save, it asks
"*File* was changed by … after you opened it. Overwrite replaces their
version with yours. Reload keeps theirs." with **Overwrite** and **Reload
theirs** (nothing is written; your edited copy is kept).

### Streaming in the terminal app

The terminal app opens a client session on the daemon. The agent whose chat
view is open streams tokens whatever its `umbilical.stream_deltas` setting
says; other agents update when their turns, tools and states change. An
older daemon, or one with another client API version, makes the terminal app
fall back to `/events` and say so once in its activity log: "Live events over
/events: … Token streaming follows each agent's umbilical.stream_deltas."

## Daemon status

Three places show the daemon Studio uses:

- **Settings → Backend → ADF daemon**: the connection state ("Connected",
  "Connecting", "Not connected, retrying", "Not connected"), pid and who
  started it ("started by this Studio", "started by Studio", "started by the
  ADF CLI", "started by a service"); **Details** shows the URL and the
  version. Studio reads who started
  the daemon again whenever it reconnects, so a daemon restarted with
  `adf daemon restart` reads "started by the ADF CLI".
- **Help menu**: **Open Daemon Log** (This computer; if the OS cannot open the
  file, a dialog says "Could not open the daemon log." with the path and the
  reason). While the connection is
  down, a status line ("ADF daemon: connecting…", "ADF daemon: not connected
  (*url*), retrying", "ADF daemon: not connected") and **Reconnect to the ADF
  Daemon**; after a failed launch also **Run Inside Studio for This Session**.
- **`adf daemon status`** in a terminal: also `started by …`, and `proof
  unavailable: …` when the daemon runs without its local proof (below).

If the daemon could not protect its local proof file (`daemon-local-proof`,
Windows `icacls` failure), Settings → Backend says "The daemon runs without
its local proof (…), so reveal and identity import are refused. Fix the file's
permissions, then restart the daemon."

## When the daemon is not reachable

| What you see | Meaning | What to do |
|---|---|---|
| Task-bar progress and the line "Starting the ADF daemon…" | Studio is starting the daemon | Wait; Studio connects when it answers |
| The line "Waiting for the ADF daemon (pid N)…" and one notification "Waiting for the ADF daemon (pid N)… Studio connects when it answers." | Another daemon is starting or stopping on these settings | Wait |
| Dialog "Studio lost its connection to the ADF daemon." (**Reconnect Now**, **Open Daemon Log**, **Dismiss**) | The connection dropped for more than 3 seconds. Studio keeps reconnecting. The dialog is not shown again within 60 seconds | Check `adf daemon status`. If the daemon stopped, start it (`adf daemon start`) or restart Studio, which starts one. Studio reconnects by itself and notifies "Reconnected to the ADF daemon." |
| Dialog "Studio could not connect to an ADF daemon." with **Reconnect**, **Run Inside Studio for This Session** and **Open Daemon Log** | No daemon for this launch (see the table below) | Fix the cause (Settings → Backend works without a daemon), then **Reconnect**: it restarts Studio and tries the daemon again. **Run Inside Studio for This Session** restarts Studio running agents itself for this launch only; the saved mode stays. The Help menu offers both later (**Reconnect to the ADF Daemon**, **Run Inside Studio for This Session**) |
| An action fails with "Cannot reach daemon at *url*: …" | The call was made while disconnected. Nothing was done | Retry after the reconnect |
| A chat waiting for its answer ends after 15 seconds without the daemon | Studio stops waiting; the daemon may still run the turn | Reopen the agent after the reconnect |
| Dialog "Emergency stop did not reach the ADF daemon. … Agents may still be running." (after **Kill**) | The stop request failed | Run `adf daemon stop` in a terminal, or stop the agents once Studio reconnects |
| Dialog "Emergency stop was partial." | The daemon stopped some agents; the dialog names the rest | Stop them by hand |
| Notification "Studio could not reopen *agent* on the ADF daemon after reconnecting (…). Open it again." | The open agent could not be held again after a reconnect | Open it again |
| Notification "*agent* is locked again after the ADF daemon restarted. Open it again to enter its password." | The daemon restarted and forgot the file password | Open the agent and enter its password |

Studio never falls back to Inside Studio on its own. The reasons in "Studio could
not connect to an ADF daemon." include:

| Reason | Fix |
|---|---|
| "The ADF daemon exited during startup (code 1). Its log says: "Failed to start: port 7385 on 127.0.0.1 is already in use"." | Another program holds the daemon port. Stop it, or set `ADF_DAEMON_PORT` for Studio and the CLI |
| "The ADF daemon exited during startup (code N)." with another line from its log | **Open Daemon Log** |
| "The ADF daemon did not answer …/health within 90s." | Same |
| "A daemon is running on port N but Studio cannot authenticate to it (token from …)." | The daemon uses another token: unset `ADF_DAEMON_TOKEN`, or stop that daemon |
| "A daemon is running on port N but has no GET /version; it is an older ADF build." | Update the CLI (`npm i -g @agentdocumentformat/cli@latest`) and run `adf daemon restart` |
| "The ADF daemon running on this machine (pid N) uses *file*, not *file*." | A daemon on another settings file holds the port. Stop it, or run it on another port |
| "The running ADF daemon (version …) does not match this Studio (client API …)." | See [Version mismatch](#version-mismatch) |

## Version mismatch

Studio and a daemon talk through a client API with a version number. If a
daemon with another client API version runs on Studio's settings, Studio asks
before it touches it: "The running ADF daemon is version *X*; this Studio is
*Y*."

| Button | What happens |
|---|---|
| **Restart the Daemon with Studio's Version** | Stops that daemon and its agents, starts this Studio's daemon, which starts the agents set to autostart |
| **Run Inside Studio for This Session** | Studio restarts and runs agents inside itself for this launch only. The daemon, its agents and its sign-ins stay as they are; Studio does not start an agent the daemon runs, and nothing moves between them. The next launch uses the saved backend again |

When the daemon was started by the ADF CLI or a service, or other clients are
connected to it, the dialog names them and the restart button reads
**Restart It Anyway**; **Run Inside Studio for This Session** is then the default. A replacement daemon
keeps the original's "started by", so Studio's quit does not stop a daemon
the CLI started.

A daemon of another release with the same client API version attaches
without a question. Settings → Backend shows its version under the ADF
daemon row's **Details**.

## Run agents inside Studio when the daemon does not work

Inside Studio is the legacy backend. It stays for this release only, as a fallback;
the next release removes it. There are two ways to run agents in Studio again:

- **Settings → Backend → Inside Studio (legacy)**.
  Studio restarts, and sign-ins and the runtime identity move back (if a
  daemon still runs on these settings, they stay with it until you stop it).
  This is the persistent way back.
- **One session**: start Studio with `ADF_STUDIO_BACKEND=embedded`. Only
  client settings move; sign-ins and the runtime identity stay as the saved
  backend keeps them. Settings →
  Backend shows "Agents run inside Studio because ADF_STUDIO_BACKEND is
  set." The version-mismatch dialog's **Run Inside Studio for This Session**
  does the same for one launch.

In a session-only Inside Studio launch, an agent the daemon still runs cannot
start in Studio (see [Agents in two runtimes](#agents-in-two-runtimes)), and
ChatGPT, Grok and MCP sign-ins that live in the daemon are not available.

## Remote computer

Set the daemon up on the server first: [Remote daemon](../cli/remote-daemon.md).
Then, in **Settings → Backend → Remote computer**:

1. **Daemon URL**: `https://…` (a TLS proxy or `tailscale serve`),
   `http://127.0.0.1:<port>` (an SSH tunnel), or `http://100.x.y.z:7385` (a
   tailnet address in `100.64.0.0/10`). Any other `http://` URL needs the box "I trust this
   network; the token is sent unencrypted."
2. **Token**: a device token from **Add a Computer** on the other computer
   ([Add device](#add-device)), or the
   `ADF_DAEMON_TOKEN` of a daemon set up by hand. Pairing fills in the URL
   and the token for you ([Discovered](#discovered)). It is saved
   encrypted with safeStorage and never shown again. Changing the
   address removes a saved token ("The saved token was removed because the
   daemon address changed. Enter the token for the new address.").
   The token is as powerful as the server's owner seed phrase: a token
   holder can run code as the daemon (an MCP server or adapter command, then
   agent start) and read the phrase from the server's keychain. Save it only
   on a computer you trust with the phrase. Rotation: [The token is as
   powerful as your seed phrase](../cli/remote-daemon.md#the-token-is-as-powerful-as-your-seed-phrase).
3. **Test connection**: "Connected to the ADF daemon at *url* (version *V*,
   started by *X*)." or the reason it failed.
4. **Switch to This Daemon** (or choose **Remote computer** under **Run agents
   in**). The switch dialog says "Studio restarts and uses the ADF daemon at
   *url*.", what stays on this computer and what happens to running agents
   ([Running agents](#running-agents-and-turns-in-flight)); confirming
   restarts Studio connected to the daemon.

Plain `http://` to a `100.64.0.0/10` address is accepted without the
confirmation because Tailscale uses that range. Internet providers use the
same range for carrier-grade NAT, so on a network you do not control the
address may not be your tailnet. Prefer `https://` through `tailscale serve`
and the MagicDNS name ([Option 4: tailscale serve](../cli/remote-daemon.md#option-4-tailscale-serve)).

### Connection problems

Each failure is one sentence that names the URL. A daemon that cannot be
reached at launch is retried with growing pauses (2 s up to 30 s), with the
line "Waiting for the remote ADF daemon at *url* …" in Settings → Backend and
the Help menu and one notification ("Waiting for the remote ADF daemon at
*url*. Studio keeps trying."). The other failures are not retried; the dialog
"Studio could not connect to an ADF daemon." shows the sentence, and Settings
→ Backend works without a daemon, so you can fix the URL or token there:

| Sentence starts with | Fix |
|---|---|
| "Cannot reach the ADF daemon at …" / "… did not answer within 15 s" | The server, tunnel or tailnet is down. Studio keeps trying |
| "… answered HTTP 502/503/504: a proxy answers there, but the ADF daemon behind it does not." | Start the daemon on the server. Studio keeps trying |
| "The ADF daemon at … refused the token." | Run `adf daemon token` on the server, save it, Test connection, then **Reconnect** (Studio restarts and connects). A token refused after connecting ends the connection with the same sentence |
| "The ADF daemon at … does not accept the host name …" | Add the name to `ADF_DAEMON_ALLOWED_HOSTS` on the server and restart the daemon |
| "The TLS connection to … failed" | Give the server a certificate this computer trusts, or use an SSH tunnel. Studio has no option to skip certificate checks |
| "… answered a redirect" | Enter the daemon's final URL |
| "… does not answer as an ADF daemon" | Wrong address or port |
| "… speaks client API N; this Studio needs M." | Update the daemon on the server (or Studio) to the same version |
| "No token is saved for … or it cannot be decrypted on this computer." | Save the token again |

### Files on the server

Agent files live on the server. Where Studio would show a file dialog of this
computer, it shows a picker of the server's folders instead (Open agent…,
New agent, Track folder, folder fields). Its locations are the server's home
folder, each tracked folder and the agents folder, listed separately. With
`ADF_DAEMON_BROWSE_ROOTS` set on the server, those folders replace the home
folder. New agent asks before it replaces a file ("*name*.adf already
exists in this folder. Replace it?").

A `.adf` of this computer that you open by double-click, from the command
line or through a second Studio instance is offered as an upload: "*name*.adf is on this
computer, not on *host*." **Upload a copy…** asks for a tracked folder or the
agents folder on the server and uploads a copy (progress in the task bar).
The copy is a separate agent that needs review before it runs; the file here
is not changed. Nothing is uploaded without your choice. A failed upload says
"Uploading *name* to *host* failed: …" or "*host* did not take the copy of
*name*: …"; if the server already knew the agent, the copy gets a new id. A path that is on
neither machine answers "No agent file at *path* on *host* (…)".

Downloads (Share → save a copy, drag an agent out, download a file) read the
server's copy.

### Sign-in pages

When the remote daemon wants to open an MCP sign-in page, Studio asks first:
"Open a sign-in page on *page host*? The ADF daemon at *daemon host* asks to
open *page host* in your browser (…). Open it only if you started this
sign-in." Studio opens only https pages on public addresses, at most one
every 5 seconds, and takes the browser's callback on this computer and hands
it to the daemon. A refused page says why: "The ADF daemon sent a sign-in page
Studio does not open: …". If the callback port is in use here: "Port N on
this computer is in use, so Studio cannot take the sign-in callback for the
daemon. …". ChatGPT sign-in relays its callback the same way in every mode.

### What stays on the server

| Action | In Remote computer mode |
|---|---|
| Reveal in folder, Reveal template | A dialog: "This file is on *host*." (or "The templates folder is on *host*.") with the path and **Copy path** |
| Back up seed phrase, Import identity, Restore identity | Disabled, with the commands to run on the server (`adf identity new`, `adf identity restore`, `adf identity import`). Studio does not send a seed phrase to another machine; this holds through an SSH tunnel too |
| Stored credential values (Identity tab, provider key field, MCP and channel forms) | Never sent. Reveal and the provider key field say "Stored credential values stay on the daemon's machine: a remote daemon never sends them to Studio."; the MCP form and Identity values show a placeholder; the channel form shows the key as stored. Leave a placeholder as it is to keep the stored value, or clear the field and type the whole new value. An edited placeholder is refused ("… was shown as a placeholder …, so an edit of it cannot be saved.") |
| Locked credentials question | Names "the daemon's machine" instead of "this machine" |
| Agent browser viewer | Not shown: "The browser viewer needs the daemon on this computer: the container's noVNC port is on the remote server's loopback." When an agent opens a browser, a notification says so |
| LAN firewall check | "The firewall check applies to this computer, but the mesh server runs on the remote daemon's machine. …" No Fix button |
| Open Daemon Log | Disabled; run `adf daemon logs` on the server |
| Recent files | Paths on the server; not added to the OS recent documents |

Providers, MCP servers, channels, compute and the mesh act on the server:
`localhost` in a provider URL means the server.

## Remote access

Your other devices use the agents on this computer: Studio on a laptop
connects to the daemon on your desktop. This works while Studio runs agents
on **This computer**; the daemon must be running. Design:
[remote-access.md](../design/remote-access.md).

In **Settings → Networking → Remote access**, turn on **Remote access**.
Studio asks once, in a dialog titled "Turn on remote access":

> Devices you pair or add get full control of this computer's agents. A
> device token is as powerful as your seed phrase.

A paired device can attach an MCP server or adapter with any command and
start an agent, so it can run code as you and read the owner seed phrase
from the keychain. Pair only devices you trust with the phrase.

The daemon is not restarted: it starts listening on this computer's private
network addresses and its Tailscale address, and running agents keep
running. It never listens on a public address or on a network that is not
private. Turning remote access off closes those listeners and disconnects
every device; the device list is kept.

**Settings → Backend** shows one line for it on This computer, "Remote
access: On · 2 devices", with **Open Networking**.

### Network status

The line at the top of Settings → Networking is the network both the mesh's
LAN mode and remote access follow:

> Network: Private (Wi-Fi) · LAN 192.168.1.20 · Tailscale on (100.101.102.103) · Firewall ok

| Part | Meaning |
|---|---|
| Network: Private / Public | Windows: the network's category in Settings → Network. macOS and Linux: Private only for a network you marked: turning remote access on marks the current one; **Mark private** (or `adf daemon remote trust`) marks another |
| LAN … , not listening | The LAN address is on a Public network: nothing listens on it, for the mesh or remote access |
| Tailscale | Tailscale addresses always listen; the tailnet authenticates its peers |
| Firewall | Blocked: the sentence under the line says how to allow ADF Studio |

Remote access's own line, under its toggle:

| Line | Meaning |
|---|---|
| "Listening on *addresses*." | Other devices reach this computer there |
| "Off." | Remote access is off |
| "Not reachable on this network (Public)." | No LAN address listens; join a private network or mark this one |
| "No private network address now." | No LAN or Tailscale address; listening starts again when one appears |

With **Keep the daemon running when Studio quits** off, the **On quit** row
says "Devices lose the connection when Studio quits." **Keep running** turns
that setting on.

### Addresses

Each address has **Copy** and a label:

| Address | Label |
|---|---|
| `https://<machine>.<tailnet>.ts.net` (Tailscale https) | Encrypted |
| `http://100.x.y.z:7385` (tailnet) | Encrypted |
| `http://192.168.x.y:7385` (LAN) | Not encrypted: "Anyone on this network can read the token." |
| `http://<name>.local:7385` | Not encrypted |

Prefer the encrypted ones. When Tailscale runs, **Enable Tailscale https**
shows the command (`tailscale serve --bg 7385`) and runs it only after you
confirm.

This computer's name for other devices is its runtime alias (Settings →
Identity → Runtime alias), else its host name: the same name in mDNS, the
pairing dialog and other devices' lists.

### Pair device

1. On this computer, **Pair device**. The **Pair device** window shows a
   6-digit code, the time left (2 minutes) and the tries left (5).
2. On the other device, choose this computer under **Discovered** and enter
   the code ([Discovered](#discovered)).
3. This computer shows the **Allow device** dialog with the device's name,
   address and how it connected. **Allow** or **Deny**. When Studio is in the
   background, an OS notification opens it.

The code alone never pairs a device: you must also allow it. Five wrong
codes close the window ("Pairing closed after 5 wrong codes."); open a new
one. After **Allow**: "Device added: *name*."

### Add device

**Add device** asks for a device name and shows a device token (`adfd_…`)
with **Copy** and **Done**. The token is shown once: after **Done** it
cannot be shown again. If it is lost, revoke the device and add it again.
On the other device, paste an address and the token in **Settings → Backend
→ Remote computer**.

The token in `adf daemon token` (this computer's own) is refused from other
devices.

### Devices

The **Devices** list shows each name, how it was added (Paired or Token),
and "Connected now", "Last seen *time* (*address*)" or "Never connected".
**Revoke** asks in a **Revoke device** dialog: "*name* is disconnected now and
its token stops working." After it: "Device revoked: *name*."

### Discovered

On the other device, **Settings → Backend → Remote computer → Discovered**
lists the ADF computers with remote access on: on this network (mDNS) and on
your tailnet. Each shows its name, address, fingerprint and Encrypted or Not
encrypted; "Pairing open" when a pairing window is open, "Paired" when it is
the saved remote computer.

**Pair** opens the **Pair** dialog: this device's name (default: its runtime
alias, else its host name), the code, and, for a plain-http address, "I
trust this network; the token is sent unencrypted." Then "Waiting for *host*
to allow this device…". When the host allows it, Studio saves the address
and token as for a pasted token (encrypted with safeStorage), preferring an
encrypted address of the host. **Switch to This Daemon** switches to it.

| Message | What to do |
|---|---|
| "Wrong code. *N* tries left." | Enter the code shown on the host |
| "Wrong code, and no tries are left. …" | On the host, **Pair device** again for a new code |
| "The pairing window on *host* is closed. …" | The 2 minutes passed or the host cancelled: open a new window |
| "*host* denied this device." | The host chose Deny |
| "Studio could not reach *host* at *url*. The host's firewall may block port 7385." | See [Firewall](#firewall) |
| "*host* is already asking about another device. …" | Wait, then try again |
| "*url* has remote access off. …" | Turn remote access on, on the host |
| "*host* runs an older ADF. Update ADF there, then pair again." | The host's ADF predates this feature |

Entering an address and token by hand still works.

### Firewall

Windows asks the first time whether ADF Studio may accept connections:
choose **Allow** on private networks. macOS may ask whether ADF Studio may
find devices on the local network: choose **Allow**. Studio adds no firewall
rule itself. On Linux, open port 7385 for your LAN, for example
`sudo ufw allow from 192.168.0.0/16 to any port 7385 proto tcp`.

### Quit with devices connected

When Studio would stop the daemon (Studio started it and **Keep the daemon
running** is off) and a device is connected, quitting Studio asks first,
every time, in a **Quit** dialog: "*N* devices connected", "Keep the daemon
running for them, or stop it."

**Keep running** leaves the daemon running after Studio quits, this time
only; the setting does not change. **Stop daemon** stops it and disconnects
them. **Cancel** keeps Studio open. Quitting from the menu, the tray, Cmd+Q
and closing the window on Windows and Linux all ask.

## Agents in two runtimes

On one computer, one agent file runs in one runtime at a time. Each runtime
(Studio in Inside Studio mode, a daemon) takes a lease on the agent file when it starts
the agent. Starting an agent another runtime runs is refused with code
`agent_leased` and a sentence naming the holder:

- "agent-1 is already running in the ADF daemon (pid 4242). Stop it there with
  "adf stop agent-1", or stop that daemon with "adf daemon stop", then start
  it here."
- "agent-1 is already running in another ADF Studio (pid 4242). Stop the
  agent there or quit that Studio, then start it here."

Autostart skips such agents (`leased_elsewhere` in the daemon's autostart
report). A Studio in This computer or Remote computer mode runs no agents and holds no
leases, so `adf daemon start` does not refuse it. Lease files, stale leases
and the full list of sentences: [Troubleshooting › Agent is already
running](../cli/troubleshooting.md#agent-is-already-running-agent_leased).

An agent file that another runtime runs opens in the daemon read-only: you
can read it, and a write answers `agent_leased` with the same sentence.

An action on the open agent while Studio does not hold it in the daemon (it
is not running there and the client session could not hold it) fails with
"*Action* is not available in daemon mode yet: W2-B (*path* is not running in
the daemon, and holding it open needs a client session)". Open the agent
again; if it repeats, restart Studio.

## Message index

Every message the backend features show, and where it is explained. Text in
*italics* varies.

| Message (start) | Section |
|---|---|
| "Run agents *on B* instead of *on A*?" | [Switch the backend](#switch-the-backend) |
| "A turn is in flight in: …" / Wait for Them to Finish / Stop Them Now | [Running agents and turns in flight](#running-agents-and-turns-in-flight) |
| "The switch to *B* is waiting: …" / Finish Switch Now / Cancel Switch | [Running agents and turns in flight](#running-agents-and-turns-in-flight) |
| "This replaces the waiting switch to "*B*"." / "Studio is already restarting for the switch to "*B*". Nothing changed." / "Not started after the switch: …" | [Running agents and turns in flight](#running-agents-and-turns-in-flight) |
| "Running again after the switch: …" / "Not started: …" | [Running agents and turns in flight](#running-agents-and-turns-in-flight) |
| "The ADF daemon keeps running (…), and so do its agents (…) there." | [Running agents and turns in flight](#running-agents-and-turns-in-flight) |
| "macOS asks once whether the ADF daemon may read Studio's runtime key from the keychain." | [Switch the backend](#switch-the-backend), [Troubleshooting](../cli/troubleshooting.md#macos-keeps-asking-for-keychain-access) |
| "ADF_STUDIO_BACKEND is set in this environment and overrides this choice …" | [Switch the backend](#switch-the-backend) |
| "Agents now run *on B*." / "… part of the handover is not done." | [What moves](#what-moves-during-a-switch), [When a move is not done](#when-a-move-is-not-done) |
| "Agents now run in a background service on this computer (the ADF daemon)." / Open the Guide | [Upgrading from 0.7.x](#upgrading-from-07x) |
| "Default changed" (Settings → Backend) | [Upgrading from 0.7.x](#upgrading-from-07x) |
| "Inside Studio (legacy)" | [Run agents inside Studio when the daemon does not work](#run-agents-inside-studio-when-the-daemon-does-not-work) |
| "Agents now run in a background service on this computer (the ADF daemon), but Studio could not connect to it." | [Upgrading from 0.7.x](#upgrading-from-07x) |
| "An older ADF daemon (adf …) is running and uses the same settings." / "An ADF daemon that Studio cannot identify …" | [Upgrading from 0.7.x](#upgrading-from-07x) |
| "Studio cannot use its backend settings file." / "… or replace its backend settings file." | [Upgrading from 0.7.x](#upgrading-from-07x) |
| "Studio and the ADF daemon are signed in to … with different accounts." | [Two accounts](#two-accounts-the-conflict-dialog) |
| `auth.replaced.<time>.json` | [Two accounts](#two-accounts-the-conflict-dialog) |
| "not moved back: … still runs on these settings" | [When a move is not done](#when-a-move-is-not-done) |
| "… is missing, so Studio cannot tell its sign-ins from the daemon's own" | [When a move is not done](#when-a-move-is-not-done) |
| "Saved. Applies from now on." (Keep the daemon running) | [Quit Studio](#quit-studio) |
| "The ADF daemon keeps running while *N* other client(s) are connected …" | [Quit Studio](#quit-studio) |
| "The daemon stays up because this app is connected: …" (terminal app) | [Quit Studio](#quit-studio) |
| "*File* was changed by … while you were editing." / Reload / Keep mine | [Changed elsewhere](#changed-elsewhere) |
| "Discard your unsaved changes to …?" | [Changed elsewhere](#changed-elsewhere) |
| "Studio kept your unsaved version of …" / Show folder / Dismiss | [Changed elsewhere](#changed-elsewhere) |
| "… was changed by … after you opened it." / Overwrite / Reload theirs (terminal app) | [Changed elsewhere](#changed-elsewhere) |
| "Live events over /events: …" (terminal app) | [Streaming in the terminal app](#streaming-in-the-terminal-app) |
| Help menu "ADF daemon: …" / Reconnect to the ADF Daemon / Open Daemon Log | [Daemon status](#daemon-status) |
| "The daemon runs without its local proof …" | [Daemon status](#daemon-status) |
| "Starting the ADF daemon…" / "Waiting for the ADF daemon (pid N)…" | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Studio lost its connection to the ADF daemon." / "Reconnected to the ADF daemon." | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Studio could not connect to an ADF daemon." and its reasons | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Studio could not reopen … after reconnecting" / "… is locked again after the ADF daemon restarted." | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Saved. Applies at the next launch." and the other Backend page messages | [Messages on the Backend page](#messages-on-the-backend-page) |
| "Uploading … failed" / "… did not take the copy of …" | [Files on the server](#files-on-the-server) |
| "Cannot reach daemon at …" | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Emergency stop did not reach the ADF daemon." / "Emergency stop was partial." | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Could not open the daemon log." | [Daemon status](#daemon-status) (Help menu) |
| "Studio restarts once the turns in flight finish (…)." / "Switching to *B*" | [Running agents and turns in flight](#running-agents-and-turns-in-flight) |
| "*Action* is not available in daemon mode yet: W2-B (…)" | [Agents in two runtimes](#agents-in-two-runtimes) |
| "… Its log says: "Failed to start: port 7385 on 127.0.0.1 is already in use"." | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "Run Inside Studio for This Session" (failure dialog, Help menu) | [When the daemon is not reachable](#when-the-daemon-is-not-reachable) |
| "The running ADF daemon is version *X*; this Studio is *Y*." / Restart It Anyway | [Version mismatch](#version-mismatch) |
| "Agents run … because ADF_STUDIO_BACKEND is set." / "… for this session only" | [Run agents inside Studio when the daemon does not work](#run-agents-inside-studio-when-the-daemon-does-not-work) |
| "Connected to the ADF daemon at …" (Test connection) and the remote sentences | [Remote computer](#remote-computer) |
| "I trust this network; the token is sent unencrypted." | [Remote computer](#remote-computer) |
| "Waiting for the remote ADF daemon at …" | [Connection problems](#connection-problems) |
| "Turn on remote access" / "Devices lose the connection when Studio quits." / "Remote access: On · *N* devices" | [Remote access](#remote-access) |
| "Network: Private / Public …" / "Not reachable on this network (Public)." / "Listening on …" / Mark private | [Network status](#network-status) |
| "Anyone on this network can read the token." / Encrypted / Not encrypted | [Addresses](#addresses) |
| "Allow device" / "Pairing closed after 5 wrong codes." / "Device added: …" | [Pair device](#pair-device) |
| "Revoke device" / "Device revoked: …" | [Devices](#devices) |
| "Waiting for *host* to allow this device…" / "Wrong code. …" / "… denied this device." / "… The host's firewall may block port 7385." | [Discovered](#discovered) |
| "*N* devices connected" (Quit) / Keep running / Stop daemon | [Quit with devices connected](#quit-with-devices-connected) |
| "*file* uses schema v2, which this version cannot upgrade …" / "… skipped: need upgrade or review" | [Troubleshooting](../cli/troubleshooting.md#an-agent-file-uses-schema-v2) |
| "*name*.adf is on this computer, not on *host*." / Upload a copy… | [Files on the server](#files-on-the-server) |
| "*name*.adf already exists in this folder. Replace it?" | [Files on the server](#files-on-the-server) |
| "Open a sign-in page on …?" / "The ADF daemon sent a sign-in page Studio does not open: …" | [Sign-in pages](#sign-in-pages) |
| "This file is on *host*." / Copy path | [What stays on the server](#what-stays-on-the-server) |
| "A remote ADF daemon never sends its owner seed phrase …" / "The owner identity of a remote ADF daemon is changed on its machine …" | [What stays on the server](#what-stays-on-the-server) |
| "Stored credential values stay on the daemon's machine …" | [What stays on the server](#what-stays-on-the-server) |
| "The browser viewer needs the daemon on this computer …" | [What stays on the server](#what-stays-on-the-server) |
| "The firewall check applies to this computer, but the mesh server runs on the remote daemon's machine." | [What stays on the server](#what-stays-on-the-server) |
| "… is already running in the ADF daemon (pid N)." (`agent_leased`) | [Agents in two runtimes](#agents-in-two-runtimes) |
| "ADF Studio (pid N) is running agents from the same settings file (…)." | [Studio and the terminal app together](#studio-and-the-terminal-app-together) |
| "Agent leases unavailable: …" / "… its lease file … could not be read or replaced" | [Troubleshooting](../cli/troubleshooting.md#agent-is-already-running-agent_leased) |
| "*X* was left running: used by …" (Settings → Compute) | [Troubleshooting](../cli/troubleshooting.md#containers-left-running) |
