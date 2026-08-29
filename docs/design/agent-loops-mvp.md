# Agent Loops — MVP build plan

> **Implementation status (2026-08-29):** S1 + S2 are implemented on this branch through commit `f466fae` (waves: `9ded83f` S1+config → `75d965f` tools/renderer/tests → `466b94c`+`b465e69` adversarial-review fixes → `2d1ba3b` runtime integration → `f466fae` runtime-review fixes). Six adversarial review passes ran; all confirmed findings fixed. `docs/design/agent-loops-wave3-brief.md` records the accumulated runtime requirements and accepted deviations (delete both notes before merge to main). Deltas from this plan as written: `loop_compact`/`loop_clear` default-on means host-enabled-and-unrestricted (restricted default-ons are not granted); side loops get `packages: []` (inheritance was worldly authority); per-loop model overrides are same-provider only (cross-provider → F3); `LoopInfo` has no `mode` (F3); config changes apply to side loops immediately, not at turn boundaries (revocations bite at the next model call). Known follow-up: several hand-rolled config fan-out sites (MCP tool sync, visibility toggles — see f466fae commit discussion) share the staleness class C2 fixed for the main save paths.

**Companion to** `docs/design/agent-loops.md` (the full Tier‑1 spec — the *why*). This is the *what to build*: the minimal, feature-complete, genuinely-secure multi-loop agent, after four adversarial reviews against the real tree.

**Verified against `main` @ `0fcb7a5` (v0.4.7).**

**Loops (facets)** = multiple named cognition streams inside one agent, sharing its file, identity, credentials, and substrate. `main` is the membrane-facing mind; side loops are interior organs (reflector, consolidator, critic) the operator *or the agent itself* configures. The governing rule: **a loop inherits the whole agent and overrides a small delta; it never gets its own identity, credentials, or channels.** The moment it needs those, it is a Tier‑2 mount — a different spec.

Two milestones (**S1**, **S2**) ship a workable agent; fast-follows **F1–F3** add polish, side-loop privilege escalation, and true serialization. §14 records the adversarial-review evidence behind every non-obvious decision.

---

## 0. Corrections to the original spec (`agent-loops.md`)

The spec was written against an older tree. Verified deltas:

| Spec says | Reality @ 0fcb7a5 |
|---|---|
| Schema `24 → 25` | Schema is **28** → migration is **28 → 29** (`ADF_LATEST_SCHEMA_VERSION`, `adf-database.ts:92`) |
| `adf_loop` has 6 columns | Also has **`ord`** (nullable position override for compaction, `adf-database.ts:1715`) |
| Loop DML "12 sites" | ✅ still centralized in `adf-database.ts` (~12 prepared statements, `2307-2337`/`2489-2495`/`2965`). No other file issues SQL against `adf_loop`. Chokepoint holds. |
| `insertAudit` callers | ✅ 3 (`adf-workspace.ts:1117/1386/1625`) — `loop:<name>` rename is trivial |
| §5.3 inherit-and-subtract tools | **Superseded** → explicit allow-list + attenuation (§2, §7) |
| §7.2 hard membrane routing | **Superseded** → uniform router, convention not mechanism (§6) |
| §6.4 "true concurrency is the hard part (M5)" | **Inverted** → concurrency is the *easy default*; serialization is the hard extra (§3) |

Two things the spec did **not** flag, both load-bearing:
- **`loopRevision`** (`adf-database.ts:339-347`) is a *global* mutation counter used as the compaction-abort guard (`adf-workspace.ts:1075-1087`). With >1 loop it must become per-loop **with bump-all on whole-table ops**, or compaction commits into a wiped table (§4.2, RT-F5).
- **`code_execution`** is a config section (`adf-v02.types.ts:338`, all default `true`) *orthogonal* to the tool allow-list — the real security seam (§2, SEC-1).

---

## 1. Core idea: `LoopScopedWorkspace` via an in-class `forLoop()` factory

Every tool receives a workspace (`Tool.execute(input, workspace)`, `tool.interface.ts:24`); `AgentSession` holds one (`agent-session.ts:36`). Hand a side loop's executor a **loop-scoped workspace** and, *without touching a single call site*:

