# ADF CLI

The ADF CLI runs your ADF agents from a terminal, with no desktop app. One
executable, `adf`, does three things:

| You type | You get |
|---|---|
| `adf` | The **terminal app**: your whole fleet in one screen. Chat with any agent or any of its loops, approve tool calls, edit files, schedule work, watch live events. |
| `adf <command>` | One-shot commands for scripts and quick checks: `adf agents`, `adf chat agent-1 "hi"`, `adf identity`, `adf new`. `adf help` lists them. |
| `adf daemon …` | The **daemon**, the background process that actually runs the agents. `adf` starts it for you; `adf daemon status \| stop \| restart \| logs \| token` manage it. |

The terminal app and the one-shot commands are both clients of the daemon.
Quitting the app, or closing the terminal, leaves every agent running.

## Install

Needs Node.js 22 or newer. Native modules (SQLite, the OS keychain) come as
prebuilt binaries for Windows, macOS (arm64, x64) and Linux (x64, arm64,
glibc), so no compiler is needed.

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

## Studio and the CLI

ADF Studio (the desktop app) and the CLI use the same settings file and the
same owner identity on one machine, so providers, tracked folders and agents
you set up in one show up in the other. They must not run the same agents at
the same time: `adf` never starts a daemon while Studio is running and tells
you so. Quit Studio first, or keep using Studio.

## Guides

- [Getting started](getting-started.md): first run, identity, a model, your first agent
- [Terminal app](terminal-app.md): layout, views, keys, chat, approvals, mouse and copy/paste
- [Loops and timers](loops-and-timers.md): inner loops (side loops) and running them on a schedule
- [Identity and security](identity-and-security.md): owner identity, keychain, daemon token, locked credentials
- [Models and providers](models-and-providers.md): API keys, ChatGPT and Grok sign-in, per-loop models
- [Channels](channels.md): Telegram, Discord, Slack, email, WhatsApp
- [MCP servers](mcp.md)
- [Agent settings](agent-settings.md): instructions, tools, compaction, model, config
- [Templates and skills](templates-and-skills.md)
- [Files](files.md): the agent's document, mind and files
- [Context](context.md): what fills a loop's context window
- [Remote daemon](remote-daemon.md): SSH tunnel, tokens, TLS proxy
- [Troubleshooting](troubleshooting.md)
- [Reference](reference.md): every command, flag, environment variable, slash command and key (generated)

For the daemon itself (HTTP API, operations, runtime) see the
[daemon docs](../daemon/index.md).

## From a source checkout

`npm run adf -- <args>` runs the same CLI from the sources (`npm run adf`
alone opens the terminal app; `npm run tui:mock` runs it against an
in-memory mock daemon, no daemon or model needed).
