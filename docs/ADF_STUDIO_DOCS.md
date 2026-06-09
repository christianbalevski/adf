# ADF Studio

ADF Studio is the desktop application for creating, configuring, and operating ADF agents. It is the visual IDE for the [Agent Document Format](../README.md) — the place where you author an agent, watch it think, give it tools, and run it on the mesh.

This document covers the **Studio application itself**: its interface, settings, and day-to-day workflows. For the underlying format, runtime, and tool concepts, see the [documentation index](index.md), which links every guide. For the headless runtime, see the [Daemon documentation](daemon/index.md).

> **Looking for a specific concept?** Start at [docs/index.md](index.md). This page is the app tour, not the full reference — it links into the guides rather than duplicating them.

---

## Installation and Prerequisites

Before you begin you need:

1. **ADF Studio** installed on your machine (macOS or Windows).
2. **At least one LLM provider** — Studio supports Anthropic, OpenAI, OpenAI-compatible endpoints, and ChatGPT Subscription (OAuth).

On first launch Studio creates its application data directory (`~/.adf-studio/`), which holds settings, the shared sandbox-package store, and per-agent compute state.

---

## Setting Up a Provider

You must configure a provider before an agent can run.

1. Open **Settings** (gear icon in the sidebar, or `Cmd/Ctrl + ,`).
2. Go to the **Providers** section.
3. Click **Add Provider** and pick a type:
   - **Anthropic** — Claude models (API key).
   - **OpenAI** — GPT models (API key).
   - **OpenAI-compatible** — any endpoint that speaks the OpenAI API (local models, gateways).
   - **ChatGPT Subscription** — ChatGPT Plus/Pro via **Sign In with ChatGPT** (OAuth, flat-rate, no API key).
4. Enter the key or complete the OAuth sign-in, optionally set a default model, and **Save**.

Provider keys are application-level and are **never** exposed to agent code execution — only server-side model invocation can use them. See [Settings](guides/settings.md) for the full provider reference.

---

## Anatomy of the Interface

The Studio window is organized into a few persistent areas:

- **Sidebar** (left) — your open agents and their live status, plus quick actions (**New .adf**, open, Settings). Selecting an agent loads it into the main panel.
- **Main panel** (center) — the active tab for the selected agent.
- **Right panel** (collapsible) — additional context and configuration where applicable.

### Per-agent tabs

| Tab | What it shows |
|-----|---------------|
| **Loop** | The conversation/transcript: your messages, the agent's reasoning, tool calls and results. This is where you chat with the agent. |
| **Inbox** | Messages received from other agents over the mesh. |
| **Files** | The agent's virtual filesystem — the primary document, the mind file, and any uploaded or agent-written files. |
| **Agent** | The configuration panel, with sub-sections for Identity, Model, Instructions, Tools, Triggers, Messaging, Serving, Mind, Timers, and the raw Config. |

### The Home view

When no agent is selected, Studio shows a **Home** dashboard: a compact header plus a grid of status tiles (agents, messaging, compute/containers, and more) that load progressively and deep-link into the relevant **Settings** section when clicked. A **Networking** panel surfaces LAN discovery state. Container-backed tiles refresh on a short interval so they settle as services finish booting.

---

## Creating Your First Agent

1. Click **New .adf** in the sidebar.
2. Choose a filename — this becomes the agent's default name.
3. Studio creates the `.adf` file with sensible defaults in your tracked directory.

A new agent ships with a blank `README.md` (its primary document), an empty `mind.md` (working memory), a default tool set, and a unique 12-character ID. It starts in the **idle** state.

See [Creating and Configuring Agents](guides/creating-agents.md) for every configuration field.

---

## Talking to Your Agent

1. Select the agent in the sidebar and open the **Loop** tab.
2. Type a message in the input at the bottom and press **Enter**.

Sending a message drives the lifecycle:

1. The agent transitions from **idle** to **active**.
2. Its model processes your message alongside its instructions, document, and available tools.
3. It responds, possibly calling tools along the way — each call and result is shown inline in the Loop.
4. It returns to **idle**.

