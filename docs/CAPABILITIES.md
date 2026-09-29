# What ADF Studio Can Do

ADF, the Agent Document Format, packages an AI agent as a single portable file. Everything the agent is and knows lives inside one `.adf` file: its instructions, memory, conversation history, files, timers, keys, and message history. Each file pairs one agent with one primary document. ADF Studio is the desktop app that runs those files: it hosts the agents, gives you a place to talk to them, and lets you watch and steer a whole fleet at once.

This page is a catalogue of capabilities. **Part 1** covers what an agent can do and what you can do with it, in plain terms. **Part 2** goes under the hood for people building on top of ADF, operating it headless, or auditing how it stays safe. Both parts are worth skimming regardless of your background; the split is about depth, not audience.

Items marked *(planned)* are designed but not shipped yet.

---

# Part 1: Capabilities

## Your agent is a file

- **One file, one agent** — the `.adf` file holds instructions, memory, history, files, timers, tasks, logs, and identity. *Why it matters:* copy the file and you have copied the agent; no database, no cloud account, no export step.
- **Move it anywhere** — an agent runs the same from a laptop, a server, or a shared drive. Open it in Studio or the headless daemon and it picks up where it left off.
- **Clone it** — duplicate an agent, choosing which parts to carry over (history, files, local tables). The clone gets its own fresh identity.
- **Template it** — save an agent as a template and stamp out new ones from it. Templates can lock fields so every child keeps the rules you set.
- **Password-protect it** — hand a file to someone with a password; opening it re-keys the file to their own identity so it unlocks silently from then on. *Why it matters:* the recipient never needs your keys, and you can hand the same file to someone else. The password keeps working until you explicitly change or remove it.
- **Nothing hidden from you** — every prompt, instruction injection, and summary the model sees is stored in the file where you can read it. Secrets never enter the model's context.
- **Built-in structured storage** — an agent can create its own tables and vector indexes inside the file for anything it needs to track. *Why it matters:* the agent keeps a real database, not just notes in a document.
- **Real files inside** — the agent has a private filesystem for documents, scripts, images, and imports. Files can be marked read-only or undeletable so the agent cannot break its own foundations.

## Talking to your agent

- **Chat in Studio** — a conversation view with the model's reasoning, tool calls, file diffs, and images shown inline. Nothing the agent does is off-screen.
- **Interrupt at any time** — send a message while the agent is working and it stops what it was doing and starts on your message.
- **Ask and answer** — an agent can pause to ask you a question and wait for the reply instead of guessing.
- **Slash commands** — `/compact`, `/clear`, `/idle`, `/hibernate`, `/stop`, plus one command per installed skill.
- **Telegram** — connect a bot; the agent receives texts, photos, and documents, replies with formatting, and can send real polls and button-based forms.
- **Discord** — DMs and server channels, slash command, threaded replies, attachments.
- **Slack** — threads, file upload/download, DMs, no public URL needed.
- **WhatsApp** — pair a personal number by QR code; quoted replies, voice notes, group chats.
- **Email** — IMAP/SMTP with auto-detection for Gmail, iCloud, Outlook, Fastmail, Yahoo; proper reply threading, CC/BCC, reply-all.
- **Catches up when it was offline** — messages that arrived while the agent was stopped are delivered when it starts, and it wakes once rather than once per message.
- **Interactive forms** — the agent can send a questionnaire (single choice, multi-choice, free text) that renders as native buttons on Telegram and as a numbered list elsewhere.
- **Who can talk to it** — per-channel rules for direct messages (everyone, allowlist, nobody) and groups (everyone, only when mentioned, nobody).
- **Self-service setup** — an agent can store its own bot token and switch a channel on without you touching Settings, if you let it.

## Agents that run on their own

- **Six states** — active, idle, hibernating, suspended, error, off. Each responds differently to events, so you can dial an agent from "always on" to "only wakes for a scheduled check-in".
- **Interactive or autonomous** — interactive agents finish when they reply to you; autonomous agents keep working until they decide to stop. *Why it matters:* the same file can be a chat assistant or a background worker.
- **Timers** — one-off, delayed, repeating, or cron schedules. Missed timers fire once on restart instead of flooding.
- **Triggers** — wake the agent when a message arrives, a file changes, a timer fires, a task completes, a log line matches, or at startup.
- **Autostart** — agents you flag boot with the app; the daemon does the same on a server.
- **Turn limits and suspension** — cap how many consecutive turns an agent can take before it pauses and asks you to continue. *Why it matters:* a runaway loop costs a bounded amount and then stops.
- **Narration circuit breaker** — an autonomous agent that keeps talking without doing anything is put to idle automatically.
- **Crash recovery** — if the app died mid-turn, the agent is told exactly how long it was gone and what it was doing when it stopped.
- **Emergency stop** — one action halts every agent.

## Work that happens without waking the model

This is the part that makes ADF agents cheap to keep running. An agent can write small scripts (lambdas) that the runtime executes on its behalf, in a sandbox, with no model call. *Why it matters:* the expensive, slow part (the LLM) only runs when judgment is needed; everything routine runs for free.

