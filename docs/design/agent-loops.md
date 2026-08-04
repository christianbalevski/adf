# Agent Loops (Facets) — Design Spec

**Status:** Proposal · Not yet implemented
**Schema impact:** `adf_loop` gains a column; one new table; schema version `24 → 25`
**Scope:** Tier 1 only (facets/threads). Tier 2 (mounts with separate identity) is explicitly out of scope and cross-referenced where it matters.
**Difficulty:** 6–7 / 10 (see §13)

---

## 1. Summary

Today an agent is a strict 1:1:1 chain — one `.adf` file → one `AgentExecutor` → one `AgentSession` → one `adf_loop` conversation stream (`background-agent-manager.ts:106`, `agent-executor.ts:169`, `agent-session.ts:6-18`). An agent has exactly one "mind," runs one turn at a time, and does nothing between external triggers.

This spec adds **loops** (a.k.a. *facets*): multiple named cognition streams inside a single agent, sharing its file, identity, credentials, and substrate, but each with its own conversation stream, prompt, tool subset, model, pacing, and — optionally — running **concurrently**. The `main` loop is the membrane-facing mind the world talks to; **side loops** are interior roles the operator configures and steers: a memory consolidator, a reflective default-mode process, a dedicated event handler, an internal critic.

The governing design rule, which dissolves most of the complexity:

> **A loop configures nothing new — it *inherits* the whole agent and *overrides* a small delta.** It never gets its own identity, credentials, channels, or tool registry. The moment a "loop" needs those, it is no longer a loop; it is a Tier‑2 mount (a separate agent), and that is a different spec.

## 2. The two-tier model

| | **Tier 1 — Facets (this spec)** | **Tier 2 — Mounts (future)** |
|---|---|---|
| Analogy | Threads | Processes |
| Identity | Shares the host DID | Own attenuated DID |
| Substrate | Same `.adf` file / same DB | Own `.adf` blob in host's `adf_files` |
| Mesh presence | None — interior only | Own address behind host membrane |
| Isolation | Capability scope (tool subset + table grants) | Full membrane + guarded cross-DB handle |
| Cost to build | 6–7 / 10 | 8–9 / 10 |

Everything below is Tier 1. Tier 2 concepts (monotone capability attenuation, guarded cross-agent DB handles, egress membrane) are referenced only to keep the Tier‑1 seams clean for a later Tier‑2 build.

## 3. Concepts & terminology

- **Loop / facet** — one named cognition stream within an agent. Values of the new `adf_loop.loop` column: `main` (reserved) plus operator/agent-defined names (`consolidator`, `critic`, …).
- **`main` loop** — the membrane-facing loop. Exists implicitly, cannot be torn down, receives all mesh-inbound events. Its config *is* the existing `AgentConfig`.
- **Side loop** — any non-`main` loop. Runs from a **derived `AgentConfig`** (see §6.1).
- **Loop mode** — `reactive` | `background` | `continuous` (see §6.3).
- **LoopScheduler** — per-agent coordinator owning the loop executor pool, the concurrency cap, and the shared token budget (see §6.2).

## 4. Data model

### 4.1 `adf_loop` — add a `loop` column

Current DDL (`adf-database.ts:93-100`):

```sql
CREATE TABLE IF NOT EXISTS adf_loop (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  model TEXT,
  tokens TEXT,
  created_at INTEGER NOT NULL
);
```

New DDL (fresh-create in `SCHEMA_SQL`):

```sql
CREATE TABLE IF NOT EXISTS adf_loop (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- stays GLOBAL, monotonic across all loops
  loop TEXT NOT NULL DEFAULT 'main',       -- NEW: stream discriminator
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  model TEXT,
  tokens TEXT,
  created_at INTEGER NOT NULL
);
```

Design decisions:
- **`seq` remains a single global autoincrement PK.** Do not reset it per loop. Insertion order stays monotonic *within* a loop for free (filter `WHERE loop = ?`), and the existing keyset queries (`WHERE seq < ?`, `WHERE seq >= ? AND seq <= ?`) keep working once loop-scoped.
- **Default `'main'`** makes the migration trivial and keeps back-compat: every existing row *is* the main stream.
- **`[Context: …]` rows** (system prompt / dynamic instructions written via `agent-session.ts:64-71`) are per-loop — each loop writes its own context rows into its own stream.

