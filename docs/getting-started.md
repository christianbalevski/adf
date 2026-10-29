# Getting Started

This guide takes you from ADF Studio to an agent's first answer, in the desktop app or a browser. To do the same in a terminal, see the [CLI getting started](cli/getting-started.md).

## Prerequisites

1. Either the ADF Studio desktop app, or the [ADF CLI](cli/getting-started.md) installed and `adf web` run on the daemon's computer. The command opens Browser Studio already signed in; no desktop app is required. To connect from another device, see [browser pairing](guides/studio-web.md#access-from-another-device).
2. One of:
   - a ChatGPT, Grok or Claude (Pro or Max, through [Claude Code](https://code.claude.com/docs/en/setup)) plan to sign in with;
   - an API key for Anthropic, OpenAI, OpenRouter or any OpenAI-compatible API;
   - a model server reachable from the daemon's computer, such as Ollama or LM Studio.

Studio asks for it the first time you send a task. You do not set it up beforehand.

## 1. Type a task

Home is the screen Studio shows when no agent is open. Type what you want an agent to do in the message box and press Enter.

The chips under the box set up the agent before it exists: its name, the template it is built from, the provider and model it starts on, and the folder its file goes in. The defaults work for a first run. A suggestion above the box fills an empty box when clicked; with text already typed, it is added on a new line below it.

## 2. Connect a provider when asked

With no provider ready, Home shows a **Model provider** card, and Enter opens the provider sheet instead of making an agent. A provider is ready when it has a key or a sign-in and a default model.

In Browser Studio, ChatGPT subscription setup requires signing the daemon in
through desktop Studio or `adf auth login chatgpt` first. Existing daemon
sign-ins work in the browser. API keys can be configured there directly; see
[browser differences](guides/studio-web.md#browser-differences) for other native
sign-in limitations.

1. Click the tile for your service. Tiles are grouped into **Subscriptions**, **APIs**, **Local** and **Other**.
2. Give it a credential:
   - **Subscription:** click **Sign in with …** and finish in the browser. A failed sign-in shows its reason under the button.
   - **API:** paste the key. Studio saves it, tests it and lists the provider's models. The key field then reads **Connected** or **Key rejected**.
   - **Local:** Studio tests the server when the tile opens, and again when you change the base URL.
3. Check the default model. Studio picks a recommended one from the list; choose another if you want.
4. Click **Done**. It stays disabled until there is a key or a sign-in and a model, and says which one is missing.

Escape or the close button cancels. The provider added in the sheet is removed, no agent is created, and your text stays in the box.

Keys and sign-ins are stored by the agent runtime, not in the agent's file. In Browser Studio they stay on the daemon's computer; a provider's local URL also refers to that computer.

## 3. See the first turn

After **Done**, Studio creates the agent:

1. A new `.adf` file is created in your agents folder (`Documents/adf-agents` by default) under the name on the name chip, for example `steady-fern`. In Browser Studio this folder is on the daemon's computer.
2. The agent opens with its loop in the center of the window.
3. Your text is the agent's first message. The agent starts, and its answer, tool calls and reasoning appear in the loop as the turn runs.

Keep talking to the agent in the loop. Every message sent from Home creates a new agent; open an existing one from the sidebar.

If the agent does not start (you cancel a provider sheet, the agent needs review, or the provider refuses the start), the message is not lost. It is shown in the loop's queue as **Not sent**, with the reason, and goes first with your next message.

## Managing providers

Settings → Providers lists every provider, with its status and default model. Use it to add one ahead of time, change a key or a default model, or remove one. See [Models and providers](cli/models-and-providers.md) for the terminal equivalent.

## What's next

- [Core Concepts](core-concepts.md): what an agent and its file are.
- [Creating and Configuring Agents](guides/creating-agents.md): instructions, model, tools and triggers.
- [Agent States](guides/agent-states.md): idle, hibernate and autonomous mode.
- [Messaging](guides/messaging.md): agents talking to each other.