- **Lambdas on triggers** — "when a file matching `reports/*.csv` changes, run this function." The function can parse the file, update a table, send a message, or decide the model does need to look.
- **Lambdas on timers** — every five minutes, poll an API, compare to last time, and only wake the model if something changed.
- **Lambdas on logs** — react to the agent's own log lines, for example escalating when an error is written.
- **Lambdas on tool calls and tasks** — observe what tools ran, or route an approval request to an external system.
- **Middleware on inbox and outbox** — every incoming message can be filtered, rewritten, or rejected before the agent sees it; every outgoing message can be checked before it leaves. Examples: strip signatures, block senders not in a contacts table, translate handles to addresses, enforce a "never send after 10pm" rule.
- **Middleware on web routes and fetches** — the same for HTTP requests the agent serves and HTTP requests it makes.
- **Warm lambdas** — keep a script's state alive between runs for counters, caches, or open connections.
- **Stream bindings** — pipe raw bytes between a WebSocket, a spawned process, a TCP socket, or the agent's own event stream, with the runtime doing the pumping. Example: a live audio feed into a transcriber, with no model involvement until a keyword appears.
- **Event taps** — subscribe a lambda to the agent's real-time event stream (every tool call, message, state change) to build monitors, dashboards, or external forwarding.
- **Scripts can call the model on purpose** — a lambda can make a targeted model call when it needs judgment, so you can build "mostly deterministic, occasionally smart" pipelines.
- **Scheduled housekeeping the agent writes itself** — an agent can install its own timers, watchers, and cleanup scripts as it learns what it needs.

## Memory and context

- **A wiki, not a scratchpad** — the agent keeps an index page of always-loaded facts plus one page per topic, loaded on demand, with an append-only change log. *Why it matters:* memory stays small, organized, and citable instead of growing into an unreadable dump.
- **Citations back to ground truth** — memory pages cite the exact conversation entries or files they came from, and those citations stay valid forever.
- **Automatic compaction** — when the conversation gets long, the agent writes durable learnings to memory, then the history is summarized by a dedicated model call. The full original is archived, not lost.
- **Manual compaction with steering** — tell the agent what to preserve when it compacts.
- **Audit archive** — compacted history, deleted files, and every message in and out can be snapshotted before deletion so the record is complete.
- **Periodic memory lint** — the agent checks its own memory for contradictions, stale pages, and orphans.
- **Self-observation** — an optional skill computes behavioral stats (idle streaks, repeated tool calls, spend without progress) and nudges the agent to change one thing when a threshold trips.
- **A voice** — an optional `soul.md` gives the agent a stable persona with concrete rules and examples rather than adjectives.
- **Context gauge** — see how full the model's context window is at all times, and what is taking up the space.

## What agents can do with tools

- **Read, write, list, delete files** — in its own filesystem, with atomic multi-edit writes and binary support.
- **Query and update its database** — SQL against its own tables, including vector similarity search.
- **Fetch the web** — HTTP requests with guardrails that stop it reaching into your local network unless you allow it.
- **A real shell** — `cat`, `grep`, `sed`, `jq`, `sqlite3`, `curl`, `crontab`, pipes, scripts, and more, operating on the agent's own files. *Why it matters:* one familiar surface instead of dozens of separate tools.
- **Run code** — JavaScript or TypeScript in a sandbox with persistent state between calls; no network, no access to keys.
- **Install packages** — pure-JS and WebAssembly npm packages, per agent, with size limits.
- **Spreadsheets, PDFs, Word, ZIP, images, YAML, dates** — bundled libraries for the common document jobs, available without installing anything.
- **Send and read messages** — to other agents, to people on connected channels, with threads and attachments.
- **Manage its own timers, config, and state** — an agent can reconfigure itself within the bounds you set.
- **Spawn new agents** — create a child agent from a template, give it files, start it, and talk to it.
- **Background execution** — any tool call can be fired in the background and checked on later.
- **Multimodal** — images, audio, and video returned by tools can be shown to the model directly when the model supports it, or saved as files otherwise.

## Extending with MCP servers and skills

- **MCP servers** — connect any Model Context Protocol server (local process or remote URL) and its tools appear to the agent. *Why it matters:* the growing MCP ecosystem is available without ADF-specific integration work.
- **Curated catalog** — around a hundred vetted servers across search, web, dev, data, communication, productivity, infrastructure, and AI, with prefilled config and prerequisites. Known name-squatted packages are kept out of the catalog, though nothing stops you installing one by hand.
- **Sign in with OAuth** — servers that need Google, GitHub, Linear, Atlassian, and similar accounts walk you through the browser sign-in; tokens are stored encrypted and never appear in config or logs.
- **Credentials travel with the agent** — per-agent keys and OAuth grants are sealed inside the `.adf` file, so moving the file moves the access.
- **Per-tool control** — every discovered tool can be enabled, hidden from the model, or set to require your approval. New tools start gated, never silently trusted.
- **Run servers in a container** — MCP servers run in the shared container by default, isolated from your machine, and on the host only if you allow it.
- **Agents can install their own MCP servers** — if you enable it, with approval.
- **Skills are just files** — drop a `SKILL.md` folder into the agent and it is indexed automatically; mute skills without deleting them. Skills can never grant tools or bypass approvals.
- **Skill catalog** — browse and preview skills from a public catalog or your own sources before installing.
- **Skill authoring and conversion** — bundled skills help write new portable skills and convert skills written for other tools.