### 4.2 Index

There is currently **no index on `adf_loop`** — all queries ride the `seq` primary key. With multiple streams interleaved in one table, add:

```sql
CREATE INDEX IF NOT EXISTS idx_adf_loop_loop_seq ON adf_loop(loop, seq);
```

so `WHERE loop = ? ORDER BY seq` stays a range scan rather than a full-table scan as streams grow. (Mirrors the sibling pattern `idx_adf_audit_source` at `adf-database.ts:206`.)

### 4.3 `adf_loops` — runtime-state table (not definitions)

**Definitions live in `AgentConfig.loops[]`** (§5), consistent with every other agent sub-resource (triggers, tools, stream_bindings) — the config is a single JSON blob in `adf_config` (`adf-database.ts:85-90`), so definitions need **no storage migration**.

The `adf_loops` *table* holds only **runtime state** that must survive restarts (budget accounting, status, metrics) and would be wrong to keep in the config blob:

```sql
CREATE TABLE IF NOT EXISTS adf_loops (
  name TEXT PRIMARY KEY,               -- matches AgentConfig.loops[].name; 'main' row auto-created
  status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'running' | 'suspended' | 'off'
  budget_day INTEGER NOT NULL DEFAULT 0,        -- UTC day-bucket for the counter below
  budget_tokens_spent INTEGER NOT NULL DEFAULT 0,
  last_tick_at INTEGER,
  updated_at INTEGER NOT NULL
);
```

> This is the correct home for the "registry alongside `adf_loop`" idea: it is a *state* table, not a second content table. Definition = config; state = this table; content = `adf_loop`. Three responsibilities, three homes, no dual source of truth.

### 4.4 `LoopRepository` — the leakage chokepoint

**Key finding from the audit:** every raw SQL statement against `adf_loop` is already centralized in `adf-database.ts` (the 12 sites at `1721-1740`, `1882-1890`; public wrappers at `2210-2320`). No other file issues SQL against it; `adf-workspace.ts` and `agent-executor.ts` only call typed methods. **The chokepoint already exists** — it just has no `loop` awareness yet.

The migration is therefore an *edit*, not a *refactor*: thread a `loop: string` parameter (default `'main'`) through those methods and add `WHERE loop = ?` / `INSERT ... (loop, …)` accordingly. Because the surface is closed, the "silent leakage" failure mode (a query forgetting the stream filter and bleeding a side loop's ruminations into main's context) is preventable by construction — there is exactly one code path to audit.

Methods to make loop-aware (all in `adf-database.ts`, wrapped in `adf-workspace.ts`):

| Method | Change |
|---|---|
| `getLoopEntries` / `-Limited` / `-Before` | add `loop`, `WHERE loop = ?` |
| `getLoopCount` / `getLoopCountBefore` | add `loop` |
| `appendLoopEntry` | add `loop` column to INSERT |
| `clearLoop` | `DELETE ... WHERE loop = ?` |
| `getLoopSeqs` / `getLoopEntriesBySeqRange` / `deleteLoopBySeqRange` | add `loop` |
| `getLastAssistantTokens` | add `loop` (per-loop token seeding) |

Workspace wrappers (`getLoop`, `appendToLoop`, `clearLoop`, `clearLoopSlice`, `replaceLoop`, `getLoopCount`, `getLastAssistantTokens`, `adf-workspace.ts:682-842`) gain the same `loop` param, defaulting to `'main'` so every existing caller is unchanged until it opts in.

### 4.5 Audit `source` convention

`adf_audit.source` is a free-form string (`insertAudit`, `adf-database.ts:2329`) with existing values `'loop'`, `'inbox'`, `'outbox'`, `'file'`. Extend the loop convention to **`loop:<name>`**:

- `main` archives under `loop:main` (back-compat readers may also treat legacy bare `'loop'` as `loop:main`).
- `consolidator` archives under `loop:consolidator`.

No schema change — the column already stores arbitrary text and is indexed (`idx_adf_audit_source`). `AuditConfig.loop` (`types:238-243`) remains a single boolean gating all loop-stream audits for now; per-loop audit toggles are a later refinement (§14).

### 4.6 Migration plan (`v24 → v25`)

Follow the established imperative-migration pattern in `adf-database.ts` (`open()`, guarded `if (sv === '24')` blocks, `adf_meta.adf_schema_version`):

