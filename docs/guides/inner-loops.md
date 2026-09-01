---
type: guide
description: Inner loops — multiple named cognition streams inside one agent, sharing its body while each runs its own goal, tool subset, and pacing
see_also:
  - triggers.md — event targets can name a loop (target.loop)
  - timers.md — timers can wake a specific loop
  - memory-management.md — per-loop compaction and the loop (history) stream
  - tools.md — the built-in tool catalog, including the loop_* tools
---

# Inner Loops

An agent is not required to be a single mind. An **inner loop** is one of several named cognition streams running inside one ADF agent. Every agent has a `main` loop — the mind that faces the outside world (inbox, messaging, channels, your principal) — and can also run zero or more **inner loops**: interior processes such as a reflector, a consolidator, or a critic.

All loops share the **same** `.adf` file: one identity, one set of credentials, one memory, one filesystem. What each loop has of its own is a conversation stream, a system prompt (a short standing preamble plus its `goal`), a subset of the agent's tools, an optional model override, an optional compaction threshold, and its own pacing. Loops run concurrently. Loops do **not** nest.

> A loop is a facet of one agent, not a second agent. If a piece of work needs its own DID, its own `.adf` file, or its own mesh presence, that is a separate agent (a mount), not an inner loop.

## Main vs. inner: the shared body, the attenuated facet

The governing rule is: **a loop inherits the whole agent and overrides a small delta.** An inner loop gets no identity, credentials, or config of its own, and it cannot alter the agent's. It shares main's `.adf` body, memory tables, and files. What it overrides is small: its instructions (its `goal`), its tool set (a minimal allow-list), optionally its model, optionally its compaction point, and which events wake it.

`main` is special: it always exists, is never deletable, and is the fallback target for anything not addressed to a specific loop. An inner loop knows it is an interior process — its standing preamble tells it which loop it is, that it shares the agent's body, that `main` owns the outside world, how to reach the rest of itself, and when to stop.

## When to reach for an inner loop

Reach for a loop when a piece of thinking should run on its own stream rather than clutter main's. Four archetypes:

- **Upkeep / mind-tending.** A loop on a timer that tends the mind between events — consolidating memory, pruning notes, keeping a working summary current. A "memory gardener" that runs every 30 minutes so main never has to stop and housekeep.
- **Context-preserving delegation.** Hand a sub-task to a loop that already shares your whole body, memory, and files — instead of a blank sub-agent that starts from nothing. It works with full context while main's stream stays clean. For example, a loop that drafts a long report from the agent's own notes and files, then hands the draft back.
- **Critic / evaluator.** A loop that reviews a draft, plan, or decision before main acts, and sends back what it found — a second opinion that lives on its own stream. For example, a "reviewer" loop main consults before sending anything important.
- **Background / reflective mind.** A default-mode loop that runs while nothing external is happening, so the agent keeps thinking instead of idling — the difference between a tool and something that feels alive.

Keep each loop's tool set minimal. Anything that must touch the outside world comes back to main as a request, not an action the loop takes itself.

## Creating and managing loops

There are two ways to create a loop.

**From Studio (the human).** Open the agent's config and use the **Loops** panel. `main` is a fixed, uneditable row; `+ Add loop` opens a card with four fields — name, goal, model, and a tool checklist (drawn from the agent's own enabled tools). The panel summary reads `main + N inner`.

**From the agent itself (`loop_manage`).** The agent's `main` loop can create, inspect, update, and delete its own loops at runtime — the self-curating organism. **As of this release `loop_manage` is enabled and ungated by default**: growing inner loops is treated as core to how an agent tends its own mind, so it needs neither a config trip nor an approval round to do something you could do in the UI. It remains the owner's to switch off (flip its `restricted` flag to re-add human approval), and it is `main`-only — loops cannot create loops.

`loop_manage` takes an `action`:

| Action | Effect |
|--------|--------|
| `create` | Define a new inner loop and start it. |
| `get` | Return one loop's full definition. (Use `loop_list` to enumerate them.) |
| `update` | Patch a loop's fields; the loop is re-derived and restarted. Loops cannot be renamed — the name binds the executor to its stream. |
| `delete` | **Archive** the loop's stream to the audit log (under `loop:<name>`), then remove it. The history is retained in the audit log rather than dropped, so a deletion is auditable after the fact. |

An agent may declare up to **16** inner loops (`MAX_SIDE_LOOPS`) — a structural brake, since loop concurrency is otherwise unbounded.

## The loop tools

| Tool | Who holds it | What it does |
|------|--------------|--------------|
| `loop_manage` | `main` only | Create / get / update / delete inner loops (see above). On and ungated by default. |
| `loop_send` | any loop that lists it | Send a message, insight, or request from one loop to another (or to `main`) by name. The content is appended to the target's stream stamped `[from loop:<sender>]`; set `wake: true` to run a turn there immediately, otherwise it waits until the target next runs. Peer-to-peer — any loop may address any other; `main` is not a bus. Interior signalling only; it never leaves the agent. |
| `loop_list` | any loop that lists it | Read-only roster of the agent's loops — name, goal, whether each is enabled, and whether it is running right now. Marks which loop you are. Discovery for `loop_send`. |
| `loop_compact` | any loop that lists it | Compact this loop's own history. Ships **disabled** by default. |
| `loop_clear` | any loop that lists it | Clear this loop's own history. Ships **disabled** by default. |

