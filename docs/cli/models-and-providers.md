# Models and providers

An agent needs a model provider: an API key, a local model server, or a
ChatGPT or Grok subscription signed in on the daemon.

## API keys and local servers

`/provider add` (or the welcome's "Connect a model", or the palette) lists
every provider Studio knows: subscriptions first (they open the sign-in
dialog), then APIs (Anthropic, OpenAI, OpenRouter, Gemini, Groq, …), local
servers (Ollama, LM Studio, …) and any OpenAI-compatible URL. `/` filters.
The form asks for a name, the base URL when needed, the API key (as dots,
with where to get one) and an optional default model.

The key goes once to the daemon, which keeps it in its secret store: the OS
keychain, or the owner's passphrase file where there is none. It is never
written to the settings file, never shown again, and never returned (only
"has a key"). When that store is locked, the identity dialog opens first.

| Command | Action |
|---|---|
| `/provider add [preset]` | Add one |
| `/provider list` | Runtime › Providers: every provider and which agents use it |
| `/provider remove <id>` | Remove it and its key (asks) |

Studio reads keys added here from the same keychain entry, so the provider
works in both apps. Keys added in Studio stay in Studio's settings file as
before.

One-shot: `adf providers` (providers and which agent resolves to which).

## ChatGPT and Grok subscriptions

Agents on a subscription need the **daemon** to be signed in. The daemon's
sign-in is its own, separate from Studio's.

| In the app | One-shot | How |
|---|---|---|
| `/login chatgpt` | `adf auth login chatgpt` | Opens your browser; the URL is shown too (`c` copies it) in case it does not open |
| `/login grok` | `adf auth login grok` | Shows a device code and URL; approve in any browser |
| `/auth` | `adf auth` | Status of both, and which providers have keys |
| `/logout <provider>` | `adf auth logout <provider>` | Sign out (the app asks first) |

When the daemon runs on another machine, ChatGPT's browser callback is
received on your machine and handed to the daemon (relay mode, chosen
automatically for a remote `--url`; `--relay` / `--loopback` override it).
Grok's device code works anywhere. Details:
[Remote daemon](remote-daemon.md#sign-in-to-chatgpt).

An agent whose subscription is not signed in shows `signed out` on the Fleet
and `ChatGPT not signed in — /login chatgpt` in Chat.

## Pick a model

- **New agent:** the wizard (`/new`) takes an optional provider and model;
  `adf new --provider <id> --model <id>`.
- **Existing agent:** `/model` opens a picker (providers with their sign-in
  state, then models; type to filter), or `/model [provider/]model`.
- **Per loop:** on `main`, `/model` changes the agent config. On an inner
  loop it sets that loop's own model override; `/model inherit` clears it.

`adf usage [agent]` and Runtime › Usage show token usage by model.