1. Add the `loop` column + `idx_adf_loop_loop_seq` + `adf_loops` table to `SCHEMA_SQL` (fresh DBs).
2. Bump the fresh-create version literal `'24' → '25'` (`adf-database.ts:1383`).
3. Append a migration block after the current tail (`~1303`):
   ```ts
   if (sv?.value === '24') {
     db.transaction(() => {
       // idempotent column add (mirror the adf_loop precedent at 576-582)
       const cols = db.prepare('PRAGMA table_info(adf_loop)').all()
       if (!cols.some(c => c.name === 'loop'))
         db.exec("ALTER TABLE adf_loop ADD COLUMN loop TEXT NOT NULL DEFAULT 'main'")
       db.exec("CREATE INDEX IF NOT EXISTS idx_adf_loop_loop_seq ON adf_loop(loop, seq)")
       db.exec(`CREATE TABLE IF NOT EXISTS adf_loops ( ... )`)
       db.prepare("INSERT OR IGNORE INTO adf_loops (name, status, updated_at) VALUES ('main','idle',?)")
         .run(/* stamped after open */)
       db.prepare("UPDATE adf_meta SET value = '25' WHERE key = 'adf_schema_version'").run()
     })()
   }
   ```
4. Raise the pre-migration backup threshold `currentSv < 24 → < 25` (`adf-database.ts:565`).

Note the pre-existing declared-type inconsistency to preserve, not "fix": fresh DDL declares `tokens TEXT` while the old ALTER used `tokens INTEGER`; values are always JSON strings, so leave it. Do not touch it in this migration.

## 5. Config model

### 5.1 `AgentConfig.loops[]`

Add one optional top-level field to `AgentConfig` (`types:693-732`), alongside the other declared-sub-resource arrays (`ws_connections?`, `stream_bindings?`, `umbilical_taps?`, `types:726-729`):

```ts
loops?: LoopConfig[]   // side loops only; 'main' is implicit and derives from AgentConfig itself
```

Because config is a single JSON blob, this needs **no storage migration** — only the Zod schema (`adf-schema.ts`) and read-time backfill (`adf-database.ts:2165`, like the tool backfill) to default it to `[]`. Executor tool-snapshot caching keys on `metadata.updated_at`, so editing `loops` invalidates caches for free.

### 5.2 `LoopConfig`

```ts
export interface LoopConfig {
  name: string                 // unique within agent; 'main' reserved/forbidden here
  goal: string                 // the loop's charter — becomes its `instructions`
  enabled: boolean
  mode: LoopMode               // 'reactive' | 'background' | 'continuous'
  model?: ModelConfig          // optional override; inherits AgentConfig.model if absent
  tools?: LoopToolOverrides    // inherit-and-subtract (§5.3); inherits all agent tools if absent
  pacing?: LoopPacing          // required for background/continuous
  grants?: LoopGrants          // read/write scope (§5.4)
  locked?: boolean             // owner lock, mirrors ToolDeclaration.locked semantics
}

export type LoopMode = 'reactive' | 'background' | 'continuous'

export interface LoopPacing {
  interval_ms?: number         // background/continuous: min spacing between ticks
  idle_gate_ms?: number        // background: skip a tick if main/inbox active within this window
  max_ticks_per_day?: number
  daily_token_budget?: number  // per-loop ceiling; enforced by the scheduler (§6.4)
}

export interface LoopGrants {
  read_streams?: string[] | '*'  // other loop streams this loop may read (default: none but own)
  write_files?: string[]         // globs this loop may write beyond local_ tables (e.g. ['mind.md'])
}
```

Agent-level runtime knobs (concurrency cap, shared budget) live in a small sibling on `AgentConfig`:

```ts
export interface LoopsRuntimeConfig {
  max_concurrent?: number        // default 1 → "in the gaps"; >1 → true concurrency (§6.4)
  shared_daily_token_budget?: number  // ceiling across ALL loops incl. main
}
// AgentConfig.loops_runtime?: LoopsRuntimeConfig
```

### 5.3 Tool inheritance — *inherit and subtract*, never build up

The pain point: an agent may carry 50+ base tools plus MCP tools; enumerating an allow-list per loop is untenable. The model inverts it — a loop **inherits the agent's full tool set and only subtracts**:

```ts
export interface LoopToolOverrides {
  inherit?: boolean                 // default true — start from parent config.tools
  preset?: LoopToolPreset           // optional named starting point (see below)
  deny?: string[]                   // remove these tool names from the inherited set
  allow?: string[]                  // when inherit=false: build up from empty (sandbox case)
  overrides?: Array<Pick<ToolDeclaration, 'name' | 'enabled' | 'visible' | 'restricted'>>
}

export type LoopToolPreset =
  | 'inherit'      // = parent tools verbatim (default)
  | 'read_only'    // fs_read, db_query, msg_read/list — no writes, no sends
  | 'reflective'   // model_invoke + local_ tables + mind.md; no external side effects
  | 'comms'        // msg_send, loop_send, msg_read/list
```

Resolution (at loop-config compile time, §6.1): start from preset or parent `config.tools` → apply `deny`/`allow` → apply `overrides`. Crucially, **each resulting entry keeps its parent `enabled` / `visible` / `restricted` flags**, so the two-toggle HIL model (`agent-executor.ts:1000`, `isRestricted = enabled && restricted`) and schema visibility carry through unchanged. A loop cannot *elevate* a tool it did not inherit (no un-restricting, no enabling a parent-disabled tool) — Tier‑1 monotone attenuation, the same invariant Tier 2 will need.

Common case ("consolidator can do everything except message out") = `{ deny: ['msg_send'] }`. Sandbox case = `{ inherit: false, preset: 'reflective' }`.

### 5.4 Grants (write-scope)

Grants exist to make concurrency safe (§6.5), not to sandbox cognition. Defaults for a side loop:
- **Write:** its own stream (`adf_loop WHERE loop = <name>`) + any `local_`-prefixed tables it creates. Nothing else.
- **Read:** its own stream; other streams only if listed in `grants.read_streams` (or `'*'`).
- **Files:** read-only on `adf_files` by default; write only to globs in `grants.write_files` (e.g. `mind.md`) under advisory lock.

`main` has no grants object — it holds full agent authority.

### 5.5 `AGENT_DEFAULTS`

`AGENT_DEFAULTS.loops = []` and `loops_runtime = { max_concurrent: 1 }` (`types:1170`). A new agent has exactly one implicit `main` loop and behaves identically to today. Batteries-optional: zero config → current behavior; add a loop → opt in.

## 6. Execution & concurrency

### 6.1 One executor per loop, from a *derived* config

Reuse the existing `AgentExecutor` wholesale. A side loop is an executor whose `AgentConfig` was **derived**, not authored:

```
deriveLoopConfig(parent: AgentConfig, loop: LoopConfig): AgentConfig
  ├─ id/handle/identity/credentials  ← parent (shared — this is what makes it a facet, not a peer)
  ├─ instructions                    ← loop.goal
  ├─ model                           ← loop.model ?? parent.model
  ├─ tools                           ← resolveLoopTools(parent.tools, loop.tools)   (§5.3)
  ├─ triggers                        ← targets whose `loop` matches this loop (§7)
  ├─ context.compact_threshold       ← parent (per-loop override allowed later)
  └─ metadata.loop_name              ← loop.name   (binds this executor's session to its stream)
```

This is the "mounting is config compilation" principle from the origin design: the scheduler compiles a `LoopConfig` into an ordinary `AgentConfig` and hands it to unchanged machinery. The `main` loop's derived config *is* the raw `AgentConfig`.

The one executor-internal change: `AgentSession` must flush to its loop's stream. `AgentSession.flushToLoop()` (`agent-session.ts:46-55`) already calls `workspace.appendToLoop(...)`; it gains the loop name from `metadata.loop_name`, and `restoreMessages()` / `getLoopEntries` filter by it. Each loop executor therefore only ever sees its own stream — the isolation is structural.

### 6.2 `LoopScheduler` — the one genuinely new runtime component

Per agent, replacing "the manager holds one executor" with "the manager holds one scheduler that holds N loop executors":

- Extends `BackgroundManagedAgent` (`background-agent-manager.ts:73-89`) so the agent's map value now owns `Map<loopName, AgentExecutor>` instead of a single `executor`. `getExecutor(filePath)` keeps returning `main` for back-compat; add `getLoopExecutor(filePath, loopName)`.
- **Owns dispatch routing** (§7): the existing `triggerEvaluator.on('trigger', … executeTurn)` wiring (`background-agent-manager.ts:669`, `agent-runtime-builder.ts:236`) is redirected to `scheduler.dispatch(loopName, dispatch)`.
- **Owns the concurrency semaphore and shared budget** (§6.4).
- **Owns background/continuous pacing** — a per-agent tick loop (reusing the 5s timer cadence pattern from `trigger-evaluator.ts` timer polling) that, respecting idle-gate + budget + concurrency, calls `executeTurn` on `background`/`continuous` loops.