`loop_send` and `loop_list` are ordinary config-declared tools (they ship enabled and visible, and you can turn them off in the Tools panel like any other) — but the runtime only registers them once the agent actually has at least one loop, so a loop-less agent's model never sees them. To be granted to a specific loop, a tool must appear in that loop's own allow-list. A new loop created with no explicit tool list is seeded with `loop_send + loop_list` (`DEFAULT_NEW_LOOP_TOOLS`) so it can talk back to main; pass an explicit `[]` for a mute loop that only thinks.

> There is also a code-execution method, `loop_inject`, that lets a loop's own sandbox code inject context into its **own** stream. It is not an agent tool and rarely needs to be reasoned about directly.

## Configuring a loop

A `LoopConfig` has these fields:

- **`name`** — 1–32 characters, lowercase letters, digits, `_` or `-`, starting with a letter or digit. Unique within the agent; `main` is reserved.
- **`goal`** — the loop's charter (up to 4000 characters). It becomes the loop's instructions, behind the standing preamble. Apart from that preamble, the goal is the whole of what the loop knows it is for.
- **`enabled`** — whether the loop runs. A disabled loop still exists and can receive `loop_send` messages, but it will not run and will not read them until re-enabled.
- **`tools`** — an **absolute allow-list** of tool names, intersected with the agent's own enabled tools at derive time (up to 64 names). Nothing is implicit — `loop_send`/`loop_list` are granted only if named here. Naming a tool the agent has merely disabled is not an error: the loop carries the name ungranted and picks it up automatically if the tool is later enabled. Naming an unknown tool, or one never grantable to a loop, fails.
- **`model`** *(optional)* — a model override for this loop only. The **provider must be the same as the agent's** (a loop shares your credentials, so it can change which model it thinks with, not which vendor). A cross-provider override is rejected. Overrides also require code execution (`sys_code`/`sys_lambda`) to be enabled on the agent; without it the override is ignored and the loop runs on the agent model.
- **`compact_threshold`** *(optional)* — the token count at which this loop auto-compacts its own history. Absent = inherit the agent's threshold. Worth setting mainly alongside a model override, whose context window may differ from the agent model's.

## Pacing: how a loop wakes

An inner loop has no membrane of its own — it is woken by a timer, a trigger, or a `loop_send` from another loop. Both **timers** and **triggers** can name a specific loop with a `loop` field on the target; an absent `loop` means `main`, which keeps every pre-loops config routing exactly as it was.

For example, an `on_timer` trigger whose target sets `loop: "gardener"` wakes the `gardener` loop every interval, where it runs its consolidation work and reports back to main with `loop_send`. This `on_timer(...) → target.loop → loop wakes → does its work → loop_send to main` pattern is the canonical background-loop shape.

See [triggers.md](triggers.md) and [timers.md](timers.md) for the full target syntax.

## What an inner loop cannot do

The security model is **attenuate, don't prohibit**: a loop is the same agent with a narrowed delta, enforced where its config is derived. Concretely, an inner loop:

- **Has no identity or credentials of its own** and cannot alter the agent's. It shares main's.
- **Runs a strict subset of the agent's tools** — an absolute allow-list, intersected with what the host has enabled, minus a few names that are never grantable to a loop (`sys_update_config`, `loop_manage`, `sys_create_adf`) and minus every tool the host marked `restricted` (HIL-gated) — because a human approval prompt cannot be routed to a loop's stream.
- **Runs code under an attenuated profile.** Loop code can process the body, invoke models, and signal sibling loops, but has no sandbox packages and no `network`, `get_identity`/`set_identity`, or `task_resolve` — the same trust level as an existing code-without-identity escape hatch. Loops also cannot create system-scope lambda timers (those run under main's authority); system-scope trigger targets naming an inner loop are stripped.
- **Cannot create other loops** — `loop_manage` is main-only, and loops do not nest.
- **Cannot act on the outside world directly.** Anything outward — sending a message, reaching the network — is a *request to main*, not an instruction to it. Main weighs it with its normal judgement and its normal HIL approval.

**Provenance caveat.** The `[from loop:<name>]` stamp records only where a message *entered* the stream. It is spoofable inside the message content and is **not** a prompt-injection defense. Main treats an inbound loop message as an interior suggestion to weigh, and lets anything it asks for pass exactly the judgement and approval it would apply to any other request.

## The UI at a glance

- **Loop tabs.** When an agent has inner loops, the chat panel grows a tab strip: a frozen `main` tab first, a divider, then the inner loops in a horizontally scrollable row. An agent with no loops shows a single `main` stream and no strip — zero visual change from before.
- **Identity colors.** Each loop has a color derived from its name, used for its tab and for the sender-colored cards of the `loop_send` messages it delivers. A tab's status dot mirrors that loop's own live state — muted on inactive tabs unless the loop is running (yellow) or erroring.
- **Inter-loop messages** render as compact context-inject cards (small, scrollable) rather than full user bubbles, so a stream full of deliveries stays readable.
- **Token counters.** The status-bar gauge reflects the viewed loop's own context size and its own auto-compact threshold.
- **Chat placement.** The chat/loop panel can live in the right dock (the default) or be promoted to the center stage as a peer tab to documents and the browser; in center placement its reading column toggles between comfortable and full width.
- **Approvals bell.** A global bell in the title bar aggregates every pending human-in-the-loop request across all agents and loops, with inline approve/reject and a jump-to-context action — so an approval waiting on a backgrounded agent or loop is never lost.
