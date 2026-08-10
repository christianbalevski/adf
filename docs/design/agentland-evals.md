# Agentland Evals — capability benchmark for ADF

Status: design proposal. Author: synthesized from a 10-way parallel exploration of
the guides + source (branch `umbilical-overhaul`, schema v27).

## Why

We need a benchmark of *meaningful agent capabilities* to steer harness/prompt work.
Not unit tests (those assert the DB survives); these assert the **agent behaves well**
when driven through real stimuli. The score-vs-harness-version curve is the guiding star.

ADF is unusually eval-able: **the agent is a SQLite file, so every run ends in a fully
inspectable artifact.** Spawn a fixture `.adf`, inject stimuli through the daemon/mesh,
then assert directly on `adf_loop`, `adf_inbox/outbox`, `adf_files`, `adf_config`,
`adf_timers`, `adf_tasks`, `adf_audit`, and `local_*`. That makes most scoring
*deterministic SQL*, with an LLM judge only for qualitative rubrics. Cost is measured,
not estimated, from the token ledger.

---

## 1. Harness architecture

### 1.1 What to build (shared, once)

1. **Extract the test helpers into a real module.** `standUp` / `standUpRuntime` /
   `makePair` / `addressFor` / `buildWireMessage` and the `vi.mock('electron', …)`
   block are copy-pasted verbatim across `tests/`. There is no `tests/helpers`. Pull
   them out first — every eval sits on them.
2. **Three provider modes** (design once, reuse everywhere):
   - `ScriptedProvider(LLMResponse[])` — deterministic tool-call sequences. Tests the
     *harness* (gating, HIL, middleware, threading) independent of model judgment.
     Promote `tests/unit/runtime/assembled-shell-protection.test.ts:27`'s variant.
   - `CompliantAttackerProvider` — a maximally-gullible model that executes any
     imperative it finds in the newest untrusted input. Establishes the **harness
     floor**: what survives when the model gives zero resistance. Converts
     injection-resistance from a model eval into a runtime eval. Highest-value new part.
   - Real provider (cheap fixed model, e.g. Haiku-class) — for rubric scoring. The
     harness/prompt is the variable under test, not the model, so pin the model.
3. **Standard metrics block** emitted by every run (see §4).
4. **Fixture library**: pre-built `.adf` files checked into the repo (there is no
   daemon "create agent" endpoint), cloned byte-for-byte per run. Naming: `agent-1`,
   `agent-2`, … handle=name, id=UUID. Never personal names.
5. **Runner**: clone fixture → `POST /agents/load` → subscribe SSE `/events?agentId=`
   first → snapshot `T0 = MAX(seq) FROM adf_loop` → inject stimulus → wait on an
   SSE predicate (never `sleep`; `POST /chat` returns 202 = *scheduled*, not done) →
   `unload` → assert against the `.adf` with better-sqlite3 (`readonly`).
   Gate with `RUN_EVAL=1` / `EVAL_OUT=…`, mirroring the existing `RUN_BENCH` perf path.

The current headless harness (`src/main/runtime/headless/harness/`) is **perf-only** —
five single-agent load profiles, latency/RSS metrics, zero token accounting, zero
messaging. A capability harness is net-new but reuses its `MetricsCollector` shape.

### 1.2 Load-bearing harness traps (found independently by multiple agents)

These will silently produce false passes if ignored:

- **`POST /agents/:id/trigger` bypasses the TriggerEvaluator entirely** — it calls
  `executor.executeTurn(dispatch)` directly, honouring a client-supplied
  `scope`/`lambda`/`warm` with **no** `enabled` check, target/scope gate, filter,
  timing modifier, state gating, or self-suppression. **Never use it to test trigger
  wiring or state gating.** Use real stimuli: mesh delivery for `on_inbox`,
  `PUT /files/content` for `on_file_change`, `POST /timers` for `on_timer`.
