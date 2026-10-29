# @agentdocumentformat/cli

The **ADF CLI**: run ADF (Agent Document Format) agents from a terminal, with
no desktop app. An ADF agent is a single `.adf` file: config, memory, files
and history in one portable document. For the desktop app, ADF Studio, see
the [releases](https://github.com/christianbalevski/adf/releases).

- `adf`: the **terminal app**. Your fleet of agents in one screen: chat with
  any agent or any of its loops, approve tool calls, edit files, schedule
  inner loops (side loops), watch live events.
- `adf <command>`: one-shot commands for scripts (`adf help`).
- `adf daemon`: the background daemon that runs the agents. `adf` starts it
  for you; it keeps running after you quit.

## Install

Current `main` requires Node.js `^22.23.4 || ^24.22.1 || ^26.12.1`; `adf`
refuses earlier releases and 23.x/25.x because of CVE-2026-111497, and 27+
until tested. Published npm v0.8.3 declares `>=22` and predates this check.
See [Node.js versions](https://github.com/christianbalevski/adf/blob/main/docs/cli/index.md#nodejs-versions).
Native modules (SQLite, OS keychain) come
prebuilt for Windows, macOS (arm64, x64) and Linux (x64, arm64, glibc).

```bash
npm i -g @agentdocumentformat/cli
adf
```

`EEXIST` on install? Remove the old package first:
`npm uninstall -g agent-document-format`.

Upgrade: `npm i -g @agentdocumentformat/cli@latest`, then
`adf daemon restart`.

## Local models

Use Ollama, LM Studio, or any server that implements the OpenAI-compatible
chat API. Both the server and selected model need tool calling for agent
tools. Vision is needed only when the model must understand images or screenshots. Add the server with
`/provider add`, using its API base URL and model ID; supply a key only if
the server requires one. See
[local model requirements](https://github.com/christianbalevski/adf/blob/main/docs/cli/models-and-providers.md#local-model-requirements).

## Quickstart

In the terminal app (a welcome checklist opens on first run):

```text
/identity create        # your owner identity: 12 words, the same as in ADF Studio
/login chatgpt          # or /login grok, /login claude, or /provider add for an API key
/new                    # create an agent; its chat opens
/loop new consolidator  # optional: an inner loop that tidies memory nightly
```

Or with one-shot commands:

```bash
adf identity new
adf auth login chatgpt
adf new agent-1 --start
adf chat agent-1 "hello"
adf events agent-1
```

Daemon: `adf daemon status | stop | restart | logs -f | token`. On current
`main`, Studio in Local mode and the CLI share one daemon, settings and owner
identity, and can run side by side. With Inside Studio (legacy), `adf`
refuses to start a daemon on the same settings while Studio runs; switch
Studio to Local mode or quit it first.

## Docs

- [ADF CLI](https://github.com/christianbalevski/adf/blob/main/docs/cli/index.md)
- [Getting started](https://github.com/christianbalevski/adf/blob/main/docs/cli/getting-started.md)
- [Terminal app](https://github.com/christianbalevski/adf/blob/main/docs/cli/terminal-app.md)
- [Reference](https://github.com/christianbalevski/adf/blob/main/docs/cli/reference.md): every command, flag, slash command and key
- [Remote daemon](https://github.com/christianbalevski/adf/blob/main/docs/cli/remote-daemon.md)
- [Troubleshooting](https://github.com/christianbalevski/adf/blob/main/docs/cli/troubleshooting.md)
- [Daemon HTTP API](https://github.com/christianbalevski/adf/blob/main/docs/daemon/http-api.md)

## License

MIT
