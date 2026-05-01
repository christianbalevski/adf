# Getting Started

This guide walks you through creating your first ADF agent and having a conversation with it.

## Prerequisites

Before you begin, make sure you have:

1. **ADF Studio** installed on your machine
2. **An LLM provider** — ADF Studio supports Anthropic, OpenAI, OpenAI-compatible, and ChatGPT Subscription providers

## Setting Up a Provider

Before creating an agent, you need to configure at least one LLM provider.

1. Open **Settings** (gear icon in the sidebar, or `Cmd/Ctrl + ,`)
2. Go to the **Providers** section
3. Click **Add Provider**
4. Select a provider type (Anthropic, OpenAI, OpenAI-compatible, or ChatGPT Subscription)
5. Enter your API key (or click **Sign In with ChatGPT** for subscription providers)
6. Optionally set a default model
7. Save

## Creating Your First Agent

1. Click the **New .adf** button in the sidebar
2. Choose a name for your agent (e.g., "assistant")
3. A new `.adf` file is created with default settings

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
- **Agent** — Configuration panel with sub-tabs for Mind, Timers, Identity, and raw Config

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

## Configuring Your Agent

Click the **Agent** tab to access configuration. Key settings include:

- **Name and Description** — How your agent identifies itself
- **Icon** — An emoji shown in the sidebar
- **Instructions** — The system prompt that defines your agent's behavior
- **Model** — Which LLM provider and model to use
- **Tools** — Which built-in tools the agent can access
- **Triggers** — What events wake the agent

See [Creating and Configuring Agents](creating-agents.md) for full details.

## What's Next?

- Learn about [Core Concepts](core-concepts.md) to understand the ADF philosophy
- Explore [Agent States](agent-states.md) to understand idle, hibernate, and autonomous mode
- Set up [Triggers](triggers.md) to make your agent respond to events automatically
- Enable [Messaging](messaging.md) to let multiple agents collaborate
