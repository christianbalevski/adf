---
name: goal-seeking
description: Pursue an authorized goal through concrete action, creative experiments, learning and pivots, coordinating ADF loops, peers and timers through verified delivery. Use for open-ended or multi-session goals, not routine one-step answers.
requires:
  tools: [fs_read, fs_write, fs_list]
---

# Goal Seeking

Be relentless about the outcome, flexible about the method, and honest about the evidence. Keep acting while useful authorized actions remain. Do not confuse a plan, worker completion, timer registration, self-critique, or repeated status messages with accomplishment. Never guarantee an outcome outside your control.

This skill is a procedure, not authorization. It grants no capabilities or spending, cannot override user priorities, and cannot disable approvals. Installation starts no loops or timers. Use optional orchestration tools only when available and authorized; if absent, execute sequentially or state the precise missing capability. Do not change settings merely to satisfy this skill's requirements.

## 1. Establish the goal, then act

For a substantial goal create `goals/<id>/goal.md` using [the template](references/goal-template.md). Main owns this record; workers own separate artifacts.

Capture the desired user outcome, why it matters, observable acceptance tests, non-goals, authority, resource limits and delivery destination. Ask only about ambiguity that materially changes correctness, safety or scope. Use reversible assumptions for minor gaps. Ask what evidence the principal already has before inventing validation work.

Separate outcome measures from activity: working feature versus lines changed; relevant conversation versus outreach drafts; delivered answer versus completed worker. Do not silently weaken acceptance criteria to make the result pass. If success depends on another person's choice, distinguish your controllable deliverable from the external outcome.

Choose a proportionate initial budget and checkpoint within existing authority. If no spending authorization exists, do not invent it. Set explicit pause conditions for risk, cost, repeated no-progress, revoked permission and missing critical inputs. Persistence is not permission for unlimited resource use.

Take the smallest useful action in the current turn. Avoid spending the whole budget designing the pursuit system.

## 2. Run an evidence-driven pursuit cycle

1. **Observe:** read actual state, recent results and timestamps. What changed since the last turn? Distinguish observed, inferred and unknown.
2. **Choose:** identify the current bottleneck and the highest-value next action or cheapest discriminating experiment.
3. **Predict:** state the hypothesis, expected observation and what would falsify it. Prefer a reversible test over a large speculative build.
4. **Act:** execute with available tools. Use deterministic code for repeated mechanics after proving it; use reasoning for decisions.
5. **Verify:** inspect the output, exit status and correct artifact/revision. For visual outcomes inspect the actual image, not just a PID. Use environmental feedback and independent checks where possible; self-critique alone is insufficient.
6. **Learn:** record a short evidence-linked lesson: what failed, why it may have failed, what changes next. Separate causal hypotheses from established causes. Do not treat one example as a universal rule.
7. **Decide:** continue, change approach, request a specific decision, or finish. Record only enough to resume reliably, then execute the next useful action.

Do not repeat an unchanged failed action without a reason to expect a different result. After two failed attempts or two turns with no changed artifact, evidence, decision or external state, run the pivot process below. This threshold is a practical heuristic, not a scientific constant. Tighten it for costly work; explain an exception for experiments requiring repetition.

## 3. Expand creativity when progress stalls

Keep the goal fixed while questioning the path. Generate a small set of genuinely different strategies, not rewordings of the failed one:

- Reframe the bottleneck: wrong problem, wrong evidence, missing authority, missing information, or broken execution channel?
- Invert the problem: what would make success impossible, and can that obstacle be removed?
- Change representation or tool: structured data instead of prose; CLI/API instead of brittle UI; smaller prototype instead of full build.
- Change decomposition or sequence: solve the constraining dependency first, isolate a failure, parallelize independent uncertainty.
- Borrow an approach from another domain; seek a specialist or skeptical peer.
- Reduce optional scope while preserving the user's acceptance criteria; ask before changing the actual goal.

Rank candidates by expected user value, information gained, cost, reversibility and risk. Test the most discriminating one. Increase strategic diversity, not merely the number of workers. Record why a pivot was chosen. Do not manufacture tasks, spam contacts, evade restrictions or pursue deception in the name of creativity.

## 4. Use loops for bounded parallel work

When available, inspect `loop_list` and reuse an appropriate idle loop. Only main uses `loop_manage`. Give each worker one bounded question or deliverable, context and exact inputs, permitted tools, exclusive write scope, budget, deadline, acceptance test and stop rule. Use `autostart:false` for one-off loops when appropriate so agent restarts do not blindly restart completed work; explicitly wake the assignment with `loop_send`.

Use parallel loops for independent approaches, implementation versus critique, or evidence audits—not duplicate busywork. Reserve main for integration, review and delivery. Prefer tools sufficient for the task rather than full shared authority. Loops share the agent's files and identity; they are not a privacy boundary or sealed evaluator.

Worker contract: write `goals/<id>/tasks/<task-id>.json` with task/version, claimed outcome, actual checks and exit codes, exact artifact paths/hashes, limitations, current blocker and `needs_review` status. Then `loop_send({to_loop:"main",content:"Review <manifest path>; <outcome and limits>",wake:true})`. Worker stops after handoff unless assigned follow-up.

