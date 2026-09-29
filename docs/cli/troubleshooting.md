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
| `adf needs Node.js 22 or newer` | Upgrade Node.js (`node --version`) |
| `ADF Studio is running.` / `Another ADF runtime on the same settings is already running` | See [Studio at the same time](#studio-at-the-same-time) |
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

The daemon requires its access token on every request.

- **Same machine:** `adf` reads the token file itself. A `401` here usually
  means the client is older than the daemon: update the CLI
  (`npm i -g @agentdocumentformat/cli@latest`). Also check that the client
  and daemon use the same settings (`ADF_DAEMON_SETTINGS`,
  `ADF_USER_DATA_DIR`), since the token file lives next to them.
- **Another machine or an SSH tunnel:** run `adf daemon token` on the
  daemon's machine and pass it with `--token` or `ADF_DAEMON_TOKEN`. A
  loopback URL on another port than your own daemon's (e.g.
  `http://127.0.0.1:7386` for `ssh -L 7386:127.0.0.1:7385 host`) counts as a
  tunnel: the local token file is not sent there.
- **`ADF_DAEMON_TOKEN` set in your shell** but the daemon uses its file (or
  the other way round): unset it, or give both the same value.

A `403` "Host header not allowed" means the daemon does not know the host
name you used: add it to the daemon's `ADF_DAEMON_ALLOWED_HOSTS`. See
[Remote daemon](remote-daemon.md).

## Studio at the same time

ADF Studio and the daemon share settings and would run the same agents from
the same files twice, so `adf` does not start a daemon while Studio runs:

```text
ADF Studio is running.
Studio and the daemon would run the same agents from the same files at once.
Quit ADF Studio, then run adf again. Or keep using Studio.
```

Quit Studio and run `adf` again. To run both on purpose, give the daemon
separate data (`ADF_DAEMON_SETTINGS=/path/to/other/adf-settings.json`), or
override the check with `adf daemon start --force` (only when you know they
will not load the same agents).

## macOS keeps asking for Keychain access

The daemon (a `node` process) reads the owner identity Studio stored in the
Keychain. macOS asks the first time; choose **Always Allow**. If it asks at
every start, open Keychain Access, find the `ADF` item, and allow `node`
under Access Control. To keep the keychain out of it, set
`ADF_KEYCHAIN=0` (the identity then lives in a passphrase file; see
[Identity and security](identity-and-security.md#where-the-phrase-is-kept)).

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
  separate from Studio's: sign in here even if Studio is signed in.
- **The browser does not open:** the URL is printed (in the app, `c` copies
  it); open it by hand.
- **Timed out:** the sign-in was not finished in time; run it again.
- **Remote daemon:** ChatGPT needs relay mode (automatic for a remote
  `--url`; `--relay` through an SSH tunnel). See
  [Remote daemon › Sign in to ChatGPT](remote-daemon.md#sign-in-to-chatgpt).
- An agent shows `signed out`: its provider is a subscription the daemon is
  not signed in to: `/login chatgpt` or `/login grok`.

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
