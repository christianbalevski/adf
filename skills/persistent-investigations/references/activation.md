# Bind an investigation to its existing instructions

Installing the skill makes it discoverable. Activating an ongoing investigation
must also put its procedure and state on the normal prompt path. Use the
[activation block](../assets/resume-instructions.txt), replacing every literal
`JOURNAL_PATH` with the actual VFS journal path. Keep the braces around the
second occurrence: `{{investigations/control/state.json}}` is a file placeholder.

1. Read the installed skill, existing journal and current instructions. Confirm
   the investigation's mandate and budget are current; retain existing data.
2. For main, append the substituted block to existing `instructions` through
   `sys_update_config` (or the owner's normal configuration editor). Preserve
   unrelated instructions and replace an existing block for this assignment
   instead of accumulating duplicates. Read back the result. Locked instructions
   require the owner's normal update route; the skill grants no bypass.
3. For a named loop, main uses `loop_manage` to append the block to that loop's
   existing `goal`. Preserve its charter and other settings. This update restarts
   the loop, so apply it at an appropriate checkpoint. Workers derive their own
   instructions from their preamble and goal; do not assume main's binding reaches
   them. Keep each goal within its existing 4,000-character limit, preserve the
   charter and give each journal a single writer. If the charter is already long,
   store it as a file and include it directly alongside the two other placeholders.
4. Verify the actual provider prompt or `[Context: system_prompt]` audit entry:
   it must contain the full skill and the journal's current question and status,
   with neither file marked `missing="true"`. Verify ordinary tool access needed
   for the next experiment separately; loading a skill grants no tools.

Both placeholders must be directly in `instructions` (or the loop goal that is
appended to instructions). File interpolation is **single-pass**: putting these
placeholders inside `mind.md` or another included file does not expand them.
The block works with `bare_prompt` because that mode still expands placeholders
in explicit instructions. A mind pointer is useful for discovery and recovery,
but is weaker than this binding for a specifically assigned investigation.

Keep the journal as a small agenda with references to full experiment artifacts.
Included files consume prompt tokens. If the journal uses a `local_*` table,
use an agent-authored query lambda to maintain a small VFS resume file and bind
that file here; the prompt renderer only includes files, not SQL queries.

## Updates and resumption

The existing runtime snapshots these files at session start and rereads them
after successful compaction or loop reset. Thus even a summary that drops the
research agenda does not erase the independent skill/journal input. During a
session the snapshot can be stale: after changing the journal, use `fs_read` or
the skill's `refresh` lambda to supply current evidence. State must be written
before compaction to appear in the new snapshot. Failed compaction retains the
old history and snapshot; read/publish current state explicitly in that case.

This binding supplies context when a model call happens; it does not wake idle
agents. For an authorized unattended workflow, inspect the existing autonomous,
loop autostart and event/timer settings and configure only the needed resumption
route. Autonomous mode alone still permits stopping and has a narration breaker.
Prefer an actual experiment-completion event or a bounded scheduled checkpoint
to repeated "keep going" wakes. Main owns scheduling/review for worker loops.
Never treat an `on_tool_call` observer as an idle veto: it runs after execution.

## Verify behavior separately from delivery

Use a disposable agent with the real provider and a bounded budget before
claiming behavioral reliability. Leave one completed experiment and one open
question in the journal, compact the transcript, then observe the next action.
Pass requires a relevant evidence-producing action or an accurate blocker/stop
decision, not an acknowledgement or another status report. Repeat for a changed
question, a cancelled investigation, restart and the actual worker-loop setup.
Check artifacts and tool results; an agent saying it resumed is not the check.

Automated repository tests verify prompt delivery through the real executor with
a scripted provider whose summary incorrectly says the work is done. They prove
the skill and fresh state reach the next call, not that every model follows them.
