# Wave 3 (runtime integration) — accumulated requirements

Inputs: renderer contract (commit 75d965f), LoopPoolApi (loop-pool.types.ts), adversarial reviews of S1/config/tools. This file is the working brief for the runtime-integration agent; delete before merge to main.

## A. Renderer ↔ main IPC contract (implement main side exactly)

1. `AgentExecutionEvent` gains top-level optional `loop?: string` (sibling of type/payload/timestamp). Absent ⇒ 'main'. Must be set on: state_changed, text_delta(_batch), thinking_delta(_batch), tool_call_start, tool_call_result, turn_complete, error, chat_updated, response_metadata, trigger_message, context_injected, inter_agent_message, tool_approval_request, tool_approval_resolved, ask_request, ask_response, suspend_request. Agent-global events (autosaved, document_updated, file_updated) ignore it.
2. `IPC.AGENT_INVOKE` payload gains `loop?: string` (4th positional in preload `invokeAgent`). Routes to that loop's executor.
3. `IPC.DOC_GET_CHAT` now receives `{ loop?: string }` → return that loop's stream (uiLog + earlierCount).
4. `IPC.DOC_GET_CHAT_OLDER` payload gains `loop?: string` (3rd positional) → page within `WHERE loop = ?`.
5. `IPC.DOC_CLEAR_CHAT` receives `{ loop?: string }`; absent ⇒ main.
6. List-timers IPC rows gain `loop?: string` (from adf_timers.loop).
7. Loop list: derived from AgentConfig.loops in renderer — no new channel.
8. `response_metadata`: only loop==='main' moves the status-bar token counters (renderer already enforces; main just stamps loop).
9. `sendChat(agentId, text, loop='main')` in runtime-service.ts:479 and all dispatch entries (ipc AGENT_INVOKE, runtime-service.trigger, daemon, attachHost).

## B. Timer channel (tools review 1.1/1.3/1.4 — HIGH)