### 6.3 Loop modes

| Mode | Behavior | Typical role |
|---|---|---|
| `reactive` | Runs only when a trigger targets it (§7). Dormant otherwise. | Event handlers (`on_tool_call → loop:X`) |
| `background` | Scheduler ticks it in idle gaps, gated by `pacing.idle_gate_ms`. | Consolidator, reflective default-mode |
| `continuous` | After each turn completes, immediately schedules the next, bounded by budget + concurrency. | Autonomous workers |

`main` is effectively `reactive` to external events plus whatever the existing `autonomous` flag (`AgentConfig.autonomous`) already provides — no change to main's behavior.

### 6.4 Concurrency cap + shared budget

**Concurrency is achievable, not blocked.** The blocker is never the provider — SDK clients are pooled by API-key/baseURL and safe under concurrency (`provider-factory.ts:14-20`). The only reason turns serialize today is executor-local single-flight state (one `abortController`, one `provider`, one `pendingTriggers`, `agent-executor.ts:174`). Give each loop its own executor and their LLM calls (async I/O) **overlap naturally**.

What "concurrent" means here precisely: **concurrent in-flight LLM turns, not parallel CPU.** `better-sqlite3` is synchronous and single-threaded, so DB touches still serialize on the event loop — but those are microseconds; the seconds-long model round-trips are what overlap, which is exactly the win.

The scheduler enforces two ceilings, honoring the "one metabolism" principle (a single budget allocated *downward*):
- **`max_concurrent`** (default `1`) — how many loop executors may have a turn in flight at once. `1` reproduces "in the gaps"; `>1` gives true concurrency. `main` always gets priority admission.
- **`shared_daily_token_budget`** — a single counter across all loops, persisted per loop in `adf_loops.budget_tokens_spent` (day-bucketed by `budget_day`). Per-loop `pacing.daily_token_budget` is a sub-ceiling. **There is no existing spend enforcement in the codebase** (`token-usage.service.ts` only aggregates; only `max_active_turns` gates iteration, `agent-executor.ts:686-706`) — this budget accounting is net-new and is the safety rail that makes `continuous` loops safe. When a loop's budget is exhausted, its ticks become no-ops until the day rolls over (same contract as the Phase‑0 userland inner-loop prototype).

### 6.5 Write contention & grant enforcement

Because the DB is synchronous, there are **no torn reads/writes** between concurrent loops — a `db.transaction()` runs atomically before any other continuation. The only real hazard is *logical*: two loops writing the same file (`mind.md`). Handled by grants (§5.4):
- A side loop's workspace is wrapped in a **grant-checking facade** that permits writes only to its own stream, `local_` tables, and `grants.write_files`. Violations throw (surfaced as a tool error).
- Shared mutable files (e.g. `mind.md`) use an advisory lock with last-writer-wins and a warning log. **Open question (§14):** whether to require append-only for shared files instead.

### 6.6 Compaction per loop

Compaction is per-executor and mutates *that executor's* session + stream, so it becomes loop-scoped automatically once the loop DB methods take a `loop` param:
- `forceCompact()` (`agent-executor.ts:2388-2519`) already operates on `this.session` and calls `workspace.clearLoop()` / `replaceLoop()`; those now target `metadata.loop_name`.
- Pre-flight context guard (`agent-executor.ts:789-818`) and the `compact_threshold` resolution (`config.context?.compact_threshold ?? config.model.compact_threshold ?? 100000`) are per-loop for free.
- `loop_compact` / `loop_clear` tools (`loop-compact.tool.ts`, `loop-clear.tool.ts`) operate on the *calling* executor's stream — i.e. whichever loop invoked them. No change to their signatures; the loop binding is implicit in which executor runs the tool.
- Archive rows land under `loop:<name>` (§4.5). Per-loop streams are individually smaller than one monolithic loop, so each brotli compaction (`brotliCompressSync`, synchronous, blocks the event loop) is *cheaper* than today; offloading compression to a worker is deferred (§14).