## Working with real computers

- **Shared container** — all agents get a Linux container for running commands, with a private workspace each.
- **Dedicated container per agent** — for full isolation, with its own packages and persistent state.
- **Your own container** — point an agent at a Docker or Podman container you already run; ADF uses it but never starts, stops, or rebuilds it.
- **Host access** — let a specific agent run commands directly on your machine, gated twice: once in the agent and once app-wide.
- **Python and Node in the container** — with `uv` and npm package installs.
- **A visible Linux desktop** — an agent can drive a real desktop (screenshots, mouse, keyboard, clipboard) that you can watch live in a Computer tab.
- **A managed browser** — persistent Chromium with Playwright-based automation; you can take over for logins, CAPTCHAs, and MFA.
- **Portable browser profile** — cookies, passwords, and extensions can be encrypted into the agent file and restored on another machine.
- **Move files in and out** — transfer between the agent's filesystem and any container or the host.

## Staying in control

- **Approve before it acts** — mark any tool as restricted and the agent must ask you before using it, with a plain-English reason. *Why it matters:* you decide the risk boundary tool by tool.
- **Approve once or always** — approve a single call, reject with feedback the agent can act on, or permanently lift the gate for that tool on that agent.
- **Approvals everywhere** — the same request shows in the chat, in a global bell menu, on the fleet map, and as an OS notification when Studio is not focused. Resolving it in one place clears it everywhere.
- **Lock what the agent cannot change** — lock any config field, tool setting, timer, or trigger so the agent cannot modify it.
- **Guard rails that cannot be overridden** — accepting unsigned messages and the middleware authorization and chain settings can only be changed by you, never by the agent, not even through an approval.
- **Locked by default** — local-network fetch and stream binding start locked; the agent can ask, and you can grant a one-time override.
- **Review before running someone else's agent** — a file you did not create is summarized (tools, triggers, channels, network) before you accept it.
- **Ownership** — every agent is stamped with your identity; opening a file that belongs to someone else prompts you to claim it, which re-keys it to you.
- **Full logs and task history** — structured logs with level and origin filters, and a task list showing every approval and background job.
- **Usage and cost** — token usage by day, provider, and model, with cost estimates where prices are known, plus live burn rates per agent.
- **Safe defaults** — new agents start with autonomous mode off, dangerous tools off, and reach limited to your own machine. They will accept messages, but only from peers that can already see them locally.

## Agents talking to agents

- **Every agent has a cryptographic identity** — a decentralized identifier (DID) backed by a signing key generated at creation. *Why it matters:* agents can prove who they are to each other without a central registry.
- **Signed messages by default** — every message an agent sends is signed; recipients verify it and mark what could and could not be verified.
- **End-to-end encryption** — optionally encrypt messages so only the recipient agent can read them, using nothing but its DID. No key exchange needed.
- **Discovery** — agents find each other on the same machine, on the local network (mDNS), and across a Tailscale network.
- **Reaching agents anywhere** — a Tailscale sweep finds runtimes your local network cannot see, and a manual host list covers static IPs and port forwards.
- **Reach control** — each agent is visible to no one, to the local machine, to the LAN, or to a public directory. Inbound messages outside that scope are refused.
- **Allow and block lists** — by agent identity.
- **Threads and replies** — conversations between agents are threaded, and a reply automatically routes back to the sender.
- **Attachments** — files are copied into the recipient's filesystem.
- **Hub agents** — an agent can act as a broadcast hub, fanning messages out to subscribers.
- **Parent and child agents** — a spawned child records its parent's identity for lineage. It does not inherit the parent's credentials by default, so making a child is not a way to acquire keys.
- **Fleet awareness** — agents get a roster of who is on the network and how many unread messages they have.
- **Talk to ADF agents from Claude Code** — a standalone MCP server gives Claude Code its own identity and inbox on the same network.

## Identity and trust

- **Your owner identity** — derived from a 12-word seed phrase you back up once. The same phrase on another machine gives you the same identity and re-stamps your files.
- **Runtime identity** — each install has its own key, with a certificate from your owner identity saying it acts for you.
- **Agent identity** — each file has its own key and DID; rotating it keeps a history so lineage stays traceable.
- **Attestations** — signed certificates stored in the file: who owns it, who operates it, that it was cloned from another, that its key rotated. Agents can also issue and exchange their own certificates to build trust between peers.
- **Public agent card** — a signed card at a URL with the agent's DID, endpoints, policies, and (optionally) attestations, so others can verify before trusting.
- **Two encryption envelopes** — the signing key and the credentials are sealed separately, each openable by your owner key, this install's key, or an optional share password. *Why it matters:* a stolen file without your keys is useless; a shared file cannot leak your signing key.
- **Headless trust** — a server daemon gets its own key; you grant it access to specific agents' credentials from Studio and can revoke it later.
- **Duplicate detection** — two copies of the same agent presenting the same DID are flagged with a one-click fix.
- **Effective runtime snapshot** — the file records which provider, base URL, model, prompts, compute policy, and MCP registrations the runtime actually applied on top of the agent's config, refreshed on start, config change and provider switch — keys by source only. [Details](guides/security-and-identity.md#effective-runtime-config).
- **Tamper-evident history** *(planned)* — signed, chained state commitments so a log cannot quietly omit an action.