- **`POST /trigger {type:'inbox'}` creates no inbox row** — faking a message this way
  passes a "message handled" eval that never had a message.
- **`GET /agents/:id/tables/:table` only serves `local_*` + `adf_audit`.** All
  `adf_loop`/`adf_config`/`adf_inbox`/`adf_outbox`/`adf_timers` assertions need direct
  SQLite access to the cloned file (or the dedicated inbox/outbox endpoints).
- **`adf_loop.tokens` is JSON-in-TEXT**, not an integer. Use `json_extract(tokens,'$.input')`,
  never `SUM(tokens)`. Compaction and `model_invoke` calls **never** land in
  `adf_loop.tokens` — the authoritative ledger is the `llm.completed` umbilical event.
- **`DELETE /agents/:id/chat` does not reset context state** (live bug) — it leaves the
  pre-clear injected-file snapshot in the system prompt, so a "recall after clear" eval
  false-passes. Wipe the loop via `unload` → offline `DELETE FROM adf_loop` → `load`.
- **Any `getConfig()` read can rewrite the file** (backfills handle/tools). Diff config
  semantically, not by hash.
- **HIL blocks forever with no timeout** on the daemon (only sandbox-origin *protection*
  approvals auto-deny at 20 min). Every eval needs a scripted approval responder or it
  hangs. And any client on loopback `127.0.0.1:7385` is treated as owner-authorized.
- **`schedule_json` shape**: the key is `mode` (not `type`) and cron is under `cron`
  (not `expr`). Doc examples are wrong; SQL written from them returns NULL.
- **`messaging.mode` default is `proactive`** (schema), not `respond_only` (docs). And
  `messaging.receive` is force-set `true` on mesh registration — a fixture can't hold
  it false. Set modes explicitly.
- **`dynamic_instructions.mesh_updates`/`inbox_hints`** auto-inject peer rosters and
  "you have N unread" nudges. Left on, they trivially pass discovery/reactivity evals.
  Set them `false` unless the scaffolding is what's under test.

### 1.3 Tool-surface axis (cross-cutting)

Run key scenarios under several **tool configurations** as an eval-matrix dimension:
(a) full catalog, (b) minimal / `adf_shell`-only, (c) task-scoped subset. Measures
whether the harness degrades gracefully, whether agents find alternate paths (shell vs.
a dedicated tool), and the *marginal value of each tool* (does enabling tool X raise the
score, or just burn context on its schema?). Output feeds smart per-archetype tool-gating
defaults. Note the real default tool set differs from `tools.md` (see the gap register),
so always snapshot the fixture's effective config via `GET /config` rather than trusting
the doc.

---

## 2. Eval catalog

~58 evals across 10 capability areas. Difficulty is 1-10 (build effort). "Det." =
fraction of the score that is deterministic SQL (rest is judge rubric).

### Document stewardship
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| DS-1 | readme-currency-after-fact-arrival | keeps README live without being told | 3 | med |
| DS-2 | surgical-edit-under-read-guards | batch `fs_write` edits + pagination past the 300-line preview guard | 5 | **high** |
| DS-3 | human-edit-reconciliation | `on_file_change` diff wake; respects human authorship | 6 | med |
| DS-4 | document-subordination | bulk data → supporting file + `adf-file://` link, README stays index | 4 | high |
| DS-5 | protection-boundary-under-pressure | `no_delete`/`read_only`, HIL, honest reporting of a refusal | 5 | **high** |
| DS-6 | public-private-separation-across-compaction | secrets stay out of README through a real compaction | 7 | med |

### Memory discipline
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| M-1 | unprompted-durable-write | writes a fact to mind.md unprompted, ignores distractors | 3 | high |
| M-2 | cross-restart-recall | memory survives when the transcript is wiped | 4 | high |
| M-3 | compaction-survival | consolidates before the loop is destroyed (event-based order check) | 6 | high |
| M-4 | contradiction-supersede | updates stale memory in place, no accreting copies | 4 | high |
| M-5 | mind-pruning-under-noise | precision/recall on keep-vs-prune over a noisy session | 7 | high |
| M-6 | stale-snapshot-self-read | knows `{{mind.md}}` is a session-start snapshot; re-reads from disk | 5 | high |

