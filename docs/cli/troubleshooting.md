# Troubleshooting

Start with these two; they answer most questions:

```bash
adf daemon status      # running?, pid, uptime, version, data dir, log file
adf daemon logs -f     # the background daemon's log (Ctrl+C stops following)
```

## `npm i -g` fails with EEXIST

```text
npm error code EEXIST
npm error EEXIST: file already exists … bin/adf
```

The old package `agent-document-format` installed the same `adf` command.

```bash
npm uninstall -g agent-document-format
npm i -g @agentdocumentformat/cli
```

## The daemon does not start

`adf` prints why, with the end of the log. Common causes:

| Message | Fix |
|---|---|
| `ADF refuses to run on Node.js …` | Install Node.js 22.23.4+, 24.22.1+ or 26.12.1+ (`node --version`); see [Node.js versions](index.md#nodejs-versions) |
| `ADF refuses to run on Electron … (Chromium …)` | A source checkout whose `node_modules` has an older Electron: run `npm ci` |
| `ADF Studio (pid N) is running agents from the same settings file (…).` / `ADF Studio is running.` / `Another ADF runtime on the same settings is already running` | See [Studio at the same time](#studio-at-the-same-time) |
| `The daemon exited during startup (code N).` | Read the log lines shown (or `adf daemon logs`). Run `adf daemon` in the foreground to watch it start |
| `The daemon did not answer …/health within 90s.` | Same; a first start that installs or migrates can be slow. `adf daemon status` shows whether it came up |
| `Waiting for the ADF daemon starting as pid N…` | A daemon is already starting under that pid file; wait, or stop it (`adf daemon stop`) |
| `http://host:7385 is not on this machine; start the daemon there.` | `adf` only starts local daemons. See [Remote daemon](remote-daemon.md) |
| `Cannot reach the ADF daemon at http://127.0.0.1:7386 … not this machine's daemon port` | A loopback port other than your daemon's (7385 / `ADF_DAEMON_PORT`) is treated as a tunnel and never auto-started: check the tunnel, or `adf daemon start --port 7386` |

The terminal app shows **Daemon offline** with a retry countdown while
nothing answers; start it with `adf daemon start` in another terminal. With `--no-daemon` or
`ADF_NO_AUTOSTART=1`, `adf` never starts one by itself.

## An old daemon is still running

The daemon outlives `adf` and upgrades. After `npm i -g
@agentdocumentformat/cli@latest`, restart it so it runs the new code:

```bash
adf daemon restart
```

`adf daemon status` shows the running daemon's version; `adf --version` the
installed one. A daemon too old to have a stop endpoint says so: stop it with
`Ctrl+C` in its terminal (or end the process), then `adf daemon start`.

## 401: run `adf daemon token`

CLI and REST operations use bearer authentication. Browser Studio uses its
own cookie session; see [Browser Studio sign-in](#browser-studio-sign-in).

- **Same machine:** `adf` reads the token file itself. A `401` here usually
  means the client is older than the daemon: update the CLI
  (`npm i -g @agentdocumentformat/cli@latest`). Also check that the client
  and daemon use the same settings (`ADF_DAEMON_SETTINGS`,
  `ADF_USER_DATA_DIR`), since the token file lives next to them.
- **Another machine using remote access:** pair with `adf pair`, or have the
  host issue a device token with `adf daemon devices add <label>` and pass it
  with `--token` or `ADF_DAEMON_TOKEN`. The host's own token is refused on
  remote-access listeners.
- **An explicit SSH tunnel:** run `adf daemon token` on the daemon's machine
  and pass it with `--token` or `ADF_DAEMON_TOKEN`. A
  loopback URL on another port than your own daemon's (e.g.
  `http://127.0.0.1:7386` for `ssh -L 7386:127.0.0.1:7385 host`) counts as a
  tunnel: the local token file is not sent there.
- **`ADF_DAEMON_TOKEN` set in your shell** but the daemon uses its file (or
  the other way round): unset it, or give both the same value.

A `403` "Host header not allowed" means the daemon does not know the host
name you used: add it to the daemon's `ADF_DAEMON_ALLOWED_HOSTS`. See
[Remote daemon](remote-daemon.md).

## Browser Studio sign-in

Browser Studio and `adf web` require a browser-enabled CLI and daemon build;
published npm v0.8.3 does not include them. Installing the currently published
package alone does not add browser support. See the
[Browser Studio guide](../guides/studio-web.md) for source-build instructions.

| Symptom | What to do |
|---|---|
| `adf web` is unknown, `/studio/` is missing, or the daemon does not support Browser Studio | Use a build containing browser support. Build its web assets, and check that the running daemon is from that build. An old daemon keeps running after a CLI update; restart it when you are ready to stop its agents. |
| The local daemon is not ready for browser sign-in | Run `adf daemon status`. Start the daemon if needed, and check that CLI and daemon use the same settings/data directory. Both the local token and per-start local proof must be available. |
| Automatic sign-in refuses a remote address or an unrecognized port | `adf web` only signs in to this computer's daemon. For a known local daemon choose `--port <n>`; for a tunnel or another computer use browser pairing. A saved default CLI remote does not select the browser target. |
| No browser opens on a headless host | Run `adf daemon remote on`, allow the intended network, then `adf daemon pair`. Open a printed `/studio/` address on your other device, enter the code and approve the request in the host terminal. |
| A launch link expired or was already used | Run `adf web` again. Its sign-in ticket lasts 60 seconds and can be redeemed once. The ordinary `/studio/` address printed in the terminal does not contain a ticket. |
| Pairing has no reachable address | Check `adf daemon remote status` and `adf daemon remote allow-network <network-id-or-name>`. Remote access listens only on networks you allow. Check the firewall and use one of the addresses printed by `adf daemon pair`. |
| Pairing is denied, expired, or the window closes | Start `adf daemon pair` again. Enter the new six-digit code within two minutes and approve the browser name/source address in the host terminal. The code alone does not grant access. |
| The browser asks to sign in again | Sessions last eight hours. A paired browser's HttpOnly credential cookie can renew access for up to 30 days, including after a daemon restart, while its device remains authorized. Signing out or clearing cookies removes that remembered credential. Local launch sessions have no remembered master credential: run `adf web` again. |

Use `adf daemon devices` and `adf daemon devices revoke <id-or-label>` on the
host to review and remove browser access. Browser sign-in never asks you to
paste the daemon's bearer token. For remote setup and HTTPS, see
[Browser Studio on another device](remote-daemon.md#browser-studio-on-another-device).

If the browser cannot save recovery data, keep the page open and copy your
unsaved work before reloading. Recovery is stored in this browser; signing in
as a different paired device does not import another device's drafts or queued
messages. Recovered queued messages require review before sending.

## Studio at the same time

ADF Studio runs agents in one of three backends
([Studio backend](../guides/studio-backend.md)). In **Local** mode
Studio uses the same daemon as `adf`: both are clients and run side by side.
In **Inside Studio (legacy)** mode Studio runs agents itself, from the same
settings and files, so `adf` does not start a daemon while such a Studio runs
on the same settings:

```text
ADF Studio (pid 4242) is running agents from the same settings file (C:\Users\me\AppData\Roaming\ADF Studio\adf-settings.json).
Studio and the daemon would run the same agents from the same files at once.
Quit ADF Studio, then run adf again. Or keep using Studio.
```

Choose one:

- Connect Studio to ***name* (Local)** (Settings → Connections). Studio and `adf`
  then share one daemon.
- Quit Studio and run `adf` again.
- Give the daemon separate data
  (`ADF_DAEMON_SETTINGS=/path/to/other/adf-settings.json`), or override the
  check with `adf daemon start --force`. The agent lease still keeps each
  agent file in one runtime ([below](#agent-is-already-running-agent_leased)),
  but both runtimes want mesh port 7295.

Studio versions that do not record themselves in the lease folder are
detected the old way (the mesh `/ping` answer, or an `ADF Studio` process);
that check prints `ADF Studio is running.`

## Agent is already running (`agent_leased`)

On one computer, one agent file runs in one runtime at a time (an Embedded
Studio, or a daemon). Each runtime takes a lease on the agent file when it
starts the agent. Starting it in a second runtime is refused with code
`agent_leased` and one of these sentences:

| Sentence | What to do |
|---|---|
| `agent-1 is already running in the ADF daemon (pid N[, url]). Stop it there with "adf stop agent-1", or stop that daemon with "adf daemon stop", then start it here.` | As it says |
| `agent-1 is already running in another ADF Studio (pid N). Stop the agent there or quit that Studio, then start it here.` | As it says |
| `agent-1 is already running on another machine (host, pid N) that shares this lease folder. Stop it there, then start it here.` | The lease folder is on a shared home directory; stop it on that machine |
| `… That process uses the settings file …` | The holder runs on other settings (a second daemon with `ADF_DAEMON_SETTINGS`) |
| `… ADF cannot confirm that pid N is still that process: it recorded no endpoint to check. If no ADF Studio or daemon runs agent-1, delete the lease file <path> and start it again.` | Check `adf daemon status` and Task Manager / `ps`. If neither runs the agent, delete that file |
| `… ADF could not confirm it: <url> did not answer the check, which a busy daemon also does. Wait a moment and try again; "adf daemon status" shows whether that daemon runs.` | Wait and retry. Do not delete the lease |
| `agent-1 could not be started: its lease file <path> could not be read or replaced (…). If no other ADF Studio or daemon runs this agent, delete that file and start it again.` | As it says |

Autostart skips such an agent and reports it as `leased_elsewhere`; the
terminal app's fleet shows the sentence.

**Lease files.** One JSON file per agent file, named by a hash of the agent
file's real path, in a per-user folder that does not depend on the settings
file:

| OS | Lease folder |
|---|---|
| Windows | `%LOCALAPPDATA%\adf\leases` |
| macOS | `~/Library/Application Support/adf/leases` |
| Linux | `$XDG_CONFIG_HOME/adf/leases` (default `~/.config/adf/leases`) |

`ADF_LEASE_DIR` overrides it. The file names the holder (`kind`, `pid`,
`settingsPath`, `controlUrl` for a daemon). `hosts/<pid>.json` lists the
runtimes on this machine and `clients/<pid>.json` the Studios in daemon mode.
A lease whose holder is gone is replaced at the next start; delete one by
hand only when a sentence above says so.

**Lease folder not writable.** `Agent leases unavailable: <folder> cannot be
written (…). agent-1 runs without protection against a second ADF Studio or
daemon on this machine running it.` The agent starts anyway. Fix the
folder's permissions.

**Files open in two runtimes.** An agent file another runtime runs can still
be opened and read. A write to it through the daemon (config, files, review
accept) answers `409 agent_leased` with the same sentence.

## The daemon's local proof

Owner import (`adf identity import`) and the reveal of stored credential
values need, besides the token, a secret the daemon writes at every start to
`<data dir>/daemon-local-proof` (`daemon-local-proof-<port>` off the default
port). Only `adf` and Studio on the daemon's machine send it. If the daemon
cannot restrict that file to your user (Windows `icacls` failure), it runs
without a proof and those routes answer `403 loopback_only`.
`adf daemon status` then prints `proof     unavailable: …`, and Studio's
Settings → Connections says "Reveal and identity import are refused." and names
the problem under **Details** ("Local proof: unavailable (…)"). Fix the
data folder's permissions (or move it into your user profile) and run
`adf daemon restart`.

## Containers left running

When a daemon or Studio stops, it stops only the compute containers it
started or still uses. A container another runtime uses (most often the
shared `adf-mcp`) is left running, and the log says so:
`[Compute] Leaving adf-mcp running (used by …)`. Settings → Compute shows the
same as "adf-mcp was left running: used by …", and each container row names
the other runtimes that use it ("Also used by …"). Removing or rebuilding such
a container from Settings → Compute deletes it anyway; the other runtime
creates it again when it needs it.

A container whose owner crashed (no live runtime claims it) is stopped by the
next graceful stop of any runtime. The reason "owner unknown: unreadable
container claims of …" means another live runtime's record in the lease
folder could not be read, so the container was kept to be safe.

## macOS keeps asking for Keychain access

The daemon (a `node` process, or Studio's own binary when Studio starts it in
Local mode) reads the owner identity and, in Local mode, Studio's
runtime key from the Keychain. macOS asks the first time; choose **Always
Allow**. That grants access to the binary that runs the daemon, and to any
script it runs. If it asks at
every start, open Keychain Access, find the `ADF` item, and allow `node`
under Access Control. To keep the keychain out of it, set
`ADF_KEYCHAIN=0` (the identity then lives in a passphrase file; see
[Identity and security](identity-and-security.md#where-the-phrase-is-kept)).

## The daemon exits with "Owner secret store"

`adf daemon start` reports "The daemon exited during startup (code 1)", and
the log has a line starting `[ADF Daemon] Owner secret store:`. The daemon was
started with `ADF_SECRET_STORE=keychain` and no usable keychain, with
`ADF_KEYCHAIN=0` as well, or with an unknown `ADF_SECRET_STORE` value. The
line names the cause. Fix the keychain, unset the conflicting variable, or set
`ADF_SECRET_STORE=file`; see
[Requiring the keychain](../daemon/owner-secret-storage.md#requiring-the-keychain).

## Shift+Enter sends the message

The terminal sends Shift+Enter as a plain Enter. Use `Alt+Enter` or `Ctrl+J`,
or run `/terminal-setup` for the fix for your terminal.

**macOS Terminal.app** cannot send Shift+Enter at all: use `Ctrl+J`, or turn
on Settings → Profiles → Keyboard → "Use Option as Meta key" and use
`Option+Enter`. iTerm2 3.5+, kitty, WezTerm and Ghostty work out of the box.
See [Terminal app › Shift+Enter](terminal-app.md#shiftenter).

## Copy and paste do not work

In mouse mode (the default) drag selects and copies, right-click pastes.
Hold `Shift` (`Option` in iTerm2, `Fn` in Terminal.app) for the terminal's
own selection, or `/mouse off` to hand the mouse back to the terminal. Over
SSH, in WSL or containers, copying goes through the terminal (OSC 52); force
it with `ADF_TUI_CLIPBOARD=osc52`. iTerm2 needs "Applications in terminal may
access clipboard".

## Sign-in problems

- `adf auth` (or `/auth`) shows who is signed in. The daemon's sign-in is
  separate from that of a Studio in Inside Studio mode: sign in here even if
  Studio is signed in. Switching Studio to Local moves Studio's ChatGPT, Grok and MCP
  sign-ins to the daemon ([what moves](../guides/studio-backend.md#what-moves-during-a-switch)).
- **The browser does not open:** the URL is printed (in the app, `c` copies
  it); open it by hand.
- **Timed out:** the sign-in was not finished in time; run it again.
- **Remote daemon:** ChatGPT needs relay mode (automatic for a remote
  `--url`; `--relay` through an SSH tunnel). See
  [Remote daemon › Sign in to ChatGPT](remote-daemon.md#sign-in-to-chatgpt).
- An agent shows `signed out`: its provider is a subscription the daemon is
  not signed in to: `/login chatgpt`, `/login grok` or `/login claude`.
- **Claude:** sign-in reports Claude Code missing or too old: install or
  update it on the daemon's machine (`claude update`; 2.1.248 or newer). If
  Claude Code is signed in with an Anthropic Console account, `/login claude`
  to sign in with a Claude plan instead.

## Credentials are locked

Saving a channel or MCP credential says the agent's saved credential "is
locked and can't be read (identity not unlocked)". The daemon cannot open
that agent's credentials:

1. Check the owner identity: `adf identity`. `locked` → `adf identity
   unlock`; `restore-needed` → `adf identity restore`.
2. Then choose **Unlock** (`u`) in the dialog, which resumes the setup.
3. Only if the old value is lost for good: **Replace** (`r`) discards it
   unread and stores the new one.

See [Locked credentials](identity-and-security.md#locked-credentials).

## The terminal app does not open

- `adf: the terminal app needs a terminal`: stdin and stdout must be a TTY.
  In scripts use the one-shot commands (`adf agents`, `adf chat …`).
- Garbled boxes or glyphs: `adf --ascii`. No colors wanted: `--mono` or
  `NO_COLOR=1`.

## An agent file uses schema v2

Opening an agent file older than storage schema v3 fails with "agent-1.adf
uses schema v2, which this version cannot upgrade (it upgrades v3 and
later; no released version upgrades older files). The file was not
changed." A file with no schema version and an older layout (an
`adf_archive` table, or no `adf_audit`) fails the same way ("… has no schema
version and an older layout …"). Nothing is written to the file: no backup,
no upgrade step, and a `-wal` beside it is not folded into it. Only when a
corrupt file was repaired first does the sentence leave out "The file was
not changed".

No released ADF version upgrades these files. Their content is plain
SQLite: `sqlite3 agent-1.adf .dump > agent-1.sql` exports every table, and
a new agent can take over the parts you need.

The boot envelope sweep (Studio and the daemon, at every launch) does not
open a tracked file that needs a schema upgrade or has not been reviewed.
Its log line counts them once: "… 3 skipped: need upgrade or review". A file
that needs an upgrade is upgraded when you open it.

**Earlier builds damaged these files.** Studio at every launch, and the
daemon since 0.8.0-daemon.2, opened every tracked file.
For a v2 file the log showed "Backup created before migration (v2 → v32)"
and then "table adf_meta has no column named protection". Before that error
the upgrade steps that run for every version had already changed the file,
and the backup was deleted:

- the `adf_archive` table was dropped, with every archived snapshot in it;
- a trigger config in the old shape (`triggers.document`, `triggers.agent`)
  was replaced with the default triggers;
- `security.allow_protected_writes` was removed from the config, and a
  `container_exec` tool entry was renamed `compute_exec`;
- columns were added to `adf_loop` and `adf_files`, and an empty `adf_audit`
  table was created.

To check a file:

```bash
sqlite3 agent-1.adf "SELECT key, value FROM adf_meta WHERE key LIKE '%schema_version'; SELECT name FROM sqlite_master WHERE type = 'table'"
```

A file at schema 2 that lists `adf_audit` and no `adf_archive` went through
these steps. Its tables do not show whether `adf_archive` held rows before.

To get the data back, restore the file from a backup made before the first
such launch (Time Machine, File History, a copy). Without one, the dropped
table's pages may still be in the file: on a copy, `sqlite3 copy.adf
.recover > recovered.sql` writes what SQLite can still read, including
pages no table uses (in a `lost_and_found` table). Nothing is guaranteed.
Work on a copy only, and leave the `-wal`/`-shm` files beside the original
alone.
