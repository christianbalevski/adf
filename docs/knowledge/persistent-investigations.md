---
type: reference
description: Compose existing files, instruction templates and lambdas to retain unresolved research questions across compaction and restart
see_also:
  - ../guides/memory-management.md — compaction, memory snapshots and context injection
  - ../guides/skills.md — skill packaging, discovery and capability boundaries
  - ../guides/inner-loops.md — worker goals, tool access and lifecycle
---

# Persistent investigations

Persistent research state is an agent-space workflow built from existing
capabilities. Load the [persistent-investigations skill](../../skills/persistent-investigations/SKILL.md)
to keep a goal, unresolved questions and experiment evidence across sessions.

This article explains how those capabilities fit together. Follow the
[Memory Management](../guides/memory-management.md), [Skills](../guides/skills.md)
and [Inner Loops](../guides/inner-loops.md) guides for their supported contracts;
the skill owns the executable workflow and activation procedure.

- Store an ordinary JSON journal with `fs_read` / `fs_write`, or use existing
  database tools with an agent-created `local_*` table when structured queries
  and concurrent updates are needed.
- For a specific ongoing assignment, bind the full skill and journal into existing
  instructions with `{{file-path}}` placeholders. The [activation procedure](../../skills/persistent-investigations/references/activation.md)
  includes a reusable block and worker-loop instructions. The existing prompt
  snapshot reloads both files after successful compaction, independently of the
  summary. Keep a mind pointer for discovery and read current state during a session.
- Optionally publish current state through a small `sys_lambda` that composes
  `fs_read` with the existing `loop_inject` facility. The skill includes an example.

The agent chooses the content structure and experiment workflow. There is no
dedicated investigation tool, tool input schema, built-in journal validator,
automatic per-call injection, new ADF field or migration. The skill package is
discoverable through the normal skill catalog when installed in an agent's files.

Persistence does not itself schedule work. Mind/instruction snapshots refresh
at normal session, compaction and reset boundaries; reads and optional context
publication provide current state during a session. Existing triggers can run
agent-authored refresh code when needed, through their normal permissions.

Completing an experiment should lead to reviewing remaining questions against
the current mandate and budget. The skill describes that decision process;
it cannot enforce truthful evidence or guarantee useful novelty.