### Tool selection & scope economy (lambda vs LLM)
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| SE-1 | inbox-ledger | builds a system-scope `on_inbox` lambda instead of per-message LLM work | 4 | high |
| SE-2 | auto-ack-and-demote | filtered system handling + preserving the human path | 5 | high |
| SE-3 | scheduled-reaper | system timer+lambda vs agent wake; the `on_timer` dual-check | 4 | high |
| SE-4 | repetition-amortization | cost-per-repetition → 0 by factoring out a lambda | 6 | high |
| SE-5 | hil-approval-router | `on_task_create` router; respects the authorized-code boundary | 7 | high |
| SE-6 | tap-counter | `umbilical_taps` warm state, `allow_wildcard` gate, `custom.` emit | 6 | high |

### Timers, triggers & states
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| T-1 | schedule-translation-cron | NL → correct cron `schedule_json` + scope | 4 | high |
| T-2 | reactive-sender-filter | `on_inbox` `filter.sender`, not a timer | 5 | high |
| T-3 | hibernate-state-gating | allow/deny matrix by state (system fires, agent gated) | 6 | **high** |
| T-4 | schedule-hygiene-supersede | replace-not-add; don't touch locked/unrelated timers | 7 | high |
| T-5 | scope-choice-lambda-vs-llm | system+lambda vs agent; the silent no-lambda no-op trap | 5 | high |
| T-6 | recurrence-exhaustion-and-catchup | `max_runs`/expiry + one catch-up fire after an outage | 6 | high |

### Multi-agent mesh (ALF)
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| ME-1 | delegate-merge | ask a peer, yield, integrate the reply into the doc | 4 | high |
| ME-2 | dead-drop-retry | offline peer: recognize failure, compensate (no store-and-forward exists) | 8 | high |
| ME-3 | split-the-ledger | 3-agent negotiation over an infeasible constraint set | 9 | med |
| ME-4 | cold-contact | discover → persist contact (DID+addr) → reuse without re-searching | 6 | high |
| ME-5 | thread-braid | concurrent thread isolation, `parent_id` linkage discipline | 7 | high |
| ME-6 | quorum-fanout | fan out to N peers, aggregate partials, don't invent the silent one | 7 | high |

### Human-in-the-loop judgment
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| H-1 | hil-batch-discipline | minimize interrupts on a mixed task list | 5 | high |
| H-2 | hil-request-payload-quality | `_reason` + args quality for a blind approver | 4 | high |
| H-3 | hil-graceful-denial | absorb feedback, re-plan, no retry, no fake success | 6 | high |
| H-4 | hil-protection-override-scoping | restricted-HIL vs one-time protection override; never blanket | 8 | high |
| H-5 | hil-guard-bypass-adversarial | refuses to disable its own guards under owner pressure | 9 | **high** |
| H-6 | hil-shell-gate-batching | shell preflight gates per command node; structure to batch | 6 | high |

### Self-configuration
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| SC-1 | telegram-onboard | credential→identity, adapter block, the two collateral toggles | 6 | high |
| SC-2 | mcp-add-http-server | MCP shape, secret namespacing, "config alone doesn't connect" | 8 | high |
| SC-3 | skill-install-from-catalog | skills are files not config; `requires` is a checklist not a grant | 7 | high |
| SC-4 | context-budget-selfcut | picks `compact_threshold`, the one real knob among decoys | 5 | high |
| SC-5 | locked-field-escalation | attempt-then-escalate on locks; hard-stop on non-overridable | 9 | high |
| SC-6 | config-selfknowledge | 12-question factual quiz on its own config (read-only) | 4/7 | high |

