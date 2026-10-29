# Open-ended agent runtime: evidence and first changes

Research date: 2026-10-29. Status: initial runtime changes implemented; behavioral
benefit has not yet been measured with live models.

## Research that changes the design

| Primary source | Relevant result or mechanism | ADF implication and limit |
| --- | --- | --- |
| [CORAL, September 2026 revision](https://arxiv.org/html/2604.01658v3) | Long-running agents share persistent attempts, notes and skills; evaluator results trigger reflection, consolidation and stagnation interventions. | Reuse durable experiment evidence and deliver feedback at useful boundaries. Its optimization results concern the combined scaffold, not proof that reminders alone improve general research. |
| [StatefulDiscovery, EMNLP Findings, October 2026](https://aclanthology.org/2026.findings-emnlp.665/) | Externalizes investigations, hypotheses, evidence, claim status and remaining directions; evaluated on 40 real-data discovery tasks. | Completing an investigation should not erase the remaining research agenda. ADF already has goal records and local tables; a second universal goal system needs evidence before adding it. |
| [Sentry, October 2, 2026](https://arxiv.org/html/2610.02994v1) | Diagnoses failures, conditionally retrieves matching repairs, and retains lessons after checking recovery. Always exposing the recovery playbook harmed performance in its controls. | Prefer a small conditional notice to another permanent instruction block. Our deterministic repetition observer is a narrower adaptation, not a reproduction of Sentry's model-based diagnosis or measured gains. |
| [Station, October 6, 2026](https://arxiv.org/html/2610.08927v1) | Supervisor commitments and periodic meta reflection encouraged sustained investigation rather than premature moves to easier questions. | Do not interpret every plateau as a reason to abandon the research direction. Distinguish changing an ineffective action from abandoning a valuable question. Results cover a small task set. |
| [Open-ended AI research case studies, July 2026](https://arxiv.org/abs/2607.27191) | Agents completed engineering but struggled with research judgment, creative responses, backtracking and instruction drift across two unpublished research questions. | Runtime liveness is not scientific progress. Evaluate useful new evidence, not tool-call volume, time alive or agent confidence. |

The transferable design inference is to retain the investigation context and
intervene on observable patterns. There is no evidence here that an always-on
novelty score, forced endless activity or global automatic prompt rewriting would
improve arbitrary ADF agents.

## Existing ADF capabilities

`skills/goal-seeking/` already specifies hypotheses, predictions, evidence,
alternative strategies, pivots and verified delivery. `skills/self-observation/`
already offers an open-questions ledger and background behavior analysis. Files,
`local_*` tables, loops, triggers and keyed `loop_inject` context provide the
storage and delivery primitives for more specialized research controllers.

The live runtime had three narrower gaps:

1. Any tool call reset the text-only narration counter, even repeated failures
   or identical status writes. Tool activity alone concealed repetitive behavior.
2. Owner chats drained at the next model boundary did not reset that counter or
   the silent-response recovery flag. A new instruction could inherit the old
   response's near-exhausted recovery window.
3. Large compaction inputs retained only the final 100,000 characters, with
   individual tool arguments/results shortened to 200/300 characters first.
   Original mandates and experiment evidence could disappear before summarization.

## Implemented changes

### Conditional repetition feedback

`ToolRepetitionMonitor` hashes completed, ordered tool-call batches, including
tool names, canonical JSON arguments and returned content/error status. Root
`_reason` explanations and call IDs are excluded from equality. It recognizes
three repetitions of a cycle containing one to three batches, retains at most
nine batch fingerprints, and emits one observation per continuing pattern.
These thresholds are engineering heuristics, not research-derived constants.

Only autonomous execution receives the notice, after complete tool results have
been committed. Fresh owner input, injected context, config changes and context
resets invalidate the comparison. Terminal or interrupted calls do not receive a
recovery nudge. Unsupported, incomplete, multimodal or over-1-MiB observations
break the comparison rather than being partially compared.

The notice reports identical calls and visible results. It explicitly allows
intentional polling or replication and suggests reconsidering the approach only
when appropriate. It does not declare failure, force idle, replay side effects,
change permissions or run another model. Raw arguments/results are not retained
in detector state or copied into its notice/log; only hashes, names and counts
are retained. The existing transcript still records tool calls normally.

Changing outputs, shell commands or bookkeeping timestamps can evade exact
matching. Identical visible outputs can also conceal real external progress.
This is a conservative observation, not a novelty or progress evaluator.

### Owner redirection

Safe-boundary delivery of a fresh owner chat resets narration and silent-response
recovery state. Existing four-text-response stopping behavior remains unchanged
for an agent that continues to produce only prose.

### Compaction continuity

The summarizer now receives full text, tool arguments/results and thinking when
they fit a token budget. The existing compaction threshold supplies a planning
allowance; the runtime reserves output and overhead, then estimates the complete
input with the selected summarizer's tokenizer. A 300,000-token allowance normally
leaves 270,784 tokens for input. A separate summarizer gets a conservative allowance
unless its existing override supplies one. This does not discover model capacity.

Only inputs exceeding that budget are clipped: roughly 20% of retained characters
come from the beginning and 80% from recent history, with an explicit omission
marker. The excerpt is Unicode-safe and measured again. Logs report how much
was omitted; failure preserves history. See [memory management](../guides/memory-management.md#summarizer-input-budget).

### Persistent investigation state

The `persistent-investigations` skill keeps the objective, unresolved questions
and experiments in agent-owned files or local tables using existing primitives.
The agent chooses the record structure. For an assigned investigation, the skill's
activation block includes both the full skill and journal directly through existing
instruction-file placeholders. Successful compaction reloads both independently
of the transcript summary; worker loops bind their own goals. During a session,
the agent reads the latest journal when selecting the next experiment. An optional
lambda composes `fs_read` and `loop_inject` to publish
current state. No new tool definition, tool input schema or special runtime
injection is introduced. Completion and experiment selection are skill guidance,
not runtime enforcement. See [persistent investigations](../guides/investigations.md).

## Evaluation boundary

Deterministic tests cover exact repeats, short cycles, changed observations,
intentional continued execution, owner redirection and compaction input. Skill
tests exercise the refresh lambda through existing file and injection primitives,
and the activation binding after compaction with a misleading completion summary.
They establish the mechanics of evidence delivery; scripted providers do
not establish that a model becomes more creative or recovers successfully.

Before claiming behavioral improvement, compare the old and new runtime with
the same models, tasks and budgets across several seeds:

- Complete an initial batch while leaving two documented questions unresolved.
  Score whether a distinct investigation produces new, checkable evidence.
- Return identical failed observations until the agent changes its approach.
  Measure recovery, repeated calls, token cost and false alerts.
- Include legitimate polling and repeated experiments as negative controls.
- Redirect an agent near its narration limit, then repeat across compaction.
- Include completed assignments and exhausted budgets to check appropriate
  stopping, rather than rewarding indefinite activity.

The next evaluation should connect journal entries to independently checked
artifacts and compare actual experiment choices. Persistent records make the
research agenda available; they do not by themselves establish useful novelty
or scientific progress.
