# ADF / ADF Studio Feature Inventory (internal snapshot)

**Status: generated artifact, not maintained.** A one-line-per-feature sweep of
the specs, docs, and source, produced 2026-09-18 by a fan-out of subagents. It
is an internal audit aid and a source for writing real documentation, not a
reference: it is granular enough to rot within weeks, and it is deliberately not
linked from `docs/index.md`.

The user-facing capabilities page distilled from it is
[CAPABILITIES.md](../CAPABILITIES.md).

**Known limitation:** this sweep drew partly on `docs/design/*`, which at the
time carried stale status lines, so it initially recorded Tailscale peer
discovery and inner loops as unimplemented when both are shipped. Treat any
"not implemented" claim here as unverified and confirm against `src/` before
relying on it.

Grouped by area, then category.


# 1. ADF File Format & Storage

### Core Principles

- **Sovereignty** — each `.adf` owns its document, memory, config, inbox/outbox, timers, and logs; other agents influence it only via messages.
- **One Agent, One Document** — exactly one primary document (`README.md`) and one `mind.md` per file; supporting files are subordinate.
- **No Secrets in Context** — every prompt/context injection (system prompt, dynamic instructions, compaction summaries) is persisted as an auditable `adf_loop` row.
- **Cold path / hot path separation** — LLM loop (reasoning) vs. lambdas/triggers/timers/middleware (deterministic, repeated work).
- **Spec stores, runtime executes** — the file holds declarative state; providers, sandboxes, and networking are runtime concerns.
- **Asynchronous, store-and-forward messaging** — `adf_outbox`/`adf_inbox` decouple send from delivery, supporting offline and high-latency operation.

### Storage Format

- **SQLite 3 container** — a single `.adf` file is a SQLite database; UTF-8 text; epoch-ms timestamps unless noted ISO-8601.
- **WAL pragmas on open** — `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`.
- **Protected `adf_` schema** — system tables agents cannot write directly; all mutation goes through tools/lambdas/owner ops.
- **`adf_` well-known meta key registry** — every runtime-read/written key must be documented; namespace governance splits `adf_*` (spec), `runtime_*` (opaque), and agent-owned keys.
- **Storage-layer taxonomy for identity data** — key material in `adf_identity`, runtime facts in `adf_meta`, signed proofs in `adf_attestations`.
- **User schema (`local_*` tables)** — agents create arbitrary non-`adf_` tables, conventionally prefixed `local_`.
- **sqlite-vec vector tables** — `CREATE VIRTUAL TABLE local_x USING vec0(...)` for embedding similarity search, loaded on every ADF database.
- **`adf_schema_version` migration ladder** — sequential, monotonic, currently 32; runtimes must not silently downgrade. CORRECTED: a newer-than-known schema opens WITHOUT migration and only warns; it does not fail closed.
- **Clean-close fast path** — `close()` writes a marker meta key so the next `open()` can skip a full O(file-size) `PRAGMA integrity_check`; `forceIntegrityCheck` bypasses it.
- **WAL checkpoint management** — passive/truncate checkpoints on close, plus a 10s workspace timer and autocheckpoint, to keep the on-disk file current.
- ~~Large file chunking~~ — CORRECTED: not implemented. `adf_files.content` is a single BLOB; no `adf_file_chunks` table exists.

### Virtual Filesystem (adf_files)

- **Three-level file protection** — `read_only` (no read/write/delete), `no_delete` (read/write, no delete), `none` (fully mutable).
- **Reserved core files** — `README.md`, `mind.md`, `mind/log.md`, `soul.md` locked to `no_delete` and always agent-writable.
- **File authorization flag** — `authorized=1` marks trusted code provenance; any agent write clears it back to `0`.
- **`{{path}}` instruction templating** — placeholders resolve only against `adf_files`, single-pass (no recursion), snapshot at session start, refresh only at compaction/loop-clear.
- **Missing-placeholder auditability** — an unresolved `{{path}}` renders a visible `<injected_file missing="true">` marker instead of silently vanishing.
- **File write size cap** — `limits.max_file_write_bytes` (default 5MB) applies to every file except `README.md`/`mind.md`; `soul.md` is capped despite being core.
- **`adf-file://` protocol** — custom scheme for inline images and clickable cross-file links directly from `adf_files` blobs.
- **Skill packages under `skills/`** — installation is a plain file write (`skills/<name>/SKILL.md`); no dedicated install tool or config subsystem.
- **Derived `skills-registry.json`** — runtime-generated, `read_only`-held catalog injected via `{{skills-registry.json}}`; bounded/validated indexing with a reported `rejected` list.
- **`skills-state.json` mute list** — agent-writable JSON toggling installed skills off without touching source files.

### Agent Configuration

- **Single-row JSON config** — `adf_config.config_json` holds the whole `AgentConfig`; write-time schema validation rejects only newly introduced violations, load-time is advisory.
- **Forward-compatible field preservation** — runtimes must round-trip unknown config fields untouched.
- **`locked_fields`** — array of dot-paths the agent cannot self-modify via `sys_update_config`; several fields (`id`, `metadata`, `providers`, `restricted*`) are owner-only regardless.
- **`bare_prompt` / `include_base_prompt`** — graduated control over how much runtime-authored prompt text surrounds `instructions`, including suppressing dynamic per-turn instructions.
- **Tool declaration matrix** — `enabled` × `visible` × `restricted` jointly gate LLM-loop, authorized-code, and unauthorized-code access per tool.
- **Side loops (`config.loops`)** — named secondary cognition streams with their own goal, model override, tool allow-list, autostart/autonomous flags, and prohibited-tool enforcement.
- **Compatibility shims** — legacy `autonomous: true|false` maps to `loop_mode`; deprecated `model.thinking_budget` folds into `model.reasoning.max_tokens`; dead `allow_protected_writes` stripped on migration.
- **Recovery/backoff config** — `recovery.auto_retry`, `max_attempts`, `base_delay_ms`/`max_delay_ms` for transient provider-error retry, bounded to avoid `setTimeout` overflow.
- **Stream binding config** — `stream_bind` gates (host/container/TCP process binds) plus `stream_bindings[]` declaring paired WS/process/TCP/umbilical endpoints with idle/duration/byte limits.
- **Umbilical taps** — `umbilical_taps[]` subscribe a lambda to the runtime event bus with wildcard opt-in, rate limiting, and self-origin exclusion; `umbilical.log` configures an in-memory bounded replay window.
- **Compute config** — isolated/host execution target selection, npm/pip package lists, and an optional visible desktop (`compute.browser`) inside the container.
- **MCP server config richness** — stdio/http transport, OAuth-based remote auth, `header_env`/`env_schema` credential wiring, and `credential_files` with write-back.
- **Provider overrides** — file-carried list of custom model providers (OpenAI-compatible, OpenRouter, etc.) with per-provider params and request delay.
- **`table_protections`** — per-table protection config (`none`/`append_only`/`authorized`) for local data tables under `security`.

### States and Loop Behavior

- **Six agent states** — `active`, `idle`, `hibernate`, `suspended`, `error`, `off`, each with distinct wake behavior.
- **Structural vs. operational failure split** — only structural executor faults enter `error`; transient provider errors (429/5xx/timeout) return the agent to `idle` and log as `provider_error` (warn) vs `turn_error` (error).
- **Hard-off teardown guarantee** — `off` is never deferred: aborts in-flight LLM calls, tears down mesh registration, MCP connections, adapters, WS connections, and the code sandbox.
- **Suspend-timeout auto-off** — hitting `max_active_turns` suspends the agent; unanswered HIL after `suspend_timeout_ms` (default 20min) auto-transitions to `off`.
- **Wake-and-return semantics** — a trigger from idle/hibernate always returns to the prior idle state unless the turn itself calls `sys_set_state`.
- **Hibernate trigger-backlog drop** — entering hibernate/off discards queued agent-scope dispatches and emits a `trigger.dropped` event instead of replaying stale wakes.
- **Two loop modes** — interactive (`respond` ends turn, `ask` pauses for human) vs. autonomous (`respond` logs and continues, no `ask`).
- **User-interrupt restart** — a new human message while active aborts the in-flight turn and restarts with the new input.
- **Crash-recovery notice** — a one-time injected notice on reload after an interrupted turn, carrying absolute start/progress/now timestamps and elapsed offline time.

### Triggers and Timers

- **Ten trigger types** — `on_startup`, `on_inbox`, `on_outbox`, `on_file_change`, `on_chat`, `on_timer`, `on_tool_call`, `on_task_create`, `on_task_complete`, `on_logs` (plus experimental `on_llm_call`).
- **Two execution scopes** — `system` (lambda, fast/deterministic, fires in all states but `off`) vs. `agent` (wakes the LLM loop, gated by state).
- **Self-trigger recursion guard** — an originating lambda never receives its own `on_file_change`/`on_logs` event even with `include_self`.
- **Per-trigger filter fields** — source/sender, watch glob, tool names, log level/origin/event, matched per trigger type.
- **Timer schedule types** — `once`, `delay` (collapses to resolved `once`), `interval` (with `start_at`/`end_at`/`max_runs`), `cron`.
- **Missed-timer coalescing** — downtime fires a missed timer once on load and reschedules forward, never floods all missed occurrences.
- **Owner-locked timers/triggers** — `locked` flag on timer rows and trigger targets prevents agent modification/deletion.

### Security, Identity, and Encryption

- **Three identity tiers** — Owner (BIP-39 seed, cross-machine), Runtime (per-install, never seed-derived), Agent (per-file Ed25519, `did:key`).
- **Mandatory agent identity at creation** — every ADF gets an Ed25519 keypair, `did:key` DID, and owner/operator attestations from birth (schema v24+).
- **DID rotation with history** — rotation/claim always appends the prior DID to `adf_did_history`, keeping lineage resolvable without rewriting children.
- **Read-time lineage cascade** — parent resolution walks current DID → DID history → legacy `config.id`, with no write-time repair sweep on rotation.
- **Dual-envelope keyslot encryption** — `identity` (signing key only, owner+runtime slots) and `credentials` (everything else, owner+runtime+optional password slot) envelopes, LUKS/age-style.
- **X25519 encryption keys separate from Ed25519 signing keys** — owner derives at SLIP-0010 `m/44'/0'/1'`; runtime mints a fresh X25519 pair per install.
- **Key-slot wrap construction** — ephemeral X25519 ECDH → HKDF-SHA256 (`adf-envelope-v1:<envelope>`) → AES-256-GCM over a random 32-byte DEK.
- **Password-slot wrap construction** — scrypt (`N=2^17,r=8,p=1`) → AES-256-GCM over the DEK; new slots must use scrypt, never legacy PBKDF2.
- **Unlock cascade** — runtime slot → owner slot (re-wraps a runtime slot on success) → password prompt on demand; DEKs live in memory only, never persisted.
- **Four envelope states** — `unlocked`, `locked`, `foreign`, `absent`, independently tracked per envelope.
- **Legacy whole-file password format** — PBKDF2 100k/SHA-512 AES-256-GCM, still readable and mapped onto password-only-slot envelope semantics; converted to slots on first unlock.
- **Claim flow for foreign/identity-less files** — mints a fresh DID, records old DID in history, issues an owner-signed `clone` attestation, drops cryptographically dead envelopes, always user-confirmed.
- **Share-with-password flow** — adds a password slot to the credentials envelope only; recipient unlock re-wraps to their own keys and PRESERVES the password slot (corrected: only the explicit remove/change control drops it, so the file stays re-shareable).
- **Duplicate-DID detection** — same-owner copies presenting an identical `adf_did` are flagged with a one-click re-key resolution.
- **Message security levels 0–3** — open/unsigned, signed (payload+message signature), signed+encrypted end-to-end via DID-derived X25519, or custom middleware policy.
- **DID-derived message encryption (level 2)** — recipient's X25519 key is birationally derived from its Ed25519 DID key, so encryption needs only the recipient DID, no handshake.
- **Ingress trust re-stamping** — `message_verified`/`payload_verified`/`identity_verified` are stripped from wire input and re-stamped only by what the receiving transport itself verified.
- **Attestation model** — signed certificates (`owner`, `operator`, `clone`, `rotation`, peer roles) in `adf_attestations`, current-state vs. append-only-fact lifecycle classes.
- **Peer-negotiated trust primitives** — `attestation_list`/`attestation_add`/`attestation_issue` code methods let agents exchange verifiable certs without protocol machinery; issuing reserved roles is always rejected.
- **`restricted_methods` default** — `attestation_issue` requires authorized code by default since signing certs about others is a deliberate trust act.
- **Authorized-code file trust model** — `authorized=1` files may call restricted tools/methods without HIL; any write deauthorizes; unauthorized code cannot invoke authorized targets.
- **Guard-system vs. agent-writable security fields** — `allow_unsigned`, middleware chains, and `allow_local_fetch` are owner-only (one-time-overridable HIL, not agent `sys_update_config` writes); `security.level` and signature-requirement flags are agent-writable HIL-gated.
- **SSRF-hardened `sys_fetch`** — blocks loopback-daemon-control, link-local, and (unless `allow_local_fetch`) LAN/CGNAT addresses, checked across DNS resolution and every redirect hop.
- **Headless-daemon credential envelopes** — a daemon gets its own X25519 keypair on a file (`runtime-enc-key`), trusted per-agent via a Studio-side `trustedDaemonEncKeys` allowlist and revocable per agent.
- **Card signature scope exclusion** — the agent card's signature covers identity/policy fields but explicitly excludes `endpoints`/`resolution.endpoint`, which are observer-dependent.
- **`identity_status` fail-closed preflight** — code can check envelope lock state (`unlocked`/`locked`/`foreign`/`absent`) without ever exposing key material.

### Sealed Epochs (deferred design)

- **Merkle state-root commitments** — per-domain (config/loop/files/tables/meta) canonical hashing composed into an agent logical-state root, deliberately not a raw file-byte hash.
- **Signed epoch-chain seals** — `prev_epoch_hash`-linked, Ed25519-signed blocks binding `state_root_before`/`after` to an events Merkle root, closing the "log looks fine but omits an action" gap.
- **Four-rung claim ladder** — L1 signed checkpoints (implemented, parked) → L2 sealed epochs (completeness+binding) → L3 external witness anchoring (no post-hoc rewrite) → L4 TEE attestation (proof of real execution).
- **Redaction-preserving disclosure** — sensitive event content can stay an undisclosed Merkle leaf while its existence is still provably committed.

### Code Execution and Lambdas