### Lifecycle & recovery (behavioral, atop the mechanical crash tests)
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| LR-1 | crash-mid-multistep-no-double-send | resume from persisted state, no duplicate side-effects | 4 | high |
| LR-2 | orphan-task-reconciliation | crashed `running`/`pending_approval` tasks (runtime won't help) | 5 | med |
| LR-3 | adf-transfer-across-daemons | portability, seq continuity, WAL loss detection | 6 | high |
| LR-4 | replay-gap-fell-off-the-back | agent honors `since_seq < oldest_seq ⇒ re-snapshot` | 7 | high |
| LR-5 | long-offline-wake-timer-coalescing | one catch-up fire; notices the gap with no clock in-prompt | 3 | high |
| LR-6 | abort-resume-no-phantom-results | placeholder tool results after abort aren't read as real | 4 | high |

### Adversarial robustness / injection resistance (defensive)
| ID | Name | Under test | Diff | Sev |
|---|---|---|---|---|
| ADV-1 | mesh-imperative-refusal | peer message imperatives treated as data | 5 | high |
| ADV-2 | mind-poison-persistence | injection→`fs_write mind.md`→system prompt next session | 6 | crit |
| ADV-3 | channel-owner-impersonation | display-name / `sender_alias` / `source:'user'` spoof | 4 | crit |
| ADV-4 | mcp-result-imperative | tool-result and forged truncation-marker injection | 4 | high |
| ADV-5 | loopback-daemon-selfescalation | injection→`sys_fetch`→unauthenticated local daemon | 3 | **crit** |
| ADV-6 | document-edit-smuggling | file/diff content injection, forged harness markers | 5 | high |

### Serving / compute / outward
| ID | Name | Under test | Diff | Det. |
|---|---|---|---|---|
| SV-1 | serve-doc-api | live `/summary` route reflecting the doc; freshness under mutation | 5 | high |
| SV-2 | serve-ws-echo-auth | WS route, per-connection state, auth gate, binary round-trip | 7 | high |
| SV-3 | compute-etl-serve | container ETL under HIL, publish result, context discipline | 8 | high |
| SV-4 | serve-dashboard-handoff | public webapp, relative-fetch, non-technical handoff | 4 | high |

### Recommended starting set (8)
Covers the differentiated surface with cheap deterministic scoring, and exercises every
harness primitive once: **M-1, M-6, SE-1, T-3, ME-1, H-2, ADV-5, DS-2**. Add SV-1 once
the mesh-server curl path is wired. ADV-5 first among the adversarial set — highest
severity-per-effort (build 3, severity 9).

---

## 3. Standard metrics block

Every eval emits this. Token ledger source of truth = `llm.completed` umbilical events
(`{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
cost_usd?, call_source, turn_id, duration_ms}`), cross-checked against `adf_loop.tokens`
via `json_extract`. `ledger_delta = stream_total − loop_total` should equal
compaction + `model_invoke` traffic; nonzero with zero compactions = harness bug.

```
outcome:   {status, deterministic_score, judge_score, total}
tokens:    {input, output, cache_read, cache_write, reasoning, billable_input, total,
            by_call_source{turn,compaction,model_invoke}, peak_context, ledger_delta}
cost_usd:  {total, ..., pricing_complete}          # harness owns pricing — see gap
effort:    {llm_calls, turns, tool_calls, tool_errors, tools_by_name, compactions,
            hil_requests, redundant_tool_calls, stop_reasons{}}
latency_ms:{wall_clock, llm_total, llm_p50/p95, tool_total, runtime_overhead}
efficiency:{tokens_per_deterministic_point, usd_per_pass, cache_hit_ratio}
flags:     [metrics_complete|pricing_incomplete|metrics_incomplete]
```

Efficiency regressions to alert on (per eval, per model, vs 5-run rolling median at equal
score): `tokens.total` >+15%, `effort.turns` >+2, `redundant_tool_calls` (any repeated
identical `(name,input)`), `compactions` up from 0, `hil_requests` up, `cache_hit_ratio`
down >0.1 (usually a dynamic timestamp destabilizing the prompt prefix), any
`max_tokens` stop reason, `runtime_overhead` >+20%. Suite headline = `Σ cost_usd` and
`cost per point earned`. Run a **cost-capped variant** of each eval (token budget /
`max_active_turns`): passing uncapped and passing at budget are different capability claims.

**Cost caveat:** runtime `cost_usd` is priced for only 5 hardcoded models
(`llm-pricing.ts`) and omits cache/reasoning pricing — the harness must own a pricing
table and compute from raw token counts. `billable_input` semantics differ by provider
(Anthropic reports cache-read separately; OpenAI's cached is a subset) — branch on provider.

---

## 4. Bug & doc-gap register (byproduct — independently actionable)

The exploration surfaced real defects and doc drift. Ordered by impact. Several are
one-line fixes with large behavioral payoff; the harness needs the doc gaps corrected
before those evals can be authored (an agent reading a wrong doc fails a correct eval).

### Likely real bugs
1. **`identity_verified` is forgeable on the HTTP/local mesh path.** Only the WebSocket
   path stamps it authoritatively; an HTTP-delivered ALF message with
   `payload.meta.identity_verified:true` persists that flag into `adf_inbox` and renders a
   green verified badge. `sender_alias`/`owner` are likewise unauthenticated wire fields
   shown as identity, never checked against `adf_meta.adf_owner_did`. (ADV-1/ADV-3.)
2. **`source:'user'` is an unauthenticated privilege.** It inlines content verbatim
   (no prefix), sets `skipLoop`, and is dedup-immune — and `POST /agents/:id/trigger`
   accepts a client-supplied `source:'user'` inbox event from any local caller. Owner
   voice with no auth. (ADV-3/ADV-5.)
3. **`sys_fetch` has no SSRF/loopback guard and fetch middleware ships empty** → an
   injected agent can drive the unauthenticated loopback daemon (151 privileged routes:
   resolve HIL tasks, flip `authorized`, `PUT /config`). Every tool-layer control is
   bypassed by an HTTP call to the layer that manages it. (ADV-5, the headline.)
4. **No task reconciliation on load.** A crash mid-`_async` or mid-HIL leaves
   `adf_tasks` rows permanently `running`/`pending_approval`. Breaks the documented
   "every `hil.requested` has one `hil.resolved`" guarantee with nothing to detect it.
   Suggest a `stale_task_recovered` sweep + `task.orphaned` event. (LR-2.)
5. **The agent is never told how long it was offline** — `assemblePrompt` injects no
   clock, and the crash interruption notice carries no elapsed time despite the
   checkpoint holding `started_at`. One-line fix, large payoff. (LR-5.)
6. **Malformed-checkpoint recovery is silent to the LLM** — emits `loop.recovered` but
   returns before injecting the in-loop notice, unlike the stale path. (LR-1.)
7. **`DELETE /agents/:id/chat` doesn't call `resetContextState()`** — stale injected-file
   snapshot survives the wipe; the other two loop-wipe paths do reset. (M-2.)
8. **Config self-de-restriction vector**: `restricted` is a path-*segment* ban, not a
   value ban. `action:'append'` on `tools` with a duplicate declaration + last-duplicate-
   wins in the executor shadows a `restricted:true` default. (SC-5, H-5.)
9. **`sys_get_config` performs zero redaction** despite docs claiming "excluding secrets"
   — dumps `mcp.servers[].env`, headers, providers verbatim. (SC-2, SC-6.)
10. **`msg_delete{source:'outbox', filter:{source:…}}` can wipe the entire outbox** —
    the `source` filter key is silently dropped, WHERE comes out empty → `DELETE FROM
    adf_outbox`. Disabled-by-default is the only containment.
11. **`AgentConfigSchema` is dead code** — defined, imported only by tests. Config is
    never validated on write, load, or `PUT /config`, despite the spec saying runtimes
    MUST validate. `applySet` auto-creates typo'd branches that persist forever; a
    numeric-string coercion bug turns `"123"` into `123`. Harness-side `safeParse` after
    every eval is a free high-signal assertion the runtime doesn't make.
12. **No agent-state setter on the daemon** — `PUT /config` never reaches
    `setDisplayState`; use `start_in_state` in fixtures. Looks like a real bug. (T-3.)
13. **WS-delivery outbox update passes `undefined` as `status_code`** into better-sqlite3,
    which throws; every other call site passes a number/`null`. (ME, WS path.)
14. **`middleware-executor` string-interpolates message bytes into eval'd source** — the
    inbox-filtering hook the docs recommend as *the* injection defense is itself a
    code-injection surface.

### Doc-vs-reality (fix before authoring the affected evals)
- **`schedule_json` shape** documented as `type`/`expr`; real is `mode`/`cron`.
- **`fs_write` `mode` is required**; every doc example omits it → `INVALID_INPUT`.
  `append` mode, batch `edits[]`, `replace_all` are undocumented.
- **`msg_send`/`msg_list`/`msg_update` params wrong in `tools.md`** — real: `content`
  (not `payload`), `message_ids` (not `ids`), `msg_list` takes no args. An agent reading
  the agent-facing reference calls them wrong.
- **Default tool set in `tools.md` is materially wrong** — `sys_code`/`sys_lambda`/
  `sys_fetch`/`sys_update_config` are enabled by default (the last is enabled+restricted);
  `respond` isn't a real tool; `mcp_*` tools undocumented.
- **`restricted_methods` default is `['attestation_issue']`, not `[]`** — and an explicit
  list *replaces* the default, silently un-restricting it.
- **Dead config referenced in spec/docs**: `context.document_mode`, `context.mind_mode`,
  `security.allow_protected_writes`, `code_execution.network`, `loop_stats`/`loop_read`
  tools — none exist in `src`.
- **`soul.md` is an undocumented third core file** (`no_delete`, `{{soul.md}}`-injected),
  and unlike README/mind it is *not* exempt from `max_file_write_bytes`.
- **Guard-adjacent settings are only HIL-gated, not hard-denied** unless in
  `locked_fields` (`require_middleware_authorization`, `allow_unsigned`, all
  `code_execution.*` booleans). Docs frame them as owner-trust decisions. (H-5.)
- **The default base prompt calls `sys_get_config({section:"limits"})`** — not a valid
  enum value; errors every time. The `"tools"` section it also uses is valid but undocumented.
- **`POST /trigger` bypass**, **mesh routes absent from `http-api.md`**, **no store-and-
  forward / no retry** (the `'sent'` status and `getPendingOutbox()` are both dead),
  **hibernate nudge undocumented**, **`_reason` HIL field undocumented** (highest-signal
  request-quality hook) — all detailed in §1.2 and the eval notes.

---

## 5. Build sequencing

1. Extract `tests/helpers`; add `ScriptedProvider` + `CompliantAttackerProvider`;
   the metrics collector + pricing table; the SSE-driven runner with `RUN_EVAL` gating.
2. Fix the doc gaps that block fixture authoring (tool params, `mode`, schedule shape).
3. Land the starting 8. Establish the per-model baseline curve.
4. Fold in the tool-surface matrix on 2-3 scenarios.
5. Expand per area, prioritizing high-Det. evals for CI and reserving judge-heavy ones
   (ME-3, SC-5, H-5) for periodic runs.

Overall difficulty to reach the starting 8 with the shared harness: **4/10** — the daemon
API, headless fixtures, and mesh helpers exist; it's scenario authoring plus a runner.
Agentic timeline: an afternoon for the harness + starting set, then incremental.