## Serving the web

- **Static site** — an agent can serve a folder of files as a website.
- **Shared files** — expose selected workspace files by pattern.
- **API routes** — HTTP endpoints backed by lambdas, with path parameters and middleware, warm-kept for high traffic.
- **WebSocket endpoints** — inbound WebSocket routes and outbound connections with reconnection and keepalive, either handled by a lambda or fed into the inbox as messages.
- **Agent-to-agent WebSockets** — mutual identity authentication over the socket.
- **Health and card endpoints** — every served agent exposes `/health` and its signed card.
- **Visible on the fleet map** — agents serving a site get a badge; click to open it.

## Models and cost

- **Any major provider** — Anthropic, OpenAI, OpenRouter, and 25+ OpenAI-compatible services (Gemini, xAI, Mistral, DeepSeek, Groq, Cerebras, Together, Fireworks, Perplexity, Azure, and more).
- **Local models** — LM Studio, Ollama, vLLM, llama.cpp, or any custom URL. Every tool-driven capability works on any model with native tool calling, the one model requirement ([details](guides/settings.md#provider-types)).
- **Subscriptions instead of API keys** — sign in with a ChatGPT Plus/Pro account or an xAI account and use the flat-rate allowance. The agent can see how much of the allowance is left.
- **Multiple accounts per service** — with per-agent overrides so one agent can use a different key, model, or parameters.
- **Reasoning controls** — one setting for thinking effort and budget, translated to each provider's mechanism.
- **Custom request parameters** — inject any provider-specific parameter per provider or per agent.
- **Retry with backoff** — transient provider errors are retried; rate-limit errors from subscriptions surface immediately with the reset time.
- **Usage ledger** — every call's tokens and cost recorded in the file and in an app-wide ledger, with a chart by day, provider, and model.
- **Live burn** — tokens per minute per agent and fleet-wide, with a leaderboard of hottest agents.

## The Studio app

- **Home screen** — a status line with agent, running, failing, and token counts, a connect-provider card until you have one, and a composer where sending a message creates a new agent.
- **Sidebar** — every tracked agent with live status, grouped by folder; start or stop a whole folder at once.
- **Agent dock** — four tabs (Loops, Inbox, Files, Agent), with Timers, Identity, Skills, and Config as sub-tabs under Agent. The container desktop opens as its own editor tab.
- **Rich editor** — WYSIWYG markdown with a raw toggle and a multi-tab code editor with syntax highlighting, live-updating as the agent writes.
- **File browser** — drag-and-drop upload, previews, protection badges, rename, download, delete.
- **Local tables and metadata views** — inspect the agent's own tables and key-value store.
- **Inbox view** — merged inbox and outbox with status filters and full message detail.
- **Tool call inspector** — every tool call with arguments, results, diffs, shell output, and timing.
- **Bottom panel** — logs and tasks with filters, expandable payloads, and auto-refresh.
- **Fleet map ("Age of Agents")** — an RTS-style hex map where every agent is a tile, folders are territories, and channels are stations. Watch messages flow, spot who needs you, box-select, assign control groups, and issue commands (start, stop, message, hibernate, restart) from the map.
- **Map lenses** — switch the map between state, token burn, model, health, and lineage views.
- **Inline approvals on the map** — answer an agent's question or approve a tool right on its tile.
- **Peer platforms** — agents discovered on other machines appear as satellite stations with their verified identity and served files.
- **Theme, font, and scale** — light/dark, font family, UI scale.
- **Auto-update** — checks GitHub releases, downloads on your click, restarts to install. The check can be turned off.
- **No telemetry** — no analytics SDK; crash dumps stay local. The update check, provider connection checks and live catalogs each have an off switch, and [every outbound connection](NETWORK.md) is listed.
- **Keyboard shortcuts** — throughout, with an in-app reference card on the map.
- **OS integration** — `.adf` file association, recent files, single-instance focus, native notifications.

## Running without the app

- **Headless daemon** — the same runtime under plain Node.js for servers, with an HTTP API and Server-Sent Events stream.
- **Command-line client** — list, start, stop, chat, approve, answer, inspect files and messages, follow events, manage auth; with no command it opens the terminal app for the whole fleet and every agent's loops.
- **Full HTTP API** — agents, chat, files, timers, identity, tasks, compute, network, settings, with an OpenAPI document.
- **Subscription sign-in over SSH** — device-code and relay flows so a remote daemon can use a ChatGPT or xAI subscription without exposing credentials.
- **Review gate** — the daemon only autostarts agents you have reviewed.
- **Cross-platform packaging** — signed and notarized macOS builds, signed Windows installer, Linux deb and AppImage.

---

# Part 2: Under the hood

This part is for anyone building on ADF, operating it at scale, or evaluating its security model. It follows the same groupings as Part 1 but names the mechanisms.

## Storage format

*Full reference: [Documents and Files](guides/documents-and-files.md) · [ADF Spec](../ADF_SPEC_v0.2.md)*

- **SQLite container** — a `.adf` is a SQLite database opened in WAL mode with foreign keys on. *Why it matters:* every agent is queryable with standard SQL tooling, and evals can assert directly on tables.
- **Protected `adf_` schema** — system tables (`adf_config`, `adf_loop`, `adf_inbox`, `adf_outbox`, `adf_timers`, `adf_files`, `adf_audit`, `adf_identity`, `adf_attestations`, `adf_tasks`, `adf_logs`, `adf_meta`) are only mutated through tools; agents create their own `local_*` tables.
- **Vector search** — `sqlite-vec` virtual tables loaded on every file.
- **Two version axes** — format version (`0.2`) and schema version (`32`) evolve independently; migrations are sequential and never downgrade. A file from a newer runtime opens without migration and only warns, rather than being rejected.
- **Clean-close fast path** — a marker lets the next open skip a full integrity check.
- **Instruction templating** — `{{path}}` placeholders pull file contents into the system prompt, snapshotted at session start and refreshed only on compaction; a missing file renders a visible marker rather than vanishing.
- **Config forward-compatibility** — unknown config fields round-trip untouched; write-time validation rejects only newly introduced violations.
- **Portability boundary** — config, documents, files, history, messages, timers, tasks, logs, audit, identity, and local tables travel with the file; installed MCP packages, app-level keys, container images, and in-memory keys do not.

## Execution model

*Full reference: [Code Execution](guides/code-execution.md) · [The adf Proxy Object](guides/adf-object.md) · [Triggers](guides/triggers.md) · [Timers](guides/timers.md)*

- **Seven execution contexts** — inline `sys_code`, `sys_lambda`, trigger lambda, timer lambda, API route, middleware, WebSocket lambda, each with distinct persistence and authorization.
- **Sandbox** — Node worker threads with V8 VM contexts; `eval` and `new Function` disabled, WASM allowed, native `fetch` removed so all egress goes through the guarded `sys_fetch`, frozen prototypes, module allowlist, 60s default / 300s ceiling timeout.
- **TypeScript in the sandbox** — types stripped on the fly with a content-hash cache.
- **Uniform `adf` proxy** — every sandbox context calls tools through one async RPC object; `_async` runs any call as a background task, `_full` lifts output truncation for code only.
- **Cold vs warm** — lambdas run in a fresh worker per call unless `warm: true`; all warm timer/trigger lambdas for an agent share one sandbox.
- **System vs agent scope** — system-scope targets run lambdas or shell commands in every state but `off`; agent-scope targets wake the model and are gated by state.
- **Dispatch lanes** — per trigger type concurrency caps (1 for high-frequency triggers like log/tool-call/file-change, 4 for work-shaped ones), a 64-deep queue, a 30s hang detector for high-frequency lanes, drop-and-log beyond capacity.
- **Trigger filters** — sender/source, watch glob, tool names, log level/origin/event, task status, per type; self-generated file changes suppressed unless opted in.
- **Timer semantics** — 5-second poll tick, rows flagged before their payload fires (no double-fire after a crash), expired timers retained as history, `locked` timers immune to the agent.
- **Loop injection** — code can queue a context entry that lands only at a clean model boundary, never splitting a tool call from its result; system/assistant shapes are rejected to prevent history forgery.
- **Capability profiles** — `studioForeground`, `studioBackground`, `daemon`, `headlessLive`, `benchmark` declare exactly which subsystems (timers, compute, MCP, adapters, shell, stream bindings, taps, mesh) are on; typecheck forces every profile to declare every capability.
- **Single assembly path** — one construction site for the executor, one dispatch path for triggers, enforced by a CI fence.
- **Lifecycle states** — created, starting, running, stopping, stopped, disposed; four stop modes, of which only `graceful` waits (5s grace); `immediate`, `owner-off`, and `emergency` all abort at once.
- **Idle sweep** — agents idle past five minutes are released from memory, gated on per-loop activity.

## Conversation loop and inner loops

*Full reference: [Memory Management](guides/memory-management.md) · [Inner Loops](guides/inner-loops.md)*

- **Loop table as ground truth** — every message, tool call, and result is a row sent verbatim to the model; sequence numbers are never reused, so citations survive compaction.
- **Compaction mechanics** — token estimate against `compact_threshold` (default 100k) triggers a memory-flush nudge, then a dedicated summary call, an optional audit snapshot, deletion, and a summary entry ordered before the preserved tail; a revision counter aborts a compaction racing a concurrent mutation.
- **Context blocks** — system prompt and per-turn dynamic instructions are stored as deduplicated loop rows, so what the model saw is always reconstructible.
- **Named inner loops** — up to 16 side loops per agent, each with its own goal, tool allowlist, optional model override, and compaction threshold, sharing the file, identity, and memory.
- **Attenuate, never escalate** — a loop's effective tools are the intersection of its allowlist and the host's enabled set; `sys_update_config`, `loop_manage`, `sys_create_adf`, and every restricted tool are prohibited for side loops.
- **Loop messaging** — `loop_send` with optional wake delivers at the next model boundary; `loop_list` shows the roster; deleting a loop archives its stream to audit.
- **Turn tools** — `respond` ends the turn in interactive mode and continues in autonomous; `say` never ends the turn; `ask` blocks for a human.
- **Context breakdown** — per-file, per-tool-schema, and per-source token accounting, recomputed only when the cache rebuilds.

## Tool access control

*Full reference: [Tools](guides/tools.md)*

- **Three flags per tool** — `enabled` gates execution, `visible` gates advertisement to the model, `restricted` requires approval from the loop and blocks unauthorized code entirely. `locked` prevents the agent from changing any of them.
- **Reason field** — every restricted call carries a runtime-injected justification shown to the approver.
- **Code-context matrix** — restricted tools are blocked from inline code, approval-gated from an authorized lambda invoked by the loop, and free from authorized files, triggers, and timers.
- **Excluded from code** — `say`, `ask`, `loop_compact`, `loop_clear` cannot be called from code at all.
- **SQL guard** — system tables read-only or blocked by pattern, identity/config/meta unreachable, PRAGMA functions blocked, comments stripped before validation, 500-row cap for the model.
- **Shell pre-flight** — commands are parsed to an AST first; each resolved tool (including redirects) is checked against declarations, with distinct exit codes for disabled and approval-required.
- **Egress guard** — `sys_fetch` and `ws_connect` deny RFC1918, CGNAT, link-local, and unspecified addresses by default, re-checked after DNS resolution and on every redirect hop; the daemon control API is always blocked; `allow_local_fetch` is owner-locked.

## Authorized code

*Full reference: [Authorized Code Execution](guides/authorized-code.md)*

- **File-level trust flag** — a file marked `authorized` can call restricted tools and methods without approval; any write to that file clears the flag at the database layer. *Why it matters:* trusted automation cannot be silently edited into something else.
- **Caller chain enforcement** — unauthorized code cannot invoke an authorized lambda; the flag propagates through an async-local context so parallel sandboxes cannot clobber each other.
- **Gateway pattern** — authorized code can authorize other files, enabling remote-approval workflows.
- **Restricted methods** — `attestation_issue` requires authorized code by default; `model_invoke`, `task_resolve`, `loop_inject`, `get_identity`, `set_identity`, `emit_event` can be added to the list.
- **Protection bypass** — authorized code can overwrite read-only files and protected meta keys, matching what the owner can do in the UI.
- **Task-level authorization** — a task can be flagged once to require an authorized approver; the flag cannot be unset.
- **Middleware gate** — only authorized files run as middleware by default; the setting is owner-only.

## Messaging protocol (ALF, the Agentic Lingua Franca)

*Full reference: [Messaging](guides/messaging.md) · [LAN Discovery](guides/lan-discovery.md) · [Umbilical Events](guides/umbilical-events.md) · [ALF Spec](../ALF_SPEC_v0.1.md)*

- **Addressing** — recipient DID resolved separately from delivery URL; three send modes (explicit, reply-by-parent, bare local handle) plus `type:id` channel addressing.
- **Transport resolution** — same-runtime direct write, then an authenticated WebSocket if one is open, then HTTP POST; single attempt, outcome recorded.
- **Security levels** — 0 open, 1 signed (default), 2 signed and encrypted end-to-end via DID-derived X25519 keys, 3 custom middleware policy.
- **Ingress re-stamping** — verification flags on the wire are stripped and re-stamped only by what the receiving transport actually verified; reserved aliases (`owner`, `system`, `user`) are dropped.
- **Visibility tiers** — `off`, `localhost`, `lan`, `directory`, strictly nested; the mesh server binds beyond loopback only when a LAN-tier agent exists.
- **Attachments** — inline base64, by reference with digest, or imported; copied into the recipient's `imported/<sender>/` namespace.
- **Forms** — `application/vnd.adf.form+json`, up to 10 questions of 12 options, rendered natively on Telegram (compact, per-question, or poll) with strict validation and plain-text fallback elsewhere.
- **Adapter framework** — shared start/stop/send/status contract, 30s health checks with backoff restart, per-platform catch-up windows, dedup on redelivery, credentials only in the agent's identity store.
- **Discovery** — mDNS service record per runtime with self-skip, peer directory fetch with cache, trust decoration on merged cards, firewall auto-repair for the mDNS and mesh ports.
- **Three-source peer table** — mDNS announcements, a Tailscale sweep, and manual `host:port` entries feed one table, each tagged with its source. *Why it matters:* multicast does not cross WireGuard, so a tailnet peer can never announce itself even though it is perfectly reachable.
- **Tailnet sweep mechanics** — reads the local Tailscale daemon (`tailscale status --json`, no keys or admin API), probes each online peer's `/ping` for an ADF runtime, sweeps every 45s with a refresh hook so a newly added manual peer appears in seconds; refused addresses back off for five minutes, and tailnet peers classify as LAN tier under the same visibility enforcement.
- **Umbilical events** — a uniform envelope for every runtime action (tool, turn, agent, LLM, lambda, DB, file, message, trigger, provider, error, HIL, config, loop, WS, binding), with loop protection (self-origin exclusion, rate limit, wildcard opt-in), optional replay ring, and SSE forwarding.

## Identity and cryptography

*Full reference: [Security and Identity](guides/security-and-identity.md) · [Security Architecture](guides/security-architecture.md)*

- **Key hierarchy** — owner Ed25519 at SLIP-0010 `m/44'/0'/0'` from a BIP-39 seed, owner X25519 at `m/44'/0'/1'`, per-install runtime Ed25519 and X25519 never seed-derived, per-agent Ed25519 as `did:key`.
- **Envelope construction** — per-envelope random data key wrapped per slot: ephemeral X25519 ECDH, HKDF-SHA256, AES-256-GCM for key slots; scrypt (N=2^17) then AES-256-GCM for password slots. Data keys live in memory only.
- **Unlock cascade** — runtime slot, then owner slot (which re-wraps a runtime slot), then password prompt; four states per envelope (unlocked, locked, foreign, absent).
- **Legacy format** — PBKDF2-based whole-file passwords still readable and converted to slots on first unlock.
- **Attestation lifecycle** — Ed25519 over canonical JSON including the subject (non-replayable); `owner` and `operator` are replaced on re-key, others append-only; reserved roles are runtime-only.
- **Card signature scope** — covers identity and policy fields, excludes observer-dependent endpoints.
- **Identity-data layering** — key material sealed in `adf_identity`, unsigned runtime facts in `adf_meta`, verifiable proofs in `adf_attestations`; signing and envelope keys are never code-readable regardless of `code_access`.
- **Sealed epochs** *(planned)* — Merkle state roots per domain, chained and signed per epoch, with a four-rung ladder to external witnesses and TEE attestation.

## MCP internals

*Full reference: [MCP Integration](guides/mcp-integration.md)*

- **Transports** — stdio (npm, PyPI, custom command) and Streamable HTTP; no SSE by design.
- **Tool reconcile** — new tools land enabled, visible, and approval-gated; changed schemas are disabled pending review; removed tools are hidden.
- **Credential paths** — env-var credentials app-wide or per-agent (`mcp:<server>:<key>` in the identity store); file-shaped OAuth credentials sealed in the credentials envelope, materialized before every spawn, captured back after a successful auth preflight.
- **Interactive auth** — stdio servers get a preflight launch with callback-port tunneling into the container and automatic browser open; HTTP servers use an SDK-native OAuth client with discovery and dynamic registration, an ephemeral loopback callback, and tokens pinned to the registered URL.
- **Process hygiene** — sensitive env vars stripped, per-agent scratch directories, agent-scoped `$HOME` in the shared container, native-addon packages rejected, path-traversal guards on install and uninstall.
- **Multimodal handling** — media saved to the agent's files at a predictable path and passed to the model natively when that modality is enabled; images an MCP tool merely wrote to disk are recovered.
- **Managed browser attach** — Playwright MCP attaches to ADF's own Chromium over the DevTools protocol instead of launching a second browser.

## Compute and containers

*Full reference: [Compute](guides/compute.md) · [Computer](guides/browser.md) · [Computer Use](guides/computer-use.md) · [Desktop Applications](knowledge/desktop-apps.md)*

- **Targets** — shared container (default), isolated per-agent container, external user-owned container, host; resolution fails closed rather than redirecting.
- **Two-tier host gate** — agent-level `host_access` plus app-level enable and per-package approval list.
- **Container network isolation** — nftables rules drop new inbound connections between sibling containers.
- **Desktop stack** — X display, Openbox, tint2, noVNC to the Computer tab, `xdotool`/`scrot`/`xclip` for control.
- **Package tiers** — bundled standard library, app-wide runtime packages, per-agent packages (50MB per package, 200MB total, 50 packages); agents can promote their own package to runtime scope.
- **WASM userland** — real jq 1.8.2 and uutils coreutils (`sort`, `uniq`, `wc`, `cut`, `tr`) run in an in-memory WASI sandbox in a killable worker.

## Providers and cost accounting

*Full reference: [Settings](guides/settings.md)*

- **Unified provider interface** — one `createMessage` contract; connection pooling by key and base URL for 100+ concurrent agents.
- **Reasoning translation** — one effort/max-tokens/exclude/preserve setting mapped to Anthropic thinking, OpenAI reasoning, xAI effort clamps, and OpenRouter reasoning details round-tripped across tool calls.
- **Error enrichment** — retry errors unwrapped to the underlying status, body, and `Retry-After` for the executor's classifier; structural faults enter `error`, transient ones return to `idle`.
- **Subscription sessions** — Studio and daemon keep separate encrypted token files with concurrent-writer safety and refusal to downgrade encryption.
- **Cost precedence** — provider-reported cost wins, then a local pricing table with cache-aware input math, never for subscriptions; `cost_source` is recorded.
- **Ledgers** — per-call tokens on each loop row; app-wide `token-usage.json` with delta-merge so Studio and daemon never clobber each other; in-memory rolling burn window per agent.

## Daemon, API, and CLI

*Full reference: [Daemon Overview](daemon/index.md) · [HTTP API](daemon/http-api.md) · [ADF CLI](daemon/cli.md) · [Terminal app](daemon/tui.md) · [Runtime Architecture](daemon/runtime-architecture.md)*

- **Runtime service** — in-memory agent map keyed by canonical path, no double-loading, dispatch-object boundary (never calls a turn directly).
- **Event bus** — monotonic cursor, bounded ring, SSE replay from a cursor.
- **Endpoints** — lifecycle (load, autostart, review, start, stop, abort, state), content (chat, loop, logs, config, document, mind, files, inbox, outbox, timers, meta, tables), identity and credentials, tasks and asks, runtime diagnostics, auth, compute and package admin, network and mesh, settings.
- **Tokened, cross-site protected** — every route but `/health` needs a bearer token: a per-install token minted into `<settings dir>/daemon-token` (0600) that local `adf` clients read by themselves, or `ADF_DAEMON_TOKEN` (required for a non-loopback bind). A Host allow-list stops DNS rebinding, and requests with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are refused (no CORS). Credential reads return metadata only; values and key material never leave the process. The SSRF guard blocks agents from reaching the API either way.
- **CLI** — agents, status, start/stop/abort, runtime, providers, auth, settings, network, usage, config, files, inbox/outbox, timers, tasks/approve/deny, asks/answer, identities, mcp, adapters, events, chat, with `--url` and `--json`.
- **Terminal app** — `adf` (or `npm run adf`) with no command: the fleet as a tree of agents and their loops, per-loop chat with streaming replies and inline approvals, side loops created from templates (memory consolidator, researcher, critic, reflector) and put on a schedule, files and mind with `$EDITOR` round-trips, live umbilical events, a command palette and themes, plus a welcome checklist, channels (`/channels`), MCP servers (`/mcp`: catalog, npm, Python, remote) and API-key providers (`/provider add`) ([terminal app](daemon/tui.md)).
- **Known gaps** — no cross-process lock between Studio and daemon on the same file or mesh port; file-change triggers are limited headless.

## Settings and persistence

*Full reference: [Settings](guides/settings.md) · [Daemon Runtime Settings](daemon/runtime-settings.md)*

- **Coalesced writes** — bursts collapse into one flush; identity-critical writes flush synchronously.
- **Merge on stale** — a write detects another process changed the file and merges rather than clobbering.
- **Corrupt-file quarantine** — an unreadable settings file is moved aside, never deleted, and writes are refused if quarantine fails.
- **Secret handling** — OS keychain encryption with a plaintext fallback warning; three-way secret status (absent, ok, locked) so keys are never minted over an undecryptable one; secrets stripped before reaching the UI process.
- **Owner-only guard set** — unsigned-message acceptance, middleware authorization, middleware chains, fetch middleware; unreachable from the agent even via approval.
- **Locked-by-default** — local-network fetch and stream binding require a deliberate owner override per agent.

## Studio internals

*Full reference: [Studio Documentation](ADF_STUDIO_DOCS.md) · [Fleet Map](guides/fleet-map.md)*

- **Process isolation** — context isolation, sandboxed renderer, no Node integration, strict CSP, sanitized markdown, navigation blocked, external-open protocol allowlist.
- **IPC** — 200+ typed channels with batched event delivery to the renderer.
- **Foreground/background handoff** — a running agent moves between the visible window and the background manager without losing state.
- **Fleet map performance** — frozen deterministic geography, canvas ambience capped at 30fps, calm-mode governor under load, delta-based polling.
- **Approval hub** — a central registry of pending approvals across agents and loops with secret-safe previews and a capped resolution history.

## Release and quality

*Full reference: [Releasing](../RELEASING.md) · [Performance Harness](daemon/performance-harness.md) · [Lifecycle Assembly](daemon/lifecycle-assembly.md)*

- **Packaging** — electron-builder for macOS (dmg and zip, arm64 and universal), Windows (NSIS x64), Linux (deb and AppImage).
- **Signing** — Apple Developer ID plus notarization; Windows Azure Artifact Signing in CI with post-build signature verification.
- **Release flow** — `npm version` tags and pushes; a three-OS matrix builds to a draft release that goes live only if all builds pass; notes generated from conventional commits.
- **Auto-update** — GitHub Releases feed, checked on launch and every hour unless `updateChecksEnabled` is off, platform-appropriate installers.
- **CI checks** — tests, lifecycle-conformance ledger assertion, typecheck as a capability-profile completeness gate, lint, build, architecture fence.
- **Performance harness** — headless stress scenarios (smoke, overhead, idle, mixed, burst) with latency percentiles, event-loop lag, memory, and handle counts.
- **Eval design** *(planned)* — around 58 SQL-scored capability evals across ten areas including adversarial robustness, with scripted, attacker, and real-model provider modes.