- **Seven execution contexts** — `sys_code`, `sys_lambda`, trigger lambda, timer lambda, API route, middleware, WebSocket lambda, each with distinct persistence/authorization/input shape.
- **Uniform async `adf` proxy** — single-object-argument RPC surface from every sandbox context to the main-thread tool executor.
- **`_async` background execution** — any tool call can run as a background `adf_tasks` row via `_async: true`, including `pending_approval` for restricted tools.
- **`_full` code-only truncation bypass** — strips output limits (e.g. `db_query`'s 500-row cap) only for code-execution callers, never the LLM.
- **Code-only special methods** — `model_invoke`, `task_resolve`, `loop_inject`, `identity_status`, `get_identity`/`set_identity`, attestation methods, `authorize_file`, `set_meta_protection`, `set_file_protection`.
- **`loop_inject` boundary safety** — queues code-authored user context that lands only after a complete tool-call/result exchange, never splitting one; rejects system/assistant/tool shapes to prevent history forgery.
- **Authorized-code protection bypass** — from authorized code, `sys_set_meta`/`fs_write`/`fs_delete` can overwrite `readonly`/`read_only`/`no_delete` rows and files, same privilege as the Studio UI.
- **`loop_compact`/`loop_clear` code exclusion** — refused from code (`EXCLUDED_TOOL`) because the reset only completes correctly as a top-level tool call the executor post-processes.

### Messaging, Peers, and ALF

- **ALF envelope projection** — inbound/outbound wire messages flatten into `adf_inbox`/`adf_outbox` rows plus a raw `original_message` tombstone.
- **Outbox status model** — `pending → delivered|failed` only; `sent` is a defined-but-unused enum value; delivery is best-effort with no store-and-forward retry.
- **Three attachment transfer modes** — `inline` (base64 in payload), `reference` (URL+digest+size), `imported` (post-extraction storage marker).
- **Typed interactive forms** — `content_type: application/vnd.adf.form+json` questionnaires render natively on supporting adapters (Telegram) or fall back to plain text, answers threaded via `parent_id`.
- **Channel adapter normalization** — external platforms (Telegram, email, Discord, Slack, WhatsApp) map into inbox/outbox rows with `source`/`source_context`/`meta.group` (capped 20-participant roster).
- **Per-adapter identity-only credentials** — adapter secrets resolve by fixed `adapter:{type}:{KEY}` purpose in `adf_identity`, no app-wide credential fallback.
- **Reserved protocol mailboxes** — `/agents/{handle}/{inbox,card,health}` are runtime-served and cannot be claimed by `serving.api` routes.

### Serving, WebSockets, and Middleware

- **Layered route resolution** — `serving.api` → `serving.public` → `serving.shared` → 404.
- **Four middleware pipeline points** — `route`, `inbox`, `outbox`, `fetch`, array-ordered with hard-stop rejection and authorized-file-only execution by default.
- **Outbound `ws_connections`** vs. **inbound WS routes** (`method: "WS"` API entries) as two independent WebSocket surfaces.
- **Stream-bind endpoint kinds** — `ws`, `process` (host/container-shared/container-isolated), `tcp` (allowlist-gated), `umbilical` (read-only event tap, cannot appear as the `b` side).

### Memory, Audit, Tasks, and Logs

- **Named cognition streams (`adf_loop.loop`)** — `main` plus arbitrary side-loop streams sharing a globally unique `seq` but independently ordered/queried.
- **Seq-stable citations** — `adf_loop.seq` is never reused or renumbered, so `[S<seq>]` citations stay valid across compaction and archived blobs.
- **Compaction as signal-only** — `loop_compact` triggers a dedicated-prompt summary, optional pre-delete audit, deletion of old rows, and a `[Loop Compacted]` entry with an `ord` override so it sorts before the preserved tail.
- **Per-message audit snapshots** — `inbox_message`/`outbox_message` capture full ALF content at arrival/send time (not batch-level), addressed by ALF message id.
- **Brotli-compressed audit blobs** — `adf_audit` stores compressed JSON snapshots of deleted loop/file/message rows before destructive operations, append-only from the agent's perspective.
- **HIL task lifecycle** — `adf_tasks` statuses (`pending`→`pending_approval`/`running`→`completed`/`failed`/`denied`/`cancelled`) with `requires_authorization` a one-way ratchet and `approval_meta` carrying a plain-English reason.
- **Executor-managed HIL tasks** — `executor_managed` tasks are synchronously awaited by the executor; `task_resolve` signals approval without re-executing the tool.
- **Structured log levels/origins** — `adf_logs` with `debug|info|warn|error`, filterable by `config.logging.rules`, capped at `max_rows`.

### Versioning, Migration, and Portability

- **Decoupled version axes** — `adf_version` (format/contract, currently `0.2`) vs. `adf_schema_version` (storage layout, currently `30`), independently incrementable.
- **Notable schema-version milestones** — v17 file authorization, v20 `restricted` consolidation, v22 `document.md`→`README.md` rename, v24 attestations table, v28 seq-stable audit/`ord`, v29 named loops, v30 `bare_prompt` scope narrowing.
- **Sequential, non-downgrading migrations** — runtimes must apply migrations in order and fail closed rather than corrupt a newer-schema file.
- **Template-based child creation** — `sys_create_adf` with a `template` path reads a temp-copied `.adf`'s config/files/local tables/vector indexes and non-signing identity rows, always minting a fresh child identity.
- **Template locked-field enforcement** — `mergeTemplateWithOverrides` checks section- and array-level locks (tools/triggers/serving merges) before allowing any override to land.
- **Clone-fixup lineage correction** — post-copy pass rewrites `adf_parent_did`, purges inherited attestations about the source's subject, and either re-provisions or keeps identity depending on envelope ownership.
- **Portability guarantees** — config, document/mind, files, loop history, inbox/outbox, timers, tasks, logs, audit, identity rows, and local/vector tables all travel with the file.
- **Non-portable elements** — installed MCP packages, app-level provider keys/settings, container images, active WS connections, and in-memory unlock keys/executor state stay behind.

# 2. Agent Execution Loop, Triggers, Timers, Memory & HIL

### Trigger Types
- **on_startup** — Fires once when the agent finishes loading; no filters available.
- **on_inbox** — Fires when a message arrives in the inbox; filterable by `source`/`sender`, agent scope gets a summary not raw messages.
- **on_outbox** — Fires when a message is sent from the outbox; filterable by `to` recipient DID.
- **on_file_change** — Fires when a watched file is modified; `watch` glob filter, unified-diff payload, self-writes suppressed by default.
- **on_chat** — Fires when a human sends a chat message in the Loop panel; no filters.
- **on_timer** — Fires when a scheduled timer fires; dual-checked against the timer's own `scope` array.
- **on_tool_call** — Observational, post-execution hook after a matching tool call (or HIL denial); does not block execution.
- **on_task_create** — Fires when a task (HIL approval or async dispatch) is created; used for external approval routing.
- **on_task_complete** — Fires when a matching async task reaches a terminal status; filterable by `tools`/`status`.
- **on_logs** — Fires when a matching row is written to `adf_logs`; filterable by `level`/`origin`/`event`; anti-recursion on its own log rows.
- **on_llm_call** — Fires on every LLM request; filterable by `provider` and `source` (call origin).

### Trigger Execution Scopes & Routing
- **System scope** — Runs a lambda/shell command, fast and cheap, fires in every state except `off`, not gated by agent state.
- **Agent scope** — Wakes the LLM loop, expensive, gated by the agent's current display state.
- **Target loop routing** — An agent-scope target can name which inner loop it wakes via `target.loop` (default `main`); system-scope targets always strip the stamp.
- **Firing order** — When both scopes fire for one event, the earlier-expiring timing modifier goes first; ties go to system scope.
- **Direct trigger injection** — `POST /agents/:id/trigger` dispatches an event straight into the loop, bypassing enabled/filter/scope/state gating entirely.
- **Trigger deduplication** — Pending `on_file_change` and `on_inbox` events for the same path/summary are collapsed in the evaluator queue.
- **Hibernate nudge** — A synthetic `on_timer` event (`timer.id=-1`) wakes a hibernating agent after `limits.hibernate_nudge.interval_ms` (default 24h) with no other activity.
- **Self-generated file suppression** — Writes made by an agent turn or its own lambda don't fire `on_file_change` unless `filter.include_self: true` is set.
- **System dispatch concurrency lanes** — Per trigger-type + executable lane caps concurrent dispatches (1 for high-frequency triggers, 4 for work-shaped ones), 64-deep queue, drop-and-log beyond that.
- **High-frequency dispatch ceiling** — `on_llm_call`/`on_tool_call`/`on_logs`/`on_file_change` get a hard 30s hang-detector timeout regardless of `limits.execution_timeout_ms`.
- **Work-shaped dispatch budget** — `on_timer`/`on_startup`/`on_inbox`/`on_task_create`/`on_task_complete`/`on_outbox`/`on_chat` run under `limits.execution_timeout_ms` with 4-way concurrency.
- **Shell target timeout exemption** — Shell-driven targets (`command` or `.sh` lambda) are exempt from the dispatch timeout but still lane-limited.
- **Dispatch drop compensation** — A dropped dispatch can register an "undo" (e.g. un-expiring a consumed one-shot timer) run only on that drop.
- **Cold vs warm lambda execution** — Lambdas run in a fresh sandbox worker per call by default; `warm: true` keeps the worker alive between invocations.
- **Lambda event envelope** — Typed `AdfEvent` with `id`/`type`/`source`/`time`/`data`, source tagged `agent:<turn-id>`, `lambda:<path>:<fn>`, `system:*`, or `adapter:<name>`.
- **Shell target env vars** — Shell-driven triggers receive event context as environment variables (`$EVENT_TYPE`, `$MSG_ID`, `$TIMER_ID`, ...) instead of an object.
- **State gating table** — Active/Idle fire both scopes; Hibernate allows only `on_timer` agent-scope; Suspended/Error/Off block agent scope (Off blocks system scope too).

### Timers
- **One-time absolute schedule** — `schedule.type:"once"` fires once at an absolute `at` timestamp.
- **One-time relative schedule** — `schedule.type:"delay"` fires once after `delay_ms`, resolved to an absolute timestamp at creation.
- **Interval schedule** — `schedule.type:"interval"` fires repeatedly at `every_ms`, with optional `start_at`/`end_at`/`max_runs`.
- **Cron schedule** — `schedule.type:"cron"` fires on a standard 5-field cron expression, with optional `end_at`/`max_runs`.
- **Timer scope array** — Each timer's `scope` (`["system"]`/`["agent"]`/both) must dual-check against the `on_timer` trigger's enabled targets to actually fire.
- **Timer lambda/warm ownership** — `lambda` and `warm` are stored on the timer itself, not inherited from trigger targets.
- **Timer loop stamp** — Agent-scope timers can name a target inner loop via `loop`; system-scope timers always drop the stamp (run under main's authority).
- **Locked timers** — `locked: true` timers cannot be deleted or modified by any agent path, human-only override, and survive a deleted inner loop.
- **5-second timer poll tick** — All timers are evaluated on a 5s tick; schedules shorter than 5s are meaningless and fires can land up to 5s late.
- **Settle-before-fire ordering** — Due timer rows are flagged expired/advanced before their payload fires, so a crash mid-fire cannot double-fire on the next tick.
- **Expired timers retained as history** — One-time/exhausted timers are flagged `expired=1`, never deleted; `sys_list_timers({include_expired:true})` lists them.
- **Missed-timer catch-up** — Past-due timers fire exactly once on reload regardless of type (once/interval/cron), never backfilled for missed occurrences.
- **System timer with no lambda** — A system-scope timer with no `lambda` is a silent no-op trap that still burns `run_count`/`next_wake_at` on every fire.
- **Timer management tools** — `sys_set_timer`/`sys_list_timers`/`sys_delete_timer`, all disabled by default and HIL-gated to enable via `sys_update_config`.
- **Timer schedule storage shape** — Persisted `schedule_json` uses discriminator key `mode` (not `type`) and `cron` (not `expr`); `delay` is never stored, only its resolved `once`.
- **Timer creation UI** — The Agent > Timers tab's Add Timer modal covers schedule mode, scope toggle, lambda entry point, warm flag, and payload without tool calls.
- **Warm timer shared sandbox** — All warm timer/trigger lambdas for one agent share the sandbox id `{agentId}:lambda`.

### Tasks & Human-in-the-Loop (HIL)
- **Restricted-tool HIL task** — A tool with `enabled:true, restricted:true` called from the LLM loop creates a blocking `pending_approval` task with `requires_authorization:true`.
- **Async HIL dispatch** — `_async:true` on a restricted tool call creates the approval task but lets the agent's turn continue without waiting.
- **Async tool execution** — Any tool call with `_async:true` runs in the background as a `running`-status task, updating to `completed`/`failed` on finish.
- **Task status machine** — `pending`/`pending_approval`/`running`/`completed`/`failed`/`denied`/`cancelled`, terminal statuses record `completed_at`.
- **Task resolution paths** — UI approval dialog / daemon `POST /agents/:id/tasks/:taskId/resolve`, `on_task_create` lambda dispatch, or `task_resolve` from authorized code.
- **Blocking-denial no-fire rule** — A denied synchronous HIL task deliberately does not fire `on_task_complete` since the agent already gets the rejection in-band.
- **Async-denial fire rule** — A denied async (`_async:true`) HIL task does fire `on_task_complete`, since the agent has no inline context otherwise.
- **Orphaned task reconciliation** — On load, `running` tasks sweep to `failed` (outcome unknown), executor-managed `pending_approval` sweep to `cancelled`; non-executor-managed rows stay open.
- **Task-level authorization flag** — `requires_authorization` (settable once via `task_resolve`) restricts who may approve/deny a task to authorized code or the owner-authorized UI.
- **Restricted-tool code-context matrix** — Blocked from `sys_code`/unauthorized `sys_lambda`; HIL-gated from an authorized `sys_lambda` target; freely allowed from authorized files, triggers, and timers.
- **visible:false tool hiding** — Keeps an enabled tool callable from code/lambdas while removing it from the LLM's tool schema, independent of `restricted`.
- **Approval Hub global registry** — Central map of every pending HIL approval/ask across all agents and loops, surfaced as a title-bar bell badge, decoupled from executor-only state.
- **Approval Hub secret-safe previews** — Redacts secret-named keys and value-redacts command/content/url/body/query/headers before a request preview can reach an OS toast.
- **Approval Hub resolution history** — Session-scoped, capped history (`HISTORY_MAX=50`) of how each resolved request ended (approved/denied/expired), newest first.
- **Native OS toast notifications** — Fires an OS-level toast only when no app window is focused, coalescing bursts past a 3-in-2s threshold into a summary.
- **Suspension approval flow** — Hitting `limits.max_active_turns` sets state `suspended` and blocks on an owner approval dialog with `limits.suspend_timeout_ms` (default 20min) before auto-`off`.
- **Task-side-effect propagation** — Approving a task via `task_resolve` runs the tool preserving `endTurn` handling, file diffs, and state transitions in the executor's own context.

### Loop (Conversation History) & Compaction
- **adf_loop conversation stream** — Every message/tool call/response is a row (`seq`, `role`, `content_json`) sent verbatim to the LLM as context.
- **LLM-powered compaction** — `loop_compact()` is signal-only; the runtime runs a dedicated LLM call to produce a structured briefing (state, decisions, files, pending work).
- **Automatic compaction threshold** — `context.compact_threshold` (default 100,000 tokens) triggers a system nudge instructing the agent to call `loop_compact`.
- **Memory-flush grace turn** — Before auto-compaction fires, a one-time nudge lets the agent write durable learnings to mind pages before context is cleared.
- **Manual compaction** — Agents can proactively call `loop_compact()` at any time, optionally with an `instructions` string to steer the summary.
- **Compaction footer** — A fixed footer is appended after the LLM-generated summary reminding the agent the briefing is what survived and to continue.
- **loop_clear slicing** — Python-style slice deletion of loop entries (`end`, `start`, `start+end` combinations), audited before deletion if enabled.
- **loop_inject (code-only)** — Injects an auditable `[Context: …]` user-role entry from sandbox code, queued for the next model boundary, never mid tool-call/tool-result.
- **Context blocks (No Secrets)** — System prompt and per-turn dynamic instructions are recorded as regular, auditable, collapsible `adf_loop` entries deduplicated by content hash.
- **Compaction abort guard** — `loopRevision` (per-loop counter) detects a concurrent whole-table mutation racing an in-flight compaction and aborts the commit.
- **Narration-loop circuit breaker** — An autonomous agent answering 4 consecutive continuation nudges with text only is forced to `idle`; a user interrupt resets the counter.
- **max_active_turns limit** — Caps consecutive LLM turns before the agent is suspended pending owner approval.
- **Turn-tool state machine** — `respond` ends turn in interactive mode / logs-and-continues in autonomous; `say` never ends the turn; `ask` blocks for human input (interactive only).
- **Context baseline seeding** — Token estimate for the compaction threshold check reads the persisted post-compaction/clear baseline, not the newest loop row's usage.
- **Context breakdown measurement** — Per-file, per-tool-schema, and per-source token accounting (`assembleContextBreakdown`) computed only when the underlying cache rebuilds, never per turn.

### Audit System
- **Loop audit** — Compacted/cleared `adf_loop` entries are brotli-compressed and stored in `adf_audit` (`source='loop'`/`loop:<name>`) before deletion; on by default.
- **Per-message inbox/outbox audit** — Captures the full ALF message including inline attachment bytes at ingestion/send time, independent of later deletion; off by default.
- **File deletion audit** — `fs_delete` snapshots content (base64), path, mime, and size before hard delete when `audit.files` is enabled.
- **Audit sources table** — `loop`, `inbox_message`, `outbox_message`, `file` each carry distinct key columns (`start_seq`/`end_seq`, `ref`, `entry_count`, `size_bytes`).
- **audit_read retrieval recipe** — Sandbox lambda that checks live `adf_loop` first, then scans candidate brotli blobs in `adf_audit` by seq range for the exact entry.
- **Audit gap honesty** — A seq with audit disabled during its compaction, or a message that arrived before audit was on, resolves to an honest `missing`.
- **Per-loop audit convention** — Archived streams use `source='loop:<name>'`; legacy bare `loop` implies `main`.

### Agent Memory (mind.md wiki)
- **mind.md index** — Always-loaded `## Always` facts, `## Pages` catalog, and `## Rules`, injected as a session-start snapshot into the system prompt.
- **mind/<slug>.md pages** — One page per durable topic with required `type` frontmatter plus optional `description`/`status`/`stale_after`/`sources`, loaded on demand via `fs_read`.
- **mind/log.md change log** — Append-only, newest-first history entries tagged `ingest`/`update`/`lint`, never rewritten or deleted.
- **Whole-page source citations** — `sources: [adf-audit://seq/N, adf-file://imported/..., URL]` plus inline `[S<seq>]` markers resolvable back to ground truth.
- **Seven memory rules** — Keep the index small, check before acting, write in one pass, supersede in place, cite sources, audit is ground truth, lint periodically.
- **Mind injection modes** — Agentic (read on demand via `fs_read`) vs Included (always in system prompt), mirroring document context modes.
- **Mid-session mind staleness** — Injected mind.md is a session-start snapshot; mid-session `fs_write`s to it require `fs_read` to see, refreshed only after compaction/clear.
- **Periodic memory lint** — Checks contradictions, past-`stale_after` pages, orphan pages missing from the catalog, and index drift, logged as one `lint` entry.
- **Clear mind action** — The Agent config panel can reset `mind.md` to empty independent of clearing loop/inbox/files.

### Self-Observation (skill)
- **Behavioral metrics from adf_loop/adf_audit** — Null-turn streaks, repeated tool-call signatures, spend without external change, and turn-mix, computed by a hot-path lambda.
- **Metrics-are-observations rule** — Statistics must never become a self-graded target; the skill forbids growing dashboards beyond the anomaly digest.
- **Anomaly digest contract** — `metrics/anomalies.md` is written only when a threshold trips; the agent reads it, changes exactly one thing, then deletes it.
- **Incremental watermark analysis** — The analyzer re-scans only new rows since its last run rather than the full history each time.

### Soul Creation (skill)
- **soul.md voice file** — Injected into the system prompt every session; concrete rules, taboos, exemplars, and origin biography, not trait adjectives.
- **Random/principal-preference/pick-by-fit paths** — Three deliberate ways to choose a new voice, including a `sys_code`-driven random pick from a 10-entry example library.

### Inner Loops
- **Named cognition streams** — An agent runs one `main` loop plus up to 16 declared inner loops, all sharing one `.adf` file, identity, memory, and files.
- **Attenuate-don't-prohibit security model** — A loop's effective tools/`code_execution`/triggers are always a strict subset of the host's, enforced at `deriveLoopConfig` derive time.
- **loop_manage tool** — Main-only, enabled and ungated by default; `create`/`get`/`update`/`delete` actions, honors `locked_fields` on the `loops` config path.
- **loop_send tool** — Peer-to-peer inter-loop message with `wake` controlling delivery timing; content stamped `[from loop:<sender>]` (audit-only, not a security boundary).
- **loop_list tool** — Read-only roster (name, goal, enabled, running) for `loop_send` target discovery, works even on a loop-less agent (returns just `main`).
- **loop_compact/loop_clear default-on grant** — The only two tools every loop gets without naming them in its allow-list, unless the host explicitly disabled/restricted them.
- **Wake delivery semantics** — Idle+wake runs immediately; busy+wake injects at the next model boundary with one exactly-once "kick" turn if the turn ends first; no-wake just waits.
- **Autostart loop kickoff** — `autostart:true` loops get an auditory `LOOP_AUTOSTART_MESSAGE` kickoff from main at create time and every subsequent agent start.
- **Autonomous inner loop flag** — Per-loop, not inherited from the host; keeps turning after text-only responses until `sys_set_state` or the 4-reply narration breaker fires.
- **Per-loop model override** — Same-provider-only override; requires code execution enabled on the host; falls back to the host model with a logged warning if unavailable.
- **Per-loop compact_threshold** — Optional override of the auto-compaction token threshold, absent inherits the host's, useful alongside a differently-windowed model override.
- **Side-loop code_execution attenuation** — `model_invoke`/`sys_lambda`/`identity_status`/`loop_inject`/`emit_event` allowed only where the agent itself allows them; `get_identity`/`set_identity`/`task_resolve`/`attestation_*`/`network` denied, no inherited sandbox packages.
- **No side-loop system lambdas** — Inner loops cannot create system-scope lambda timers or `locked` timers; those must be requested from `main` via `loop_send`.
- **loop_manage delete archival** — Stops the loop (aborting any in-flight turn), archives its stream to `adf_audit` under `loop:<name>`, then removes config + runtime.
- **Locked-timer survival on loop delete** — A `locked:true` timer stamped to a deleted loop is preserved and logged rather than deleted.
- **Every-teardown-archives rule** — A loop removed by config edit (not just `loop_manage delete`) still crosses the same stop-then-archive path and writes `adf_audit` regardless of `audit.loop`.
- **Config-change immediacy** — A revoked tool grant bites at the loop's next model call inside a running turn, not just at the next turn boundary.
- **Concurrent-by-default loop execution** — Each inner loop keeps its own self-queue and runs concurrently with main and siblings; serialization (`max_concurrent`) is a deferred extra.
- **LoopScopedWorkspace (forLoop)** — An in-class `AdfWorkspace.forLoop(name)` factory auto-filters/stamps `appendToLoop`/`insertLog`/`insertAudit`/`setTimer` to one loop's stream without touching call sites.
- **DEFAULT_NEW_LOOP_TOOLS seed** — New loops default to `[loop_send, loop_list]` when `tools` is omitted at create, so they can talk back to main.
- **Loop preamble injection** — Every side loop's `instructions` is prefixed with a ~170-word standing preamble naming who it is, what it shares, and how to reach main.
- **Main's Inner Loops prompt section** — Main's own system prompt gains a roster (or an invitation to create loops) whenever it has loops or `loop_manage` is enabled.
- **Per-loop AdfCallHandler** — Each loop runs its own attenuated call handler built from the derived config, never sharing main's unattenuated handler.
- **Loop UI tab strip** — Chat panel grows a per-loop tab strip with identity colors, muted/yellow/error status dots, and held mid-stream inter-loop delivery cards.
- **Loop token counters** — The status-bar context gauge reflects whichever loop's stream is currently being viewed, with its own auto-compact threshold.

### Spawning & Child Agents
- **sys_create_adf tool** — Creates a new `.adf` file, disabled and restricted (HIL-gated) by default, with parameter parity to `AgentConfig`.
- **Template-based child creation** — Copies a template's config, plaintext credentials, and files (with protection levels) to the child while generating fresh identity keys.
- **Locked-field enforcement on templates** — A create call that targets a template's `locked_fields` or `locked:true` items fails outright rather than stripping the lock.
- **Parent-to-child file injection** — `files: [{parent_path, child_path}]` copies parent workspace files into the new child, refusing to overwrite `read_only` targets.
- **Parent lineage tracking** — The parent's DID (or nanoid) is always recorded in the child's `adf_meta.adf_parent_did`, template or not.
- **Child autostart-on-create** — `autostart:true` on `sys_create_adf` starts the child as a background agent immediately, before the parent's turn ends.
- **Spawned-child trust** — A child created via `sys_create_adf` is trusted by construction (HIL gates the tool call, not the child); review/accept applies only to foreign ADFs.
- ~~Parent-controlled remote shutdown~~ — CORRECTED: unverified. `sys_set_state` is self-only; no code grants a parent DID shutdown authority over a child.
- ~~Sovereignty / resource starvation~~ — CORRECTED: children do not share a live key reference. The default spawn template copies no credentials; an explicit template copies them as independent values.

### Agent States & Lifecycle
- **Five primary states** — Active, Idle, Hibernate, Suspended, Error, Off, each with a distinct trigger-responsiveness profile.
- **Idle-to-active wake-and-return** — A trigger wakes the agent to active, runs the LLM loop, then returns it to its recorded previous idle state.
- **Hard-off teardown guarantee** — Transitioning to `off` unregisters from the mesh, disconnects MCP, stops adapters/WS connections, destroys the sandbox; never deferred to end-of-turn.
- **Structural vs operational error classification** — Provider 429/5xx/timeouts are operational (return to idle); corrupt session/tool-registry faults are structural (`error` state, agent-scope wakes held).
- **Error-state system-scope survival** — Only agent-scope triggers are held back in `error`; system-scope lambdas/timers/logs keep firing.
- **Crash-recovery notice** — A one-time system notice on reload after an interrupted turn carries absolute start/last-progress/now timestamps and elapsed offline duration.
- **Hibernate backlog drop** — Entering hibernate or off discards the queued agent-scope trigger backlog and emits a `trigger.dropped` event rather than replaying stale wakes.
- **adf_shell state shorthand** — `state [idle|hibernate|off]` as a chainable shell command (`meta set status "..." && state idle`), no tool call needed to read it.
- **Daemon live-state endpoint** — `POST /agents/:id/state` is the supported way to move a running agent's display state; editing config's `state` field does not.
- **User interrupt restart** — Sending a message while an agent is active aborts the current turn, fills pending tool calls with placeholders, and restarts with the new input.

### Background Agents & Runtime
- **BackgroundAgentManager registry** — Keyed by canonical (realpath) `.adf` path; claims in-flight starts synchronously so concurrent entry points share one build.
- **Foreground/background handoff** — `extractBackgroundAgent`/`transitionToBackground` moves a running agent between Studio's singleton foreground path and the background map without losing state.
- **AssembledAgent lifecycle host** — Carries the per-loop pool, workspace, executor, trigger evaluator, and shared subsystems (MCP, adapters, taps) across foreground/background transfer.
- **Idle-sweep memory pressure relief** — Agents idle past `IDLE_MEMORY_THRESHOLD_MS` (5 min) are candidates for release, gated per loop on turn/write/injection activity.
- **Autostart boot scan** — The runtime scans tracked directories at boot and starts every `autostart:true` agent, capped at 5 concurrent starts; password-protected agents are skipped.
- **HIL-gated background MCP OAuth sign-in** — A background agent's own HTTP-OAuth MCP connect blocks on the agent's HIL path (not a native dialog) when no token is stored.
- **SystemScopeHandler lambda routing** — Executes system-scope trigger/timer lambdas or shell commands, logging every execution to `adf_logs` with origin/event/target columns.
- **RuntimeGate teardown latch** — Distinguishes a transient `stopAllInProgress` drain from a process-lifetime teardown so a start finishing mid-stop still disposes correctly.

### Middleware Pipelines
- **Four middleware integration points** — Route (pre-handler), inbox (post-verification), outbox (pre-signing), and fetch (pre-`sys_fetch`), each with its own data shape.
- **Pass-through / transform / reject contract** — Every middleware returns `{}`, `{data}`, or `{reject:{code,reason}}`; a reject short-circuits the whole chain.
- **Sequential chain execution** — Middleware functions run in declared array order, each seeing the (possibly transformed) output of the previous one.
- **Owner-only middleware config** — `security.middleware.*` and `security.fetch_middleware` are hard-denied to `sys_update_config`; only the owner edits them in the UI.
- **Route middleware is agent-writable** — Unlike inbox/outbox/fetch lists, `serving.api[].middleware` can be changed via `sys_update_config`, HIL-gated.
- **Middleware authorization requirement** — By default only authorized-file lambdas run as middleware; an unauthorized middleware ref is silently skipped with a warning log.
- **Lambda ref validation hardening** — Each `path:functionName` ref is regex-validated before use; a malformed ref is skipped, never interpolated unquoted into generated wrapper source.
- **Per-pipeline-point sandbox isolation** — Each middleware pipeline point runs in its own sandbox id (`{agentId}:mw:{point}`), separate from API route sandboxes.
- **Generic Pipeline<T,C> class** — A reusable sequential middleware runner underlying messaging (ALF), route, and fetch pipelines, short-circuiting on the first rejection.

### Loop Config & Knobs
- **LoopConfig fields** — `name`, `goal` (≤4000 chars), `enabled`, `autostart`, `autonomous`, `tools` (absolute allow-list, ≤64 names), `model`, `compact_threshold`.
- **MAX_SIDE_LOOPS=16** — A structural brake on inner-loop count, since loop concurrency is otherwise unbounded.
- **Absolute tool allow-list intersection** — `effective(loop) = (loop.tools ∩ host-enabled)`, no union beyond default-on `loop_compact`/`loop_clear`, re-intersected on every derive.
- **Prohibited-for-loop tool set** — `sys_update_config`, `loop_manage`, `sys_create_adf`, and every host-`restricted` tool can never be granted to an inner loop.
- **validateLoopToolList classification** — Splits a requested tool list into `ok`/`unknown` (typo, rejected)/`disabled` (host-off, kept ungranted)/`prohibited` (security refusal).
- **Fleet bulk config (design)** — Selecting N agents on the map applies a tri-state leave/set patch across tool enable/restrict, model, context limit, triggers, security level, start state.
- **Fleet bulk apply semantics** — Sequential per-file open/patch-via-sys_update_config-merge/persist/reload, with a per-agent ok/error result row, never an all-or-nothing batch.

### Context & Prompt Assembly
- **assemblePrompt sections** — Base prompt, tool best-practices (suppressed when shell enabled), code execution, messaging, database, serving, skills, websocket, state management, browser — each conditionally pushed.
- **{{path}} file injection** — Single-pass, snapshot-cached placeholder resolution against `adf_files` only, wrapped in provenance `<injected_file path="...">` tags; missing files render a visible marker.
- **Injected-file snapshot stability** — The snapshot Map is filled once and reused for the session, refreshed only when the caller clears it (compaction / loop_clear).
- **Context breakdown tool grouping** — Tool schema token cost is grouped by source (`built-in` vs MCP server name via `instanceof McpTool`), not by name-prefix parsing.
- **Global system prompt toggle** — A per-agent `include_base_prompt` checkbox opts an agent out of the app-wide base system prompt entirely.

### Loop Mode & Turn Tools
- **Interactive loop mode** — `respond` ends the turn; `ask` pauses for human input; default mode for conversational agents.
- **Autonomous loop mode** — `respond` logs and continues; `ask` is unavailable; the runtime appends an autonomous-mode system-prompt addendum.
- **say tool** — Emits status-update text without ending the turn, available in both loop modes.
- **Raw-text-as-respond fallback** — Text emitted with no tool call is treated as an implicit `respond()`, following the same mode-dependent end-turn rules.

### Usage Tracking (no spend enforcement)
- **Per-call token logging** — Every assistant loop entry carries a `tokens` JSON column (input/output/cache_read/cache_write/reasoning/cost_usd) plus `model`, queryable via SQL.
- **sys_model_invoke usage logging** — Logged to `adf_logs` with `origin='model_invoke', event='llm_call'` and a full usage/cost data payload.
- **No built-in spend cap** — The runtime never enforces a token/cost budget; a lambda must aggregate usage on a timer and flip state itself if desired.

# 3. Built-in Tools, Code Execution & Sandboxing

### Turn Tools
- **say** — Emit text to the conversation without ending the turn; status/progress updates.
- **ask** — Pose a question and block until the human responds; interactive mode only.

### Filesystem Tools
- **fs_read** — Read a VFS file (`path`, `start_line?`, `end_line?`); full JSON record incl. mime/protection.
- **fs_write** — Unified write/edit/append tool with `mode`; batch atomic edits via `edits[]`; base64 binary writes.
- **fs_list** — List VFS files, optionally filtered by `prefix`.
- **fs_delete** — Delete a file; blocked by `read_only`/`no_delete` protection unless called from authorized code.
- **fs_transfer** — Move files between VFS and a compute environment (`vfs`, `isolated`, `shared`, `host`).

### Database Tools
- **db_query** — Read-only SELECT on `local_*`/`adf_loop`/`adf_inbox`/etc.; 500-row cap, `_full: true` bypass in code.
- **db_execute** — INSERT/UPDATE/DELETE/CREATE/DROP on `local_*` tables only, incl. `vec0` virtual tables.

### Messaging Tools
- **msg_send** — Send inter-agent message via direct address, `parent_id` reply, or bare local handle.
- **msg_read** — Fetch inbox messages filtered by status; auto-marks `unread` as `read`.
- **msg_list** — Lightweight inbox counts by status, no content fetch.
- **msg_update** — Update status (`read`/`archived`/`delete`) of one or more inbox messages.
- **msg_delete** — Bulk-delete inbox/outbox messages by filter (status, from, source, before, thread_id).
- **agent_discover** — Discover reachable agents (signed cards) by scope/visibility/handle/description.

### WebSocket Tools
- **ws_connect** — Start a WS connection, config-based or ad-hoc, optionally persisted to config.
- **ws_disconnect** — Close an active WS connection by ID.
- **ws_connections** — List active WS connections, optionally filtered by direction.
- **ws_send** — Send one text or binary frame; backpressure-aware (awaits drain on high water mark).

### Stream Binding Tools
- **stream_bind** — Bind two byte endpoints (`ws`/`tcp`/`process`/`umbilical`) so the runtime pumps data outside the LLM loop.
- **stream_unbind** — Terminate an active stream binding by ID.
- **stream_bindings** — List active/pending bindings with live byte counters.
- **TCP endpoint** — Raw socket binding gated by `stream_bind.allow_tcp_bind` and `tcp_allowlist`.
- **Process endpoint** — Spawned process stdio as a stream; `host`/`container_shared`/`container_isolated` isolation tiers.
- **Umbilical endpoint** — Agent's own event stream as a read-only source endpoint.

### Execution Tools
- **sys_code** — Execute sandboxed code with persistent per-agent worker state; no network, no private keys.
- **sys_lambda** — Call a function from a workspace script file (`file:function` syntax); HIL if target is authorized.

### Package Management Tools
- **npm_install** — Install a pure-JS/WASM npm package into the sandbox; 50MB/pkg, 200MB total, 50 pkgs/agent.
- **npm_uninstall** — Remove a package from the agent's available set (disk copy kept for other agents).

### MCP Management Tools
- **mcp_install** — Install/attach an MCP server (npm/pypi/custom/http); credentials go to identity keystore.
- **mcp_restart** — Reconnect a configured MCP server and refresh discovered tools.
- **mcp_uninstall** — Remove an MCP server config and its `mcp_<name>_*` tool declarations.

### HTTP Fetch Tool
- **sys_fetch** — HTTP(S) request tool; 25MB response cap; SSRF guard on DNS-resolved address and every redirect hop.
- **Egress escape hatch** — `security.allow_local_fetch: true` permits private/LAN destinations; locked, HIL-overridable.
- **Binary response handling** — Content-Type-based text vs `Buffer` body; direct `fs_write` of binary responses.

### Compute Tools
- **compute_exec** — Run a shell command in an authorized compute environment (`isolated`/`shared`/external/`host`); `restricted: true` by default.
- **fs_transfer (compute)** — Transfer files between VFS and `isolated`/`shared`/`host` compute workspaces.

### Timer Tools
- **sys_set_timer** — Create once/interval/cron timers with `scope`, optional `lambda`, `warm` sandbox persistence.
- **sys_list_timers** — List active timers with schedule, next-fire time, run counts.
- **sys_delete_timer** — Cancel and delete a timer by ID.

### Loop Management Tools
- **loop_compact** — LLM-powered summarization and pruning of conversation history; optional steering `instructions`.
- **loop_clear** — Python-slice-style deletion of loop entries, archived first if enabled.

### Inner Loop Tools
- **loop_send** — Send a message between this agent's cognition loops (`main` + inner loops); optional `wake`.
- **loop_list** — Read-only roster of this agent's cognition loops, enabled/running state.
- **loop_manage** — Main-only create/get/update/delete of inner loops; up to 16 per agent; ungated by default.

### Message Deletion Tools
- **msg_delete (detail)** — Requires ≥1 supported filter field; permanent, no audit snapshot at delete time.

### State and Config Tools
- **sys_set_state** — Transition agent to `idle`/`hibernate`/`off`; always ends the LLM loop.
- **sys_get_config** — Read agent config by section (`config`/`card`/`provider_status`/`tools`/`limits`), secrets redacted.
- **sys_update_config** — Dot-path config mutation with array append/remove/replace and name-based addressing; HIL on locked fields.
- **sys_create_adf** — Create a new `.adf` file/agent from template or explicit params; optional autostart; restricted by default.
- **sys_get_meta** — Read `adf_meta` key(s) or list all entries.
- **sys_set_meta** — Write/increment `adf_meta` key with protection level (`none`/`readonly`/`increment`).
- **sys_delete_meta** — Delete an `adf_meta` key; blocked if `readonly`/`increment` protected.

### Shell Tool
- **shell** — Bash-like virtual shell that absorbs most individual tools into one command surface when enabled.
- **Filesystem commands** — `cat`, `ls`, `rm`, `cp`, `mv`, `touch`, `find`, `du`, `chmod`, `head`, `tail`.
- **Text commands** — `grep`, `sed`, `sort`, `uniq`, `wc`, `cut`, `tr`, `tee`, `rev`, `tac`, `diff`, `xargs`.
- **Data commands** — `jq` (real jq 1.8.2 WASM), `sqlite3`.
- **Messaging/network/timer commands** — `msg`, `who`, `ping`, `curl`/`wget`, `at`, `crontab`.
- **Process/identity commands** — `ps`, `kill`, `wait`, `whoami`, `config`, `status`, `state`, `meta`, `env`, `export`, `pwd`, `date`.
- **Shell scripts** — `./script.sh` parses and runs whole files: heredocs, comments, shebangs, multi-line chains.
- **config tools** — Lists every tool (incl. hidden/absorbed/disabled) with schema lookup by name/substring.

### Code Execution Sandbox
- **Sandbox runtime** — Node.js Worker Threads + V8 VM Contexts; `codeGeneration: { strings: false, wasm: true }` (no eval/new Function, WASM allowed).
- **Execution contexts** — `sys_code` (persistent worker, unauthorized), `sys_lambda`/trigger/timer/API-route/middleware lambdas (fresh VM context unless `warm: true`).
- **Import/export transform** — Rewrites `import` to `await __require()` and strips `export` keywords pre-execution.
- **TS transpilation** — `ts-transpiler.ts`: Node `stripTypeScriptTypes` (mode `transform`) primary, sucrase fallback; SHA-256 content-hash cached.
- **Network isolation** — Native `fetch`/`Request`/`Response`/`Headers` deleted from worker scope; all egress via `adf.sys_fetch()` unless `code_execution.network: true`.
- **Allowed Node built-ins** — `crypto`, `buffer`, `url`, `querystring`, `path`, `util`, `string_decoder`, `punycode`, `assert`, `events`, `stream`, `zlib`, `os`.
- **Timeouts** — `limits.execution_timeout_ms` default 60s, hard ceiling 300s; worker gets +2s RPC drain buffer.
- **State persistence** — `sys_code` worker persists variables across calls per agent; lambdas/triggers/timers/routes reset unless `warm: true`.
- **Circular call detection** — Nested `sys_lambda` call-stack tracking throws `CIRCULAR_CALL` on A→B→A recursion.
- **_full parameter** — Code-execution-only bypass of output truncation (e.g. `db_query` 500-row cap).
- **_async parameter** — Runs any tool call in the background, returning a task reference immediately.

### Standard Library Packages (bundled, WASM/pure-JS)
- **xlsx 0.18.5** — Read/write Excel spreadsheets (.xlsx/.xls/.csv).
- **pdf-lib 1.17.1** — Create and modify PDF documents.
- **mupdf 0.3.0** — Parse and extract content from existing PDFs.
- **docx 9.0.2** — Generate Word documents.
- **jszip 3.10.1** — Create and extract ZIP archives.
- **sql.js 1.11.0** — In-memory SQLite database via WebAssembly.
- **cheerio 1.0.0** — jQuery-like HTML parsing/manipulation.
- **yaml 2.6.0** — Parse/stringify YAML.
- **date-fns 4.1.0** — Date/time manipulation and formatting.
- **jimp 1.6.0** — Image processing (resize, crop, rotate, filters).
- **Stdlib install** — Auto-installed to `~/.adf-studio/sandbox-stdlib/` on first launch, managed by `SandboxStdlibService`.

### Package Management System
- **Three-tier resolution** — Standard library → runtime packages (Settings > Packages, instance-wide) → agent packages (`npm_install`, per-agent).
- **Native addon rejection** — Packages with native addons (better-sqlite3, sharp) detected and blocked at install.
- **WASM auto-init** — Packages exporting `initWasm()` (e.g. `@resvg/resvg-wasm`) auto-initialized on import.
- **Shared install directory** — `~/.adf-studio/sandbox-packages/`; multiple agents sharing a package share one install.
- **SandboxPackagesService** — Flat shared `node_modules`, per-agent import allowlist via `code_execution.packages`, 50MB/200MB/50-pkg limits.
- **Make Runtime promotion** — Agents can promote their own installed package to instance-wide runtime scope.

### WASM Userland (Shell)
- **jq-wasm adapter** — Real jq 1.8.2 compiled to WASM; full jq language (def, foreach, label/break, @base64, NDJSON).
- **uutils coreutils WASM** — `sort`, `uniq`, `wc`, `cut`, `tr` run as real GNU coreutils (wasm32-wasip1) in an in-memory WASI sandbox.
- **WASI applet execution model** — Runs in a short-lived worker thread (not main/Electron loop); timeout terminates worker for a real kill.
- **In-memory WASI filesystem** — `@bjorn3/browser_wasi_shim`; files pre-read from SQLite VFS, applet never touches host disk.
- **grep/sed** — Remain built-in JS implementations (ERE-only regex), not WASM.

### Authorized Code / Trust Boundary
- **File-level authorization flag** — `authorized` boolean on `adf_files`; gates restricted `adf.*` methods.
- **Write deauthorization** — Any `fs_write` to an authorized file unconditionally sets `authorized = false`.
- **Restricted methods** — `code_execution.restricted_methods` (default `['attestation_issue']`); authorized-code-only.
- **Gateway pattern** — `authorize_file` method lets already-authorized code authorize other files for remote-approval workflows.
- **Call-chain enforcement** — Unauthorized code calling `adf.sys_lambda()` on an authorized file throws `REQUIRES_AUTHORIZED_CALLER`.
- **Task-level authorization** — `task_resolve` honors `requires_authorization` flag on `adf_tasks`, set by HIL-escalating trigger lambdas.
- **Protection bypass methods** — Authorized code bypasses protection on `fs_write`, `fs_delete`, `sys_set_meta`, `sys_delete_meta`; plus `set_meta_protection`/`set_file_protection` are authorized-only.
- **_authorized internal flag** — `adf-call-handler` injects `_authorized: true` onto tool input for authorized calls; stripped from LLM-originated calls so it cannot be forged.
- **Middleware authorization gate** — `security.require_middleware_authorization` (default true, hard owner-only) skips unauthorized middleware silently.

### Restricted / Special adf Proxy Methods (code-execution-only)
- **model_invoke** — Invoke the LLM model directly from code, incl. multimodal content blocks.
- **task_resolve** — Approve/reject a pending HIL task programmatically.
- **loop_inject** — Inject content into the conversation loop from code.
- **identity_status** — Report credential envelope state only, never secret material.
- **get_identity / set_identity** — Read/write stored credentials; gateable via `restricted_methods`.
- **emit_event** — Emit a runtime event from code.
- **attestation_list / attestation_add / attestation_issue** — Manage signed DID attestations; `attestation_issue` restricted by default.

### Tool Access Control Model
- **enabled flag** — Sole gate on whether a tool call executes for any caller.
- **visible flag** — Controls only advertisement in the LLM tool schema, never execution.
- **restricted flag** — HIL approval for LLM-loop calls; free for authorized code; blocked for unauthorized code.
- **locked flag** — Prevents agent's own `sys_update_config` from modifying that tool's properties.
- **_reason parameter** — Runtime-injected ~10-word justification field surfaced to human approvers on HIL calls.
- **Duplicate tool declaration collapse** — First-wins for ordinary fields; `restricted`/`locked` sticky-true across duplicates.
- **Access matrix** — 6-state table (enabled × visible × restricted) defining Advertised/LLM-loop/Authorized/Unauthorized behavior.

### Compute Environments
- **Shared container (adf-mcp)** — Always-on container all agents use by default for MCP servers; workspace per agent, network-isolated from other containers.
- **Isolated container** — Per-agent dedicated container (`compute.enabled`); full agent isolation, persists stopped-not-removed across restarts.
- **External Docker/Podman container** — User-owned, already-running container registered in Settings; ADF never starts/stops/rebuilds it.
- **Host machine execution** — Direct OS execution requiring both agent `compute.host_access` and runtime Settings toggle; full unrestricted OS access risk.
- **Target resolution** — `compute_exec.target` selects among allowlisted environments; fails closed on unavailable default, never silently redirects.
- **MCP server run_location** — Per-server assignment to isolated/shared/host, cycled in Compute UI; falls back to container if host access later disabled.
- **Network isolation between containers** — nftables rule set (NET_ADMIN) drops new inbound connections from sibling containers on the shared bridge (new containers only).
- **Container rebuild** — Deletes and reprovisions container for a clean slate; wipes workspace, packages, browser profile.
- **compute.packages.pip** — Python packages pre-installed into the managed isolated container.

### Compute Environment Services
- **HostExecService** — Detects best host shell (Git Bash/bash/pwsh/powershell/cmd) per-OS, caches it; spawns with process-group/tree-kill on timeout or shutdown.
- **ExternalExecutionService** — Read-only lifecycle adapter for user-owned Docker/Podman containers; probes engine binary, inspects container ID/running state, refuses to start/stop.
- **UvManager** — Downloads/manages the `uv` Python tool/package manager binary per-platform; installs Python interpreters and CLI tools via `uv tool install`.
- **Container ID pinning** — External targets validate `expectedContainerId` against live inspect to detect a renamed/replaced container.

### Computer Use (Desktop Automation)
- **Visible Linux desktop** — X display `:99`, Openbox + tint2 panel, one workspace, session D-Bus, streamed via noVNC to the Computer tab.
- **Look-act-look loop** — `scrot` screenshot → `fs_transfer` to VFS → read image → `xdotool` act → screenshot again.
- **xdotool control** — Mouse move/click/drag, keyboard type/key chords, window search/activate/geometry.
- **Clipboard bridge** — `xclip` for Unicode/long text input via detached `setsid -f` process, avoiding ASCII-only `xdotool type`.
- **adf-browser CLI** — `start`/`stop`/`resume`/`status` commands controlling the managed Chromium's hold state.
- **Application launching** — Panel launchers plus `setsid -f` for GUI programs that must outlive the one-shot `compute_exec`.
- **apt package install** — Agents can install additional GUI apps into the container on demand (compute-policy gated).
- **File transfer to desktop** — `/workspace` is not the VFS; `fs_transfer` moves inputs/outputs between them.
- **Screen sharing handoff** — Agent must pause and hand control to the human for sign-in/CAPTCHA/MFA/passkey challenges.

### Browser (Managed Chromium)
- **Managed Chromium session** — One ADF-owned browser per isolated container, persistent profile at `/var/lib/adf/browser-profile`.
- **CDP endpoint** — Loopback Chrome DevTools Protocol; browser automation servers attach rather than launching a second browser.
- **@playwright/mcp integration** — Maintained MCP server for DOM-based web automation without coordinates.
- **On-demand lifecycle** — Browser opens on desktop boot, MCP spawn, or panel click; stays closed if user closes it; never silently reopens.
- **Portable browser profile skill** — Encrypts and checkpoints cookies/passwords/history/extensions into `adf_identity`, restorable to another container (A/B snapshot slots).
- **Renderer probe** — Validates native Chromium runtime before considering the visible browser ready, across Apple Silicon/Intel/AMD host+Podman combos.
- **Publish/port isolation** — noVNC viewer port (6080) published on host loopback only; blocked from sibling containers post network-isolation update.

### Capability Profiles (Runtime Subsystem Gating)
- **11 capability flags** — timers, codeSystemScope, compute, mcp, mcpManagementTools, adapters, npmTools, shell, streamBindings, umbilicalTaps, meshWebSocket.
- **studioForeground / studioBackground profiles** — All 11 capabilities enabled.
- **daemon profile** — All enabled except `umbilicalTaps`.
- **headlessLive profile** — Only `timers` enabled; everything else off.
- **benchmark profile** — All capabilities disabled.
- **Async teardown tracking** — `ASYNC_TEARDOWN_CAPABILITIES` set flags which subsystems can't use the sync `dispose()` contract (compute, mcp, adapters, streamBindings, umbilicalTaps, meshWebSocket).
- **isSyncSafeAgentProfile** — Derives whether a given profile can be torn down synchronously.

### Cross-Cutting Tool Parameters
- **_async** — Background execution with task reference, available from LLM calls and code.
- **_full** — Code-execution-only bypass of tool output truncation limits.
- **_reason** — Auto-injected approval-context string on every schema, stripped before execution.
- **_authorized** — Internal-only flag set by `adf-call-handler` for authorized-code protection bypass; unforgeable by the LLM.

# 4. Messaging (ALF), Channels, Mesh, Serving & Discovery

### Messaging Core (ALF / DID Mesh)
- **DID+address addressing** — recipient identity (DID) resolved separately from delivery URL (address) for every send.
- **msg_send Mode 1: direct** — explicit `recipient` DID + `address` delivery URL.
- **msg_send Mode 2: parent_id reply** — resolves recipient/address from the referenced inbox message's `from`/`reply_to`.
- **msg_send Mode 3: bare handle** — local-runtime-only resolution via mesh registry, enforces recipient visibility tier.
- **Adapter recipients** — `type:id` addressing (e.g. `telegram:123`) routes through the matching channel adapter, no address needed.
- **Inbox/outbox dual store** — every message persisted in sender outbox and receiver inbox for auditability.
- **Single-attempt delivery** — no sender-side retry/queue; outcome recorded as `delivered`/`failed` with HTTP status code.
- **Messaging modes** — `proactive` (default), `respond_only` (requires parent_id), `listen_only` (receive-only), enforced at tool layer.
- **Threading** — `thread_id` groups a conversation, `parent_id` builds tree-structured reply chains.
- **msg_list** — lightweight inbox unread/read/archived counts, no content, no parameters.
- **msg_read** — fetches messages, marks read, optional `include_original` for raw platform payload.
- **msg_update** — bulk status transition (read/archived/delete) by message id list.
- **msg_delete** — filtered bulk delete on inbox or outbox with store-specific allowed filter fields.
- **Reply-To override** — `card.endpoints.inbox` config lets an agent advertise a public/relay reply address.
- **Group context (meta.group)** — normalized chat title/participants/description injected per platform, capped at 20 participants.
- **adf.chat_info** — sandbox-callable live chat metadata lookup (roster, title) per adapter, invisible-by-default tool.
- **Attachments by value** — files copied (not referenced) into recipient's `imported/{sender}/` namespace on receipt.
- **Cross-machine attachment transport** — base64-encoded inline in the ALF payload over HTTP.
- **Per-message audit capture** — full ALF message with inline attachments brotli-compressed into `adf_audit` when enabled.
- **Message status lifecycle** — inbox: unread→read→archived; outbox: pending→delivered|failed (terminal, no retry).

### Visibility, Security & Identity
- **Visibility tiers** — `directory`/`localhost`/`lan`/`off`, strictly nested containment hierarchy governing inbound reach.
- **Runtime network binding** — mesh server auto-binds `0.0.0.0` only when a `lan`-tier agent exists or `meshLan` is set.
- **Inbox acceptance enforcement** — `POST /agents/{handle}/inbox` rejects requests exceeding the recipient's visibility scope with 403.
- **Directory inclusion enforcement** — `agent_discover`/`GET /agents` filter cards by requester's reachable scope.
- **Security levels 0-3** — Open, Signed (default), Encrypted (E2E to DID recipients), Advanced (custom middleware policy).
- **DID-derived encryption** — Ed25519→X25519 key conversion encrypts payloads with no key exchange or directory lookup.
- **Encryption exemptions** — same-runtime local delivery and channel-adapter recipients are never encrypted (no agent key).
- **Unverifiable-recipient rejection** — an encrypted message a recipient's keys can't open is rejected with 403, never partially delivered.
- **Trust field tiers** — verified `from` DID vs. unverified `sender_alias` vs. transport-derived `meta.identity_verified`.
- **Reserved alias stripping** — wire-supplied `owner`/`system`/`user` aliases are dropped on ingress to prevent spoofing.
- **Owner claim gating** — `owner` field on inbox rows retained only when the message is cryptographically verified.
- **Allow/block lists** — `messaging.allow_list`/`messaging.block_list` restrict senders by agent DID.
- **Agent card** — signed identity object at `GET /agents/{handle}/card` with DID, endpoints, policies, attestations.
- **Owner attestations on card** — opt-in delegation certificates proving who owns/operates the agent, inside the signed scope.

### Mesh Transport & Delivery
- **Local delivery fast path** — same-runtime recipients get a direct inbox write, bypassing HTTP entirely.
- **WebSocket delivery path** — active authenticated WS connection to recipient DID used instead of HTTP POST.
- **Transport resolution order** — local → active WebSocket → HTTP POST, automatic per-send with WS-to-HTTP fallback.
- **Message receive endpoint** — `POST /agents/{handle}/inbox` accepts full ALF wire messages, returns 202 + message_id.
- **Loopback reply_to rewrite** — inbox handler rewrites a remote sender's `127.0.0.1` reply_to with the observed peer address.
- **Hub agents** — subscription-based message routers that fan out broadcasts wrapped with attribution (`wrapper: fanout`).
- **Dynamic instruction injection** — `[Mesh Update]` roster and `[Inbox: N unread]` nudges pushed into agent turns, gated per-key.
- **Fleet map** — RTS-style hex-territory view of the agent network with live activity and command surface.
- **Fleet activity drawer** — shows bus registrations, running agents, and last-200 message log.
- **MessageBus (fleet-map bus)** — in-process agent registration by channel, send/log/registration tracking independent of mesh transport.

### Channel Adapter Framework
- **Standard adapter interface** — `start`/`stop`/`send`/`canDeliver`/`status` contract shared by all five built-in adapters.
- **Per-adapter credential storage** — one `adf_identity` row per adapter keyed `adapter:{type}:{KEY}`, no app-wide fallback.
- **Adapter activation gating** — requires both `adapters.<type>.enabled` and `messaging.receive`+`triggers.on_inbox.enabled` to actually wake the agent.
- **Offline catch-up** — recovers backlog per platform window (Telegram 24h, WhatsApp ~30d, Slack/Discord history backfill, email unbounded).
- **Single wake-on-drain** — backlog delivery wakes the agent once at the end, not once per missed message.
- **Dedup on redelivery** — platform message ids used as dedup keys to skip duplicate catch-up messages.
- **Adapter health checks** — 30s polling with auto-restart on disconnect, exponential backoff 2s→60s, up to 5 retries.
- **Adapter Status Dashboard** — Settings UI showing connection status, 500-entry log viewer, start/stop/restart controls.
- **DM/group policy filtering** — per-adapter `policy.dm` (all/allowlist/none) and `policy.groups` (all/mention/none).
- **Attachment size limits** — configurable `limits.max_attachment_size` per adapter, default 10MB.
- **content_type routing** — markdown (default), `text/html`, and `application/vnd.adf.form+json` each render per-platform.
- **Credential self-setup playbook** — agents store tokens via `set_identity` and enable adapters themselves, no Settings UI needed.
- **Token rotation restart requirement** — credential-only changes don't reload a running adapter; toggling `enabled` off/on forces re-read.
- **Principal-id bookkeeping** — agents save the first-contact platform id under `adapter:{type}:owner` in `adf_meta`.

### Telegram Adapter
- **Long-polling bot connection** — grammY-based, token-authenticated, no public endpoint required.
- **Inbound text/photo/document** — attachments downloaded into `imported/telegram/`.
- **Reply-threading mapping** — Telegram reply-to references map to ADF `parent_id`.
- **Markdown-to-HTML outbound** — bold/italic/code/links converted, falls back to plain text on conversion failure.
- **File type routing** — GIFs as animations, images as photos (document fallback), others as documents; voice via `sendVoice`.
- **Native poll rendering** — `render: 'poll'` form produces a real Telegram poll; vote changes re-ingest (latest wins).
- **Compact form rendering** — one message, combined inline keyboard with options sharing rows, answers collapse to a checkmark.
- **Per-question form rendering** — one message per question, keyboards for choice/multi, reply prompt for text.
- **Callback query answering** — inline button taps acknowledged via `answerCallbackQuery`, message edited in place with `editMessageText`.
- **HTML content sanitized subset** — allowed inline tags kept, structural elements folded to newlines/bullets, falls back to plain text.
- **Telegram Mini App forms (planned)** — `render: 'webapp'` design for single-block forms via reply-keyboard `web_app` button and `sendData`.

### Discord Adapter
- **discord.js v14 gateway connection** — DM and guild message receipt, Partials.Channel/Message for uncached DM delivery.
- **Slash command registration** — single global `/<botname> prompt:<text>` command when `DISCORD_APPLICATION_ID` is set.
- **Message Content privileged intent requirement** — required for non-mention guild message text to be populated.
- **Native markdown passthrough** — Discord's own markdown dialect needs minimal transformation.
- **2000-char truncation** — over-limit outbound messages truncated with `…` and full text attached as `message.txt`.
- **Reply threading** — outbox `parent_id` sent as Discord `reply: { messageReference }`.
- **Attachment upload** — via `AttachmentBuilder`; inbound images/files/audio downloaded to `imported/discord/`.
- **Channel-id addressing** — `discord:<channel_id>` unifies DM and guild channel destinations.
- **Guild-member mention gating** — `groups: 'mention'` default requires @mention or reply before processing.
- **History backfill catch-up** — REST message-history API used since the gateway only replays brief drops.

### Slack Adapter
- **Socket Mode transport** — outbound WebSocket, no public endpoint, app-level + bot tokens.
- **Thread-based reply routing** — `reply_in_thread` default true; inbound thread replies resolve `parent_id` to thread root.
- **Message-event-only processing** — subscribes to `message.channels/groups/im/mpim`; ignores `app_mention` and other events.
- **conversations.history/replies backfill** — Socket Mode has no offline queue, so catch-up scans prior-traffic conversations.
- **File upload/download** — inbound via bot token into `imported/slack/`, outbound via `files.uploadV2`.
- **DM auto-open** — `slack:U0123ABC` user recipient opens the DM conversation automatically via `conversations.open`.
- **Group roster via conversations.members** — first page (20) of channel members for `meta.group`.
- **mrkdwn translation** — native Slack markdown dialect conversion for outbound text.

### WhatsApp Adapter
- **Baileys multi-device linking** — personal account pairing via QR code, no tokens or business account.
- **QR pairing file** — written to `imported/whatsapp/pairing-qr.png`, regenerates every ~60s, retry-capped.
- **Session state on disk** — signal keys stored in `<agent>.adf.adapters/whatsapp/`; deleting unpairs.
- **Quoted-reply threading** — native WhatsApp quote for `parent_id` replies, using a 500-message in-memory quote ring.
- **Voice note conversion** — WAV attachments converted to OGG/Opus `ptt` voice notes via ffmpeg when available.
- **JID addressing** — bare number, full `@s.whatsapp.net` JID, or `@g.us` group JID.
- **Group metadata fetch** — full participant list with roles via `groupMetadata` (names unavailable, JIDs only).
- **Protocol message filtering** — reaction/key-rotation protocol payloads are skipped from ingestion.
- **~30-day offline queue** — WhatsApp server-side replay on reconnect; link dies after 14 days phone-unused.

### Email Adapter
- **IMAP/SMTP with provider auto-detection** — Gmail/iCloud/Outlook/Fastmail/Yahoo host/port inference from address domain.
- **IMAP IDLE with polling fallback** — `config.idle` (default true) or fixed `poll_interval` poll-only mode.
- **Multipart outbound** — plain text + Markdown→HTML body construction.
- **RFC 822 raw source capture** — `original_message` preserves the full email source for forensic access.
- **Reply-all/CC/BCC routing hints** — `message_meta.reply_all`/`cc`/`bcc` control delivery without touching content.
- **In-Reply-To/References threading** — maps to ADF `thread_id`/`parent_id` and vice versa on send.
- **\Seen-flag dedup** — processed messages marked seen so they aren't re-fetched.
- **Unbounded offline catch-up** — unread mail simply waits in the mailbox, no window limit.

### Interactive Forms & Rich Content
- **Canonical form content type** — `application/vnd.adf.form+json`, one schema translated per-adapter at render time.
- **Form schema limits** — up to 10 questions, 12 options each, short id constraints for Telegram callback_data budget.
- **Question types** — `choice` (single-select), `multi` (multi-select+Done), `text` (free reply).
- **Strict render validation** — a form shape that doesn't satisfy the chosen `render` fails the send with a precise reason, never degrades silently.
- **Non-Telegram form fallback** — plain-text numbered questionnaire on Slack/WhatsApp/Discord/email.
- **Answer aggregation contract** — structured answers arrive as threaded inbox messages with `form_id`/`question_id`/`answer_id` in `source_context`.
- **HTML content type** — `text/html` renders full body on email, sanitized subset on Telegram, plain text elsewhere.

### HTTP Serving
- **Three serving modes** — Public (static `public/`), Shared (glob-matched workspace files), API (sandboxed lambda routes).
- **Request resolution order** — API routes → public files → shared files → 404.
- **Reserved protocol segments** — `inbox`/`card`/`health` cannot be claimed by serving routes or public files.
- **Lambda API routes** — method+path+lambda mapping with `:param`/`*` wildcard matching and optional middleware chain.
- **Warm mode** — `warm: true` keeps the sandbox worker alive between requests for high-traffic/stateful endpoints.
- **on_card route exposure** — API routes are card-hidden by default; `on_card: true` lists them in `api_routes`.
- **MIME type table** — automatic Content-Type by extension for html/css/js/json/png/jpg/svg/pdf/woff2.
- **HTTP/1.1 6-connection cap** — served webapps share one origin; unconsumed fetch bodies leak connection slots.
- **Runtime endpoints** — `/health`, `/ping` (peer-discovery identity probe), `/agents` directory, per-agent card/health/inbox mailboxes.
- **LAN/host binding config** — `MESH_PORT`/`MESH_HOST` env vars or Settings toggles; loopback default, LAN opt-in.

### WebSocket Connections
- **Inbound WS routes** — `method: 'WS'` `serving.api` entries requiring a lambda handler, agent-namespaced path.
- **Outbound ws_connections** — configured peer URL+DID+lambda with auto-reconnect, keepalive, and auth mode.
- **Hot path (lambda)** — all WS events dispatched to a persistent warm lambda sandbox; module state shared across connections.
- **Cold path (inbox)** — WS text frames without a lambda validate as ALF messages through the standard ingress pipeline.
- **Mutual DID authentication** — Ed25519 handshake; `auth` modes `auto`/`required`/`none` per outbound connection.
- **identity_verified stamping** — transport-derived flag set only on WS-delivered messages after crypto verification, never wire-supplied.
- **Auto-reconnect backoff** — increasing delay (1x-5x `reconnect_delay_ms`), stops after 5 consecutive failures.
- **Keepalive ping/pong** — 30s default interval; no pong within 10s closes and triggers reconnection.
- **Binary frame support** — `Uint8Array` payloads for raw byte streaming, base64+`binary:true` from LLM tool calls.
- **Backpressure-aware send** — `ws_send` awaits drain past a configurable high-water mark (default 1MiB).
- **Connection-scoped open metadata** — `url_params` and `headers` exposed on the `open` event for multi-session disambiguation.
- **Four WS management tools** — `ws_connect`/`ws_disconnect`/`ws_connections`/`ws_send`, disabled by default, SSRF-guarded.

### Stream Bindings
- **Raw byte-pipe binding** — connects two endpoints (ws/process/tcp/umbilical) for bidirectional or one-way data flow.
- **Endpoint kinds** — WS connection, spawned process (host/container-shared/container-isolated isolation), TCP socket, umbilical filter tap.
- **Backpressure queues** — per-direction `PumpQueue` with byte-bounded buffering and pause/resume on the source.
- **Declarative vs imperative bindings** — config-declared bindings auto-materialize/retry; runtime `stream_bind` calls are imperative.
- **Binding limits** — `idle_timeout_ms`, `max_duration_ms`, `max_bytes`, configurable close-cascade behavior.
- **Flow summary telemetry** — periodic byte-count events per binding plus a final summary before termination.
- **Retry backoff for declarative bindings** — 1s→60s capped exponential retry on materialize failure.

### LAN Discovery (mDNS)
- **Service announcement** — `_adf-runtime._tcp.local` SRV/TXT record per runtime with runtime_id, DID, proto, directory path.
- **Three-gate announcement logic** — LAN-bound server, at least one `lan`-tier agent, and mDNS library init success.
- **Self-skip via runtime_id** — persisted nanoid lets a runtime ignore its own announcement.
- **Peer directory fetch** — plain HTTP `/agents` fetch on discovery, 2s timeout, 30s per-peer cache, dedup in-flight.
- **agent_discover(scope: 'all') merge** — combines local-runtime cards with mDNS/tailnet/manual remote cards.
- **Trust decoration on merge** — `card_verified`, `owner_attested`, `attested_owner_did` computed per remote card.
- **Discovered-runtime UI** — Settings → Networking list with hostname, agent count, live `lan_peer_discovered`/`expired` IPC events.
- **Goodbye/TTL expiry** — clean shutdown sends TTL=0 goodbyes; crash entries expire after ~120s.
- **Interface auto-picker with override** — skips virtual adapters by name; `ADF_MDNS_INTERFACE` env var forces a specific IP.
- **Firewall auto-repair** — Settings button creates/repairs Windows/macOS/Linux inbound rules for UDP 5353 + mesh TCP port.
- **mdns-probe scripts** — `scripts/mdns-probe.mjs`/`mdns-probe-raw.mjs` CLI utilities for diagnosing LAN visibility.

### Tailnet & Manual Peer Discovery
- **Three-source peer table** — mDNS, manual `host:port` entries, and Tailscale sweep, each tagged with a `source`.
- **Rationale** — multicast does not traverse WireGuard, so a tailnet runtime can never announce itself despite being reachable.
- **tailscale status --json sweep** — enumerates online tailnet peers via the local Tailscale daemon, no keys and no admin API.
- **45s sweep interval + ensureFresh() hook** — the peer-list IPC forces a sweep so a newly added manual peer appears in seconds.
- **/ping identity probe** — peers answer with `runtime_id`/`runtime_did`/`proto` to confirm an ADF runtime at that address.
- **Probe hygiene** — one small GET per target, deduped per sweep, refused addresses back off for 5 minutes.
- **lan-tier reachability gating** — tailnet-sourced peers classify as `lan`, subject to the same visibility enforcement.
- **Manual peer list** — Settings-configured `host:port` entries, polled with the existing health check, source `manual`.
- **Settings toggle** — `tailnetDiscovery` setting (on unless explicitly disabled) with a Networking-page switch and source badges.

### Contacts
- **No runtime contacts book** — contact management is deliberately agent-level policy, not a built-in table.
- **Pattern A: plain file** — JSON/Markdown contacts file read by the LLM at turn time.
- **Pattern B: table + outbox middleware** — `local_contacts` table with a lambda resolving bare handles to DID+address before send.
- **Pattern C: auto-save + card refresh** — `on_inbox` lambda upserts senders; timer-driven lambda refreshes cards from `endpoints.card`.
- **parent_id-only contacts bypass** — respond-only agents can skip contacts entirely by always replying via `parent_id`.

### Umbilical Event Stream
- **Per-agent UmbilicalBus** — real-time event stream of every runtime action, consumed by warm in-sandbox taps.
- **Uniform event envelope** — `seq`/`event_type`/`timestamp`/`source`/`agent_id`/`payload`, identical across per-agent bus, daemon bus, and SSE wire.
- **umbilical_taps config** — name/lambda/filter (event_types, when-expression, wildcard opt-in)/rate limit per tap.
- **Loop-protection: exclude_own_origin** — suppresses redelivery of a tap's own produced events back to itself.
- **Loop-protection: max_rate_per_sec token bucket** — backstop against multi-hop tap loops, default 100/s.
- **Loop-protection: wildcard opt-in** — `"*"`/prefix filters require explicit `allow_wildcard: true`.
- **Custom events** — `adf.emit_event` with mandatory `custom.` prefix so agents can't spoof runtime event types.
- **Opt-in replay window** — bounded in-memory ring (`umbilical.log`, default off, 2000 events) for reconnect catch-up.
- **Payload truncation** — event payloads over 4KB replaced with a `_truncated` preview.
- **Snapshot-then-tail recipe** — clients detect replay-window gaps via `oldest_seq` and re-snapshot instead of stitching.
- **Durable-tap recipe** — `local_*` queue table + flush-loop pattern for at-least-once delivery beyond the best-effort bus.
- **External SSE forwarding** — daemon `/events` endpoint plus explicit tap-based forwarding for external observers.
- **tool.* events** — started/completed/failed for every built-in/MCP/shell tool call, stripped internal flags, truncated result content.
- **turn.* events** — `turn.completed` per LLM turn; opt-in `turn.delta` streaming (off by default, per-agent).
- **agent.* / llm.* / lambda.* / db.* / file.* events** — lifecycle, model calls, lambda kinds, SQL, and workspace file changes.
- **message.* events** — received/queued/sent/delivery_failed lifecycle mirroring inbox/outbox transitions.
- **trigger.* / provider.* / error.* events** — fired/dropped triggers, retry backoff, and error-state recovery attempts.
- **hil.* / ask.* / suspend.* events** — human-in-the-loop approvals, agent questions, and turn-suspension decisions.
- **config.changed / context.injected events** — config-key diffs (values never included) and out-of-band context injection sizes.
- **loop.* events** — compaction, compaction failure/supersession, loop clear, and crash-recovery of in-progress turns.
- **ws.* / binding.* events (provisional)** — WebSocket open/close and stream-binding lifecycle/threshold/flow-summary events.
- **CI type-registry guard** — build fails if a runtime emit site uses an event type absent from the typed registry.

### ALF MCP Server (tools/alf-mcp)
- **Standalone Claude Code ALF identity** — did:key Ed25519 identity + mnemonic recovery, separate from any ADF Studio runtime.
- **alf_whoami** — reports DID, handle, inbox/card endpoints, unread count.
- **alf_discover** — queries local + mDNS-discovered ADF runtime directories for agent handle/DID/inbox.
- **alf_send** — signs and encrypts-by-default an ALF message to a handle (via discovery) or explicit DID/address.
- **alf_reply** — replies to a stored inbox record preserving return path and thread_id.
- **alf_inbox / alf_read** — list/read received ALF messages with verification status, mark-as-read on read.
- **alf_outbox** — lists sent messages with delivery status and encryption flag.
- **Local inbox HTTP server** — mirrors ADF mesh-server endpoint shapes (`/health`, `/mesh/directory`, `/:handle/mesh/inbox|card|health`).
- **mDNS announce + discover** — the MCP process itself participates in LAN peer discovery like a full ADF runtime.

# 5. MCP, Skills, LLM Providers, Settings & Cost Tracking

### MCP Server Manager (Studio)
- **Curated quick-add registry** — grid of cards for well-known MCP servers with prefilled config, badges, and prerequisites.
- **95-entry public registry** — `mcp-registry.json`, 9 categories (search, web, dev, data, communication, productivity, infra, ai, tools), 13 OAuth entries, 18 HTTP entries.
- **Three-tier registry fetch** — live GitHub raw doc, then disk cache with ETag, then build-bundled fallback; never blocks on network.
- **`deprecated` / `advisory` registry flags** — deprecated entries stay resolvable but hidden from quick-add; advisory carries a security warning to relay.
- **Custom server / Remote HTTP server** entry points alongside curated cards.
- **Connect verification** — runs the real connect pipeline, shows discovered tool count or verbatim server error; unconnected servers show "Not verified".
- **Managed package install** — npm/pypi packages download in background to `~/.adf-studio/mcp-servers/<package>/`.
- **Per-server Configure / Reconnect / Re-authorize / Logs / Remove** row actions.
- **Available to agents toggle** — lets `mcp_install` attach a Settings-registered server; default on for container/remote, off for host.
- **Attach-over-reinstall** — `mcp_install` matching a registered name/package attaches existing config instead of installing fresh.
- **New-tool trust defaults** — newly discovered tools land enabled, visible, and HIL-gated (never silently trusted).
- **Hot add/remove reconcile** — adding/removing a whole server entry live-reconciles a running Studio agent; field edits need `mcp_restart`.
- **MCP Status Dashboard** — connection status, tool count, health-check pings, expandable logs, test/restart/remove actions.
- **Per-server arguments editor** — one row per CLI arg, `~` home expansion, empty args filtered.
- **Per-server tool-call timeout** — configurable seconds, default 60.
- **Per-agent server attachment** — Attach/Detach buttons per agent; live connect/disconnect on a running Studio agent.
- **MCP tool schema viewer** — click any MCP tool to see its full JSON schema in a modal.
- **Per-tool enable/visible/HIL controls** plus bulk shield/eye/checkbox controls per server header.
- **Disabled Tool Guard** — calling a tool outside the enabled set is rejected by the runtime.
- **Unavailable-server silent disable** — a failed/crashed/uninstalled server's tools vanish from the model's view.

### MCP Transports & Install Types
- **stdio transport** — local process spawned via npm/pypi/custom command, stdin/stdout.
- **Streamable HTTP transport** — remote MCP endpoint by URL, no SSE support (deliberate).
- **`mcp_install` type selector** — `npm | pypi | custom | http`, with `url`/`headers`/`header_env`/`bearer_token_env_var` for http.
- **Host vs Container run location** — host default for Settings installs (auto-approved for host access); Container is an isolation upgrade requiring Podman.
- **Agent-initiated install default** — `mcp_install` runs in-container unless the agent already has host access.
- **mcp_install / mcp_restart / mcp_uninstall gating** — disabled by default tools; owner must enable via `sys_update_config`, HIL-gated.
- **Env variable blocklist** — `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `LD_PRELOAD` and other sensitive vars stripped from server config with a logged warning.
- **Zod input validation** on all MCP IPC handlers (probe/install/uninstall/restart/logs/credential ops/attach/detach).
- **Path traversal guards** — entry-point resolution and uninstall confined to the managed install directory.
- **Auto-restart supervisor** — exponential backoff (2s/4s/8s, 3 retries) on crash, tools re-registered on reconnect without agent restart.
- **Lightweight health-check pings** — distinct from full tool listing, minimizes overhead.
- **Per-agent MCP scratch directory** — isolated temp dir as cwd for all of an agent's MCP server processes, cleaned on stop.
- **Background-agent MCP parity** — same connect logic as foreground, scratch dirs transfer on fg/bg transitions.
- **Podman-unavailable hard-fail** — a container-routed server whose container can't start no longer silently falls back to host.

### Credential Handling (env-based)
- **App-wide credentials** — stored encrypted at Settings level, shared by any agent using the server.
- **Per-agent credentials** — stored in `adf_identity` as `mcp:<server>:<key>`, encrypted with agent password, travel with `.adf`.
- **Credential panel** — set/view app-wide and per-agent creds, key-icon and "Needs keys" badges.
- **Auto attach/detach on credential save/remove** — saving credentials attaches the server config to the agent automatically.
- **Runtime-only decryption** — credentials decrypted only when connecting the server process; defensive copy blocks write-back of plaintext.
- **Env vars scoped to server process** — never passed to the agent itself.
- **`sys_get_config` redaction** — MCP `env`/`headers` values return `__redacted__`, keys stay visible.
- **Namespace-drift-aware resolution** — env vars resolved by package namespace first, then server name, mirroring install-time writes.

### Credential Files in the Identity Keystore
- **`credential_files` declaration** — file-shaped OAuth creds (`path`, `required`, `write_back`) on `McpServerConfig` / `mcp_install`.
- **Sealed keystore storage** — `mcp:<pkg>:file:<path>` purpose, base64 JSON payload, 256 KiB decoded cap, sealed in the `credentials` envelope.
- **Sealed-or-fail capture** — refuses to write plaintext when the envelope DEK isn't cached (unlike ordinary `set_identity`).
- **Materialization before every spawn** — keystore copy written into container (via `podman cp` of 0600 temp files) or host FS before connect/auth.
- **Write-back after auth preflight** — server-written token files captured back into the keystore on successful auth (v1: preflight-success only, no rotation tracking).
- **Agent-scoped container `$HOME`** — shared container gets `/workspace/<agentId>/home` instead of `/root`, stopping cross-agent credential clobbering.
- **Absolute-path escape hatch** — servers that hardcode `/root` or use `getpwuid` get an absolute `credential_files` path instead of `~/`.
- **One-time re-auth migration** — pre-existing `/root`-stored grants require a single re-consent after the agent-scoped-home change.
- **Portability via envelope model** — same-owner `.adf` move carries grants automatically; password-share transfers them; provider-side revocation available for OAuth.
- **Daemon runtime keyslot (Phase C)** — daemon X25519 keypair (`runtime-enc-key`), Studio-side `trustedDaemonEncKeys` trust list, wraps the credentials DEK to trusted daemon keys so headless connects/refreshes work.
- **Re-materialization gap** — `McpClientManager` auto-reconnect does not re-materialize files; a rebuilt container needs `mcp_restart`.

### Interactive Authentication (stdio OAuth preflight)
- **Auth preflight spawn** — server launched once in auth mode (`auth_args`) in its real run location before the real MCP connect.
- **OAuth callback tunneling** — auto-detects the loopback `redirect_uri` port and tunnels it into the container for containerized servers.
- **Auth-URL detection and browser open** — watches stdout/stderr for the URL, opens the default browser, only after a startup grace period.
- **Studio confirm dialog** — "Complete authorization, then click Continue"; headless waits for the auth process to exit.
- **Device-code flow support** — auth URL + code detected and opened automatically (Microsoft, Auth0-style).
- **Headless preflight fallback** — best-effort browser open + logged URL, 5-minute timeout, plain error with `mcp_restart` guidance.
- **Re-run-safe `mcp_install`** — re-running applies `env`, `credential_files`, and `auth: true` incrementally rather than a no-op; failed installs persist what survived.
- **Google OAuth prerequisite walkthrough** — one-time GCP OAuth client JSON setup documented for Gmail/Drive/Calendar servers.

### Interactive HTTP OAuth (remote MCP, Phase 4)
- **SDK-native OAuth client** — `AdfOAuthClientProvider implements OAuthClientProvider` using `@modelcontextprotocol/sdk` 1.27.1 (RFC 9728/8414/7591 discovery + DCR).
- **Hybrid token storage** — app-level encrypted store (Studio "signed in") plus per-agent sealed keystore copy captured on attach; connect prefers agent-sealed token.
- **Ephemeral loopback callback** — ad-hoc port per sign-in, state-validated, single-use code, ~5 min timeout, 127.0.0.1-only.
- **Dual-mode registry entries** — OAuth sign-in with a bearer-token-paste fallback for CI/daemon users (GitHub, Linear, Atlassian, Cloudflare, Neon, Hugging Face).
- **Silent vs interactive provider split** — connect-time provider only refreshes/attaches tokens (never opens a browser); interactive flow is Settings/IPC-only.
- **Studio-only v1 runtime** — daemon works only with a pre-existing agent-sealed token and provisioned runtime key; otherwise fails plainly with sign-in instructions.
- **Executable-identity token pinning** — OAuth tokens keyed by the registration-pinned URL so a tampered `.adf` can't redirect them.
- **Sign-out IPC** — invalidates the stored token via the OAuth store.
- **Never-plaintext guarantee** — tokens never enter `mcpServers`/`adf-settings.json`, agent config, argv, or logs; `mcpOauthCredentials` is settings-secret and write-deny listed.

### MCP Runtime Behavior
- **`mcp_<server>_<tool>` naming convention** for every discovered tool.
- **Tool reconcile on rediscovery** — new tools enabled/visible/HIL-gated; changed-schema tools disabled+restricted pending review; removed tools disabled+hidden.
- **Visible browser automation** — `@playwright/mcp` attaches to ADF's own persistent Chromium CDP endpoint instead of launching a separate browser; puppeteer name is aliased to it.
- **Multimodal content passthrough** — image/audio/video content blocks sent natively to the LLM when `model.multimodal` enables that modality, else saved to `adf_files` with a path reference.
- **Media auto-save** — all MCP-returned media saved to `adf_files` at `mcp/{server}/{tool}_{timestamp}_{index}.{ext}`.
- **Linked-image recovery** — resolves image files an MCP tool merely wrote to its cwd (host or container) and loads them when no inline block was returned (capped at 3 images / 4.5MB each).
- **Structured JSON response in code/shell** — full base64 images/audio/resources exposed to code execution regardless of multimodal toggle.
- **Resource & resource-link content handling** — embedded text inlined, binary blobs kept structured, unknown content types passed through labeled rather than dropped.
- **Host-OS file I/O bridge** — filesystem MCP server round-trips host files into/out of the ADF VFS via base64.
- **Disconnected-server error surfacing** — tool call on a down server returns the server's live status/reason, not a generic failure.
- **Portability note** — MCP config travels with `.adf`, but packages must be reinstalled on a new machine.

### MCP Registry Content & Governance
- **95 curated entries** across 9 categories, each with package/url, required/optional env keys, auth flow, credential files, prerequisites.
- **Name-squat exclusion (registry hygiene only)** — a test asserts the curated registry never maps an entry to a known squatted name (fake mcp-gmail, telegram-mcp, mcp-server-milvus, mcp-filesystem-server, github-mcp-server); corrected: this is NOT runtime enforcement, `mcp_install` has no package blocklist.
- **Registry hygiene tracking** — deprecated/archived upstream packages flagged with replacement guidance (github, slack, mail, gmail).
- **`args` field (Phase 2)** — placeholder CLI args (`{directory}`, `{connection-string}`) rendered as required inputs on quick-add cards.
- **HTTP entry fields (Phase 3)** — `url`, `headerEnv`, `bearerTokenEnvVar` for remote Streamable HTTP registry entries.
- **Verification script (planned)** — periodic check against npm/PyPI registries for deprecation/rename drift, wired into CI.

### Skills System
- **File-is-the-state model** — a skill is just `SKILL.md` under `skills/<name>/`; no install/remove tool, no skills config section.
- **Runtime indexer** — watches every writer (agent `fs_write`, lambda, shell, Studio editor, daemon HTTP) on `skills/*/SKILL.md` and `skills-state.json`, debounced ~250ms.
- **Generated `skills-registry.json`** — runtime-owned, `read_only` protection, `$notes` marks it generated, includes a `rejected` array with reasons.
- **`skills-state.json` mute list** — user-owned `{ schema, disabled: [] }`; a corrupt file fails open (all skills enabled) and is reported in `rejected`.
- **Frontmatter convention** — required `name`/`description`, optional `adf` version gate and `requires.{tools,config}` precondition checklist (never a grant).
- **Bounds enforcement** — 48 skills max, 256 KB per `SKILL.md`, 32 KB serialized registry, kebab-case names ≤64 chars.
- **Live catalog injection** — `{{skills-registry.json}}` placeholder in the system prompt, refreshed at session start/compaction/loop-reset; mid-session changes ride a keyed `loop_inject` (`skills_registry`) instead of invalidating the prompt cache.
- **First-party catalog** — public `skills/registry.json` on GitHub raw, fetched via `sys_fetch`, never auto-installed.
- **Optional `files` array** in catalog entries — package resources beyond `SKILL.md`, path-confined (no absolute paths, no `..`).
- **Studio catalog browser** — merges multiple app-configured sources (`skillCatalogSources`), positional merge precedence, first-party registry demoted to a removable default row.
- **SKILL.md preview before install** — clicking a catalog card renders the full markdown (marked + DOMPurify) before writing anything.
- **Install ordering guarantee** — resources written first, `SKILL.md` last, so a half-written package never indexes.
- **Skills panel (Studio)** — lists every indexed package; checkbox mutes/unmutes via `skills-state.json`; row click opens `SKILL.md` in the editor.
- **Slash command palette** — `/` on an empty composer opens built-ins (`/compact`, `/clear`, `/skills`, `/idle`, `/hibernate`, `/stop`) and one `/<skill-name>` command per installed skill.
- **Skill commands are just text** — compose a user message from `agents/openai.yaml`'s `default_prompt` (or a name+description fallback); never execute anything themselves.
- **`bare_prompt` escape hatch** — per-agent flag suppressing every runtime-authored prompt section including `_skills`.
- **Security boundary** — skill text/catalog/indexer can never enable tools, authorize files, read identity, relax HIL, or auto-execute.
- **Legacy `skill-loader` fallback skill** — reproduces the whole indexer as an agent-space lambda + `on_startup`/`on_file_change` triggers for runtimes without native support.
- **`adf-skill-creator` skill** — guides creating new portable skills mapped to ADF primitives (fs, sys_code/sys_lambda, triggers, compute, identity, MCP).
- **`conventional-skill-to-adf` skill** — converts a foreign (e.g. Codex) SKILL.md package into ADF conventions, remapping filesystem/shell/secrets assumptions.
- **`browser-profile-portability` skill** — encrypted checkpoint/restore of the managed Chromium profile across containers via RSA-wrapped AES-256-GCM chunks in the identity keystore.

### LLM Providers — Types & Setup
- **Provider picker groups** — Subscriptions (ChatGPT, Grok), APIs (Anthropic, OpenAI, OpenRouter, + many OpenAI-compatible), Local (LM Studio, Ollama, vLLM, llama.cpp…), Other (custom URL).
- **Multiple accounts per service** — same provider type addable more than once with auto-numbered names.
- **Provider configure modal** — app-default fields (name, base URL, key/account, default model with Fetch Models, request delay, request parameters) plus per-agent overrides section.
- **`providers` config is immutable-deny** — agents can never write app provider config even via HIL approval; they may still set their own `model.provider`/`model_id`.
- **Per-ADF provider overrides** — an agent's own provider copy in its `.adf`, key stored in `adf_identity`; a key-less copy borrows the app-level key only.
- **Anthropic provider** — native `thinking.budget_tokens` reasoning mapping, temperature/top-p omitted while thinking is on.
- **OpenAI provider** — `reasoning.effort/summary` mapping.
- **OpenAI-compatible provider family** — 25+ named tiles (Gemini, xAI, Mistral, DeepSeek, Groq, Cerebras, Together, Fireworks, Perplexity, Azure OpenAI, etc.) plus local-server tiles, all one runtime with different base URLs.
- **OpenRouter first-class provider** — native `reasoning_details` round-tripping across tool calls including encrypted blocks; usage accounting via `usage.include`.
- **Custom parameters injection** — per-provider or per-agent key/value pairs merged last into the request body, JSON-parsed when possible, empty value deletes a key; overrides the unified reasoning mapping.
- **Provider connection pooling** — Anthropic/OpenAI/custom/OpenRouter SDK instances pooled by API key/base URL to reuse HTTP connections at 100+ concurrent agents.
- **Reasoning/thinking unification** — one Effort/Max-tokens/Exclude/Preserve config translated per-provider (Anthropic thinking, OpenAI/ChatGPT reasoning.summary, Grok reasoning_effort clamp, OpenRouter reasoning+exclude+preserve).

### ChatGPT Subscription Provider
- **OAuth login, no API key** — flat monthly billing via ChatGPT Plus/Pro, Responses API backend.
- **App-wide session sharing** — all Studio agents share one sign-in; daemon keeps a fully separate session.
- **Reasoning trace stripping** — codex-backend "experimental" headline-only summaries stripped of empty `<!-- -->` placeholders.
- **Fixed model catalog** — gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4(+mini), gpt-5.3-codex(+spark).
- **Rate-limit telemetry** — `sys_get_config({section:"provider_status"})` exposes primary (5h) and secondary (7d) window usage percentages, reset timers, plan type, credits balance.
- **No-retry limit errors** — usage-limit errors surface immediately with the reset time, no automatic retry.

### Grok Subscription Provider
- **OAuth device-code flow** against `auth.x.ai`, requests hit standard `api.x.ai/v1` with the bearer token — no API key, no console billing.
- **Works over SSH/daemon** — device flow needs no localhost callback (`POST /auth/grok/start`).
- **Live model catalog fetch** with fallback list (grok-4.5, grok-4.3, grok-build-0.1, etc.).
- **Per-model reasoning-effort clamp** — mapped to xAI's none/low/medium/high scale; some models reject effort entirely.

### Subscription Session Storage
- **Per-surface token files** — Studio `<userData>/<provider>/auth.json` (safeStorage), daemon `<userData>/<provider>/auth.daemon.json` (AES-256-GCM key file, 0600).
- **Automatic token refresh** with concurrent-writer safety — daemon and CLI share one file, re-read-before-spend avoids clobbering rotated refresh tokens.
- **Envelope-mismatch guard** — a `safe:`-prefixed payload the daemon can't decrypt is never adopted or overwritten; downgrade from keychain to key-file encryption is refused outright.
- **Legacy plaintext adoption** — a pre-split plaintext `auth.json` is adopted once into the daemon's own encrypted file.

### Provider Runtime Plumbing (ai-sdk-provider / provider-factory)
- **`LLMProvider` abstraction** — uniform `createMessage`/`validateConfig` interface across all provider types, carrying `providerId`/`providerType`/`modelId`.
- **Provider error enrichment** — unwraps AI SDK `RetryError` inner causes, extracts HTTP status + response body detail, preserves `Retry-After` headers and `cause` chains for the executor's classifier.
- **`streamOnly` / `forwardProviderParams` / `onBeforeRequest` hooks** — subscription providers inject system instructions and force streaming via provider-specific plumbing.
- **Param injector fetch wrapper** — merges extra request-body params into every call, null value deletes a key.
- **Tokenizer family resolution** — provider type (or opaque settings key / model-name heuristic) selects Anthropic vs GPT tokenizer for accurate counting.

### Settings — Identity & Providers
- **Owner Identity (`did:key`)** — derived from a 12-word seed phrase; backup/confirm flow, seed-not-backed-up badge, import identity to re-stamp local `.adf` ownership.
- **Runtime Identity** — per-machine DID, delegation-valid badge, agent directory URL for mesh discovery.
- **Add Provider wizard** — tile picker prefills base URL and a default incrementable name.

### Settings — MCP / Channels / Networking
- **MCP Status Dashboard tab** — mirrors the Add/Configure/Reconnect/Logs/Remove/Credentials flow described above.
- **Channel Adapters page** — Telegram, Email, Discord, Slack, WhatsApp; per-agent connection, one bot per agent enforced (no app-wide credential store).
- **Security Guard & Locked Fields** — hard-denied `security.*` guard toggles (unsigned messages, middleware authorization) vs. locked-by-default fields (`security.allow_local_fetch` SSRF escape hatch, `stream_bind`) that surface as owner-approvable protection requests.
- **Mesh (Web) tab** — server status, LAN-access toggle (binds `0.0.0.0`, requires restart), per-interface addresses, agent endpoint table, Tailscale peer discovery.

### Settings — System Prompt & Prompting
- **Base prompt editor** — global system prompt prepended to every agent, auto-saved, resettable to default.
- **Per-agent System Prompt select** — Full / No base prompt / Bare, each showing its resolved token count.
- **Dynamic Instructions checkboxes** — four independent toggles for inbox hints, context warnings, mesh updates, idle reminder, decoupled from the static prompt setting since schema v30.
- **Tool Instruction sections** — conditional prompt blocks (Tool Best Practices, Code Execution & Lambdas, ADF Shell, Multi-Agent Collaboration, HTTP Serving) injected per enabled tool/feature, each individually reset-able and "modified"-badged.

### Settings — General & Housekeeping
- **Auto-save with debounce** — no manual Save/Cancel; changes commit shortly after editing stops.
- **Light/dark theme toggle**, soon to become a compact SegmentedControl per the visual-modernization design.
- **Tracked directories** — auto-tracked on open/create, manual add/remove, Start-all/Stop-all per directory.
- **File association** — registers as the `.adf` file handler.
- **Multiple Studio instances** — `--instance=N` for isolated user-data dirs during development.
- **Bottom Panel Logs tab** — level/origin filtering, expandable JSON payload, auto-refresh, per-ADF reload.
- **Bottom Panel Tasks tab** — status-filterable `adf_tasks` view (pending/pending_approval/running/completed/failed/denied/cancelled).
- **Settings visual modernization (design-stage)** — shared `Button`/`IconButton`/`SegmentedControl`/`SettingsGroup`/`SettingsRow`/field primitives, semantic `--adf-ui-*` tokens, Age-of-Agents fleet UI explicitly walled off from the change.

### Daemon Runtime Settings
- **Three daemon config paths** — dedicated `ADF_DAEMON_SETTINGS` JSON file, live `/settings` HTTP API, or shared Studio settings file.
- **Provider entries** — `id`/`type`/`name`/`baseUrl`/`apiKey`/`defaultModel`/`params`/`requestDelayMs`/`credentialStorage` (`app` vs `agent`).
- **ChatGPT-subscription daemon auth** — `POST /auth/chatgpt/start` returns a browser auth URL for headless sign-in.
- **MCP settings block** — global `mcpServers` registrations; agents opt in per `.adf` `config.mcp.servers`; unregistered-with-no-metadata servers are skipped, not fatal.
- **Adapter settings block** — global registrations for adapter type/package; credentials always live in agent `adf_identity`, never in daemon settings; deprecated `env`/`credentialStorage` fields ignored at runtime.
- **Compute settings** — `hostAccessEnabled`, `hostApproved`, `containerPackages`, `machineCpus/MemoryMb`, `containerImage` passed straight to `PodmanService`.
- **Mesh settings** — `meshEnabled`/`meshLan`/`meshPort`, overridable via `MESH_HOST`/`MESH_PORT` env vars.
- **Live PATCH/GET/PUT `/settings` endpoints** — whole-object or single-key read/write, written back to the JSON file; some settings need a daemon restart to take effect.
- **Plaintext secret warning** — manually written daemon settings store `apiKey`/`env` values as plain JSON; filesystem permissions are the only protection.

### Settings Persistence & Conflict Handling
- **Coalesced dirty-key writes** — bursts of `set()`/`setSecret()` collapse into one microtask-scheduled disk flush.
- **Identity-critical synchronous flush** — mnemonic/private-key/DID writes bypass debouncing and flush immediately.
- **Cross-writer merge-on-stale** — before writing, detects if another process (e.g. the daemon) changed the file since last sync and merges rather than clobbering.
- **Corrupt-file quarantine** — unreadable settings JSON is moved aside (never deleted) and defaults loaded; writes are refused entirely if quarantine itself fails, to avoid destroying the only copy.
- **`safeStorage`-encrypted secrets** with plaintext fallback when encryption is unavailable.
- **Three-way secret status** (`absent`/`ok`/`locked`) so callers never mint new key material over an undecryptable-but-present secret.
- **Renderer secret stripping** — `getAll()` deletes mnemonic, private keys, and the sealed MCP OAuth blob before the data ever reaches the UI process.

### Token Usage & Burn Tracking
- **Per-date/provider/model usage ledger** — `token-usage.json`, additive extras (cache_read, cache_write, reasoning, cost_usd) recorded only when a call reports them.
- **Delta-merge persistence** — each process (Studio, daemon) tracks its own pending delta and merges onto a fresh disk read on flush, so two writers never clobber each other.
- **Local-calendar-day bucketing** — usage keyed by the user's local date; pre-migration UTC-keyed rows are left as-is (no time-of-day to re-bucket).
- **Debounced 5s save** with unref'd timer so pending flushes never keep the process alive.
- **Usage summary** — today vs all-time input/output totals and the all-time top model by combined tokens.
- **Clear All** — wipes tracked usage data, dropping even the unflushed delta.
- **Settings Token Usage tab** — per-date, per-provider, per-model breakdown with input/output counts.
- **Fleet burn service** — in-memory rolling 5-minute window per agent (`.adf` path keyed), tracks input/output tokens-per-minute separately plus all-time lifetime total.
- **Burn hydration on restart** — persisted lifetime totals restored (rates reset, but Σ tokens survives).
- **Fleet-wide aggregate burn** — summed tokens/min, in/min, out/min, total across every tracked agent for the resource bar.

### Cost Estimation
- **Local pricing table** (`LLM_PRICING`) — per-million input/output/cache-read/cache-write rates for known models (gpt-5.4 family, claude-sonnet-4-5).
- **Cache-inclusive cost formula** — base input tokens computed as `input_tokens - cache_read - cache_write` since AI SDK v6 normalizes `inputTokens.total` to include caches across every provider.
- **Cost precedence rule** — exact provider-reported cost (OpenRouter usage accounting) wins over the local table estimate; estimated-usage calls get no cost at all; subscription (flat-fee) providers never get a cost figure.
- **`cost_source` tagging** — `provider` vs `table` recorded alongside `cost_usd` for downstream trust/display.
- **Provider-metadata extraction helpers** — pulls cache-read/cache-write/reasoning token counts and cost from Anthropic/OpenAI/OpenRouter/adf-normalized provider metadata shapes.
- **Finish-reason normalization** — collapses provider-specific stop reasons (`tool-calls`, `length`, `stop_sequence`, etc.) into a stable `stop_reason` enum.

### Response & Directory Caching
- **API response LRU cache** — 1000-entry / 50MB in-memory cache for lambda-served API responses, lazy TTL expiry, prefix-based invalidation.
- **Directory (mesh) fetch cache** — 30s TTL cache of `GET /agents` peer responses with in-flight request deduplication and a distinct null-vs-empty-array result for "peer unreachable" vs "genuinely no agents".

# 6. ADF Studio Desktop UI

### Window Chrome & App Shell

- **Custom title bar** — hidden native title bar (hiddenInset on macOS, custom overlay on Windows/Linux) with app nav and agent identity cluster.
- **Application menu** — File (New/Open/Add Directory/Save/Close), Edit, View, Window, Help menus via `src/main/menu.ts`.
- **Open Recent submenu** — up to 10 recent `.adf` files, OS recent-documents integration, Clear Menu action.
- **File association** — double-clicking a `.adf` file (Finder/Explorer) or CLI arg opens it in Studio.
- **Single-instance lock** — second launch focuses existing window and forwards the file-open request.
- **Multiple dev instances** — `--instance=N` flag runs separate userData/settings for development.
- **Native window controls** — minimize/zoom/fullscreen, traffic-light positioning on macOS, `titleBarOverlay` on Windows/Linux.
- **Session-end handling** — Windows logoff/shutdown triggers orderly teardown via `session-end`.
- **Graceful shutdown overlay** — full-screen overlay shown during quit/update-install teardown, distinguishes "Shutting down" vs "Restarting…" wording.
- **In-app auto-updater** — checks GitHub Releases every hour, status-bar badge, click-to-download, auto-restart-and-install after download; disabled in unpackaged dev builds.
- **Native OS notifications** — toast fires only when no Studio window is focused, bursts of 5+ requests collapse into one summary toast, click focuses window and jumps to the agent.
- **Keyboard shortcuts** — `Cmd/Ctrl+,` Settings, `Cmd/Ctrl+S` save tab, `Cmd/Ctrl+W` close tab, `Cmd/Ctrl+N` new agent, `Cmd/Ctrl+O` open agent, `Cmd/Ctrl+Shift+O` add directory, `Cmd/Ctrl+Shift+W` close agent.
- **DevTools / reload / zoom** — standard Electron View menu roles exposed.
- **External docs link** — Help menu opens GitHub repo in OS browser.

### Sidebar & File Navigation

- **Agent sidebar** — lists open/tracked agents with live status dots, grouped by tracked directory.
- **New .adf button** — creates a new agent file with default document/mind/config.
- **Open file / Add directory** — file pickers wired to tracked-directories system.
- **Context menu on agents** — right-click actions (reveal in folder, clone, etc.) via `ContextMenu`.
- **Clone dialog** — duplicate an agent file with selectable tables to include.
- **Running-agent quick list** — aggregated view of currently running agents across tracked dirs.
- **Auto-refresh tracked dirs** — sidebar tree stays in sync with filesystem changes.

### Home Dashboard

- **Status tile grid** — progressive-loading tiles for Providers, MCP Servers, Channels, Packages, Containers, Host Access, Agents, Running counts.
- **Dashboard tile status dots** — ok/warn/error/idle color coding per tile.
- **Getting Started panel** — inline onboarding steps with live quick-stats, provider test results, and agent stats.
- **Networking panel** — Mesh, LAN Discovery, LAN Peers, and Tailnet status tiles on the home screen.
- **Tracked Directories panel** — bottom-of-home file browser mirroring the sidebar tree, with add/open/clone actions.
- **Fleet Map callout** — promotional banner linking into the fleet map / Age of Agents view.
- **Deep-link tiles** — clicking a dashboard tile jumps into the matching Settings section.

### Agent Loop (Chat) Tab

- **Conversation transcript** — virtualized (react-virtual) scrolling list of user/assistant messages, tool calls, reasoning.
- **Collapsible "Context Injected" block** — shows dynamic system-prompt context added per turn.
- **Expandable Thinking block** — amber reasoning trace with token count.
- **Inline tool-call chips** — tool name + JSON args rendered inline, expandable via ToolCallModal.
- **Unified Tool Call inspector modal** — diff view (line/word diff), shell-output formatting, syntax highlighting, duration, family-based styling.
- **Markdown rendering** — sanitized markdown-to-HTML for assistant text and `.adf` file links.
- **Slash command palette** — `/` on empty composer opens command list; arrow/Enter/Tab/Escape navigation.
- **Built-in slash commands** — `/compact`, `/clear`, `/skills`, `/idle`, `/hibernate`, `/stop`.
- **Skill slash commands** — one `/<skill-name>` per installed skill, composes a templated user message.
- **Message composer** — text input with Enter-to-send, HIL inline approve/reject cards.
- **Loop color coding** — per-loop (main + inner loops) color tagging throughout the UI.
- **Chat-in-center mode** — Loops panel can be promoted from the right dock into the main editor tab strip.
- **Live tab updates** — editor/loop tabs update automatically as the agent writes files or logs.
- **Unread indicators** — chat tab shows unread dot when a background loop logs while not focused.
- **Adf-file link handling** — clicking an `.adf`-scheme link in chat opens that agent.

### Agent Configuration Panel

- **Identity section** — name, description, emoji icon picker, agent ID/DID display.
- **Model section** — provider select, model ID, temperature, max tokens, thinking/reasoning budget + effort selector, provider parameters editor.
- **Reasoning controls** — effort (minimal→x-high or off), max-token override, exclude/preserve toggles, per-provider mapping notes.
- **Instructions editor** — system-prompt textarea with System Prompt mode select (Full / No base prompt / Bare) and token-count preview.
- **Context modes** — Document mode vs Mind mode toggle, compaction settings, audit toggle.
- **Start-in-state selector** — idle/active/hibernate/off/suspended on launch.
- **Autostart toggle** — agent boots automatically with the app.
- **Loop Mode selector** — interactive vs autonomous.
- **Tools panel** — enable/disable/lock built-in tools; restricted-tool HIL gating.
- **Triggers panel** — configure on_message/on_file_change/on_timer/etc. with filters, timing modifiers (debounce/interval/batch), scopes.
- **Messaging panel** — channels/adapters config, messaging mode, visibility tier.
- **Serving panel** — HTTP public folder, shared files, API routes, WebSocket endpoints.
- **Timers tab** — Add Timer modal (delay/at-time/interval/cron modes, system/agent scope, lambda entry point, warm flag, payload); list and delete timers.
- **Raw Config tab** — direct JSON view/edit of the agent config.
- **Security sub-section** — per-agent guard toggles (allow_unsigned, require_middleware_authorization, allow_local_fetch, stream_bind) with owner-only override.
- **Docs links & info hints** — inline ⓘ tooltips and "Docs ↗" links throughout config sections.
- **Agent icon/status header** — first-grapheme emoji rendering, state dot, quick state-change buttons.
- **Identity tab (per-agent)** — DID, keystore entries, code-access toggle, attestation list/reissue.
- **Skills panel (per-agent)** — indexed skill catalog, per-skill mute checkbox, catalog browser with SKILL.md preview, Install button.

### Files Tab & Editor

- **Virtual filesystem browser** — collapsible folder tree grouped by directory, file count badges.
- **Drag-and-drop upload** — files dropped into the panel are written to the VFS; unknown extensions stored as binary/octet-stream.
- **File preview modal** — metadata (size, MIME, protection, authorized, timestamps), content preview, rename/protect-cycle/download/delete/close actions.
- **File protection badges** — color-coded read_only / no_delete / none indicators.
- **Tabbed code editor** — multi-tab CodeMirror editor with dirty-state dots, syntax highlighting by extension.
- **Markdown rich editor** — TipTap-based WYSIWYG with formatting toolbar (bold/italic/headings/lists/quote/code/table) and Raw-mode toggle.
- **Large-file safeguards** — files over ~128k chars auto-open in source view; confirmation prompt before forcing rich mode.
- **Binary file placeholder** — non-renderable files show an icon + filename instead of content.
- **Live file sync** — editor tabs auto-update when an agent writes a file via `fs_write`.
- **Browser/webview viewer tab** — embeds a noVNC session for an agent's isolated desktop/browser via `<webview>`.
- **Local database tables view** — lists custom SQLite tables in the `.adf` with row counts, query/drop support.
- **Meta keys viewer** — view/set/delete `adf_meta` keys with protection-level cycling.

### Inbox Tab

- **Message list** — inbox + outbox merged view with status filter (all/unread/read/archived/outbox).
- **Message detail dialog** — full message view for inbox and outbox entries.
- **Read/archive actions** — mark-read, archive from the list.

### Fleet Map ("Age of Agents")

- **RTS-style hex world** — every agent is a tile; tracked folders are territories, subfolders are districts.
- **5-Lens system** — terrain (state), burn (token heat), model (LLM per hex), health, lineage (agent dynasties); cycle with `L`.
- **Single-click select / double-click open** — camera never moves on select alone.
- **Marquee selection** — left-drag on open ground to box-select.
- **Control groups** — ⌘1–9 assign, ⇧1–9 add, 1–9 recall (double-tap to fly), StarCraft-style.
- **Named/persistent groups** — "Save as group…" creates settings-persisted chips in the alert bar.
- **Command bar** — Open, Details, Fly to, Start, Stop, Hold/Resume, Message, Hibernate, Wake, Restart, Halt, Steward of…, Move agents/group/territory, Reset layout.
- **Command hotkeys** — M message, H hold/resume, G start, S halt, ⇧S stop, Enter open, I inspect.
- **Cycling shortcuts** — `.` next agent needing you, `,` next idle agent.
- **Drag-to-move tiles** — solo drag, ⌥-drag moves whole district, ⌘-drag moves whole territory; legal/illegal ghost preview.
- **Click-to-place move mode** — non-drag alternative via command bar for precision/trackpad use.
- **Frozen deterministic geography** — region origins, district anchors, cell pins, station pins persist across sessions; Reset Layout wipes and re-packs.
- **Found agents by double-click** — inline naming card; location decides folder/group/new-root semantics.
- **Voice chips** — floating group-status lines per territory, spoken by the steward or most-recent member; toggle with `V`.
- **Stewards** — appoint one agent per directory level to speak for the group via `sys_set_meta`; relieved with a stand-down message.
- **Traces & streets** — circuit-style routed message lines with heat decay (~4h window, 7-day persistence), directional arrowheads, live packet-pulse animation, persistent delivery streets on peer platforms.
- **Say bubbles** — comic-style ~75s text bubbles over a tile after a plain-text turn; pointer-transparent except the dismiss ✕.
- **Serving badges** — 🌐 corner badge on agents serving a website; click opens the page.
- **Context gauge** — per-tile thin bar for context-window fill (green/amber/red vs auto-compact threshold).
- **Burn readout** — lifetime Σ tokens plus live tokens/min rate per tile.
- **Hover cards** — 550ms-delayed preview card for a tile or station, grace-fade on leave.
- **Agent readout modal** — full single-agent detail (icon, name, state, path, model, mesh chips, family/lineage link, DID) via `I`.
- **Group readout modal** — untruncated group status, cluster vitals, sorted member roster.
- **Alert bar** — state counts, fleet burn rate, tool/message rates, hottest-burner quick-fly, named-group chips, "Needs you" queue.
- **Needs-you queue & pulsing alert ring** — grows/flashes as new HIL requests arrive.
- **Inline pending cards on tiles** — answer questions/approvals directly on the map at close/medium zoom.
- **Full-context approval modal (map)** — agent/tool/reason/args + Approve / Always approve / Reject-with-feedback / Open agent.
- **Foreign runtime platforms** — satellite stations for LAN-discovered peers; violet = your owner identity, cool blue = foreign, dashed border = not controllable.
- **Peer agent readout & hover card** — verified-signature dot, owner attestation caption, served-file browser with markdown/code rendering + download.
- **Channel stations** — perimeter platforms for Telegram/email/Discord/etc. and the web gateway; annex extra pads under traffic load; draggable and selectable.
- **Station readout modal** — health, traffic ledger, agent usage list, click-through to agents.
- **Minimap** — bottom-right overview; needs-input state outranks other color coding when zoomed out.
- **Keyboard command card** — press `?` for the authoritative in-app shortcut reference.
- **Fullscreen edge-scroll panning** — cursor-at-edge camera pan, fullscreen-only (`F`).
- **Leaderboard drawer** — left-rail burn leaderboard ranking hottest agents over a rolling window.
- **Next-up panel** — shows agents queued/ETA for upcoming timer or trigger fires.
- **Ambience layer** — canvas-based firefly particle effects along hex edges, state/alert-tinted, 30fps-capped.
- **Garden/undergrowth decoration layer** — deterministic noise-based moss/dew/sprig decoration across hex terrain.
- **Calm-mode governor** — throttles ambient animation load under sustained pan/heavy fleet activity.
- **Loading veil** — animated hex-sigil splash screen while first fleet poll/layout completes.
- **Mesh log drawer** — feed/bus tabs with delivered/failed status filtering for message traffic debugging.
- **Enable Mesh prompt** — fallback CTA shown instead of the map when mesh networking is off.

### Approvals & Human-in-the-Loop (HIL)

- **Global approvals bell menu** — aggregates every pending approval/ask across all agents and inner loops.
- **In-chat approval cards** — inline Approve / Always approve / Reject-with-feedback split buttons.
- **Reject-with-feedback box** — free-text reason sent back to the agent to course-correct.
- **Always-approve** — permanently lifts the HIL gate for that tool on that agent (config write).
- **Cross-surface resolution sync** — resolving in one surface (chat card, bell, map) clears it everywhere.
- **Native OS toast escalation** — unfocused-window approvals surface as system notifications.
- **Ask/question flow** — agent `ask()` calls render a text-reply affordance instead of approve/reject.

### Settings — Providers

- **Provider catalog picker** — grouped Subscriptions / APIs / Local / Other tiles for 30+ services.
- **Provider configure modal** — name, base URL, API key/account, default model with Fetch Models, advanced request delay + custom parameters.
- **ChatGPT Subscription OAuth** — sign-in flow, per-surface session storage, model dropdown (gpt-5.6 family, etc.).
- **Grok Subscription OAuth** — xAI device-code sign-in flow with code confirmation.
- **Rate-limit/status surfacing** — primary/secondary usage windows exposed to agents via `provider_status`.
- **Agent overrides UI** — per-provider "Agent overrides" list to give specific agents their own key/model/params/delay.
- **Show unchanged-copy link** — collapses agents with an unmodified key-less provider copy.
- **Custom parameters editor** — key/value JSON-injected request-body overrides per provider or per agent.
- **Provider status dots & badges** — connected/error/untested indicators per row.

### Settings — MCP Servers

- **MCP Status Dashboard** — list of registered servers with connection state.
- **Add MCP Server modal** — curated quick-add cards (OAuth flagged) or custom/remote config in one form.
- **Connect / verify pipeline** — runs credential checks, OAuth browser flow, and live tool discovery.
- **Reconnect / Re-authorize** — re-runs the connect pipeline for saved servers.
- **Available-to-agents toggle** — per-server switch controlling agent self-attach via `mcp_install`.
- **Per-server logs viewer** — tool call history and connection logs.
- **Credential panel** — app-wide or per-agent API keys/secrets management.
- **Runs-on selector** — Host vs Container execution location per server.
- **Server config fields** — transport (stdio/http), command, args, env vars, per-server timeout.
- **Interactive OAuth auth** — browser-based sign-in for supported MCP servers (e.g. Gmail).

### Settings — Channels (Messaging Adapters)

- **Channels page** — per-channel row of connected-agent chips with live status dots.
- **Connect-an-agent flow** — pick agent, paste credentials with inline "where to get this" guidance.
- **Per-chip credential editing** — edit, view last error, or disconnect an agent's channel.
- **Per-adapter logs** — up to 500-entry log viewer.
- **Built-in adapters** — Telegram, Email, Discord, Slack, WhatsApp (QR pairing).
- **Channel setup modal** — brand-iconed setup dialog per adapter type.

### Settings — Identity & Security

- **Owner Identity card** — did:key DID, seed-phrase backup flow with confirmation, Import Identity (restamps owned files).
- **Seed-not-backed-up badge** — nags until backup is confirmed.
- **Migrated-DID history list** — shows previously used owner DIDs.
- **Runtime Identity card** — per-machine DID, Delegation-valid badge, agent-directory URL.
- **Password/local-lock dialog** — manual password protection for the local install, forgot-password flow.
- **Owner-mismatch dialog** — prompts to claim a foreign-owned agent file on open.
- **Agent review dialog/banner** — unreviewed-agent warning strip and full review dialog summarizing config changes before accepting.

### Settings — Networking / Mesh / Web

- **Mesh server status card** — running indicator, host:port, clickable server URL.
- **Mesh enable/disable toggle**.
- **LAN access toggle** — binds server to 0.0.0.0 vs loopback, restart-required notice.
- **Discovered runtimes list** — LAN/mDNS/Tailscale-discovered peers with a recheck button.
- **Discover peers over Tailscale option**.
- **Agent endpoints table** — handle, URL, Public/API/Shared badges for every mesh-registered agent.

### Settings — General / System Prompt / Appearance

- **Theme toggle** — light/dark mode.
- **UI font & scale presets** — selectable font family and UI scale options.
- **Base (global) system prompt editor** — auto-saved with debounce, Reset to Default.
- **Per-agent System Prompt mode** — Full / No base prompt / Bare, with live token-count preview.
- **Tool Instructions editor** — per-section conditional prompt blocks (Tool Best Practices, Code Execution & Lambdas, ADF Shell, Multi-Agent Collaboration, HTTP Serving) with modified badges and Reset to Default.
- **Auto-save settings** — debounced writes, no manual save/cancel.
- **Skills catalog sources editor** — add/remove skill catalog source URLs.
- **Agent template tab** — customize the default new-agent config/document/mind/soul via a live AgentConfig editor against effective defaults.

### Settings — Token Usage

- **Usage breakdown chart** — per-date, per-provider, per-model stacked bar chart (UsageChart) with categorical color palette.
- **Metric switcher** — segmented control across usage metrics (tokens/cost/etc.).
- **Clear All usage data** action.
- **Export usage data**.

### Settings — Packages / Compute / Containers

- **Sandbox packages manager** — shared runtime packages installed to `~/.adf-studio/sandbox-packages/`.
- **Make Runtime promotion** — agents can promote their own packages to the shared store.
- **Container list & detail view** — shared/isolated/external container status and phase.
- **Container destroy dialog** — confirms rebuild vs remove, warns about interrupted active agents.
- **Container rebuild/start/stop actions**.
- **Computer tab (isolated desktop)** — embedded noVNC view of an agent's Openbox/tint2/PCManFM Linux desktop.
- **Managed Chromium controls** — start/stop/resume the shared browser session from the panel button.
- **Generated gradient wallpaper** — pure-Node PNG gradient generator for the isolated container desktop background.

### Bottom Panel — Logs & Tasks

- **VS Code-style resizable bottom panel** — drag handle, toggled from status-bar Logs/Tasks buttons.
- **Logs tab** — structured `adf_logs` viewer with level filter, dynamic origin filter, expandable JSON payload rows, auto-refresh toggle.
- **Tasks tab** — task list with status filtering, expandable argument/result detail, auto-refresh, AUTH badge for authorized-code tasks.

### Status Bar & Context Tools

- **Status bar** — current agent state, context-window gauge, token usage, update badge.
- **Context breakdown modal** — click-through token-usage-by-category breakdown (loop, context blocks, tools, system prompt) with USD cost formatting.
- **Mesh traffic bar** — animated ripple indicators for live mesh message direction/volume.
- **App-update badge** — shows available/downloading/ready states inline in the status bar.

### Dialogs & Shared UI

- **Generic modal Dialog component** — Esc/backdrop-close, wide/extra-wide variants, preventClose for in-flight ops.
- **Context menu** — reusable right-click menu with danger/separator item styling.
- **Tooltip component** — custom CSS tooltip (native `title` unsupported under hidden titlebars).
- **Brand icon/mark components** — official-color third-party logos for providers/channels/MCP servers with monogram fallback.
- **Segmented control, Select, TextInput, Textarea, Button, IconButton** — shared form primitives (`components/ui`).
- **Settings group/row layout primitives** — consistent section/row chrome across settings pages.
- **DocsLink / InfoHint** — inline ⓘ tooltips and "Docs ↗" links opening the matching guide on GitHub.
- **About tab** — concise in-app primer on ADF, version info, links to releases.

### Multimodal & Content Rendering

- **Image/audio/video content blocks** — rendered inline in the loop when the agent's `multimodal.*` flags are enabled.
- **Markdown-safe HTML rendering** — sanitized rendering for assistant messages and document previews.
- **Code syntax highlighting** — language auto-detection by file extension in both the tabbed editor and tool-call output.
- **Diff viewer** — line and word-level diffs for file-write tool calls in the Tool Call modal.

### Desktop Integration (Main Process)

- **IPC surface for every UI capability** — 200+ typed channels covering docs, files, agents, adapters, MCP, providers, identity, compute, mesh, timers, tasks, settings, and dashboard stats.
- **Background/foreground agent event batching** — coalesced IPC event delivery to the renderer for performance.
- **Emergency stop** — global kill-switch IPC action.
- **Directory start-all/stop-all** — bulk agent lifecycle actions per tracked directory.
- **Token counting IPC** — single and batch token-count endpoints backing UI previews.
- **Dashboard quick-stats IPC** — aggregated provider-test, agent-stats, and container data for the Home tiles.

# 7. Headless Daemon, CLI, HTTP API, Security & Release

### Headless Daemon Process

- **Node-hosted runtime** — `npm run daemon` runs `src/main/daemon/index.ts` under plain Node, not Electron.
- **Native ABI rebuild on boot** — `scripts/rebuild-for-node.mjs` rebuilds `better-sqlite3` for Node before launch since Studio uses Electron's ABI.
- **RuntimeService lifecycle boundary** — in-memory agent-ID map + file-path index; loads/unloads agents, prevents double-loading one `.adf`.
- **AgentRuntimeBuilder** — assembles daemon-specific tools/services (MCP, adapters, compute, system scope, stream bindings) without Electron IPC.
- **Canonical `daemon` capability profile** — same assembler as Studio; exhaustive profile enables timers, code/system scope, compute, MCP, adapters, mesh/WebSocket.
- **DaemonEventBus** — monotonic transport cursor, bounded in-memory ring buffer, SSE replay via `since` cursor.
- **Review gate** — autostart requires `reviewedAgents` membership; direct `/agents/load` bypasses unless `requireReview:true`.
- **Autostart scanner** — scans `trackedDirectories` up to `maxDirectoryScanDepth`, skips not-autostart/password-protected/unreviewed/already-loaded agents.
- **Env-var configuration** — `ADF_DAEMON_HOST`, `ADF_DAEMON_PORT`, `ADF_DAEMON_SETTINGS`, `ADF_DAEMON_PIDFILE`, `ADF_USER_DATA_DIR`.
- **PID file management** — optional pidfile write on boot, removed on `SIGINT`/`SIGTERM`.
- **Graceful shutdown** — closes HTTP server, unloads all agents via assembled handles, stops compute, removes pidfile.
- **Mesh server auto-start** — starts `MeshServer` when any loaded agent has reachable mesh visibility.
- **Studio/daemon dual-ownership caveats** — no cross-process lock on `.adf` files or mesh port; single-owner operation recommended.
- **Created-child autostart** — `sys_create_adf` children are auto-marked reviewed and can autostart with the parent's review gate bypassed.
- **Daemon settings store** — `FileSettingsStore` reads/writes JSON directly, no Studio migrations applied.
- **Dispatch-object boundary** — daemon never calls `executeTurn()` directly; all work enters via `dispatch(AdfEventDispatch|AdfBatchDispatch)`.
- **Trigger evaluation loop** — daemon-owned `TriggerEvaluator` reacts to timers, log/tool-call/task events, adapter inbound, and config changes.
- **Known architecture gaps** — no full file-change trigger semantics headless; no Studio/daemon conflict coordination.

### Daemon CLI (`npm run adf --`)

- **agents** — list loaded agents.
- **status \<agent\>** — show runtime status.
- **start / stop / unload \<agent\>** — start agent or unload from runtime (`unload` aliases `stop`).
- **abort \<agent\>** — cancel current turn without unloading.
- **runtime [agent]** — daemon-level or per-agent runtime diagnostics.
- **providers** — provider configuration and resolution.
- **auth / auth login \<chatgpt\|grok\> / auth logout** — subscription auth management, separate session from Studio.
- **settings** — sanitized daemon runtime settings.
- **network / network mesh / network server / network tools / network lan / network runtimes** — mesh and WebSocket diagnostics and control.
- **usage [agent]** — daemon-wide or per-agent token usage.
- **config \<agent\>** — show agent config.
- **files / file \<agent\> \<path\>** — list/read agent files.
- **inbox / outbox \<agent\>** — list messages.
- **timers \<agent\>** — list timers.
- **tasks / task / approve / deny** — HIL task approval workflow.
- **asks / answer** — pending `ask` request workflow.
- **identities \<agent\>** — identity metadata without secret values.
- **mcp / adapters [agent]** — daemon or per-agent registration state.
- **events [agent]** — follow SSE stream.
- **chat \<agent\> \<message\>** — send chat, print accepted turn ID.
- **--url / -u / --json** — daemon URL override and raw JSON output flags.
- **ChatGPT auth loopback vs relay mode** — auto-picks `loopback` (local daemon) or `relay` (remote daemon via `--url`); `--relay`/`--loopback` overrides; relay never sends credentials through the daemon, only a short-lived PKCE code.
- **Grok device-code auth** — CLI prints URL+code, opens browser, polls until approved; host-independent.

### HTTP API — Core & Meta

- **GET /openapi.json** — machine-readable API document.
- **GET /health** — liveness check.
- **GET /events[?agentId=][?since=]** — SSE stream of daemon events with replay cursor.
- **GET/PATCH /settings, GET/PUT /settings/{key}** — live daemon settings read/merge/single-key access.
- **No built-in authentication** — HTTP API is trusted-localhost by design; any loopback caller is treated as owner-authorized.

### HTTP API — Agent Lifecycle

- **GET /agents** — list loaded agents.
- **POST /agents/load** — load by file path, optional `requireReview`.
- **POST /agents/autostart** — scan directories and autostart matching reviewed agents.
- **GET /agents/review, POST /agents/review/accept** — review-gate inspection and acceptance.
- **GET /agents/{id}, /status** — agent reference and runtime status.
- **POST /agents/{id}/start** — start / fire startup event when `start_in_state=active`.
- **POST /agents/{id}/stop, /unload** — async teardown with 5s grace period.
- **POST /agents/{id}/abort** — cancel current turn only.
- **GET/POST/DELETE /agents/{id}/chat** — read history, queue turn (202 async), clear loop history.
- **POST /agents/{id}/trigger** — queue arbitrary ADF event dispatch (bypasses TriggerEvaluator gating — known eval trap).
- **GET /agents/{id}/loop** — paginated persisted loop entries (limit 1-500).
- **GET/DELETE /agents/{id}/logs, GET /logs/after** — agent log access and clearing.
- **POST /agents/{id}/state** — move live display state.

### HTTP API — Agent Content & Config

- **GET/PUT /agents/{id}/config** — read/replace agent config.
- **GET/PUT /agents/{id}/document** — primary document content.
- **GET/PUT /agents/{id}/mind** — mind file content.
- **GET/PUT/DELETE /agents/{id}/files/content, GET /files** — file CRUD.
- **POST /files/rename, /files/rename-folder** — rename file or folder prefix.
- **PATCH /files/protection, /files/authorized** — set file protection level / authorized-code flag.
- **GET/DELETE /agents/{id}/inbox, GET /outbox** — message queues.
- **GET/POST/PUT/DELETE /agents/{id}/timers** — timer CRUD.
- **GET /agents/{id}/umbilical/events** — in-memory umbilical replay catch-up.
- **GET /agents/{id}/usage** — token usage from persisted loop rows.
- **GET/PUT/DELETE /agents/{id}/meta/{key}, PATCH /meta/{key}/protection** — metadata store with protection.
- **GET/DELETE /agents/{id}/tables/{table}** — local table query/drop (`local_*` + `adf_audit` only).

### HTTP API — Identity & Credentials

- **GET /agents/{id}/identities, /identity, /identity/entries** — identity metadata without secret values.
- **GET/PUT/DELETE /agents/{id}/identity/{purpose}** — metadata read (never the value) / write (`replace: true` discards a locked sealed value) / delete.
- **PATCH /identity/{purpose}/code-access** — gate code-execution readability of a key.
- **DELETE /agents/{id}/identity-prefix** — bulk delete by purpose prefix.
- **GET/PUT/DELETE /agents/{id}/identity/password** — legacy manual password status/set/remove.
- **POST /identity/password/unlock, /password/change** — unlock and rotate manual password.
- **GET /agents/{id}/identity/did** — read agent DID.
- **POST /identity/generate-keys** — generate identity signing keys.
- **POST /identity/wipe** — wipe all identity rows.
- **POST/DELETE /agents/{id}/providers[/{id}]** — attach/detach agent-level provider config.
- **PUT/GET /providers/{id}/credential[s]** — set/read provider API key.
- **GET/PUT /mcp/credentials** — MCP credentials by package.
- **POST/DELETE /mcp/servers[/{name}]** — attach/detach MCP server + credentials.
- **GET/PUT /adapters/credentials, DELETE /adapters/{type}** — adapter credential and detach.

### HTTP API — Tasks, HIL & Runtime Diagnostics

- **GET /agents/{id}/tasks, /tasks/{id}, POST /tasks/{id}/resolve** — list/read/resolve HIL approvals.
- **GET /agents/{id}/asks, POST /asks/{id}/respond** — pending `ask` request workflow.
- **POST /agents/{id}/suspend/respond** — resume/stop after a suspend request.
- **GET /agents/{id}/runtime, /runtime/adapters, /runtime/mcp, /runtime/triggers, /runtime/ws** — per-agent diagnostics (aliased at `/adapters`, `/mcp`, `/triggers`, `/ws`).
- **POST /agents/{id}/runtime/adapters** — attach/update adapter config.
- **GET /runtime, /runtime/providers, /runtime/auth, /runtime/settings, /runtime/mcp, /runtime/adapters, /runtime/network, /runtime/usage** — daemon-wide diagnostics.
- **GET /runtime/models** — list models for a configured provider.
- **POST /runtime/token-count[/batch]** — token counting utility.
- **GET /diagnostics** — legacy daemon diagnostics.

### HTTP API — Auth Endpoints

- **GET /auth/chatgpt/status, POST /start, /complete, /logout** — ChatGPT subscription OAuth (detached/relay flow).
- **GET /auth/grok/status, POST /start, /logout** — Grok (xAI) device-code subscription auth.

### HTTP API — Compute & Package Admin

- **GET /compute/status, /containers, /containers/{name}, /exec-log** — compute environment and container introspection.
- **POST /compute/start, /stop, /destroy, /setup** — shared compute lifecycle control.
- **POST/POST/POST /compute/containers/{name}/start|stop|destroy** — per-container control.
- **GET/POST/DELETE /admin/mcp/packages/npm, /python** — install/uninstall MCP packages.
- **GET /admin/mcp/packages** — list installed MCP npm/Python packages.
- **GET/POST/DELETE /admin/adapters/packages** — adapter npm package management.
- **GET/POST/DELETE /admin/sandbox/packages, POST /packages/check** — sandbox package install/manifest check.

### HTTP API — Network & Mesh

- **GET /network, /network/mesh, /network/server** — daemon/mesh/HTTP-server diagnostics.
- **POST /network/mesh/enable, /disable** — toggle mesh registration.
- **GET /network/mesh/recent-tools, /lan-addresses, /discovered-runtimes** — mesh tool-call log, LAN addresses, discovered peer runtimes.
- **POST /network/server/start, /stop, /restart** — mesh HTTP server control.

### Podman / Container Execution

- **Detect-and-guide install model** — Podman is not bundled; `podman-bootstrap.ts` detects binary, version, and VM-machine state, offering install/start guidance (incl. WSL prerequisite on Windows).
- **PodmanService** (2400+ lines) — shared and per-agent container lifecycle, exec, file transfer, browser/CDP integration, package install, exec logging.
- **Shared compute container** — default Debian-based Node image with configurable CPU/memory (`machineCpus`, `machineMemoryMb`, `containerImage`, `containerPackages`).
- **Isolated per-agent compute** — `config.compute.enabled` starts a dedicated container and workspace mount for that agent.
- **compute_exec / fs_transfer tools** — always registered by the daemon builder; report actual available targets even when compute is absent.
- **Host access two-tier gate** — `compute.host_access` (agent) plus daemon-wide `hostAccessEnabled`/`hostApproved` list; approved-by-source-package matching prevents name-squatting host grants.
- **External execution targets** — `execution-target-settings.ts` resolves persisted Docker/Podman container targets into safe runtime aliases (`local-container` kind), with allowlist/default-target mapping.
- **Container command resolver** — builds in-container MCP server commands (`npx`, `uvx`, custom) distinct from host path resolution; Playwright MCP auto-substitutes archived Puppeteer server with managed CDP endpoint.
- **MCP container routing** — `shouldContainerize()` defaults every MCP server to the shared container unless `run_location:'host'` plus both host-access gates pass; `isServerForceShared()` lets a server override agent-level isolation.
- **Container exec log** — `/compute/exec-log` HTTP endpoint and in-memory `ContainerExecLogEntry[]` history.
- **VFS airlock file transfer** — host↔container file movement via dedicated read/write/copy helpers rather than shared filesystem mounts.
- **Browser/CDP compatibility selection** — `selectBrowserRuntimeCompatibility()` picks Chromium/driver behavior per host.
- **Container package installer** — sandbox package install/uninstall/manifest-check surfaced through `/admin/sandbox/packages*`.
- **Setup/bootstrap step endpoint** — `POST /compute/setup` runs bootstrap phases (machine init, package installs) incrementally.

### Firewall (LAN Discovery)

- **Two inbound rules** — TCP mesh port (`ADF Mesh (LAN)`) and UDP 5353 (`ADF mDNS (LAN)`), named consistently across runtime check, elevated apply, and NSIS installer.
- **Cross-platform state check** — `checkLanFirewall()`: Windows via `Get-NetFirewallRule` (no elevation), macOS reports per-app firewall as unknown (no reliable read), Linux detects `firewalld`/`ufw` and queries port state where readable without root.
- **Reachability self-probe** — fetches own LAN IP's `/agents` endpoint with a 2s timeout to confirm the mesh server is LAN-bound (note: same-host probes bypass Windows firewall, so this doesn't prove peer reachability).
- **Elevated apply flow** — Windows UAC via `Start-Process -Verb RunAs`, macOS AppleScript admin prompt via `socketfilterfw`, Linux `pkexec`; each maps user cancellation to a distinct `declined` result.
- **Idempotent rule creation** — removes any stale rule (including a shadowing Block rule) before recreating; program-scoped to the app binary only.
- **NSIS installer firewall rules** — `resources/firewall-installer.nsh` adds rules at elevated install time so LAN discovery never needs a runtime UAC prompt.
- **RFC1918 LAN IP selection** — `firstLanIpv4()` picks the first private IPv4 address as the peer-reachable address.

### Security Architecture — Trust Boundaries

- **Renderer-to-main isolation** — `contextIsolation`, `sandbox`, `nodeIntegration:false`, strict CSP (`script-src 'self'`, `connect-src` localhost-only, `frame-src`/`object-src 'none'`), DOMPurify on LLM/message markdown, `will-navigate` blocked, `shell.openExternal` protocol allowlist.
- **Sandbox-to-main (code execution)** — Worker Thread + V8 VM context; `codeGeneration.strings:false`, frozen built-in prototypes, deleted `fetch`/`Request`/etc. (only reachable via `adf.sys_fetch`), module allowlist, execution timeout (default 60s, ceiling `min(configured,300s)`, 10s bare fallback), RPC-bridge tool-call validation.
- **Network boundary** — mesh server binds `127.0.0.1` by default (`meshLan` opt-in), Ed25519 envelope/payload signature verification, configurable `allow_unsigned`, DID allow/block lists, inbox middleware pipeline.
- **External process boundary (MCP/packages)** — blocked env vars (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `LD_PRELOAD`, etc.), health-check auto-restart (60s/10s), 120s connect timeout, native-addon-install blocking (`binding.gyp`/`node-gyp`/`gypfile` scan), per-package 50MB / total 200MB size limits.
- **Settings-install vs agent-install trust split** — a user-initiated Settings MCP install defaults to host with a persistent host badge; an agent-initiated `mcp_install` defaults to container and needs the two-tier host gate.
- **Storage boundary (`.adf` files)** — dangerous tools (`adf_shell`, `ws_*`) off by default, `sys_fetch` on but egress-guarded, `restricted` tools auto-HIL and blocked from unauthorized code, AES-256-GCM identity encryption (PBKDF2 100k/SHA-512), `code_access` per-key gate, file protection levels (`read_only`, `no_delete`).

### Security Architecture — Access Control & Guards

- **Three-flag tool access model** — `enabled` gates execution, `visible` gates only LLM schema advertisement, `restricted` triggers HIL from the loop and blocks unauthorized code entirely.
- **`locked` fields** — prevent agent self-modification of a tool's config via `sys_update_config`.
- **Self-modification protection** — agents can toggle `enabled` on unlocked tools but can never modify `restricted`, `restricted_methods`, or `locked`.
- **Hard-denied guard-system config** — `security.allow_unsigned`, `security.require_middleware_authorization`, `security.middleware.*`, `security.fetch_middleware`, and wholesale `security` replacement are unreachable via `sys_update_config` (plain error, no HIL, no override).
- **Locked-by-default dangerous capabilities** — `security.allow_local_fetch` and `stream_bind` gates are locked for every agent, requiring a deliberate owner override.
- **Excluded-from-code tools** — `say` and `ask` cannot be called from `sys_code`/`sys_lambda` at all.
- **Gate-able code-execution methods** — `model_invoke`, `sys_lambda`, `task_resolve`, `loop_inject`, `identity_status`, `get_identity`, `set_identity`, `emit_event`, `attestation_list/add/issue`; restrictable via `code_execution.restricted_methods` (default `['attestation_issue']`, replaces not merges).
- **SQL access control matrix** — system tables read-only/blocked by table pattern, `local_*` full access, identity/config/meta blocked entirely, PRAGMA table-valued functions blocked, comment/literal stripping before validation.
- **Shell command AST pre-flight** — tokenizes/parses before execution, checks each resolved tool (including redirects) against tool declarations, disabled→126, restricted→HIL/130, `execFile` array args (no shell injection).
- **sys_fetch/ws_connect SSRF egress guard** — default-denies RFC1918/CGNAT/unspecified/link-local; loopback allowed except the daemon control API (hard-blocked always); DNS-resolved-address and per-redirect-hop rechecking; `security.allow_local_fetch` overrides only the overridable tier.
- **Verification-meta stamping** — `identity_verified`/`payload_encrypted`/`message_verified`/`ws_remote_did` stripped from wire input and stamped only by the ingress pipeline post-verification; `source:'user'` rejected on `POST /trigger`.
- **Default security posture** — autonomous mode off, messaging receive off, mesh loopback-only, dangerous tools off, `allow_unsigned:true`, identity encryption opt-in.

### Identity & Attestation

- **Three-tier DID identity** — Owner (BIP-39 seed, SLIP-0010 Ed25519 `m/44'/0'/0'`), Runtime (fresh per-install Ed25519, never seed-derived), Agent (Ed25519 `did:key` per `.adf`, mandatory at creation).
- **Owner X25519 encryption key** — separate sibling-path key (`m/44'/0'/1'`) for envelope keyslots, distinct from the signing key; only public half stored.
- **Seed phrase backup/recovery** — OS-keychain-encrypted storage (Electron safeStorage) with plaintext fallback warning; multi-machine import converges owner DID and triggers envelope re-wrap.
- **Runtime delegation certificate** — owner-signed cert proving a runtime install acts on the owner's behalf; never a trust anchor itself.
- **DID rotation/history** — claiming/re-keying mints a new DID, appends old DID to `adf_did_history`, keeps lineage resolvable without rewriting child files.
- **Three identity-data layers** — key material (`adf_identity`, sealed), runtime-asserted facts (`adf_meta`, unsigned/local-trust), signed proofs (`adf_attestations`, verifiable).
- **Dual-envelope keyslot encryption** — LUKS/age-style: random DEK per envelope, wrapped per keyslot (owner/runtime/optional share-password); Identity envelope never gets a password slot.
- **Envelope states** — Protected, Password locked, Foreign, Not protected.
- **Daemon credentials-envelope trust** — headless daemon writes its own X25519 keypair to `runtime-enc-key` (0600); Studio operator adds the daemon's public key to `trustedDaemonEncKeys` to grant per-agent credential decryption; revocation strips the daemon's `daemon:<fingerprint>` slot on next Studio unlock.
- **Agent sharing flow** — share-password slot on the credentials envelope only, arrival-dialog capability review + claim step, re-wrap to recipient's keys; password slot is retained post-claim (corrected), removable only via the explicit share-password control.
- **Foreign-agent claim flow** — four-scenario classification (yours / yours-other-install / foreign-owner / no-identity); claiming mints fresh keys, records `adf_did_history`, issues an owner-signed `clone` attestation, drops cryptographically-dead foreign credential envelopes.
- **AttestationService** — signs/verifies Ed25519 certs over canonical JSON (subject included, non-replayable); reserved roles (`owner`,`operator`,`runtime`,`clone`,`rotation`) runtime-only; `REPLACEABLE_ROLES` (`owner`,`operator`) replaced wholesale on re-key, others append-only.
- **Peer attestations** — agent-negotiated trust via `attestation_list`/`attestation_add`/`attestation_issue`; `attestation_issue` is authorized-code-only by default.
- **Card publishing opt-in** — `card.publish_attestations` (agent-writable, HIL-gated) controls whether attestations appear on the public agent card.
- **Identity store (`adf_identity`)** — general-purpose secret store; `crypto:signing:*`/`crypto:envelope:*`/`crypto:kdf:*` never code-readable regardless of `code_access`.
- **Legacy manual password protection** — whole-file lock distinct from envelopes; only case where Studio prompts for a password on open.
- **Message security levels** — level 1 Signed (default) and level 2 Encrypted (DID-derived recipient encryption, no key exchange).
- **Cryptography spec table** — AES-256-GCM (encryption), X25519 ECDH+HKDF-SHA256 (envelope wrap), scrypt N=2^17 (share-password KDF), PBKDF2 100k/SHA-512 (legacy KDF, read-only support), Ed25519 (signing), `did:key` (agent identity format).

### Authorized Code Execution

- **File-level `authorized` flag** — boolean on `adf_files`, settable only by owner (Studio UI) or already-authorized code (gateway pattern).
- **Write-deauthorizes invariant** — any `fs_write` to an authorized file unconditionally sets `authorized=0` at the DB layer.
- **Execution-context authorization rules** — trigger/timer/middleware lambdas inherit file flag; loop-invoked `sys_lambda` on an authorized target requires HIL; inline `sys_code` is always unauthorized; unauthorized callers cannot invoke authorized `sys_lambda` targets (`REQUIRES_AUTHORIZED_CALLER`).
- **`AsyncLocalStorage`-scoped authorization context** — `withAuthorization()`/`currentAuthorization()` in `authorization-context.ts` scopes the flag per async call chain, preventing parallel/nested sandbox clobbering.
- **`_authorized` internal flag propagation** — `adf-call-handler` injects a cross-cutting `_authorized:true` param only it can set; LLM tool calls always strip it.
- **Authorized-code protection bypass** — can overwrite/delete `read_only`/`no_delete` files and protected meta keys, and change protection levels — equivalent to owner-via-UI.
- **Task-level authorization** — `requires_authorization` flag on `adf_tasks`, set once by a trigger lambda via `task_resolve`, cannot be unset; distinct from method-level restriction.
- **Governance patterns** — multi-agent quorum approval, remote authorization gateway (`authorize_file` chained trust), secure middleware pipeline gated by `require_middleware_authorization`.
- **Error codes** — `REQUIRES_AUTHORIZED_CODE`, `REQUIRES_AUTHORIZED_CALLER`.

### Guard System & Runtime Gate

- **`RuntimeGate` kill switch** — process-wide `stopped`/`tearingDown` flags consulted by every turn/timer path; `resume()` becomes a permanent no-op once `beginTeardown()` is called.
- **Scope resolver** — classifies remote socket addresses into `directory`/`localhost`/`lan`/`public` tiers (RFC1918, CGNAT-as-tailnet-lan, link-local, IPv6 ULA); `permits()`/`denialReason()` enforce agent `Visibility` settings.
- **Ancestor-directory scope** — same-runtime message delivery scoped by `.adf` file directory ancestry, degrading to `localhost` for untracked senders.
- **Execution-context provenance** — `AsyncLocalStorage`-backed `withSource()`/`currentSource()` tags every umbilical event with `agent:<turn_id>`/`lambda:<file>:<fn>`/`system:<subsystem>`; dev-mode throws on missing wrap.
- **Lifecycle characterization ledger** — closed migration ledger (9 findings: 6 `fixed`, 3 `declaredByProfile`, 0 `pending`), no `pending` status type member; CI independently verifies terminal counts.
- **Architecture fence in CI** — production-source scan fails if removed ownership-bridge identifiers or the raw-adoption helper reappear; enforces single `AgentExecutor` construction site and single evaluator dispatch path.

### Packaging & Release

- **electron-builder multi-target packaging** — macOS (dmg+zip, arm64 + universal), Windows (NSIS x64), Linux (deb + AppImage x64).
- **`npm version <patch|minor|major>`** — single-command release: bumps `package.json`, commits, tags, and (via `postversion`) pushes with `--follow-tags`.
- **Tag-triggered CI release** — `release.yml` matrix builds on `macos-14`/`windows-2022`/`ubuntu-latest`, blocks publish until all three succeed, then flips a draft GitHub Release live.
- **Windows runner pinned to `windows-2022`** — `windows-latest`/2025 ships VS2026, which the pinned node-gyp can't detect for the `node-pty` native rebuild.
- **macOS universal dmg** — arm64-native build plus a `--arm64 --universal` lipo-merged build; single-arch prebuilt deps (`sqlite-vec`, `esbuild`, `@lydell/node-pty`) exempted via `x64ArchFiles` and pre-installed via `scripts/install-mac-x64-deps.mjs`.
- **macOS code signing + notarization** — Developer ID Application cert (`CSC_LINK`/`CSC_KEY_PASSWORD`), Apple notarization (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`); local builds sign but skip notarization without the Apple env vars.
- **Windows Azure Artifact Signing** — CI-only `electron-builder.win-sign.yml` overlay adds `azureSignOptions`/`forceCodeSigning`; short-lived Microsoft-managed cert avoids SmartScreen reputation ramp; local Windows builds stay unsigned.
- **Post-build signature verification** — CI runs `Get-AuthenticodeSignature` over every `.exe`, fails the job unless `Valid` and signed by the expected CN.
- **Draft-then-publish release flow** — installers upload to a draft release; `publish` job generates notes via `scripts/release-notes.mjs` (grouped by conventional-commit prefix) and flips the release live only if all matrix builds pass.
- **In-app auto-update** — checks GitHub Releases (`latest*.yml`) on launch and every hour; badge-driven, user-initiated download+restart; macOS uses signed zip (Squirrel.Mac), Windows silent NSIS, AppImage self-swap, `.deb` via `pkexec`-gated `dpkg -i`; `src/main/services/app-updater.service.ts`.
- **Local update-path testing harness** — documented two-build + local HTTP feed procedure using `ADF_INSTANCE`/`ADF_UPDATE_FEED_URL` (real single-instance app never honors the feed override).
- **NSIS firewall installer hook** — `resources/firewall-installer.nsh` opens LAN discovery ports at elevated install time.
- **CI verify workflow** — `npm ci --ignore-scripts` + explicit `better-sqlite3` rebuild for Node ABI, `npm test`, lifecycle-conformance test with verbose ledger assertion, `typecheck` (doubles as capability-profile completeness gate), `lint`, `build`.

### Lifecycle Assembly Contract

- **Single `AgentExecutor` construction call site** — `assemble-agent.ts`; reusable per agent, not a singleton constraint.
- **Five capability profiles as exhaustive data** — `studioForeground`, `studioBackground`, `daemon`, `headlessLive`, `benchmark`; `AGENT_CAPABILITIES` union forces every profile to declare every capability at typecheck time.
- **`attachHost()` handle reattachment** — framework-neutral, idempotent detach token; Studio window reattach and daemon client reconnect are the same operation on a running agent.
- **Direction-sensitive workspace-close ownership** — background ownership closes the workspace on disposal; foreground leaves it for Studio's document lifecycle.
- **Five lifecycle states** — `created`, `starting`, `running`, `stopping`, `stopped`, `disposed`; idempotent/concurrency-safe transitions.
- **Conditional sync `dispose()`** — exposed only on sync-safe headless/benchmark types; a runtime invariant rejects any profile enabling MCP/adapters/taps claiming sync-safety.
- **Three shutdown modes** — normal (grace period, `DEFAULT_STOP_GRACE_MS=5000`), owner-off (immediate abort), emergency (immediate abort).
- **Checkpoint recovery conformance fence** — every profile must pass seeded stale-checkpoint recovery; CI retains a real child-process crash/reopen test permanently.

### Evals & Testing Harnesses

- **Headless performance harness** (`scripts/stress-runtime.mjs`, `npm run stress:runtime`) — mock-provider synthetic load, `benchmark` profile, disables timer polling.
- **Six stress scenarios** — `smoke`, `overhead`, `idle`, `mixed`, `burst`, `all`.
- **Metrics collected** — turn count/latency (p50/p95/p99/max), event-loop lag, RSS/heap peak+avg, active timer-handle peak, provider call count.
- **`RUN_BENCH=1` gated benchmark test** — `tests/perf/stress-harness.test.ts` kept out of normal `npm test` runs.
- **Agentland Evals design proposal** (`docs/design/agentland-evals.md`) — ~58-eval capability benchmark across 10 areas (document stewardship, memory discipline, tool selection, timers/triggers, mesh, HIL judgment, self-configuration, lifecycle/recovery, adversarial robustness, serving/compute).
- **Deterministic SQL-first scoring philosophy** — assert directly on `adf_loop`/`adf_inbox`/`adf_outbox`/`adf_files`/`adf_config`/`adf_timers`/`adf_tasks`/`adf_audit`/`local_*` since every agent is a SQLite file.
- **Three provider-mode harness design** — `ScriptedProvider` (deterministic tool sequences), `CompliantAttackerProvider` (establishes injection-resistance harness floor), pinned real cheap model (rubric scoring).
- **`RUN_EVAL=1`/`EVAL_OUT=` gating** — proposed, mirrors the existing `RUN_BENCH` perf-path convention.
- **Documented harness traps** — `POST /trigger` bypasses TriggerEvaluator; `/tables/:table` only serves `local_*`+`adf_audit`; `adf_loop.tokens` is JSON-in-TEXT; `DELETE /chat` doesn't reset context state; unbounded HIL hang risk on the daemon.
- **Standard eval metrics block** — outcome/tokens/cost_usd/effort/latency_ms/efficiency with defined regression-alert thresholds.
- **Recommended starting 8-eval set** — M-1, M-6, SE-1, T-3, ME-1, H-2, ADV-5, DS-2 (covers every harness primitive once).
- **ADV-5 (ssrf/loopback-daemon-selfescalation)** — headline adversarial eval for the unauthenticated-daemon-via-`sys_fetch` attack path, flagged highest severity-per-build-effort.
- **Bug/doc-gap register** — 14 code bugs tracked as fixed in this branch; 3 residual/deferred items (adapter display-name spoof, spec version drift, dead `code_execution.network` field).
- **Daemon-specific unit test suite** — `tests/daemon-*.test.ts` (mesh-serving, node-runtime, host, event-bus, cli, api), `runtime-service.test.ts`, `runtime-gate.test.ts`, `agent-runtime-builder.test.ts`, `background-agent-manager.test.ts`, subscription/auth-relay/token-store tests.

### Adapter / Channel Security

- **Credential isolation** — adapter credentials live only in `adf_identity` under `adapter:{type}:{KEY}`, never in daemon settings; a missing identity row fails the adapter plainly with no fallback.
- **Built-in adapter types** — `telegram`, `email`, always available even without a settings registration.
- **External adapter loading** — npm-package adapters resolved via settings `npmPackage` field.
- **Blocked env vars for MCP child processes** — shared with the sandbox external-process boundary (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH`).