- `appendToLoop` / `getLoop*` / `clearLoop` / `replaceLoop` → auto-filtered to this loop's stream
- `insertLog` (~30 sites) / `insertTask` → auto-stamped with `loop`
- `insertAudit` → source auto-becomes `loop:<name>`
- `setTimer` → auto-stamped with `loop` (**forced**, not default-when-absent — SEC-2)
- `querySQL` / `executeSQL` (`adf-workspace.ts:1956,1960`, the only two raw-SQL entries) → available for later per-loop table grants (deferred, §12)

**It cannot be a standalone wrapper (IMPL-3/RT-F5).** `AdfWorkspace` is nominally typed with private fields (`envelopeDeks`, `onFileChangeCallback`, caches, `:171-186`). A naïve subclass gets its *own empty* `envelopeDeks` → sealed-credential reads silently return null; its own null file-change callback → side-loop writes never notify Studio. So this is an **in-class `AdfWorkspace.forLoop(name)` factory** that shares deks/callbacks/caches and only overrides the `loop` binding. The per-file destructive mutex (`:1003`) and `.bak` naming stay keyed by **file**, not loop.

This is a cost-*reducer*: without it the work re-inflates to threading `loop` through ~30 `insertLog` sites and every tool path. `main` gets `forLoop('main')` too — uniform, no `?? 'main'` scattered around.

---

## 2. Security model: attenuate, don't prohibit

Side loops are LLMs with a restricted toolset. Enforcement rests on the **derived config** (allow-list + attenuated `code_execution`) and the **scoped workspace**. Code execution is the core ADF pattern — introspection/consolidation loops *must* run code to search, filter, and process the ADF body without dragging every byte through the LLM's context — so the model attenuates the dangerous seams rather than banning code.

### 2.1 Tool allow-list (§7 details resolution)

`effective(loop) = (loop.tools ∩ host-enabled) ∪ ESSENTIALS`, an **absolute allow-list** named at creation. No presets, no add/remove diff, **no per-loop visibility** (in the set → in the schema; a side loop is meant to be minimal). `main`'s session visibility toggling never affects side loops.

**Prohibited from `loop.tools`** (Zod-reject): `sys_update_config`, `loop_manage`, `sys_create_adf`, and every `restricted` tool. Rationale:
- No `sys_update_config` → no config self-escalation (SEC-9).
- No `restricted` tool → no HIL approval ever parks on a side-loop executor, whose approval channel the filePath/singleton-keyed IPC can't reach (IMPL-2/RT-F11). This defers loop-aware HIL to F2 at zero MVP cost.

### 2.2 `code_execution` attenuation (the real SEC-1 fix)

`code_execution.*` dispatches off `config.code_execution` (`adf-call-handler.ts:213`, all default `true`) — a section the tool allow-list never touched. That orthogonality, not code exec, was the skeleton key. `deriveLoopConfig` gives side loops a locked profile:

| method | side loop | rationale |
|---|---|---|
| `model_invoke`, `sys_lambda`, `identity_status`, `loop_inject`, `emit_event` | **allow** | process the body, invoke models, read envelope *state*; **`emit_event` = the inter-loop signal bus** (a loop emits `custom.*`, others subscribe via an event-type trigger with `target.loop`) |
| `get_identity` / `set_identity` | **deny** | credential exfil (SEC-3) |
| `task_resolve`, `attestation_*`, `network` | **deny** | cross-loop task hijack (SEC-6); egress; already opt-in |

This lands side-loop code at the same trust level as the existing `compute_exec`/MCP code-exec escape hatches (code without identity) — consistent, not a new hole. Further bounded by the scoped workspace.

> **`emit_event` residual (SEC-7, accepted):** an emitted event may reach operator-configured umbilical taps that forward externally — but the loop *chooses no recipient* (it writes to the bus; egress is tap policy) and, with `get_identity` denied, has no secrets to leak. Per-loop tap filtering is a later refinement.

### 2.3 The one hard boundary: no side-loop system lambdas

