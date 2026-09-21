# Async experiments and completion triggers

Use this when experiments outlast a short tool call. These are optional operational recipes, not install-time configuration changes. Inspect live schemas, permissions and config first. Do not auto-enable requirements, self-approve tasks or alter restricted flags. This skill can still run sequentially without these capabilities.

## Configure completion routing deliberately

Read `sys_get_config({section:"config"})` and inspect `triggers.on_task_complete`. Current documentation says new agents default to enabled agent scope; older agents may differ. Check actual settings rather than assume defaults. Preserve existing targets and approval-routing handlers.

Desired minimal target for main-owned experiments:

```json
{"scope":"agent","loop":"main","filter":{"tools":["sys_code","sys_lambda","compute_exec"]}}
```

Omit a status filter so completed, failed, denied and cancelled outcomes are all considered. Use actual outer task tool names: a compute call wrapped in async sys_code is a sys_code task. Filter by task-ID ledger in the handler/review, since unrelated tasks can use the same tools.

Only as an authorized operational setup, after inspecting existing configuration, use the normal approval path for these example changes:

```js
// Append ONLY if existing targets do not already cover the intended events.
await adf.sys_update_config({
  path: "triggers.on_task_complete.targets", action: "append",
  value: {scope:"agent",loop:"main",filter:{tools:["sys_code","sys_lambda","compute_exec"]}}
});
// Set only if currently disabled and enabling is authorized.
await adf.sys_update_config({path:"triggers.on_task_complete.enabled",value:true});
```

Do not paste these blindly or replace the entire targets array. Record what was changed and restore only your own additions if appropriate. Avoid interval throttling that drops completion events. If batching is used, reconcile every tracked task from durable state rather than assuming each event survived. Agent scope receives a formatted notification, not a JS event object. System scope receives `event.data.task`; it needs a real lambda/command, not an empty target. A system handler may record deterministic observations but must not auto-approve work or forward unreviewed claims to the user.

Use idle while awaiting agent-scope task completion: hibernate normally admits only timer wakes; off admits none. Verify routing for work launched by inner loops instead of assuming main is automatically notified. Worker review handoffs still use `loop_send` with `wake:true`.

## Launch one tracked experiment

Before launch, write an experiment record with goal/task ID, hypothesis, exact input/source revision, acceptance test, budget, unique output paths and review owner. Commit that intent before the asynchronous dispatch so a restart between dispatch and task-ID recording can be reconciled without launching duplicates.

Use `_async:true` on the outer supported tool call. For example, after saving and reviewing your own experiment lambda:

```json
{
  "source":"goals/demo/experiments/trial-01.js:run",
  "args":{"experiment_id":"demo-trial-01"},
  "_async":true
}
```

This is a `sys_lambda` call; the referenced script must exist and have appropriate capabilities. `_async` does not bypass HIL, timeout limits, resource budgets or restricted-tool rules. In code-execution scripts, await constituent calls; do not nest background dispatch accidentally. If a tool's live schema does not expose async mode, use a supported outer async tool or execute synchronously—do not invent arguments.

Immediately record the returned `task_id` and status. `pending_approval` means NOT executing. `running` means NOT passed. For shell experiments capture the command's own exit code before printing/tailing logs and return it; use appropriate pipeline error handling. `task.status=completed` can still contain `exit_code:1` from a successfully executed shell tool. Conversely a failed task can have produced external effects.

Use separate worktrees/fixtures/output directories for parallel trials, with bounded concurrency and aggregate cost. Do not overwrite the baseline or let candidates see sealed evaluation cases. Keep logs and a compact manifest with revision, command, exit status, artifact hashes and limitations. Preserve experiment evidence before cleanup.

## Consume completion and reconcile missed events

When notified, inspect the durable task row and its actual result/error:

```js
await adf.db_query({
  sql:"SELECT id, tool, status, result, error, created_at, completed_at FROM adf_tasks WHERE id = ?",
  params:[taskId]
});
```

`adf_tasks` is read-only through SQL; keep your review ledger in goal files or local tables. Parse the actual result shape from the live tool—some results are textual wrappers. A system callback should re-read the task row before acting on notification content.

Transition the goal experiment to needs_review, not done. Inspect correct output version and command exit status, run acceptance checks, then accept/reject and deliver once. Persist review decision and delivery reference. Duplicate completion notifications must not repeat review side effects or user messages. Main is the single review/delivery writer; concurrent system handlers should use atomic local-table keys/transactions rather than race on shared JSON files.

On restart and each bounded backup wake, query all tracked non-delivered task IDs. A missed event must not strand completed work. Check pending approvals without self-resolving them. Runtime orphan reconciliation may mark interrupted running tasks failed with 'outcome unknown': inspect artifacts and external state before retrying. Never blindly replay publishing, sends, payments or destructive operations. Do not assume task terminal state cancels every child process; track owned processes and verify cleanup under the tool's actual lifecycle.

## Test the complete route before relying on it

1. In a disposable goal, launch a harmless async experiment returning a known sentinel; record its task ID.
2. Observe actual on_task_complete handling, intended loop wake, durable completed row and sentinel. A manually injected notification or direct trigger endpoint is not proof the configured route works.
3. Repeat with an intentional harmless failure and verify it reaches review rather than success. Test approval denial only with an authorized test setup, never manufacture or self-approve authorization.
4. Exercise reconciliation against the already-reviewed task and confirm no second delivery. Test restart/outcome-unknown handling in an approved disposable runtime, not by crashing the principal's live agent.
5. Report separately: configuration inspected, async execution observed, completion event/wake observed, review/delivery observed, backup/restart recovery tested or untested.

If events do not arrive, inspect task state, trigger enablement/filter/loop/state and logs; use a bounded timer backup only if its own route works. Do not sit idle awaiting an unverified wake or claim the goal will autonomously resume merely because a task ID exists.

Sources (read 2026-09-21): ADF guides/tasks.md and guides/triggers.md at https://raw.githubusercontent.com/christianbalevski/adf/main/docs/ . Recipes need verification against the installed runtime. No live trigger configuration is changed by installing this file.

## Binding dispatch intent across restart

Generate a unique experiment/idempotency ID before dispatch and include it in the OUTER async tool arguments (for sys_lambda, args.experiment_id as illustrated). Persist the intended outer tool, dispatch timestamp/window, expected origin when known and exact argument shape in the intent record. The ID is a correlation key, NOT a runtime exactly-once guarantee. If another tool has no metadata field, use a schema-valid unique output path or labeled script argument visible in its outer args; never add unsupported parameters.

If restart occurs before recording task_id, query bounded adf_tasks candidates by outer tool and dispatch time window, then parse each row’s args and match the exact ID and known origin. Do not expose unrelated task arguments. One match: bind that task and inspect its state/results. Zero matches: widen the bounded search if appropriate and inspect external/artifact state; absence does not prove no effect, so do not automatically relaunch. Multiple matches: preserve all IDs, pause side effects and reconcile which attempts executed. Ambiguity is a blocker, never permission for an automatic retry.

## HIL denial exception

Denied blocking/synchronous HIL calls return the denial in-band and deliberately do not fire on_task_complete. Async HIL denials do fire completion. Handle synchronous denial at the call site; the completion trigger is not a universal approval/denial bus. Never self-approve either path.
