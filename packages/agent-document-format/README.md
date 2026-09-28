# agent-document-format

The ADF (Agent Document Format) daemon, CLI and terminal UI. An ADF agent is a single `.adf` file: config, memory, files and history in one document. This package runs your agents headless from a terminal, with no desktop app. For the desktop app (ADF Studio), see the [releases](https://github.com/christianbalevski/adf/releases).

## Install

Requires Node.js 22 or newer.

```bash
npm i -g agent-document-format
adf
```

Native modules (SQLite, OS keychain) install from prebuilt binaries; no compiler is needed on Windows, macOS (arm64/x64) or Linux (x64/arm64, glibc).

## Use

```bash
adf                   # the terminal UI; starts the daemon in the background if needed
adf agents            # one-shot CLI commands; `adf help` lists them
adf daemon status     # the background daemon: status | stop | restart | logs -f
adf daemon            # or run the daemon in the foreground (http://127.0.0.1:7385)
adf --version
```

The daemon keeps running after you quit the TUI (`adf daemon stop` stops it gracefully). It is only started automatically for a daemon URL on this machine, never next to a running ADF Studio, and not with `--no-daemon` / `ADF_NO_AUTOSTART=1`. `adf --url http://127.0.0.1:7400` (or `ADF_DAEMON_URL`) targets, and if needed starts, a daemon on another port. Other daemon settings: `ADF_DAEMON_HOST`, `ADF_DAEMON_SETTINGS` (settings JSON path), `ADF_USER_DATA_DIR`, `ADF_DAEMON_TOKEN` (required off loopback).

The daemon shares its settings file with ADF Studio on the same machine by default, so providers and tracked directories you set up in Studio carry over.

## Identity and sign-in

- `adf identity` shows the owner identity status; `adf identity create` / `adf identity restore` sets it up (the seed phrase is typed at a hidden prompt; the same phrase as Studio means the same owner). The phrase is kept in the OS keychain, or a passphrase-protected file where no keychain exists (`adf identity unlock`).
- `adf providers` lists model providers; `adf auth <provider>` signs in to subscription providers (ChatGPT, Grok) from the terminal.
- `adf new` creates an agent from a template, sealed with the owner identity.

## Docs

- [Daemon getting started](https://github.com/christianbalevski/adf/blob/main/docs/daemon/getting-started.md)
- [CLI reference](https://github.com/christianbalevski/adf/blob/main/docs/daemon/cli.md)
- [Terminal UI](https://github.com/christianbalevski/adf/blob/main/docs/daemon/tui.md)
- [HTTP API](https://github.com/christianbalevski/adf/blob/main/docs/daemon/http-api.md)

## License

MIT