## 7. Triggers & steering

### 7.1 `TriggerTarget.loop`

Add one optional field to `TriggerTarget` (`types:53-64`) and its Zod schema (`adf-schema.ts:38-60`):

```ts
loop?: string   // which loop this target dispatches to. Absent → 'main'. '*' → broadcast to all loops.
```

All existing trigger configs (e.g. `AGENT_DEFAULTS.triggers`, `types:1186-1211`) are unchanged — absent means `main`. **Zero migration of existing trigger configs.**

### 7.2 The membrane routing rule (enforced in one place — the scheduler's router)

| Source | Loop targeting | Rationale |
|---|---|---|
| **Mesh-inbound** — `on_inbox`, `on_outbox` | **`main` only** (`loop` field ignored) | The membrane presents *one* address; side loops have no mesh identity (that is Tier 2). |
| **Host-facing** — `on_chat` | Any loop, via the UI/`sendChat` (§7.3) | The operator is *inside* the membrane and may address any organ. |
| **Internal/scheduled** — `on_timer`, `on_tool_call`, `on_task_create`, `on_task_complete`, `on_file_change`, `on_logs`, `on_llm_call`, `on_startup` | Any loop via `loop`, default `main`; `'*'` broadcasts | These are interior events the host routes to whichever loop is designed to handle them. |

Put this rule in the router (`scheduler.dispatch`), not scattered across the evaluator — one function decides the target loop from `(eventType, target.loop)`, so the membrane invariant lives in exactly one place. (Note: `TriggerEvaluator.onInbox` already suppresses agent-scope emits when `getUnreadCount() === 0` at `trigger-evaluator.ts:447-450`; that logic is untouched and still targets `main`.)

This is the payoff for handler loops: `on_tool_call` with `filter.tools: ['fs_write']` and `loop: 'auditor'` wakes a dedicated auditor loop on every file write, with no change to inbox routing and no cascade of "change every target from agent to loop."

### 7.3 `on_chat` / `sendChat` loop routing (steering)

You must be able to *chat with* and steer a side loop after creating it — not just fire-and-forget. The live chat path bypasses `on_chat` target evaluation entirely: `runtime-service.sendChat` builds a dispatch directly and calls `trigger(agentId, createDispatch(event, { scope: 'agent' }))` (`runtime-service.ts:362-381`). So loop steering is a **runtime/UI concern, not a trigger-config concern**:

- `sendChat(agentId, message, loopName = 'main')` — route the chat dispatch to the named loop's executor.
- The UI (§10) surfaces one chat view per loop; typing in the `consolidator` tab calls `sendChat(agentId, msg, 'consolidator')`. **The tab is the loop selector** — no wildcard or pattern needed for chat.

### 7.4 Broadcast & per-loop customization

- `loop: '*'` → the router fans the dispatch out to every enabled loop (a genuine broadcast, e.g. a shutdown or "reflect now" pulse).
- For *different behavior per loop* (different filter or timing per loop), use **multiple targets** — `TriggerConfig.targets` is already `TriggerTarget[]`, and each target carries its own `filter`/timing. Do **not** add comma-lists inside a single target: it would duplicate the array and could not carry per-loop filters. One loop (or `*`) per target; fan out with more targets.

## 8. Loop lifecycle tools

New built-ins, mirroring the `Tool` interface (`tool.interface.ts:16-26`) and the existing `loop_compact`/`loop_clear` structure (`category: 'system'`). Because they need injected runtime services (the scheduler), register them conditionally like `sys_code`/`npm_install` — guarded by `config.tools.some(t => t.name === 'loop_create')` in `agent-runtime-builder.ts` / `ipc/index.ts`, not in the stateless `registerBuiltInTools`. All are **`main`-only**: a side loop calling them is rejected. Disabled + `restricted` by default in `DEFAULT_TOOLS` (like `sys_create_adf`), so lifecycle management is HIL-gated until the operator opts in.