Side loops run code **inline during their own turn** (through the loop's own attenuated `AdfCallHandler`), but may **not create system-scope lambda *timers*** (`sys_set_timer` with a `lambda` target). System lambdas fire through the single agent-wide `SystemScopeHandler`, keyed by file authorization not loop, so a loop-created one would run under *main's* authority (SEC-2/5). The loop doesn't need it — a trigger/timer wakes it and it runs its code in the resulting turn. This keeps `SystemScopeHandler` per-loop routing and capability-follows-provenance out of the MVP (→ F2).

### 2.4 What stays hard (mechanism, not convention)

1. **Attenuation** — a loop's tools/`code_execution`/tables ⊆ host's. `loop_manage` enforces it at create time; `deriveLoopConfig` intersects at derive time. Essentials (interior-only) are the sole exception.
2. **`main` exists, is not deletable**, is the fallback target for anything unaddressed.
3. **Provenance** — every send/log/task/audit/emit records its originating loop. `loop_send` content is stamped `[from loop:<sender>]` (audit-only; SEC confirmed spoofable — not a prompt-injection defense; the mitigation is that main's HIL still gates any action it takes on the suggestion).
4. **`msg_send` from side loops** — allowed by grant, omitted by default (convention). One DID means it sends *as the agent* anyway; no protocol reason to hard-block, only style.

The confused-deputy channel (`loop_send` to main: "send this for me") is deliberately open — main is an LLM, persuadable, but the ask is visible and main's HIL gates the resulting action. Attenuation + audit, not isolation.

---

## 3. Concurrency: concurrent-by-default (no semaphore)

The spec's `max_concurrent:1` "in the gaps" model is **unimplementable as written** (RT-F1): `AgentExecutor` self-schedules successor turns via `process.nextTick` (`agent-executor.ts:2986`, `:586-594` — "never pass through dispatch()'s choke point"), so a scheduler-level semaphore cannot enforce serialization and "main gets priority" is impossible. It also makes the spec's "agent-executor: no structural change" false, and leaves cross-loop queue ownership / interrupt-of-queued-loop undefined (RT-F2/F3).

**Resolution: let per-loop executors run concurrently.** Each keeps its *existing* self-queue. `better-sqlite3` is synchronous → no torn writes; the seconds-long LLM round-trips overlap, which is the actual win. This sidesteps the semaphore, the cross-loop queue, priority admission, and all re-entrancy surgery — `agent-executor.ts` is genuinely unchanged. Token spend is uncontrolled, but it already is today (no enforcement exists); budgets stay a later milestone. **Serialization (`max_concurrent`) becomes the hard F3 extra, not the default.**

---

## 4. Data model (S1)

### 4.1 Schema migration `28 → 29`

| Table | Change |
|---|---|
| `adf_loop` | `+ loop TEXT NOT NULL DEFAULT 'main'` · `+ INDEX (loop, seq)` |
| `adf_timers` | `+ loop TEXT` (nullable → `main`) — the timer→loop wake |
| `adf_logs` | `+ loop TEXT` (nullable = system/`mcp`/`adapter`) — kept so early logs are attributable; filter UI deferred (F1) |
| `adf_tasks` | `+ loop TEXT` (nullable) — same |
| `adf_audit` | **none** — `source` is free text; convention → `loop:<name>` |

Guarded-ladder pattern: `PRAGMA table_info` idempotent adds, `CREATE INDEX IF NOT EXISTS`, bump `adf_meta.adf_schema_version` to `'29'`, bump `ADF_LATEST_SCHEMA_VERSION = 29`, raise the pre-migration backup threshold. **No `adf_loops` state table** — status is in-memory, definitions live in config, ticks are driven by persisted `adf_timers` (the table returns in F3 with budgets).

> Index note: `ORDER BY COALESCE(ord, seq)` (compaction path) can't use the new index and scans; per-loop streams are smaller than today's monolith, so it's a net win. Don't chase it.

### 4.2 `adf-database.ts` — thread `loop` through the ~12 statements

`getLoopEntries`/`-Limited`/`-Before`, `getLoopCount`/`-Before`, `appendLoopEntry`, `clearLoop`, `getLoopSeqs`, `getLoopEntriesBySeqRange`, `deleteLoopBySeqRange`, `getLastAssistantTokens`, and the chunked `DELETE ... WHERE seq IN (...)` (`:2965`). Each gains a **required** `loop: string` (not defaulted — force explicitness; only the facade calls them, so it costs nothing and prevents the silent-leakage bug). `insertLog`/`insertTask`/`insertTimer` gain an optional `loop`.

**`loopRevision` → `Map<string, number>`** with `bumpLoopRevision(loop)`/`getLoopRevision(loop)`. **Critical (RT-F5):** whole-table ops (`clearLoop` wipes all streams `:2918`; `replaceLoop` = clear+reinsert `adf-workspace.ts:1174`) must **bump every key**, or a side loop's in-flight compaction guard reads "unchanged" and commits its summary into a wiped table. Keep a global epoch checked alongside the per-loop counter.

### 4.3 `adf-workspace.ts`

`loop` param on the wrappers (mechanical); `insertAudit('loop', …)` (`:1117`) → `insertAudit('loop:' + loop, …)`. Compaction guard reads the per-loop revision; the destructive mutex stays keyed by **file**. `compactLoop`'s `ord = min(preserved ord)-1` is per-loop-safe once the reads are filtered (RT-F7).

---

## 5. Config model (`adf-v02.types.ts` + `adf-schema.ts`)

```ts
// AgentConfig — one optional field; single JSON blob, no storage migration
loops?: LoopConfig[]                 // side loops only; 'main' implicit

interface LoopConfig {
  name: string                       // unique; 'main' forbidden
  goal: string                       // → derived config's `instructions`
  enabled: boolean
  model?: ModelConfig                // inherits parent if absent
  tools?: string[]                   // absolute allow-list (§2.1); essentials implicit
}

// TriggerTarget
loop?: string                        // absent → 'main'; '*' deferred to F3
```

Read-time backfill defaults `loops` to `[]` → existing agents byte-identical. `AGENT_DEFAULTS.loops = []`. **Not in MVP:** `mode`/`pacing` (an `on_timer` trigger with `target.loop` *is* a background loop, using shipped machinery), `grants`, `locked`, `loops_runtime`, `AuditConfig.loops` — all F3.

### 5.1 `deriveLoopConfig(parent, loop)`

```
id/handle/identity/credentials  ← parent (shared — this is what makes it a facet)
instructions                    ← loop.goal
model                           ← loop.model ?? parent.model
tools                           ← (loop.tools ∩ host-enabled) ∪ ESSENTIALS   (§2.1)
code_execution                  ← attenuated side-loop profile               (§2.2)
triggers                        ← targets whose `loop` matches
metadata.loop_name              ← loop.name  (binds executor↔stream)
```

`main`'s derived config *is* the raw `AgentConfig`. **Config-change fan-out (IMPL-6):** the ~19 sites pushing fresh host config into executors must re-derive per loop; wire one scheduler subscription on the config-changed chokepoint (`assemble-agent.ts:494`) and guard that no site ever hands the raw host config to a loop executor.

---

## 6. Runtime & state

### 6.1 The pool lives on `AssembledAgent`, not `BackgroundManagedAgent`

**Showstopper the spec missed (IMPL-1/RT-F13):** `BackgroundManagedAgent` is orphaned on Studio's foreground/background handoff (`extractBackgroundAgent`/`transitionToBackground`, `background-agent-manager.ts:573-604`) and doesn't exist while the agent is foreground — exactly when the loop tabs are visible. The foreground path is singleton-based (`ipc/index.ts` `agentExecutor`/`currentSession`/`currentAdfCallHandler`, `:1717`). So:

- The `Map<loopName, LoopRuntime>` **hangs off `AssembledAgent`** (`assemble-agent.ts`), which survives host transfer, and the `current*` singletons + handoff paths carry it.
- **Per-loop** (`LoopRuntime`): `session`, `executor`, `toolRegistry`, `accumulatedText`, **attenuated `AdfCallHandler`** (built with the derived config; inline code runs through it).
- **Shared**: base `workspace`, `config`, `triggerEvaluator`, `mcpManager`, `adapterManager`, `tapManager`, `streamBindingManager`, and **`SystemScopeHandler` (main's — side loops make no system lambdas, §2.3)**.
- `getExecutor(filePath)` keeps returning `main` (back-compat); add `getLoopExecutor(filePath, loop)`.
- Only **main's** executor feeds `triggerEvaluator.setDisplayState` (RT-F4) — else a side loop's `thinking` flips trigger gating for the whole agent. Register every per-loop executor in `inFlight`/dispose or they leak on unload.

### 6.2 Dispatch routing & steering

- **Uniform router** (§6, no special-casing): `target.loop ?? 'main'`; any event type may target any loop (membrane rule is convention, not mechanism). `'*'` broadcast → F3.
- The router sits **in front of `AssembledAgent.dispatch`** (IMPL-4): every entry point — `ipc` AGENT_INVOKE (`:4327/4345`), `runtime-service.trigger` (`:476`), daemon, `attachHost` trigger path — must carry `loop` and select the loop's executor.
- `sendChat(agentId, text, loop = 'main')` (`runtime-service.ts:479`) through all those entry points.
- Timer wake carries `adf_timers.loop`. **Loop-targeted `on_inbox` (RT-F16):** evaluate the target loop *before* `deliverOwnerMessage` pre-appends (`mesh-manager.ts:632`), so the row lands in the executing loop's stream, not main's.

### 6.3 Agent state semantics

| Level | Meaning |
|---|---|
| Per-loop status | in-memory `idle`/`running` in the `LoopRuntime` (no DB row in MVP) |
| `AgentState` | **= main's state, unchanged** — every consumer (sidebar, fleet map, HTTP API `daemon/http-api.ts:1261`, trigger gating) keeps its meaning (RT-F8: verified compatible) |
| Rollup | **derived, never stored**: `running` if any loop is running, else main's. UI badge `idle (2 loops active)` |

- **`idle` = main idle**, not the organism — a ticking consolidator doesn't make the agent "busy" to the mesh or block inbox delivery.
- **`suspended`/`off` cascades to all loops.** Hibernate semantics (main hibernating vs. loop timers) — decide and state (RT-F10); default: hibernate silences loop-targeted triggers except timers, matching `on_timer` today.
- **Idle-sweep iterates all loops (RT-F9):** `sweepIdleAgents` (`background-agent-manager.ts:1903`) must gate each `LoopRuntime` on `getState()`+`isTurnActive()`+`hasPendingWrites()`+`hasPendingContextInjections()` and rehydrate per-loop; scheduler-queued dispatch counts as in-flight; a ticking side loop must not indefinitely shield main's session from release.

### 6.4 Compaction per loop

Per-executor already, so loop-scoped for free once the DB methods take `loop`. Archive rows land under `loop:<name>`. Per-loop streams are smaller → each `brotliCompressSync` is cheaper than today's monolith (worker offload deferred).

---

## 7. Tools

### 7.1 Resolution — allow-list + essentials

```
effective(loop) = (loop.tools ∩ host-enabled)  ∪  ESSENTIALS
ESSENTIALS = ['loop_send', 'loop_list']              // hardwired, ignore host flags
           + ['loop_compact', 'loop_clear']          // default-on, honor explicit host disable
```

Union-after-intersection is not an attenuation violation: essentials act only on *interior* streams, no worldly authority. `loop_send`/`loop_list` are structural machinery (registered by the pool into every loop executor, absent from `config.tools`). `loop_compact`/`loop_clear` honor a host disable (owner intent about history destruction) — a loop without them still survives, because preflight auto-compaction at `compact_threshold` is executor-driven, not tool-driven. Unknown/host-lacking names in `loop.tools` error at create with the available names (discovery via the error path). Empty = essentials only (a pure reflective loop).

### 7.2 New tools (all MVP)

| Tool | Callable by | Shape |
|---|---|---|
| **`loop_send`** | all loops (essential) | `{ to_loop, content, wake? }` → appends a real `adf_loop` row to the target stream (auditable, No-Secrets), stamped `[from loop:<sender>]`, optional wake. **Peer-to-peer**, main is not a bus. Whether a wake runs is the *receiver's* decision. **RT-F6 delivery pattern required:** append-at-send + `loop_seq` on the wake dispatch + `skipLoop` inline (mirror `deliverOwnerMessage`, `agent-executor.ts:1302`) or session/DB diverge and the wake duplicates content. |
| **`loop_list`** | all loops (essential) | `{}` → `[{ name, goal, mode, status, enabled }]` — discovery for `loop_send`. Read-only, interior. |
| **`loop_manage`** | **main only** (restricted) | `{ action: create\|list\|get\|update\|delete, name?, config? }`. The **self-curating organism**: main creates/updates/tears down its own loops at runtime. Mutates `AgentConfig.loops[]` + adds/removes a `LoopRuntime` in the pool. `create`/`update` enforce create-time attenuation (child tools ⊆ host, apply §2.1 prohibitions, reject `name:'main'`); `delete` **archives the stream to `adf_audit` under `loop:<name>`** then removes config + pool entry (`main` not deletable). **Decoupled from the F2 bundle** — it's main acting with main's authority + HIL, so it needs no `SystemScopeHandler` routing / provenance / loop-aware HIL. |

`loop_manage` ships `enabled:false, restricted:true` in `DEFAULT_TOOLS` (HIL-gated until the operator opts in), registered conditionally like `sys_code`. `sys_set_timer` gains a side-loop guard: **reject `lambda` targets** (§2.3); the facade forces the loop-stamp.

---

## 8. UI

| Surface | Change |
|---|---|
| `AgentLoop.tsx` | Loop **tab strip**; each tab = one loop's stream + its own composer wired to `sendChat(…, loop)`. **Renderer store restructure (IMPL-5/RT-F17):** the store is a singleton (one `log` array, adjacency-based delta merge, `useAgent.ts:17`) — concurrent loop streams splice into each other. Key the store by loop; **default filter to `loop==='main'`** so side-loop `chat_updated`/`forceCompact` events (`agent-executor.ts:4035`) never truncate main's view. This lands in **S2**, not a later UI pass — running a side loop without it ships a broken main tab. |
| `AgentConfig.tsx` | **Loops** section: `main` fixed uneditable row 0; `+ Add loop` card = **name, goal, model, tool checklist** (host tools only — 4 fields, deliberately not the full AgentConfig). |
| `AgentTimers.tsx` | Show the timer's target loop (display-only in MVP; editing is sugar). |

**Deferred to F1:** per-loop `ContextBreakdownModal` (RT-F12: its "total spend across loops" roll-up has *no surviving data source* — compaction deletes per-row tokens; needs the F3 budget hook first); BottomPanel log/task loop filter.

---

## 9. Milestones

| # | Milestone | Ships | Diff |
|---|---|---|---|
| **S1** | Schema 28→29 (`adf_loop.loop`+index, `adf_timers.loop`, nullable `adf_logs/adf_tasks.loop`); required `loop` through the ~12 statements; `loopRevision`→Map **with bump-all**; `AdfWorkspace.forLoop()`; audit `loop:<name>`. | **Invisibly** — all defaults to `main`, zero behavior change | 4 |
| **S2** | `LoopConfig`+Zod (§2.1 prohibitions) + backfill; `deriveLoopConfig` (allow-list ∩ host, attenuated `code_execution`, no restricted); **per-loop attenuated `AdfCallHandler`**; `sys_set_timer` no-lambda guard; **pool on `AssembledAgent`** carried across handoff+singletons; **concurrent** executors; `TriggerTarget.loop`+`adf_timers.loop`+uniform router; facade **forces** loop-stamp; `loop_send`+`loop_list`+**`loop_manage`**; `sendChat(loop)` through all dispatch entries; `loop` on emitted events + **renderer store keyed by loop, main-only filter**; loop tabs + Loops config panel; idle-sweep all loops. | Loops exist, run concurrently, are code-capable, reflective, self-curating, visible & steerable | 7–7.5 |
| **F1** | log/task loop filter UI + per-loop `ContextBreakdownModal` | Per-loop observability | 3 |
| **F2** | Lift the side-loop prohibitions as a unit: `SystemScopeHandler` per-loop selection + capability-follows-provenance for side-loop system lambdas + `sys_update_config` write-guard + loop-aware HIL routing (restricted tools in side loops) | Side loops gain privileged tools | 5 |
| **F3** | `mode`/`pacing` + `adf_loops` state table + token budgets (RT-F12 recording hook at `recordUsage` sites) + `max_concurrent>1` serialization + `grants` (tables/files/streams) + `'*'` broadcast | Pacing, budgets, true serialization, sandboxing | 6 |

**The S2 canonical path works end to end:**
```
main calls loop_manage → creates 'reflector' loop (attenuated, code-capable)
operator/main sets trigger: on_timer(30m) → target.loop:'reflector'
  → reflector wakes, runs sys_code inline (scoped workspace; no identity, no msg_send)
  → filters/consolidates adf_loop + files + local_ tables
  → loop_send({to_loop:'main', content:'<insight>', wake:true})
  → main ingests it ([from loop:reflector]) on its next turn
```

**Overall difficulty: 7.5–8/10** (spec's 6–7 was optimistic). S2 is dominated by four non-cuttable items: the `AssembledAgent` pool + foreground handoff, the `forLoop()` facade, the renderer store restructure, and per-loop `AdfCallHandler` (+`loop_manage`'s runtime pool mutation). Agentic estimate: S1 in one sitting; S2 is the bulk, `AgentConfig.tsx` (289 KB) + the renderer store the largest chunks.

---

## 10. Your requirements → where they land

| Requirement | Where |
|---|---|
| Loop table "which loop" column | §4.1 `adf_loop.loop` + `(loop,seq)` index |
| Triggers **and timers** target a loop | §5 `TriggerTarget.loop`, §4.1 `adf_timers.loop`, §7.2 `sys_set_timer` guard, routed §6.2 |
| Logs record which loop | §4.1 `adf_logs.loop` + §1 auto-stamp (filter UI → F1) |
| Tasks record which loop | §4.1 `adf_tasks.loop`, same |
| Token modal tabs per loop | §8 → F1 (needs F3 budget data for the roll-up) |
| Config for the loops | §5 `LoopConfig[]`, §8 Loops panel |
| Disable tools per loop | §7.1 allow-list ∩ host |
| Disable tables per loop | §5/§12 `grants.tables` → F3 (omit `db_execute` from `loop.tools` gets you most of the way now) |
| `loop_send` for all loops | §7.2 |
| Loop manage: create/check/delete | §7.2 `loop_manage` (MVP) |
| `adf audit` per loop | §4.1 source `loop:<name>`, §7.2 teardown archival; `AuditConfig.loops` → F3 |
| Self-curating organism | §7.2 `loop_manage` at runtime |
| Loops process the body with code | §2.2 attenuated `code_execution` (keeps `sys_code`/`sys_lambda`) |
| Loops signal each other | §2.2 `emit_event` bus + §7.2 `loop_send` |

---

## 11. Out of MVP scope

- **Tier 2 mounts** — separate DID, own `.adf` blob, mesh presence. Different spec.
- **Nested loops** — loops creating loops. Flat set only; `loop_manage` is main-only.
- Per-loop MCP servers / channel adapters / credentials — a loop needing these is a mount.
- **Side-loop privileged tools** (F2): restricted/HIL tools, `sys_update_config`, system-scope lambdas.
- **Pacing/modes, budgets, `adf_loops` table, grants, `max_concurrent>1`, `'*'`** (F3).
- Per-loop `seq` — stays global autoincrement; ordering within a loop is the `WHERE loop=?` filter.
- Worker-offloaded compaction — per-loop streams are smaller; revisit if F3 concurrency shows stalls.

---

## 12. Decisions log

1. **Attenuate, don't prohibit code exec** — `sys_code`/`sys_lambda` stay; `code_execution` locked to non-identity/non-egress (§2.2). Code exec is the core ADF pattern.
2. **`emit_event` allowed** — inter-loop signal bus; residual external-tap egress accepted (no recipient choice, no secrets).
3. **`loop_manage` in MVP** — self-curating organism; main-only, decoupled from the F2 bundle.
4. **Concurrent-by-default** — no semaphore; serialization is F3 (§3).
5. **Pool on `AssembledAgent`** — survives foreground/background handoff (§6.1).
6. **Facade via `forLoop()`** — shares deks/callbacks; a plain subclass silently breaks sealed reads + Studio updates (§1).
7. **Uniform router, convention not mechanism** — any event type targets any loop; defaults conservative (§6.2).
8. **Explicit allow-list, no visibility** — main's viz toggling never affects side loops (§7.1).
9. **HIL banned in side loops (MVP)** — approval routing can't reach them; don't-list beats gating (§2.1); → F2.
10. **Essentials split** — `loop_send`+`loop_list` hardwired; `loop_compact`/`loop_clear` honor host disable (§7.1).
11. **`AgentState` = main's**; rollup derived; suspend cascades; idle-sweep all loops (§6.3).
12. **`loopRevision`→Map with bump-all** on whole-table ops (§4.2).
13. **`loop_send` peer-to-peer**, RT-F6 delivery pattern; stamp is audit-only (§7.2, §2.4).
14. **`seq` global**; **no `adf_loops` table in MVP** (§4.1); budget-reset UTC day + shared-file advisory-lock/last-writer-wins → F3.

---

## 13. Grounded change map (file → what changes)

- `adf-database.ts` — `SCHEMA_SQL` (`loop` cols + `(loop,seq)` index); version `28→29` (`:92`, backup threshold); migration block; required `loop` on the ~12 DML statements (`2307-2337`/`2489-2495`/`2965`); `loopRevision`→Map+bump-all (`339-347`).
- `adf-workspace.ts` — `AdfWorkspace.forLoop(name)` factory (share deks/callbacks); `loop` on wrappers; `insertAudit` `loop:<name>` (`1117`); per-loop revision guard; mutex stays file-keyed (`1003`).
- `agent-session.ts` / `agent-executor.ts` — **no signature change** (scoped workspace does the work; concurrency needs no executor edit — §3).
- **NEW** `deriveLoopConfig` + the `Map<loop, LoopRuntime>` pool on **`assemble-agent.ts`** (`AssembledAgent`); lifecycle (create/attach/dispose) + config-change re-derive subscription (`:494`).
- `background-agent-manager.ts` — split per-loop vs shared; carry pool across `extractBackgroundAgent`/`transitionToBackground` (`573-604`); only main feeds `setDisplayState`; idle-sweep all loops (`1903`).
- `ipc/index.ts` — `current*` singletons carry the pool; router selects loop executor at AGENT_INVOKE (`4327/4345`); `getLoopExecutor`.
- `runtime-service.ts` — `sendChat(agentId, text, loop)` (`479`).
- `trigger-evaluator.ts` — carry `target.loop`; evaluate target before owner-message pre-append.
- `adf-call-handler.ts` — per-loop instance with attenuated `code_execution` (`213`); reject side-loop system lambdas.
- `mesh-manager.ts` — loop-target resolution before `deliverOwnerMessage` (`632`).
- `adf-v02.types.ts` + `adf-schema.ts` — `AgentConfig.loops?`, `LoopConfig`, `TriggerTarget.loop?`, `AGENT_DEFAULTS.loops`, `DEFAULT_TOOLS` entry for `loop_manage`.
- **NEW** `src/main/tools/built-in/` — `loop-send.tool.ts`, `loop-list.tool.ts`, `loop-manage.tool.ts`; `sys-set-timer.tool.ts` no-lambda guard.
- Renderer — store keyed by loop + main-only filter (`useAgent.ts`); loop tabs (`AgentLoop.tsx`); Loops panel (`AgentConfig.tsx`).

---

## 14. Adversarial review evidence (4 reviewers @ 0fcb7a5)

Scope / implementation-cost / security / runtime-correctness, against the real tree. Findings referenced inline above; the load-bearing ones:

- **SEC-1 (critical):** `code_execution.*` orthogonal to the tool allow-list (`adf-call-handler.ts:213`, defaults `adf-v02.types.ts:338`) → §2.2 attenuation.
- **SEC-2/5:** timer/trigger lambda authority spoof + single agent-wide `SystemScopeHandler` (auth by file, not loop) → §2.3 no side-loop system lambdas.
- **SEC-3/6/7:** `get_identity`/`set_identity` credential read, `task_resolve` cross-loop hijack, `emit_event` umbilical egress → §2.2 profile.
- **IMPL-1 / RT-F13 (showstopper):** foreground singleton path + handoff orphaning → §6.1 pool on `AssembledAgent`.
- **IMPL-2 / RT-F11:** HIL approval routing filePath/singleton-keyed (`ipc:4275-4304`, `agent-executor.ts:408`) → §2.1 ban restricted tools in side loops (MVP).
- **IMPL-3 / RT-F5:** facade can't be a plain subclass (empty `envelopeDeks`/null callbacks) → §1 `forLoop()`.
- **IMPL-5 / RT-F17:** singleton renderer store + side-loop `chat_updated` truncates main → §8 store restructure in S2.
- **RT-F1/F2/F3:** executor self-scheduling defeats a serial semaphore → §3 concurrent-by-default.
- **RT-F5:** whole-table wipes need bump-all → §4.2.
- **RT-F6:** naïve `loop_send` append diverges session/DB → §7.2 delivery pattern.
- **RT-F12:** token spend has no agent/loop key (`token-usage.service.ts:32-45`) → per-loop roll-up needs the F3 budget hook; context breakdown (per-executor) is free.
- **RT-F16:** owner-message pre-append vs. loop-targeted inbox → §6.2 evaluate target first.

Verified-true spec claims: the `adf_loop` DML chokepoint (~12 statements), 3 `insertAudit` callers, 2 raw-SQL entry points, and the `loopRevision` compaction-guard hazard.
