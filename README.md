<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/brand/adf-wordmark-dark.svg">
    <img src="./docs/assets/brand/adf-wordmark-light.svg" alt=".ADF" width="240">
  </picture>
</p>

<h1 align="center">Agent Document Format</h1>

<p align="center">
  <b>Agents, localized.</b><br>
  An open file format for AI agents, with a reference runtime.<br>
  An <code>.adf</code> file is one localized agent: its identity, state and behaviour in a single SQLite file (<a href="ADF_SPEC_v0.2.md#13-one-file-one-agent">what's inside</a>).
</p>

<p align="center">
  <a href="https://agentdocumentformat.org"><b>agentdocumentformat.org</b></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f5bea.svg" alt="License: MIT"></a>
  <a href="ADF_SPEC_v0.2.md"><img src="https://img.shields.io/badge/ADF%20spec-v0.2-2f5bea.svg" alt="ADF spec v0.2"></a>
  <a href="ALF_SPEC_v0.1.md"><img src="https://img.shields.io/badge/ALF%20protocol-v0.1-2f5bea.svg" alt="ALF protocol v0.1"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-474b54.svg" alt="Platform: macOS, Linux, Windows">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/brand/adf-localization-dark.gif">
    <img src="./docs/assets/brand/adf-localization-light.gif" alt="An agent's parts, spread loosely across an AI company, the cloud and an app, are pulled into one bounded orbital-shaped entity labelled ava.adf." width="800">
  </picture>
  <br>
  <sub>Where an agent lives. At t = 0 its parts are spread across systems run by other people. At t = 2026 they are held in one file, ava.adf.</sub>
</p>

![The ADF Studio window: the agent quick-orchid in the sidebar, the Loops tab in the center with the user's request, a collapsed Dynamic Instructions block, assistant text, two fs_write tool calls and a sys_update_config call awaiting approval with Approve and Reject buttons, and the Overview tab on the right with the agent's levels and the pending approval under Coming up.](docs/assets/screenshots/studio-agent-loop-approval-v0.7.8.png)

This repository contains the spec, the runtime daemon, the CLI, and the desktop app ADF Studio. Together they are the reference implementation of ADF.

## Download ADF Studio

**Available for Windows, macOS and Linux.** [Download ADF Studio from the latest release](https://github.com/christianbalevski/adf/releases/latest), then choose the installer for your machine under **Assets**:

- **Windows (x64):** the `.exe` installer.
- **macOS:** the universal `.dmg` for Intel and Apple Silicon, or the arm64 `.dmg` for Apple Silicon.
- **Linux (x86_64/amd64):** the `.deb` package or `.AppImage`.

The [Quick start](#quick-start) below is for developers running ADF from source; use the release downloads above if you just want the desktop application.

## Install the ADF CLI from npm

For terminal-only use (servers, SSH sessions, no desktop app), install the [`@agentdocumentformat/cli`](https://www.npmjs.com/package/@agentdocumentformat/cli) package. Current `main` requires Node.js `^22.23.4 || ^24.22.1 || ^26.12.1`; published npm v0.8.3 declares `>=22` (see [Node.js versions](docs/cli/index.md#nodejs-versions)). Native modules install from prebuilt binaries, so no compiler is needed. The desktop app brings its own runtime and does not use the Node.js on your system.

```bash
npm i -g @agentdocumentformat/cli
adf
```

`adf` opens the terminal app and starts the daemon in the background when it is not running yet (it keeps running after you quit; `adf daemon stop` stops it). A welcome checklist walks you through the owner identity (`/identity`, the same 12 words as Studio), a model (`/login chatgpt` or `/provider add`) and your first agent (`/new`). `adf agents` and the other one-shot commands (`adf help`) start the daemon the same way.

Studio and the CLI share the same settings file and owner identity (OS keychain) on one machine. Studio runs its agents in the ADF daemon on this computer (Local daemon, the default; Settings → Connection), so Studio and `adf` show the same agents at the same time; an install upgraded from 0.7.x switches at its first launch and says what it moved ([Studio backend](docs/guides/studio-backend.md#upgrading-from-07x)). With the legacy Embedded backend, kept for this release only, `adf` will not start a daemon next to a running Studio. After an upgrade run `adf daemon restart`. See the [ADF CLI docs](docs/cli/index.md): [getting started](docs/cli/getting-started.md), [terminal app](docs/cli/terminal-app.md), [reference](docs/cli/reference.md).

## Capabilities

- **One file per agent.** Copy or move the file to copy or move the agent ([what's inside](ADF_SPEC_v0.2.md#13-one-file-one-agent)).
- **ADF Studio:** a desktop IDE for agents. Author them, follow their turns, configure their tools and approve restricted tool calls.
- **Mesh view:** an RTS-style command surface. Every agent is a tile on a hex map; select, message, hold and command whole groups with hotkeys.
- **Model providers:** Anthropic, OpenAI, OpenRouter, any OpenAI-compatible endpoint (Ollama, LM Studio and others), a ChatGPT or Grok subscription via OAuth, or a Claude Pro/Max plan through your installed Claude Code. Local servers and their selected models need tool calling for agent tools; vision is needed only when the model must understand images or screenshots. See [local model requirements](docs/cli/models-and-providers.md#local-model-requirements).
- **Built-in tools and services:** sandboxed code execution, lambdas, timers, triggers, skills, MCP servers, container-backed compute, HTTP serving and WebSockets.
- **Code path:** lambdas run on a trigger, a timer or a message, and middleware sits on the inbox, outbox, routes and fetches. A model turn runs only when a trigger, timer or message starts one.
- **Inner loops:** up to 16 inner loops (side loops) next to the main loop, each with its own transcript, goal and tool subset, all stored in the agent's file.
- **Computer use:** a visible Linux desktop and a managed Chromium an agent can drive, with screen handoff when a login needs you.
- **Agent mesh:** agents discover and message each other across runtimes over the ALF protocol (LAN, tailnet or direct address), with DIDs, signatures and optional end-to-end encryption.
- **Channels:** connect agents to Telegram, Discord, Slack, WhatsApp and email.
- **Visible context:** everything injected into an agent's context is stored in the file and viewable in the UI.
- **Human in the loop:** restricted tools pause for your approval, inline in the Mesh view or in a full-context modal.

## Screenshots

<table>
  <tr>
    <td width="50%">
      <img src="docs/assets/screenshots/fleet-map-needs-you.png" alt="The Mesh view with agent districts on a hex map; one agent tile is amber with a pending approval, and the alert bar shows a Needs you queue with fleet token-burn rates.">
      <p align="center"><i>Mesh view</i></p>
    </td>
    <td width="50%">
      <img src="docs/assets/screenshots/hil-approval-modal.png" alt="The human-in-the-loop approval modal: an agent wants to call sys_update_config, with the full formatted arguments and Approve / Reject buttons.">
      <p align="center"><i>Tool approval</i></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/assets/screenshots/studio-home-v0.7.8.png" alt="The Home screen: a new agent's avatar, example requests, and the composer with chips for the agent's name, template, model and folder.">
      <p align="center"><i>Home</i></p>
    </td>
    <td width="50%">
      <img src="docs/assets/screenshots/studio-files-mind-v0.7.8.png" alt="An agent's mind.md open in the editor, and the Files tab listing its files with protection badges.">
      <p align="center"><i>Files and mind</i></p>
    </td>
  </tr>
</table>

## Quick start

**Prerequisites for current `main`:** Node.js `^22.23.4 || ^24.22.1 || ^26.12.1`, npm, and a supported model provider (an API key, subscription sign-in, or a [local server](docs/cli/models-and-providers.md#local-model-requirements) with a tool-calling model). Optional: Podman for container-backed compute.

```bash
git clone https://github.com/christianbalevski/adf.git
cd adf
npm install
npm run dev        # launches ADF Studio
```

Then, in Studio:

1. **Connect a provider.** Settings → Providers → **Add provider**, pick a service from the catalog, paste an API key (or sign in, for the Claude, ChatGPT and Grok subscription tiles; Claude needs [Claude Code](https://code.claude.com/docs/en/setup) installed).
2. **Create an agent.** Click **New .adf** in the sidebar and name it.
3. **Send a message.** Open the Loop tab and send a message.

The `.adf` file it creates is the agent: configuration, memory, files, loops and runtime state. See [Getting Started](docs/getting-started.md) for the full walkthrough.

### Run the daemon and CLI

The daemon runs the same `.adf` agents headlessly; Studio uses it too (Local daemon, the default). Configure a provider and create an agent in Studio first, then (with Studio set to the legacy Embedded backend, close Studio first, so it does not own the same file or mesh port):

```bash
npm run adf -- agents     # starts the daemon in the background if needed
```

(`npm run daemon` runs it in the foreground instead.) Then:

```bash
curl http://127.0.0.1:7385/health

# every other route needs the daemon's access token
TOKEN="$(npm run -s adf -- daemon token)"

# load an agent by path, then talk to it by handle
curl -X POST http://127.0.0.1:7385/agents/load \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/absolute/path/to/example.adf"}'

npm run adf -- chat example-agent "Hello from the CLI"
npm run adf -- events example-agent
```

The CLI is a client for the running daemon; the daemon API defaults to `http://127.0.0.1:7385` (override with `ADF_DAEMON_URL` or `--url`). The daemon requires its access token on every request but `/health`; `adf` reads it by itself on this machine. See the [daemon quick start](docs/daemon/getting-started.md).

Run `npm run adf` with no command for the terminal app: the whole fleet in one screen, chat with any agent or any of its loops (an agent's separate chat sessions, such as an inner loop that consolidates memory every night), approvals, files, schedules and live events. See the [terminal app guide](docs/cli/terminal-app.md); `npm run tui:mock` tries it without a daemon.


### Build and test

```bash
npm run build      # production build
npm run package    # platform artifacts via electron-builder

npm run typecheck
npm run lint
npm test               # full Vitest suite
npm run test:lifecycle # lifecycle, dispatch, handoff, shutdown, recovery
```

## Motivation

AI agents read on your behalf, write on your behalf, remember things for
you, and increasingly decide things for you. Almost every major one is
owned by the platform that runs it. That seems like the wrong
arrangement for software that holds your context and shapes what you
conclude.

Portability isn't a complete answer, but nothing else works without it.
Your photos in iCloud feel like yours because you can download them and
leave. If an agent's memory, instructions, and history sit behind
someone else's API, you don't really own the agent.

So ADF is less about what an agent can *do* and more about what an agent
*is*. If an agent is a file with a defined shape, any runtime that
implements the spec can run it, the same way any photo viewer can open a
JPEG.

<details>
<summary><b>History</b></summary>

ADF started smaller. The idea was a document that comes with its own
agent attached, shipped together, so the agent knows the document's
history and can act on it. The first version was a zip with four files:
an agent config, a working document, the agent's private memory, and a
chat log. SQLite turned out to be a better container.

Once a few agents existed as files on one machine, the next question was
how they talk to each other. That became ALF, a small protocol for
asynchronous messaging between agents that don't share a host.

Deciding what an agent *is* was never meant to limit what it can *do*.
Most of the runtime work has gone into primitives, controls, and
security gates, so an agent can be configured in almost any direction.
The cost is that setting one up takes more thought up front. The payoff
is that once you have an agent you like, copying or sharing it is just
copying a file.

I don't know if ADF is the standard anyone settles on. It does show that
an open, interoperable primitive for agents is buildable, and that every
agent being permanently tied to the platform that made it isn't
inevitable.

</details>

## Documentation

[What ADF Studio can do](docs/CAPABILITIES.md) is the full
capability catalogue: plain terms first, mechanisms and internals further
down.

| Start here | Reference |
|---|---|
| [Getting Started](docs/getting-started.md) | [ADF spec v0.2](ADF_SPEC_v0.2.md): the file format |
| [ADF Studio tour](docs/ADF_STUDIO_DOCS.md) | [ALF spec v0.1](ALF_SPEC_v0.1.md): the agent communication protocol |
| [Core Concepts](docs/core-concepts.md) | [Identity spec v0.1](docs/design/ADF_IDENTITY_SPEC_v0.1.md): DIDs, envelopes, attestations |
| [Mesh view guide](docs/guides/fleet-map.md) | [ADF CLI](docs/cli/index.md), [terminal app](docs/cli/terminal-app.md) and [HTTP API](docs/daemon/http-api.md) |
| [Creating agents](docs/guides/creating-agents.md) | [Tools catalog](docs/guides/tools.md) |
| [Daemon quick start](docs/daemon/getting-started.md) | [Security architecture](docs/guides/security-architecture.md) |

The full guide index lives in [`docs/`](docs/index.md): messaging, code execution, MCP integration, compute, serving, timers, triggers, memory management, and more. Every guide is also fetchable as raw markdown, so agents can read their own documentation.

## Repository layout

- **`ADF_SPEC_v0.2.md`**: the file format specification.
- **`ALF_SPEC_v0.1.md`**: the agent communication protocol specification.
- **`src/main/`**: the runtime, daemon, CLI, providers, tools, mesh, and IPC.
- **`src/renderer/`**: the Electron Studio UI.
- **`docs/`**: guides for using ADF Studio and building agents.
- **`tests/`**: test suite.

## Status

This is an early public release. The format and APIs may change. The
runtime, daemon, CLI, and Studio are all in active development under one
roof; expect ongoing structural changes as the codebase matures.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions require DCO
sign-off (`git commit -s`). Documentation changes follow the
[docs style guide](docs/STYLE.md).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability disclosure.

## License

MIT. See [LICENSE](LICENSE).

---

Created and maintained by Christian Balevski.