| Tool | Input | Effect |
|---|---|---|
| `loop_create` | `{ name, goal, mode, model?, tools?, pacing?, grants? }` (mirrors `LoopConfig`; reuse the `sys_create_adf` tools sub-schema `{name, enabled, restricted?}` at `sys-create-adf.tool.ts:113-118`) | Appends a `LoopConfig` to `AgentConfig.loops[]`, inserts an `adf_loops` state row, and spins up a derived-config executor in the scheduler. Monotone attenuation enforced (cannot grant beyond the host). |
| `loop_get` | `{ name? }` | No arg → all loops with config + live status (running/idle, budget spent today, last tick). With a name → that loop's full config + status. |
| `loop_teardown` | `{ name }` | Stops the loop's executor, **archives its stream to `adf_audit` under `loop:<name>`** (No-Secrets: nothing vanishes silently), removes the `LoopConfig` and `adf_loops` row. `main` is not tearable. |
| `loop_send` | `{ to_loop, content }` | Appends a message to `to_loop`'s stream (a real, auditable `adf_loop` row — No-Secrets clean) and optionally wakes it via a synthetic dispatch. The internal analog of `msg_send`. |

Spawned loops **cannot** create loops — lifecycle is `main`-managed, loops form a flat set. This drops recursion/attenuation depth handling entirely for Tier 1.

## 9. Inter-loop communication

Two mechanisms, no new messaging subsystem:

- **Passive (reads):** a loop reads another's stream via `grants.read_streams` — `adf_loop` is queryable by `loop`. This is the non-human capability the origin design wanted: main reads the consolidator's digest; the consolidator reads main's history verbatim. Governed by read grants.
- **Active (send/wake):** `loop_send` (§8). The norm is to exchange **digests**, not dump whole streams into another loop's context — a loop writes a summary to `mind.md` / a `local_` table / a tagged `adf_loop` row that the other loop reads, avoiding context pollution.

## 10. UI

- A **Loops** section on the agent config surface. `main` is a fixed row 0 (uneditable name — it is the membrane). `+ Add loop` opens a compact card: **name, goal (textarea), mode, model dropdown, tool preset + deny checkboxes, pacing**. ~5 fields — deliberately *not* the full `AgentConfig` surface. If the panel ever grows toward AgentConfig, that is the signal the thing should be a Tier‑2 mount, not a loop.
- **One chat view/tab per loop** (§7.3), so the operator can open, watch, and steer any loop — including reading its stream verbatim.
- `loop_get` status (running/idle, budget spent, last tick) surfaces inline per row.

## 11. Security considerations

- **No credential leakage across loops** — loops share the host identity by design (they *are* the host); there is no separate secret store to leak. Tier 2 is where credential isolation becomes a concern.
- **Autonomy footgun:** `continuous` + inherit-all-tools is powerful. Default `continuous`/`background` loops to the `reflective` or `read_only` preset; require an explicit opt-in (and, being `restricted`-gated, HIL) to grant a background loop `msg_send` or `fs_write`.
- **Monotone attenuation (Tier 1):** a loop's effective tools ⊆ the host's tools; it cannot enable a parent-disabled tool or un-restrict a restricted one (§5.3). This is the same invariant Tier 2 generalizes to identity and DB handles.
- **No-Secrets holds:** every loop's cognition is a queryable, viewable `adf_loop` stream; `loop_send` writes real rows; teardown archives rather than deletes. Nothing is hidden injected context.

## 12. Phasing

1. **M1 — Storage & scoping.** `loop` column + index + `adf_loops` table + migration; thread `loop` through the `LoopRepository` methods; audit `loop:<name>` convention. No behavior change (everything defaults to `main`). *Ships invisibly.*
2. **M2 — Config & derived executor.** `AgentConfig.loops[]` + `LoopConfig` types + Zod + backfill; `deriveLoopConfig`; session→stream binding; the scheduler holding `Map<loopName, executor>` with `max_concurrent: 1` (in-the-gaps only). Reactive + background modes.
3. **M3 — Triggers & steering.** `TriggerTarget.loop` + membrane router; `sendChat(loopName)`; per-loop chat UI + Loops config panel.
4. **M4 — Lifecycle & comms.** `loop_create` / `loop_get` / `loop_teardown` / `loop_send`; teardown archival.
5. **M5 — True concurrency & budget.** `max_concurrent > 1`; shared/per-loop token budget accounting in `adf_loops`; grant-checking workspace facade; `continuous` mode.

Milestones 1–4 deliver the whole facet experience serially (in the gaps); M5 is the concurrency upgrade and can land later without redoing 1–4.

## 13. Difficulty

Overall **6–7 / 10**. Breakdown:

