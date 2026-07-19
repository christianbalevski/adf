# Fleet Bulk Config — batch configuration from the Age of Agents map

**Status: draft for review — not implemented.**

Select N agents on the map → apply a *config delta* to all of them. The core
idea is that the user expresses a **patch, never a snapshot**: every knob in
the UI is tri-state (or "leave / set value"), defaulting to *leave unchanged*,
so heterogeneous fleets keep their unrelated settings.

## Entry point

`Configure…` item in the command bar's **More ▾** menu (enabled for any
selection ≥ 1). Opens a right-side sheet — same visual family as the founding
overlay — titled `Configure N agents`, listing the affected handles at the
top (with per-directory grouping so "all of ops + 2 strays" is legible).

## Knobs (v1 — bulk-safe subset)

| Knob | Control | Applies to | Takes effect |
|---|---|---|---|
| Tool enable/disable | searchable tool list; each row tri-state `leave / enable / disable` | `tools[].enabled` | next turn (live reload) |
| Tool restricted (HIL) | same rows, tri-state `leave / restrict / unrestrict` | `tools[].restricted` | next turn |
| Model | `leave` or provider+model picker | `model.provider`, `model.model_id` | next turn |
| Context limit | `leave` or number input (tokens) | `compact_threshold` | next turn (pre-flight guard reads it) |
| Trigger toggles | per trigger type, tri-state `leave / on / off` | `triggers.<type>.enabled` | live (trigger evaluator re-reads) |
| Security level | `leave` or 0/1/2 | `security.level` | next send |
| Start state | `leave` or `active / idle` | `start_in_state` | next start |

Deliberately **not** in v1: per-target trigger editing, serving/API routes,
code_execution packages, adapters (all too structural to blind-apply), and
anything identity-adjacent.

## Apply semantics

For each selected file, sequentially (same loop shape as batch message):

1. Open workspace (reuse live registration when running, brief open/close
   when ghost — same split as `MESH_MESSAGE_AGENTS`).
2. Read current config, apply only the non-`leave` deltas (key-path patch,
   reusing the `sys_update_config` merge + Zod validation path so a bad combo
   fails per-agent, not per-batch).
3. Persist; if live, fire the existing `onAgentConfigChanged` →
   `updateAgentConfig` reload hooks (mesh cache, adapter reconcile).
4. Collect `{ filePath, ok | error }`.

Result list renders in the sheet (green check / red row + message), mirroring
the message-delivery result UX. A tool named in the patch that an agent
doesn't declare = per-agent no-op, reported as "skipped (no such tool)".

## Open questions for review

- Should applying a **model** change to a mid-turn agent interrupt, or defer
  to next turn? (Proposal: defer; note it in the result row.)
- Does bulk-enabling a tool need the same review gate as first-open capability
  review? (Proposal: yes when it crosses the enabled+unrestricted boundary —
  surface a confirm step summarizing the capability delta.)
- Persist "recent patches" for one-click re-apply to a new selection?

**Difficulty: 6/10** — the patch/validation machinery exists; the work is the
tri-state sheet UI, per-field effect timing, and honest per-agent reporting.
