---
type: guide
description: First run — add an agent from the registry, review and claim it, connect a provider when you first run it, learn the interface, send the file on
see_also:
  - core-concepts.md — the ideas behind what you just built
  - creating-agents.md — the full per-agent configuration surface
---

# Getting Started

This guide walks you through your first agent: adding one from the registry, claiming it, running it, and sending it somewhere.

## Prerequisites

1. **ADF Studio** installed on your machine
2. Either an LLM API key (Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint) or a ChatGPT / Grok subscription to sign in with. You are asked for it the first time you run an agent, not before.

## First run

With no agents yet, the home screen shows **Agent registry**: cards for the agent files bundled with the app, plus any the live registry lists. Each card has one button, **Add**.

1. Click **Add** on a card. The file is copied into your agents folder (`Documents/adf-agents` by default) and opened.
2. The review dialog shows everything inside the file: tools, code execution, triggers, channels, compute tier, and a warning that it has no identity yet. Read it. **Continue**, then **Claim & Run** (or **Claim only**). Claiming mints a fresh identity owned by you.
3. Running needs a model provider. If none is usable, the **Connect a provider** sheet opens: sign in with ChatGPT or Grok, or pick a provider type and paste an API key. Then the **Model** step, and **Save and start**. The key is saved in app settings, not in this agent's file.

The same review-then-claim flow runs for any `.adf` you open, including one someone sent you.

Under the registry is a **Start** list with the other ways in:

- **New agent** — Create a blank agent file
- **Open .adf…** — Open an agent file from disk
- **Add directory…** — Show every agent file in a folder in the sidebar

Once an agent exists, the home screen becomes the dashboard, with a **Getting started** strip of four steps: Add an agent, Connect a provider, Run an agent, Share an agent. You can hide the strip.

## Setting Up a Provider

Providers can also be managed ahead of time, or changed later, in Settings.

1. Open **Settings** (gear icon in the sidebar, or `Cmd/Ctrl + ,`)
2. Go to the **Providers** section
3. Click **Add Provider**
4. Select a provider type (Anthropic, OpenAI, OpenAI-compatible, or ChatGPT Subscription)
5. Enter your API key (or click **Sign In with ChatGPT** for subscription providers)
6. Optionally set a default model
7. Save

![Settings → Providers with a connected provider entry and a new provider being added: type dropdown, name, credential storage, masked API key field, and default model.](../assets/screenshots/settings-add-provider.png)

## Creating a Blank Agent

1. Click the **New agent** button in the sidebar (the `+`), or on the first-run home screen
2. Choose a name for your agent (e.g., "assistant")
3. A new `.adf` file is created with default settings and the app's default provider

Your agent is now created and in the **idle** state by default.

## Anatomy of the Interface

The ADF Studio interface is organized into several areas:

- **Sidebar** (left) — Lists your open agents, shows their status, and provides quick actions
- **Main Panel** (center) — Shows the active tab content
- **Right Panel** (collapsible) — Additional context and configuration

### Tabs

- **Loop** — The conversation history with your agent. This is where you chat, see tool usage, and observe the agent's reasoning
- **Inbox** — Messages received from other agents
- **Files** — The agent's virtual filesystem (document, mind, and uploaded files)
- **Agent** — Configuration panel with sub-tabs for Timers, Identity, and raw Config

![The ADF Studio window: agents with live status toggles in the left sidebar, the agent's document open in the center editor, and the Loop panel on the right showing the conversation.](../assets/screenshots/studio-agent-loop.png)

## Talking to Your Agent

1. Select your agent from the sidebar
2. Make sure you're on the **Loop** tab
3. Type a message in the input field at the bottom
4. Press Enter to send

When you send a message, several things happen:

1. The agent transitions from **idle** to **active**
2. The agent's LLM processes your message along with its instructions, document, and available tools
3. The agent responds (and may use tools along the way)
4. The agent returns to **idle**

You'll see the full conversation in the Loop panel, including any tool calls the agent makes.

![The Loop tab mid-conversation: a user message, an expandable Thinking block, assistant text, and inline tool-call chips with their arguments.](../assets/screenshots/agent-loop-conversation.png)

## Configuring Your Agent

Click the **Agent** tab to access configuration. Key settings include:

- **Name and Description** — How your agent identifies itself
- **Icon** — An emoji shown in the sidebar
- **Instructions** — The system prompt that defines your agent's behavior
- **Model** — Which LLM provider and model to use
- **Tools** — Which built-in tools the agent can access
- **Triggers** — What events wake the agent

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