| Piece | Difficulty | Note |
|---|---|---|
| Storage: `loop` column + `adf_loops` + repository threading + migration | 4 | Chokepoint already centralized (`adf-database.ts`) |
| Multi-session executor pool with **true concurrency** (scheduler, cap, budget, grant facade) | 6–7 | The load-bearing new runtime; no spend enforcement exists today |
| `loop_create/get/teardown/send` + archival | 3–4 | Mirrors existing tool + `sys_create_adf` patterns |
| Inter-loop reads + `loop_send` + grants | 4 | |
| `on_chat` loop routing + per-loop chat UI + Loops panel | 5 | |
| `TriggerTarget.loop` + membrane router | 3 | Additive; one routing chokepoint |

Still Tier 1 — **no** separate mesh identity, **no** guarded cross-agent DB handle, **no** egress membrane. Those are the Tier‑2 surcharge and are out of scope.

## 14. Open questions

1. **Compaction stall:** keep `brotliCompressSync` (simplest; per-loop streams are small) or offload compression to a worker to avoid blocking concurrent loops during a large compaction?
2. **Shared-file writes:** advisory lock + last-writer-wins for `mind.md`, or require append-only for any file granted to more than one loop?
3. **Per-loop audit toggles:** keep the single `AuditConfig.loop` boolean, or extend to per-loop (`AuditConfig.loops?: Record<string, boolean>`)?
4. **`main` in `adf_loops`:** auto-create a `main` state row for uniform budget accounting (recommended), or special-case main out of the table?
5. **Global vs per-loop `seq`:** spec keeps `seq` global (simplest, ordering preserved by filter). Revisit only if the UI needs per-loop 1-based indices for `loop_clear` slices.
6. **Budget reset semantics:** UTC day rollover vs rolling 24h window for `daily_token_budget`.

## 15. Grounded change map (file → what changes)

- `src/main/adf/adf-database.ts` — `SCHEMA_SQL` (`93-100`, add `loop` + index + `adf_loops`); version `24→25` (`1383`, `565`); new migration block (`~1303`); loop-param on the 12 DML methods (`1721-1740`, `1882-1890`, wrappers `2210-2320`); `insertAudit` callers use `loop:<name>`.
- `src/main/adf/adf-workspace.ts` — `loop` param on `getLoop*`/`appendToLoop`/`clearLoop`/`clearLoopSlice`/`replaceLoop`/`getLastAssistantTokens` (`682-842`); audit source `loop:<name>` (`726, 762, 822`).
- `src/main/runtime/agent-session.ts` — flush/restore bound to `metadata.loop_name` (`46-55, 88-92`).
- `src/main/runtime/agent-executor.ts` — read `loop_name` for session binding; compaction/preflight already per-session (`789-818, 2388-2519`); no structural change.
- `src/main/runtime/background-agent-manager.ts` — `BackgroundManagedAgent` holds `Map<loopName, executor>` (`73-89`); `getLoopExecutor`; trigger wiring → `scheduler.dispatch` (`669`).
- **NEW** `src/main/runtime/loop-scheduler.ts` — pool, concurrency semaphore, shared budget, background/continuous pacing, membrane router.
- `src/main/runtime/runtime-service.ts` — `sendChat(agentId, message, loopName)` (`362-381`).
- `src/main/runtime/trigger-evaluator.ts` — carry `target.loop` into the emitted dispatch; membrane rule enforced downstream in the router.
- `src/shared/types/adf-v02.types.ts` — `AgentConfig.loops?` + `loops_runtime?` (`~726`); `LoopConfig`/`LoopMode`/`LoopPacing`/`LoopGrants`/`LoopToolOverrides`/`LoopsRuntimeConfig`; `TriggerTarget.loop?` (`53-64`); `AGENT_DEFAULTS.loops` (`1170`); `DEFAULT_TOOLS` entries for `loop_create/get/teardown/send` (`1091-1134`).
- `src/main/adf/adf-schema.ts` — Zod for `LoopConfig`, `TriggerTarget.loop`.
- `src/main/tools/built-in/` — NEW `loop-create.tool.ts`, `loop-get.tool.ts`, `loop-teardown.tool.ts`, `loop-send.tool.ts`; conditional registration in `agent-runtime-builder.ts` / `ipc/index.ts`.
- Renderer — Loops config panel + per-loop chat tabs.