See [Agent States and Lifecycle](guides/agent-states.md) for the full state model (active, idle, hibernate, suspended, off) and [Memory Management](guides/memory-management.md) for how the Loop is compacted and archived over time.

---

## Configuring an Agent

Open the **Agent** tab to configure the selected agent. The main areas:

- **Identity** — name, description, icon, and the agent ID/DID.
- **Model** — provider, model ID, temperature, max tokens, thinking budget, and provider parameters.
- **Instructions** — the system prompt (immutable by the agent itself).
- **Tools** — which built-in tools are enabled and visible, and which are restricted/locked. See [Tools](guides/tools.md).
- **Triggers** — what events wake the agent. See [Triggers](guides/triggers.md).
- **Messaging** — channels and inter-agent routing. See [Messaging](guides/messaging.md).
- **Serving** — HTTP routes, shared files, and WebSocket endpoints. See [HTTP Serving](guides/serving.md).

Every field is documented in [Creating and Configuring Agents](guides/creating-agents.md).

---

## Settings

Settings (gear icon, or `Cmd/Ctrl + ,`) holds application-wide and instance-wide configuration:

- **Providers** — LLM provider accounts and default models.
- **Packages** — runtime sandbox packages available to *every* agent on this instance, installed to the shared store at `~/.adf-studio/sandbox-packages/`. Agents can also promote their own packages here via **Make Runtime**. See [Code Execution](guides/code-execution.md).
- **MCP** — the MCP Status Dashboard for registered tool servers and their credentials. See [MCP Integration](guides/mcp-integration.md).
- **Networking** — LAN discovery (mDNS) state and discovered runtimes. See [LAN Discovery](guides/lan-discovery.md).
- **Web** — settings for serving agent content over HTTP. See [HTTP Serving](guides/serving.md).
- **About / Updates** — version and update information.

The complete reference is in [Settings](guides/settings.md).

---

## Multimodal

Studio agents can perceive images, audio, and video when the matching modality is enabled in the agent's `model.multimodal` configuration. When enabled, media returned by `fs_read` or MCP tools is sent to the model as a native content block (rather than just a path reference); when disabled, the file is still saved to `adf_files` and the tool result includes a path reference, but no content block is created.

| Modality | Config flag | Content block | Supported formats | Default size limit (`limits.*`) |
|----------|-------------|---------------|-------------------|--------------------------------|
| **Image** | `multimodal.image` | `image_url` | PNG, JPEG, GIF, WEBP | `max_image_size_bytes` (5 MB) |
| **Audio** | `multimodal.audio` | `input_audio` | WAV, MP3, OGG, FLAC, AAC, AIFF, M4A, WebM | `max_audio_size_bytes` (10 MB) |
| **Video** | `multimodal.video` | `video_url` | MP4, MPEG, QuickTime, WebM | `max_video_size_bytes` (20 MB) |

Notes:

- **Image** replaces the legacy `model.vision` toggle.
- **Audio** — the AI SDK natively supports only WAV and MP3; other formats are coerced to WAV for the SDK's validator while actual codec negotiation happens provider-side.
- **Video** — the AI SDK has no native video support, so the runtime injects raw OpenAI-format `video_url` parts directly into the request body. This works for providers that accept the OpenAI chat-completions format (OpenRouter, Gemini, etc.).
- Media content blocks are **ephemeral** — they are not persisted to `adf_loop`.
- **In code/shell execution**, the full structured JSON (with raw base64 data) is always returned regardless of these settings, so agents can parse, transform, save (`fs_write`), or forward media programmatically. See [The adf Proxy Object](guides/adf-object.md) and [Tools](guides/tools.md#filesystem-tools).

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + ,` | Open Settings |
| `Cmd/Ctrl + S` | Save the current editor tab |
| `Cmd/Ctrl + W` | Close the active editor tab |

---

## Where to Go Next

- [Getting Started](getting-started.md) — create your first agent and start a conversation.
- [Core Concepts](guides/core-concepts.md) — sovereignty, one-agent-one-document, and the ADF stack.
- [Documentation index](index.md) — the full list of guides for the format, runtime, tools, messaging, security, and more.
- [Daemon documentation](daemon/index.md) — run the same `.adf` agents headlessly via the API runtime.
