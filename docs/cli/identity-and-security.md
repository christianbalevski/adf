# Identity and security

## Owner identity

Your owner identity proves the agents are yours. New agents are sealed under
it (their keys, owner and runtime attestations), exactly as in ADF Studio. It
is derived from a **12-word seed phrase**: the same phrase in Studio and in
the CLI is the same owner, so agents made in either open in both.

| Status (`adf identity`, header badge) | Meaning | Next step |
|---|---|---|
| `none` | No owner on this machine yet | `adf identity new`, or `/identity create` |
| `restore-needed` | This machine has an owner (for example from Studio) but the daemon lacks the phrase | `adf identity restore`; the phrase must match that owner |
| `locked` | The phrase is in a passphrase-protected file that is not unlocked | `adf identity unlock` |
| `ready` | Agents can be created and unlocked | |

- **Create** shows the 12 words **once**. Write them down; confirm with `yes`
  (CLI) or `saved` (terminal app). Anyone with the phrase can act as you;
  without it the identity cannot be recovered. The daemon never shows it
  again (Studio on the same machine can: Settings → Back up seed phrase).
- **Restore** reads the phrase at a hidden prompt (CLI) or a masked field
  (app): never argv, shell history, logs or the clipboard. Piping it on stdin
  works for automation.
- Create, restore and unlock only work on the daemon's own machine
  (loopback, never through a reverse proxy). Against a remote daemon, run
  them there (or over an [SSH tunnel](remote-daemon.md)); behind a proxy,
  on the server against its loopback port.

```bash
adf identity            # status
adf identity new        # first time
adf identity restore    # you already have a phrase
adf identity unlock     # passphrase-file storage, after a daemon restart
adf identity lock
```

In the app: `/identity [create|restore|unlock|lock]`, `i` on the Fleet, or
Runtime › Identity.

## Where the phrase is kept

| Storage | When | Notes |
|---|---|---|
| **OS keychain** | macOS Keychain, Windows Credential Manager, Linux Secret Service | Shared with Studio on the same machine (service `ADF`), so `adf identity` is usually `ready` right away |
| **Passphrase file** | No usable keychain (a headless Linux server) | `owner-secrets.json` next to the daemon settings. You choose the passphrase (8+ characters) on create / restore. After every daemon restart: `adf identity unlock`, or start the daemon with `ADF_OWNER_PASSPHRASE` or `ADF_OWNER_PASSPHRASE_FILE` |

`ADF_SECRET_STORE=file|keychain` forces one; `ADF_KEYCHAIN=0` disables the
keychain. Provider API keys added with `/provider add` go to the same store.

On macOS the first time the daemon (a `node` process) reads the phrase Studio
stored, the Keychain asks whether to allow it. Choose **Always Allow**, or it
asks again at every daemon start.

## Daemon access token

Every request to the daemon except `GET /health` needs its access token
(`Authorization: Bearer …`). This is what stops a web page in your browser
from talking to `127.0.0.1:7385`.

- On first start the daemon writes a random token to
  `<data dir>/daemon-token` (mode 0600). `adf` and the terminal app on the
  same machine read it themselves: nothing to configure.
- `adf daemon token` prints it (only the token on stdout, so it pipes). Use
  it for a client on another machine: `--token <token>` or
  `ADF_DAEMON_TOKEN`.
- `ADF_DAEMON_TOKEN` set for the daemon replaces the file; it is required
  when the daemon binds a non-loopback `--host`.
- The local token file is only ever sent to a loopback URL, never to another
  host.
- The daemon also refuses requests whose `Host` is not its own (DNS
  rebinding) and any cross-site browser request.

The data dir is the folder of the daemon's settings file:
`ADF_DAEMON_SETTINGS`, else `<config dir>/ADF Studio` (when Studio's settings
are there) or `<config dir>/adf-studio`, where the config dir is
`~/Library/Application Support` (macOS), `%APPDATA%` (Windows) or
`$XDG_CONFIG_HOME` / `~/.config` (Linux). `adf daemon status` prints it.

A `401` means the token is missing or wrong: see
[Troubleshooting](troubleshooting.md#401-run-adf-daemon-token).

## Credentials

Channel tokens and MCP server keys are sealed in the agent's own identity
store, under your owner identity, never in its config. Provider API keys are
in the daemon's secret store. None of them is ever sent back: the CLI and the
app only see metadata (set or not, sealed, locked, length). `adf identities
<agent>` lists an agent's identity entries the same way. Forms show
`set • (hidden)`, `set • locked` or `not set`, and can replace a value but
never reveal it.

### Locked credentials

An agent's saved credentials are **locked** when the daemon cannot open the
agent's credentials envelope, usually because the owner identity is not
unlocked here. Saving a channel or MCP credential then asks what to do:

| Key | Choice |
|---|---|
| `u` | **Unlock** first: opens the identity dialog, then resumes the setup |
| `r` | **Replace**: after one more confirm, stores the new values anyway. The old sealed value is discarded unread; the agent's log records the replace |
| `c`, `Esc` | **Cancel**: back to the form, as typed |

Nothing is replaced without that explicit choice.

## Review and trust

Agents you create here are reviewed and trusted automatically. An `.adf` from
someone else shows `needs review`: its review lists what it can do (owner,
compute, powerful tools, MCP servers, channels) before you accept and load
it. Templates from someone else are reviewed the same way. See
[Terminal app › Stopped agents](terminal-app.md#stopped-agents).
