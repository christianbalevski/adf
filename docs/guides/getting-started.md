---
type: guide
description: First run — type a message to make your first agent, connect a provider when it first runs, learn the interface, send the file on
see_also:
  - core-concepts.md — the ideas behind what you just built
  - creating-agents.md — the full per-agent configuration surface
---

# Getting Started

This guide walks you through your first agent: making one from a message, running it, and sending it somewhere.

## Prerequisites

1. The **ADF Studio** desktop app, or the [ADF CLI](../cli/getting-started.md) and `adf web` to open Studio in your browser already signed in. A desktop installation is optional. For another device, follow [browser pairing](studio-web.md#access-from-another-device).
2. Either an LLM API key (Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint) or a ChatGPT / Grok subscription to sign in with, or a Claude Pro/Max plan with [Claude Code](https://code.claude.com/docs/en/setup) installed. You are asked for it the first time you run an agent, not before.

## First run

In Browser Studio, agent files, provider credentials and compute belong to the
daemon's computer. Folder dialogs browse that computer; file attachments upload
from your browser. The desktop app's native menus and live Computer viewer have
[browser-specific differences](studio-web.md#browser-differences). To use a
ChatGPT subscription, sign the daemon in through the desktop app or
`adf auth login chatgpt` first; starting that sign-in inside Browser Studio
is unavailable. API keys can be configured in the browser.

The home screen is a message box. Type what you want an agent to do and press Enter. The `+` on the left, or a drop onto the box, attaches files; they are uploaded into the new agent with your first message.

1. If no provider is ready yet (a key or a sign-in, and a default model), the provider sheet opens first and no agent exists until you finish it. Sign in with ChatGPT, Grok or Claude, or pick a provider and paste an API key: Studio tests the key, lists the models and preselects one. **Done** stays disabled until there is a credential and a model. Cancelling removes the provider added there and keeps your text in the box. The key is saved in app settings, not in the agent's file.
2. A new agent file is created in your agents folder (`Documents/adf-agents` by default) under a generated name like `steady-fern`, and opens with its loop in the center.
3. Your message is the agent's first message. The agent answers in the loop. Keep talking to it there; it configures itself from the conversation.

Every message sent from the home screen makes a new agent. To continue with one you already have, open it from the sidebar.

The chips under the message box set up the agent before it exists. The leaf chip is its name: click the name to type one, or the shuffle icon for another rolled one. Any name that works as a file name is accepted. The **Start from** chip is the template the agent is built from, **Standard** until you pick another or make a different one the default; see [Agent Templates](agent-templates.md). The provider chip is the model provider and model it starts on, listing the ones you have connected with each one's models underneath, and **Add provider…** to connect another in place. Picking a template pre-fills the provider chip with that template's provider and model when you have that provider connected, and what the chips show when you send is what the agent starts on. The folder chip is where its file goes. With no provider ready yet, a **Model provider** card sits in the middle of the screen; it and the chip's **Connect a provider** both open the provider sheet. A suggestion chip fills an empty box; with text typed, it is added on a new line below it.

Once agents exist, a status line at the top shows how many there are, how many are running, tokens used today, and a **Mesh** button that opens the Mesh view. Each part is a link: the agent count opens the Mesh view, **running** (and **failing**, when it appears) unfolds a list of those agents with a **Stop** on each row, tokens opens usage in Settings, and a failing provider opens Settings → Providers.

The sidebar's `+` creates a blank agent under a name you choose. Its folder button opens a menu: **Open agent…** for one file, **Track folder…** for a whole folder of them. Right-click an agent's row for **Rename…**, which renames the agent and its file together. Right-click a folder's row to rescan it, reveal it on disk, or **Untrack folder…**: after you confirm, every agent running from that folder is stopped, then the folder and its subfolders leave the sidebar. Nothing is deleted from disk.

## Setting Up a Provider

Providers can also be managed ahead of time, or changed later, in Settings.

1. Open **Settings** (the gear in the title bar, or `Cmd/Ctrl + ,`)
2. Go to **Providers**
3. Click **Add provider** — a catalog opens, grouped into **Subscriptions**, **APIs**, **Local**, and **Other**
4. Click the tile for the service you use (Anthropic, OpenAI, Claude, ChatGPT, Grok, a hosted OpenAI-compatible API, or a local server). The provider is created with its base URL prefilled and its configure modal opens
5. Enter your API key (or sign in, for the Claude, ChatGPT and Grok subscription tiles)
6. Optionally set a default model
7. Save

![The Add a provider catalog: a search field, a Subscriptions group (ChatGPT, Grok) and an APIs group (Anthropic, OpenAI, OpenRouter, Google Gemini, xAI, Mistral, DeepSeek, Groq, Cerebras, Together AI, Fireworks AI, Perplexity), each tile with the service logo and a one-line description.](../assets/screenshots/studio-add-provider-v0.7.8.png)

## Creating a Blank Agent

1. Click **New agent** in the sidebar (the `+`), or File → New ADF Agent (`Cmd/Ctrl + N`)
2. Choose a file name and folder in the save dialog (e.g., `assistant.adf`)
3. A new `.adf` file is created from the default template, with the runtime's default provider, and opens

Your agent is now created and in the **idle** state by default.

## Anatomy of the Interface

- **Title bar**: **Home**, **Mesh**, **Settings**, the notifications bell and, while an agent is open, its avatar; the open agent's name, state and current step in the middle; **Start** or **Off** on the right
- **Sidebar** (left): tracked folders and their agents, with a **Running** list at the top
- **Center**: Home, the Mesh view, Settings, or the open agent's editor tabs
- **Dock** (right): the open agent's **Overview**, **Loops**, **Inbox**, **Files** and **Agent** tabs; **Agent** has the **Timers**, **Identity**, **Skills** and **Config** sub-tabs
- **Status bar** (bottom): save state, model and context gauge, **Logs** and **Tasks**, the version, and the runtime's **Mesh** and **Kill**

[ADF Studio](../ADF_STUDIO_DOCS.md#anatomy-of-the-interface) describes each area.

![The ADF Studio window: the agent quick-orchid in the sidebar, the Loops tab in the center with the user's request, a collapsed Dynamic Instructions block, assistant text, two fs_write tool calls and a sys_update_config call awaiting approval with Approve and Reject buttons, and the Overview tab on the right with the agent's levels and the pending approval under Coming up.](../assets/screenshots/studio-agent-loop-approval-v0.7.8.png)

## Talking to Your Agent

1. Open your agent from the sidebar
2. Open the **Loops** tab in the dock (an agent made from Home has it in the center)
3. Type a message in the composer at the bottom
4. Press Enter to send

When you send a message, several things happen:

1. The agent transitions from **idle** to **active**
2. The agent's LLM processes your message along with its instructions, document, and available tools
3. The agent responds (and may use tools along the way)
4. The agent returns to **idle**

You'll see the full conversation in the loop, including any tool calls the agent makes. **Stop** next to the send button, or `Esc`, ends a running turn.

![The Loops tab: the user's request, a collapsed Dynamic Instructions block, assistant text with timestamps, an expanded step group with two fs_write tool calls and their JSON arguments, and a sys_update_config call awaiting approval with Approve and Reject buttons.](../assets/screenshots/studio-agent-loop-approval-v0.7.8.png)

## Configuring Your Agent

Open **Agent** → **Config** in the dock. Key settings include:

- **Name and Description**: how your agent identifies itself
- **Icon**: an emoji published on the agent's card. Studio shows the agent's orbital instead, unless Settings → Appearance → **Agent avatars** is **Emoji**
- **Instructions**: the system prompt that defines your agent's behavior
- **Model**: which LLM provider and model to use
- **Tools**: which built-in tools the agent can access, and which need your approval
- **Triggers**: what events wake the agent

See [Creating and Configuring Agents](creating-agents.md) for full details.

## Sharing an Agent

An agent is one file, so sending it is moving the file. Drag an agent row out of the sidebar onto your desktop, into a message, or onto another computer running ADF Studio. Right-click the row and choose **Share…** for a dialog with the same drag chips and a **Save copy…** button.

The copy the app hands over is a consistent snapshot, taken even while the agent runs, with the identity stripped.

- **In the file:** config and agent instructions; README, memory and files; loop history; lambdas, skills and tool settings; provider names and base URLs (no keys).
- **Not in the file:** identity keys (the receiver claims a new identity); provider keys and sign-ins, which stay in app settings; credentials sealed to you — unless you set a share password, in which case they travel sealed and open only with it.

Whoever opens the file gets the same review dialog you did.

## What's Next?

- Learn about [Core Concepts](core-concepts.md) to understand the ADF philosophy
- Explore [Agent States](agent-states.md) to understand idle, hibernate, and autonomous mode
- Set up [Triggers](triggers.md) to make your agent respond to events automatically
- Enable [Messaging](messaging.md) to let multiple agents collaborate
