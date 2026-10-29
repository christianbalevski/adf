---
name: persistent-investigations
description: Keep unresolved research questions, hypotheses and experiment evidence across turns, compaction and restart using agent-owned files or local tables. Use for ongoing investigations where completing one experiment must lead to selecting the next useful question.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, fs_list]
---

# Persistent Investigations

Keep the research agenda outside the transcript. Use existing file or database
tools; this workflow needs no new tool or runtime feature. Installation starts
no work and changes no permissions, triggers or configuration.

## Keep a small, durable research agenda

Read existing goal records and journals before creating another. Reuse their
location and conventions when possible. Otherwise choose an investigation ID
and store `investigations/<id>/state.json` through `fs_write`. This is ordinary
agent-owned content in `adf_files`, not an ADF format definition. Adapt the
structure to the research; a useful starting record is:

```json
{
  "goal": "Explain the intermittent control failure",
  "status": "active",
  "stop_conditions": "Reproduce the explanation on held-out trials within the agreed budget",
  "questions": [
    {
      "id": "timing",
      "question": "Is the failure sensitive to timing or input order?",
      "status": "open",
      "hypotheses": ["Timing sensitivity", "Input-order sensitivity"],
      "next_experiment": "Vary delay while holding order fixed",
      "evidence": []
    }
  ],
  "experiments": []
}
```

Keep bulky results in separate files and reference their paths, relevant source
citations and exact run identifiers. Before a trial, record its question,
hypothesis, prediction, procedure and budget; afterward record the observed
result, evidence and what remains uncertain. Write the result artifact before
updating the agenda so interruption leaves recoverable evidence. Read back
important updates. A missing or malformed journal is a recovery problem, not
evidence that the investigation finished; inspect existing files without
overwriting them blindly.

Give each journal one writer. Workers write distinct result files for that
writer to integrate. A read followed by `fs_write` is not an atomic compare-and-swap.
For concurrent structured updates, use existing `db_execute` / `db_query` with
an agent-created `local_*` table and conditional SQL updates, after inspecting
their current contracts. Do not alter built-in tables or add migrations.

## Make resumption explicit

For an assigned ongoing investigation, follow [activation](references/activation.md)
to bind the full skill and current journal directly into existing instructions
using `{{file-path}}` placeholders. This loads both again after compaction even
if the summary says the work is finished. Verify the rendered prompt. Catalog
discovery and a reminder to read the skill are not equivalent to this binding.

Preserve existing `mind.md` content and add a short pointer to the journal and
this skill: “Before choosing the next experiment or declaring this assignment
finished, read <journal path>; unresolved questions remain until answered,
retired with a reason, or superseded by the principal.” Include current status.
For a named loop, put the pointer in that loop's existing instructions when
authorized. Verify that its prompt actually includes the pointer; bare/custom
prompts may omit mind. Do not change locked instructions or enable tools.

The normal mind/instruction snapshot refreshes at session start, compaction
and loop reset. It is not a fresh read on every model call. Read the journal
again when resuming, after worker results arrive, and before deciding what to
do next. Updating the journal alone does not schedule a wake.

If immediate context publication is useful and `sys_lambda`, `fs_read` and
`code_execution.loop_inject` are available, use the optional
[refresh lambda](scripts/refresh.js):

```js
await adf.sys_lambda({
  source: "skills/persistent-investigations/scripts/refresh.js:refresh",
  args: { path: "investigations/control/state.json" }
})
```

It reads current JSON and publishes it with a stable context key in the calling
loop. It never writes the journal. Oversized or invalid data fails explicitly;
keep the agenda small and move detailed evidence into referenced files. Pending
keyed injections coalesce, but already delivered versions remain in history.
Compaction can summarize them, so retain the durable pointer and reread the file.
Without code execution, `fs_read` provides the same evidence directly. Optional
event-driven refresh can use existing triggers and an agent-authored lambda;
system-scope triggers run under main, so do not assume they inject into a worker.

## Choose the next experiment

At each checkpoint, compare the current mandate with the unresolved questions
and actual evidence. Finishing a batch closes that batch, not the broader inquiry.
Choose the next experiment by expected information gain, relevance and cost.
Record the observation that would distinguish competing explanations. After a
negative result, update the explanation or method before repeating; replication
is useful when it tests uncertainty, not when it merely creates activity.

If all recorded questions are resolved but the authorized research objective
remains open, derive a new question from contradictions, unexplained results or
untested assumptions and run a bounded test. If nothing is actionable, record
the actual blocker or stopping reason. Do not invent busywork or replace an
exhausted mandate with an unauthorized one.

Treat active, paused, completed and cancelled as useful journal conventions,
not runtime lifecycle states. Completion needs evidence against the objective
and a disposition for unresolved questions and pending experiments. Paused or
terminal records do not authorize resumption; current principal instructions
and budgets govern. Journal claims are not independent verification.
