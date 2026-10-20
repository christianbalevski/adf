# Models and providers

An agent needs a model provider: an API key, a local model server, or a
Claude, ChatGPT or Grok subscription signed in on the daemon.

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

## Subscriptions

Agents on a subscription need the **daemon** to be signed in. The daemon's
ChatGPT and Grok sign-ins are its own, separate from Studio's. Claude's is
not: it is the sign-in of the Claude Code installed on the daemon's machine,
shared with Studio and with Claude Code itself.

| In the app | One-shot | How |
|---|---|---|
| `/login chatgpt` | `adf auth login chatgpt` | Opens your browser; the URL is shown too (`c` copies it) in case it does not open |
| `/login grok` | `adf auth login grok` | Shows a device code and URL; approve in any browser |
| `/login claude` | `adf auth login claude` | Runs `claude auth login`, which opens your browser; the URL is shown too. Paste the code if the page shows one |
| `/auth` | `adf auth` | Status of each, and which providers have keys |
| `/logout <provider>` | `adf auth logout <provider>` | Sign out (the app asks first) |

Claude requires [Claude Code](https://code.claude.com/docs/en/setup) 2.1.248
or newer on the daemon's machine. `adf auth logout claude` runs `claude auth
logout`, which signs Claude Code out on that machine too.

When the daemon runs on another machine, ChatGPT's browser callback is
received on your machine and handed to the daemon (relay mode, chosen
automatically for a remote `--url`; `--relay` / `--loopback` override it).
Grok's device code works anywhere. For Claude, open the shown URL in any
browser and paste the code the page shows. Details:
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

## Media when changing models

The table below is what ADF can send to each provider. It says nothing about
whether a model understands that media. That is your choice: set
`model.multimodal.image`, `.audio`, and `.video` per agent to match the
model you selected. ADF does not detect model capabilities. The toggles can
only narrow the table, never widen it:

| Provider | Image | Audio | Video |
| --- | --- | --- | --- |
| Anthropic, Claude subscription | yes | no | no |
| OpenAI, ChatGPT subscription | yes | no | no |
| Grok subscription | yes | no | no |
| OpenRouter, OpenAI compatible | yes | yes | yes |

A new chat message with an attachment the model cannot take is refused with
the reason (`400 media_unsupported` on `POST /agents/:id/chat`). It is never
sent without the attachment. Studio's composer refuses such a file before
upload and shows the reason. `GET /agents/:id/status` answers each loop's
effective set as `media`.

Attachments already in history that the model cannot take are replaced by a
stable text placeholder in the outgoing request only. The first request of a
turn that leaves any out adds a System row to the loop that names them and
why. The live session keeps the original attachment until normal media cleanup
or context reset, so switching back to a model that takes it restores it
without rewriting history.

Native media payloads are held in memory; normal session writes exclude them
from persisted loop messages. Tool-result text may retain a saved file path,
but reopening a loop does not automatically reload that file as a native
attachment. Read it again when needed. Changing models requires a separate
cache warmup.

## Prompt caching

Direct Anthropic and Claude models selected through OpenRouter cache the
system instructions and the end of conversation history before temporary
runtime hints. OpenAI and ChatGPT subscription requests carry a
`prompt_cache_key` that is stable per agent loop. Compaction summaries and
`model_invoke` calls are not sent again, so they get no cache markers. Cache
hits still depend on the provider's minimum token count, retention window, and
matching prompt prefix. Explicit raw `cache_control` request parameters
override this default policy; an empty value disables the default markers.
Claude subscription sessions use Claude Code's own caching.