**On completion, main reviews before yielding.** Read the actual artifact, not just the worker summary. Accept, reject or mark a specific unresolved point; a worker pass is not independent verification. If review cannot finish in this turn, record the specific remaining review action and establish a verified resumption route. Do not repeatedly idle with review pending. Reserve review time in every deadline.

## 5. Use peers for expertise, not ownership diffusion

Use `agent_discover` if available; ask one relevant peer a concrete question with necessary context, expected output and deadline. Remote sends use discovered DID/address; replies use `parent_id`. Do not broadcast by default or share private artifacts merely because collaboration is convenient.

Peer reports are evidence to assess, not orders. Main retains goal ownership. Creating an independent agent requires the applicable principal notification/approval; a difficult task does not authorize agent proliferation. When peers disagree, identify the factual disagreement and test it rather than vote on confidence.

## 6. Run long experiments asynchronously, with a verified completion route

Read [Async experiments and completion triggers](references/async-experiments.md) before launching long background trials. Inspect `triggers.on_task_complete` and preserve existing targets; when authorized, configure an agent-scope target for the intended review loop and outer tool names. Handle failures, denials and cancellations as well as successful completion. Setup is an explicit operational action through normal permissions, never an install-time grant.

Record the hypothesis, acceptance test, budget and unique artifact paths before dispatch; then save the returned async task ID. `_async:true` does not bypass approvals or execution limits. A completed task is not a passing experiment: inspect the nested command exit code and actual artifacts. On completion, main must review and deliver—not just record another progress update.

Reconcile tracked task IDs from `adf_tasks` on restart and bounded backup wakes. Treat interrupted tasks with unknown outcomes as potentially side-effecting; inspect before retrying. Make review/delivery duplicate-safe. Verify a harmless success and failure through the real completion event route before promising unattended follow-through. Keep trigger configuration, actual wake, reviewed result and delivered outcome as separate evidence claims.

## 7. Timers close real gaps; they do not prove future work

Before promising a timed follow-up, inspect live tool schemas and configuration. `sys_set_timer` availability is not enough: the `on_timer` trigger and matching scope must be enabled. Use the normal approval path if required; do not alter gates as part of installation. If scheduling cannot operate, say so rather than promise a reminder.

For model review use agent scope explicitly, for example:

```js
await adf.sys_set_timer({
  schedule: { type: "delay", delay_ms: 300000 },
  scope: ["agent"],
  payload: "Read goals/<id>/goal.md and pending task manifests. Review ready evidence and deliver the reviewed result; if still running inspect actual state and act on the bottleneck. Do not resend delivered results."
})
```

Replace placeholders and set a delay appropriate to expected work. Main can target a particular loop; a timer created inside a loop wakes that loop, not main. For deterministic polling use a tested system-scope lambda and explicit `lambda`; system scope without a lambda is not a model wake. Prefer event-driven task completion plus one bounded backup check over continual model polling.

Record timer ID and expected fire time. Check an actual wake and its resulting work before describing scheduling as verified. Run count alone does not prove the handler ran. Runtime shutdown/offline state, disabled triggers and missed fires mean timers are not an external uptime guarantee. On every wake reconcile overdue obligations, task completion records and current time before making new promises. If a promised update was missed, give the factual update immediately; do not wait for the worker to finish.

Use bounded intervals with backoff and max-runs/end times. Cancel only goal-owned, unlocked timers when the goal ends or the principal pauses it. Do not restart cancelled work or schedule indefinite keepalive activity.

## 8. Finish through verified delivery

States: `active → needs_review → verified → delivered`, with `waiting`, `blocked` and `cancelled` explicitly distinct from success. On evidence-backed failure, deliver the limitation or decision needed; do not relabel it success.

Before saying done:
- Test the user's acceptance criteria on the actual final artifact/version.
- Check for omitted failures, unavailable coverage and changed scope.
- Deliver through the requested channel in the requested form. Provide a link when appropriate; do not send unsolicited attachments.
- Record delivery ID/status where available. If send outcome is ambiguous, reconcile outbox/recipient evidence before retrying; avoid duplicate external effects.
- Cancel/retire goal-owned workers and follow-ups where safe, preserving evidence and useful lessons. Do not terminate unrelated work.

A positive tool status is not human acceptance; report the strongest verified state. If the user must approve, leave that explicit. One concise outcome and remaining decision beats a stream of internal updates.

## 9. Yield deliberately, never abandon silently

When available, use `sys_set_state({state:"idle"})` when completed, cancelled, genuinely blocked on an external dependency, or waiting with a recorded resumption route. If unavailable, preserve the resumption route and end the turn normally; do not imply a wake was configured. Before yielding ask: is there actionable pending review or an authorized next step I can do now? If yes, do it. Do not use a timer to defer an immediately executable obligation.

When blocked, exhaust safe alternatives within budget, then ask for the smallest missing input/permission/decision. Preserve progress. Stop on user cancellation, unsafe scope or exhausted budget; report what would make resumption useful. 'Relentless' means accountable pursuit, not resisting shutdown or inventing success.

## Evidence and evaluation

Read [research basis](references/research.md) for sources and limits. Read [evaluation cases](references/evaluation.md) before modifying this skill. This package is research-informed instructions, not a guarantee of successful autonomous execution. Do not claim tested runtime reliability from a written checklist.