1. Both timer read statements (adf-database.ts:2443, :2458) must SELECT the `loop` column; rowToTimer carries it.
2. trigger-evaluator dispatch of agent-scope timers must route to the originating loop's executor (timer.loop ?? 'main').
3. Orphaned timer (loop deleted/disabled): **drop + log**, never fall back to main (that fallback is a privilege escalation).
4. `sys_list_timers` / `sys_delete_timer` from a side loop: scope to own-loop timers only (both currently unscoped — a side loop could delete main's charter timers).
5. Side-loop `sys_set_timer` refusal message: a loop-targeted agent-scope timer only fires if a parent `on_timer` target names the loop — pool should auto-provision an `on_timer` target per loop at createLoop, or the guard message must state the prerequisite.

## C. LoopPoolApi semantics (pinned in loop-pool.types.ts doc comments)

1. deleteLoop of a RUNNING loop: refuse while status==='running' (caller retries after abort). Archive-then-drop; also clean/orphan-handle the loop's timers (drop+log per B3). Specify what happens to its tasks/logs (kept, still stamped).
2. sendToLoop wake-while-running: pending-wake flag consumed at turn end (executor self-schedules successors — a naive check is nondeterministic). "Reads on next run" text must be true.
3. createLoop rejects duplicates itself (tool pre-check is TOCTOU); updateLoop on in-flight turn: apply at turn boundary or refuse; config-write + pool-Map mutation ordering documented (config write first, Map second; crash between = config-only, reconciled at next assemble).
4. fromLoop is trusted-caller-supplied: pool validates it names an existing loop; tools derive from workspace.getLoopName().
5. enabled:false loops: listLoops includes, hasLoop true, sendToLoop appends but never wakes and reports reason 'loop disabled', updateLoop({enabled:false}) on running loop takes effect at turn end.
6. Wrap pool internals so raw better-sqlite3/SQL errors never surface verbatim to the model.
7. createLoop/updateLoop MUST call validateLoopToolList and REJECT unknown/prohibited (deriveTools silently subtracts — that is fail-safe, not enforcement). createLoop returns the effective tool set so loop_manage reports truth, not prediction.

## D. Registration + wiring (tools review 1.5/5.1, S1 review)

1. Registration sites: ipc/index.ts:~3158, agent-runtime-builder.ts:~399, background-agent-manager.ts:~1097. loop_send/loop_list into EVERY loop registry (incl. main) unconditionally, via lazy `() => assembled.loopPool` accessor. loop_manage into MAIN's registry ONLY — do NOT copy the sys_code declaration-presence idiom (DEFAULT_TOOLS backfill makes it always-true); gate on loop==='main' AND declaration enabled.
2. Every side-loop execution path gets `workspace.forLoop(name)`: the loop's AgentExecutor/toolRegistry AND its AdfCallHandler (adf-call-handler.ts:352 passes this.workspace — a root-workspace handler defeats getLoopName() guards from code paths). SysFetchTool in side-loop registries must be constructed with getFetchGuardContext or the daemon-port SSRF block disappears.
3. Whole-table adf_loop ops (reset-agent etc.) must use db.clearAllLoops() (bumps epoch) — never raw DELETE FROM adf_loop.
4. deriveTools drops `restricted` from derived declarations — LOAD-BEARING (adf-call-handler.ts:279 authorizedBypass needs restricted && authorized; carrying it through would let side-loop authorized code call restricted tools). Comment exists at derive site; do not "fix".
5. Dynamic HIL escapes the static no-restricted filter: agent-executor.ts:1778-1782 (sys_lambda targeting authorized file forces HIL even unrestricted) and adf-call-handler.ts:355-360 (protection-denial approval). Side-loop executors must fail these closed (auto-deny with clear error), not park an unreachable approval.
6. Pool lives on AssembledAgent; carried across extractBackgroundAgent/transitionToBackground and the ipc current* singletons. Only main's executor feeds triggerEvaluator.setDisplayState. Register per-loop executors in inFlight/dispose. Idle-sweep gates each LoopRuntime (getState+isTurnActive+hasPendingWrites+hasPendingContextInjections).
6a. Main's essentials: tool exposure is declaration-driven end-to-end (executor snapshot filters config declarations; call handler rejects undeclared names). Registry entries alone do NOT expose loop_send/loop_list to main — the pool must inject synthetic declarations {name, enabled:true, visible:true} into MAIN's executor tool snapshot (not persisted to config).
6b. Config-change fan-out (IMPL-6): sysUpdateOnConfigChanged (assemble-agent.ts:492-499) hands the RAW host config to executor/triggerEvaluator/adfCallHandler updateConfig. With the pool live, every site reaching a loop executor must re-derive via deriveLoopConfig — handing raw host config to a side loop is total attenuation loss.
6c. Strip metadata.loop_name from the raw host config at assemble/load — an imported/hand-edited .adf can pre-declare it and mis-bind main's executor; the field is derived-config-only.
7. loop_send delivery = RT-F6: append-at-send + loop_seq on wake dispatch + skipLoop inline (mirror deliverOwnerMessage, agent-executor.ts:1302).
8. Loop-targeted on_inbox: evaluate target loop BEFORE deliverOwnerMessage pre-append (mesh-manager.ts:632).

## E. Deferred decisions (documented, not bugs)

- adf_logs/adf_tasks.loop never NULL via workspace writers (all stamp bound loop; NULL reserved for future non-workspace writers).
- DEFAULT_TOOLS backfill rewrites .adf on first open (established precedent).
- loopRevisions per-connection (pre-existing scope; file-keyed destructiveLoopChains mutex is the cross-connection mitigation).
- loop_manage model patch requires full ModelConfig (provider required, defaults applied) — document in tool description rather than partial-merge semantics.
- LoopInfo has no `mode` (plan §7.2 mentions it) — mode is F3; plan doc to be corrected.
- _providerMeta shadows per-loop view — acceptable (per-loop provider meta).
- code_execution.network has NO reader in src/main (not in CODE_EXECUTION_METHODS); real egress control = unconditional `delete globalThis.fetch` in the sandbox worker + the sys_fetch tool allow-list. Profile keeps network:false for documentation/future wiring only.
- Side-loop derived configs get packages: [] (attenuation: pure-JS packages load via worker-scope createRequire with unrestricted require — child_process/fs/net — so inherited packages are worldly authority). Per-loop package grants → F3.
- authorized-code-only branch (adf-call-handler.ts:199-210: authorize_file, set_*_protection, protection-bypassing sys_set_meta) sits outside CODE_EXECUTION_METHODS and is un-attenuable by the profile; parity with main, accepted.
- Allow-list re-intersection at derive means a loop.tools name the host lacks is granted the moment the host gains it (owner enables tool later). Accepted for MVP; loop_manage rejects unknown names at create, so this only arises from hand-edited configs.
