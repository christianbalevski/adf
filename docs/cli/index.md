# ADF CLI

The ADF CLI runs your ADF agents from a terminal, with no desktop app. One
executable, `adf`, provides these entry points:

| You type | You get |
|---|---|
| `adf` | The **terminal app**: your whole fleet in one screen. Chat with any agent or any of its loops, approve tool calls, edit files, schedule work, watch live events. |
| `adf web` | In a browser-enabled build, opens **Browser Studio** already signed in to this computer’s daemon. No desktop app required. |
| `adf <command>` | One-shot commands for scripts and quick checks: `adf agents`, `adf chat agent-1 "hi"`, `adf identity`, `adf new`. `adf help` lists them. |
| `adf daemon …` | The **daemon**, the background process that actually runs the agents. `adf` starts it for you; `adf daemon status \| stop \| restart \| logs \| token` manage it. |

The terminal app, Browser Studio and one-shot commands are clients of the
daemon. Quitting a client leaves the agents running. Browser Studio and
`adf web` require a build containing browser support; they are not included
in published npm v0.8.3.

## Install

Current `main` requires Node.js `^22.23.4 || ^24.22.1 || ^26.12.1`.
The published npm v0.8.3 package declares `>=22`; see
[Node.js versions](#nodejs-versions) for the version-specific requirements.
Native modules (SQLite, the OS keychain) come as prebuilt binaries for
Windows, macOS (arm64, x64) and Linux (x64, arm64, glibc), so no compiler is
needed.

```bash
npm i -g @agentdocumentformat/cli
adf
```

The first `adf` starts the daemon in the background and opens the terminal
app with a welcome checklist. Continue with [Getting started](getting-started.md).

**`EEXIST` on install?** The package used to be called
`agent-document-format`, which also installed an `adf` command. npm refuses to
overwrite it:

```text
npm error code EEXIST
npm error path …/bin/adf
npm error EEXIST: file already exists
```

Remove the old package, then install again:

```bash
npm uninstall -g agent-document-format
npm i -g @agentdocumentformat/cli
```

## Upgrade

```bash
npm i -g @agentdocumentformat/cli@latest
adf daemon restart
```

The daemon keeps running across upgrades, so it keeps running the old code
until you restart it. `adf --version` prints the installed version,
`adf daemon status` the one the running daemon reports.

## Node.js versions

`adf` and the daemon run on the Node.js on your system. On current `main`,
both package engine declarations and the runtime check require
`^22.23.4 || ^24.22.1 || ^26.12.1`: Node.js 22.x from 22.23.4,
24.x from 24.22.1, or 26.x from 26.12.1.
Earlier releases, and every 23.x and 25.x, ship a Brotli decoder with an
out-of-bounds write ([CVE-2026-111497](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)),
and the daemon decodes Brotli it did not produce: web responses agents fetch
(`Content-Encoding: br`) and audit history inside `.adf` files you import.
On such a release every `adf` command stops at once with
`ADF refuses to run on Node.js …` and changes nothing. There is no override.
Node.js 27 and later are refused the same way until ADF is tested on them.

Published npm v0.8.3 declares `engines.node: ">=22"`. That published package
predates the stricter range above; the current-main runtime check and refusal
behavior do not describe v0.8.3. Use the requirements for the version you
install, rather than treating `main` as the published package.

On current `main`, the check is the version number plus the fixed decoder's
new error code, so a distribution package that backports the fix under an
older version number is refused too; use a build from [nodejs.org](https://nodejs.org) or your
vendor's current release. After upgrading Node.js, restart a daemon that was
already running (`adf daemon restart`): it keeps the runtime it started with.

ADF Studio (the desktop app) does not use the Node.js on your system. It
runs on its own bundled Electron runtime (Electron 43, Chromium 150), whose
Brotli decoder is Chromium's and has the fix, and starts its daemon on that
same runtime.

## Open Browser Studio

In a browser-enabled build:

```bash
adf web
adf web --port 7485       # a different local daemon port
adf web --no-daemon       # require an already-running daemon
```

The launcher starts the local daemon if needed, then opens a one-use sign-in
link in your browser. It does not print an access token or require desktop
Studio. Automatic sign-in is local-only: remote URLs and unrecognized
forwarded ports use [browser pairing](remote-daemon.md#browser-studio-on-another-device)
instead. A saved default CLI remote does not select the browser launch target.
`--url <local-daemon-url>` is an alternative to `--port`; it must name a known
local daemon.

See the [Browser Studio guide](../guides/studio-web.md) for shared UI behavior,
browser limitations and authentication. A browser-enabled CLI and daemon are
both needed; installing published npm v0.8.3 does not add this command.

## Studio and the CLI

On current `main`, ADF Studio in **Local** mode and the CLI are clients of
the same daemon. They share settings, owner identity and agents on this
computer and can run side by side.

With **Inside Studio (legacy)**, Studio runs agents in its own process.
`adf` refuses to start a daemon while that Studio runs on the same settings.
Switch Studio to Local mode or quit it first. See
[Studio backend](../guides/studio-backend.md) and
[Studio at the same time](troubleshooting.md#studio-at-the-same-time).

## Guides

- [Getting started](getting-started.md): first run, identity, a model, your first agent
- [Browser Studio](../guides/studio-web.md): local browser launch and pairing from another device
- [Terminal app](terminal-app.md): layout, views, keys, chat, approvals, mouse and copy/paste
- [Loops and timers](loops-and-timers.md): inner loops (side loops) and running them on a schedule
- [Identity and security](identity-and-security.md): owner identity, keychain, daemon token, locked credentials
- [Models and providers](models-and-providers.md): API keys, Claude, ChatGPT and Grok sign-in, per-loop models
- [Channels](channels.md): Telegram, Discord, Slack, email, WhatsApp
- [MCP servers](mcp.md)
- [Agent settings](agent-settings.md): instructions, tools, compaction, model, config
- [Templates and skills](templates-and-skills.md)
- [Files](files.md): the agent's document, mind and files
- [Context](context.md): what fills a loop's context window
- [Remote daemon](remote-daemon.md): terminal/browser pairing, SSH tunnel, device tokens and TLS proxy
- [Troubleshooting](troubleshooting.md)
- [Reference](reference.md): every command, flag, environment variable, slash command and key (generated)

For the daemon itself (HTTP API, operations, runtime) see the
[daemon docs](../daemon/index.md).

## From a source checkout

`npm run adf -- <args>` runs the same CLI from the sources (`npm run adf`
alone opens the terminal app; `npm run tui:mock` runs it against an
in-memory mock daemon, no daemon or model needed).

For Browser Studio in this source build, compile the shared renderer first:

```bash
npm run build:web
npm run adf -- web
```

`npm run build:npm` includes the browser assets in the CLI package. A daemon
still running an older build must be updated and restarted before it can serve
this browser client.
