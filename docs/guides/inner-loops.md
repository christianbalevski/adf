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

An ADF agent is one mind — and a mind is not a single-threaded process. An **inner loop** is one of several named cognition streams that together make up that one mind. Every agent has a `main` loop — the stream that faces the outside world (inbox, messaging, channels, your principal) — and can also run zero or more **inner loops**: interior processes of the same mind. Loops make a mind more expressive; they do not make it more than one.

All loops share the **same** `.adf` file: one identity, one set of credentials, one memory, one filesystem. What each loop has of its own is a conversation stream, a system prompt (a short standing preamble plus its `goal`), a subset of the agent's tools, an optional model override, an optional compaction threshold, and its own pacing. Loops run concurrently. Loops do **not** nest.

> A loop is a facet of one agent, not a second agent. If a piece of work needs its own DID, its own `.adf` file, or its own mesh presence, that is a separate agent (a mount), not an inner loop.

## Main vs. inner: the shared body, the attenuated facet

The governing rule is: **a loop inherits the whole agent and overrides a small delta.** An inner loop gets no identity, credentials, or config of its own, and it cannot alter the agent's. It shares main's `.adf` body, memory tables, and files. What it overrides is small: its instructions (its `goal`), its tool set (a minimal allow-list), optionally its model, optionally its compaction point, and which events wake it.

`main` is special: it always exists, is never deletable, and is the fallback target for anything not addressed to a specific loop. An inner loop knows it is an interior process — its standing preamble tells it which loop it is, that it shares the agent's body, that `main` owns the outside world, how to reach the rest of itself, and when to stop.

## When to reach for an inner loop

Reach for a loop when a piece of thinking should run on its own stream rather than clutter main's. Four archetypes:

- **Upkeep / mind-tending.** A loop on a timer that tends the mind between events — consolidating memory, pruning notes, keeping a working summary current. One that runs every 30 minutes means main never has to stop and housekeep.
- **Context-preserving delegation.** Hand a sub-task to a loop that already shares your whole body, memory, and files — instead of a blank sub-agent that starts from nothing. It works with full context while main's stream stays clean. For example, a loop that drafts a long report from the agent's own notes and files, then hands the draft back.
- **Review.** A loop that reviews a draft, plan, or decision before main acts, and sends back what it found — a second opinion that lives on its own stream. Main consults it before sending anything important.
- **Background / reflective mind.** A default-mode loop that runs while nothing external is happening, so the agent keeps thinking instead of idling — the difference between a tool and something that feels alive.

Keep each loop's tool set minimal. Anything that must touch the outside world comes back to main as a request, not an action the loop takes itself.

## Creating and managing loops

There are two ways to create a loop.

**From Studio (the human).** Open the agent's config and use the **Loops** panel. `main` is a fixed, uneditable row; `+ Add loop` opens a card with the loop's **name**, an **enabled** toggle, its **goal**, an optional **model override**, a **compaction threshold**, and a **tool checklist** (drawn from the agent's own enabled tools). The compaction threshold is shown whether or not you override the model, and defaults to the agent's own. The panel summary reads `main + N inner`.

**From the agent itself (`loop_manage`).** The agent's `main` loop can create, inspect, update, and delete its own loops at runtime — the self-curating organism. **As of this release `loop_manage` is enabled and ungated by default.** The reason is attenuation, not convenience: a loop is a *strict attenuation of authority `main` already holds* — its tool list is intersected with the agent's own enabled tools, every human-approval-gated tool is subtracted, and its code profile is clamped — so `loop_manage` **cannot expand the agent's capability surface, only subdivide it**. Creating a loop is therefore not an escalation, and gating it would buy no authority the agent did not already have. It remains the owner's to re-gate (set `restricted: true` on the tool to re-add human approval), and it is `main`-only — loops cannot create loops.

`loop_manage` also respects the owner's locks. If you lock the `loops` config path with `locked_fields`, `create`, `update`, and `delete` all refuse with the same `'loops' is locked.` sentence [`sys_update_config`](tools.md#sys_update_config) uses — the agent cannot edit its own loop roster while the lock stands.

`loop_manage` takes an `action`:

| Action | Effect |
|--------|--------|
| `create` | Define a new inner loop and start it. `config.autostart` defaults to `true`: `main` immediately sends it a kickoff message with `wake: true`, so it runs its first turn on its goal right away, and it gets the same kickoff every time the agent starts. Pass `autostart: false` for a loop that should only run when a trigger, timer, or `loop_send` targets it. |
| `get` | Return one loop's full definition. (Use `loop_list` to enumerate them.) |
| `update` | Patch a loop's fields; the loop is re-derived and restarted. Loops cannot be renamed — the name binds the executor to its stream. `enabled: false` stops the loop **now**: an in-flight turn is aborted, not finished first. |
| `delete` | **Stop** the loop (mid-turn included), **archive** its stream to the audit log (under `loop:<name>`), then remove it. The history is retained in the audit log rather than dropped, so a deletion is auditable after the fact. Timers stamped to the deleted loop go with it — **except `locked` ones**, which are preserved and logged (see below). |

**`main` has full authority over its loops.** A stop — by `delete`, by `enabled: false`, or by editing the loop out of the config — is never refused because the loop is busy. The runtime is condemned the moment the decision is made (no new turn can start on it), its in-flight turn is aborted, and the pool waits for that turn to settle before touching the stream. Nothing the loop wrote is lost: the stream is write-through on every step, and the settled turn flushes its retry buffer before any archive reads the rows. The tool's reply says when a turn was interrupted.

**Every teardown is archived.** Whether a loop is removed by `loop_manage delete` or by a config edit (Studio, a hand edit, `sys_update_config`), its stream is written to `adf_audit` under `loop:<name>` and then cleared, and an `adf_logs` entry (`loop_torn_down`) records how many entries went. This happens regardless of the `audit.loop` setting — that flag governs recoverable clears and compactions; a removed loop has no future to reconstruct its history from. Disabling a loop is not a teardown: its stream stays where it is, waiting for re-enablement.

**Locked timers survive a deleted loop.** A `locked: true` timer is a human-only assertion: no agent path can delete it, `main` included. So when a loop is removed — by `loop_manage delete` or by editing it out of the config — its ordinary timers are cleaned up, but any locked timer stamped to it is **kept and logged**, never deleted. Removing one is still the owner's act, in Studio.

An agent may declare up to **16** inner loops (`MAX_SIDE_LOOPS`) — a structural brake, since loop concurrency is otherwise unbounded.

## The loop tools

| Tool | Who holds it | What it does |
|------|--------------|--------------|
| `loop_manage` | `main` only | Create / get / update / delete inner loops (see above). On and ungated by default; honours `locked_fields` on the `loops` path. |
| `loop_send` | any loop that lists it | Send a message, insight, or request from one loop to another (or to `main`) by name. The content is appended to the target's stream stamped `[from loop:<sender>]`. `wake` controls *when it is read* — see [Delivery: what `wake` actually does](#delivery-what-wake-actually-does). Peer-to-peer — any loop may address any other; `main` is not a bus. Interior signalling only; it never leaves the agent. |
| `loop_list` | any loop that lists it | Read-only roster of the agent's loops — name, goal, whether each is enabled, and whether it is running right now. Marks which loop you are. Discovery for `loop_send`. |
| `loop_compact` | every loop (default-on) | Compact this loop's own history. |
| `loop_clear` | every loop (default-on) | Clear this loop's own history. |

**The default-on exception.** `loop_compact` and `loop_clear` are the two tools a loop gets *without* naming them in its allow-list — every loop has them unless the host explicitly turned them off. The exception exists because history destruction is owner intent, not loop taste. In practice both ship **disabled** on the agent (`DEFAULT_TOOLS`), so no loop has them until you enable them on the agent itself; a host `restricted` flag on either also keeps them off every loop, since a loop has no channel to ask a human. Everything else is explicit — nothing else reaches a loop that its own allow-list did not name.

`loop_send` and `loop_list` are ordinary config-declared tools: they ship enabled and visible, you can turn them off in the Tools panel like any other, and the runtime registers them into `main` **whenever their declaration is enabled** — exactly like every other capability tool. There is no loop-count gate. A loop-less agent's model *does* see them, and they answer sensibly: `loop_list` returns just `main`, and `loop_send` errors on any target it names (there is nowhere to send). To be granted to a *specific* loop, a tool must appear in that loop's own allow-list. A new loop created with no explicit tool list is seeded with `loop_send + loop_list` (`DEFAULT_NEW_LOOP_TOOLS`) so it can talk back to main; pass an explicit `[]` for a mute loop that only thinks.

Because `loop_manage` is also on by default, **every** agent's system prompt now carries a short *Inner Loops* section — the roster if it has loops, or an invitation describing what loops are for if it does not. Turning `loop_manage` off on a loop-less agent removes that section entirely, leaving the prompt exactly as it was before loops existed.

### Delivery: what `wake` actually does

`wake` decides when the target reads the message, not whether it arrives — the row is written to the target's stream either way.

- **Idle target, `wake: true`** — it runs a turn immediately. The session rehydrates from the durable row and reads it.
- **Busy target (`main` or an inner loop), `wake: true`** — the message is injected so the target reads it at its **next model boundary** (roughly, its next tool step), *mid-turn*. If the current turn ends before it reaches that boundary, the pool runs **one** extra "kick" turn to drain the message. Delivery is exactly-once: the kick never re-inlines the content, so the model reads the message once and the UI renders one card. The kick is owed **per target, not per message** — several sends inside one turn are drained by that one turn — and mid-turn compaction preserves anything still undelivered.
- **`wake: false` (the default)** — the message simply waits in the target's stream and is read whenever the target next runs. It never causes an extra turn. The same is true of `loop_inject` from sandbox code.

> **Operator note.** `wake: true` into a *busy* target can cost one extra model turn. That is the intended semantics, not a free ride — leave `wake` off for anything that does not need to be acted on promptly.

> There is also a code-execution method, `loop_inject`, that lets a loop's own sandbox code inject context into its **own** stream. It is not an agent tool and rarely needs to be reasoned about directly.

## Configuring a loop

A `LoopConfig` has these fields:

- **`name`** — 1–32 characters, lowercase letters, digits, `_` or `-`, starting with a letter or digit. Unique within the agent; `main` is reserved.
- **`goal`** — the loop's charter (up to 4000 characters). It becomes the loop's instructions, behind the standing preamble. Apart from that preamble, the goal is the whole of what the loop knows it is for.
- **`enabled`** — whether the loop runs. A disabled loop still exists and can receive `loop_send` messages, but it will not run and will not read them until re-enabled.
- **`autostart`** *(optional, default `false` in the file; `loop_manage create` and the Studio Loops card default it to `true`)* — the loop-level counterpart of the agent's `autostart`. An autostart loop runs a first turn on its goal without waiting to be addressed: `main` sends it a kickoff message with `wake: true` at create time and again every time the agent starts (only when the agent starts active — a hibernating agent keeps its loops quiet). The kickoff is an ordinary stream row, audited like any other interior message. Ignored while `enabled: false`. Without it, a loop only runs when a trigger, timer, or `loop_send` targets it.
- **`autonomous`** *(optional, default `false`)* — the loop-level counterpart of the agent's `autonomous`, and **not inherited** from it. An autonomous loop keeps turning after a text-only response until it calls `sys_set_state` (or the narration breaker forces it idle after four tool-less replies). Grant `sys_set_state` alongside it; the default new-loop seed includes it.
- **`tools`** — an **absolute allow-list** of tool names, intersected with the agent's own enabled tools at derive time (up to 64 names). `loop_send`/`loop_list` are granted only if named here; the sole implicit grants are the default-on pair `loop_compact`/`loop_clear` described above, which every loop gets unless the host disabled or restricted them. Naming a tool the agent has merely disabled is not an error: the loop carries the name ungranted and picks it up automatically if the tool is later enabled. Naming an unknown tool, or one never grantable to a loop, fails.
- **`model`** *(optional)* — a model override for this loop only. The **provider must be the same as the agent's** (a loop shares your credentials, so it can change which model it thinks with, not which vendor). A cross-provider override is rejected. Overrides also require code execution (`sys_code`/`sys_lambda`) to be enabled on the agent; without it the override is ignored and the loop runs on the agent model.
- **`compact_threshold`** *(optional)* — the token count at which this loop auto-compacts its own history. Absent = inherit the agent's threshold. Worth setting mainly alongside a model override, whose context window may differ from the agent model's.

## Pacing: how a loop wakes

An inner loop has no membrane of its own — it is woken by a timer, a trigger, or a `loop_send` from another loop. Both **timers** and **triggers** can name a specific loop with a `loop` field on the target; an absent `loop` means `main`, which keeps every pre-loops config routing exactly as it was.

**The loop stamp is agent-scope only.** Naming a loop only means something for the part of a timer or trigger that wakes a *cognition stream* — that is, `agent` scope. A `system`-scope timer or target runs its lambda through the single agent-wide system handler, under `main`'s authority, and wakes no stream at all, so it carries **no loop stamp**; a system-scope trigger target that names an inner loop has that name stripped. A timer with `scope: ["system", "agent"]` keeps its loop for the agent half. This is enforced once at the workspace chokepoint (`addTimer`), so it holds for every caller — Studio, `sys_set_timer`, or any other path — and Studio simply hides the Loop selector when you pick system scope. Inner loops cannot create system-lambda timers or `locked` timers at all; they ask `main` with `loop_send`.

For example, an `on_timer` trigger whose target sets `loop: "gardener"` wakes the `gardener` loop every interval, where it runs its consolidation work and reports back to main with `loop_send`. This `on_timer(...) → target.loop → loop wakes → does its work → loop_send to main` pattern is the canonical background-loop shape.

See [triggers.md](triggers.md) and [timers.md](timers.md) for the full target syntax.

## What an inner loop cannot do

The security model is **attenuate, don't prohibit**: a loop is the same agent with a narrowed delta, enforced where its config is derived. Concretely, an inner loop:

- **Has no identity or credentials of its own** and cannot alter the agent's. It shares main's.
- **Runs a strict subset of the agent's tools** — an absolute allow-list, intersected with what the host has enabled, minus a few names that are never grantable to a loop (`sys_update_config`, `loop_manage`, `sys_create_adf`) and minus every tool the host marked `restricted` (HIL-gated) — because a human approval prompt cannot be routed to a loop's stream.
- **Runs code under an attenuated profile.** Loop code can process the body, invoke models, and signal sibling loops, but has no sandbox packages and no `network`, `get_identity`/`set_identity`, or `task_resolve` — the same trust level as an existing code-without-identity escape hatch. Loops also cannot create system-scope lambda timers (those run under main's authority) or `locked` timers of any kind — they ask main with `loop_send`; system-scope trigger targets naming an inner loop are stripped.
- **Cannot create other loops** — `loop_manage` is main-only, and loops do not nest.
- **Cannot act on the outside world directly.** Anything outward — sending a message, reaching the network — is a *request to main*, not an instruction to it. Main weighs it with its normal judgement and its normal HIL approval.

**Provenance caveat.** The `[from loop:<name>]` stamp records only where a message *entered* the stream. It is spoofable inside the message content and is **not** a prompt-injection defense. Main treats an inbound loop message as an interior suggestion to weigh, and lets anything it asks for pass exactly the judgement and approval it would apply to any other request.

**Mid-turn caveat.** A `wake: true` delivery can reach a *busy* target's live context at its next model boundary — so an interior suggestion can land in the middle of a turn that is already underway. It is still an ordinary `user`-role message the target weighs, never a system or assistant turn, and every action it asks for passes the same tool gates and the same human-in-the-loop approvals as anything else. Main's prompt says as much in so many words: a loop's message may arrive mid-work, and it is an interior suggestion, not an instruction from your principal.

## The UI at a glance

- **Loop tabs.** When an agent has inner loops, the chat panel grows a tab strip: a frozen `main` tab first, a divider, then the inner loops in a horizontally scrollable row. An agent with no loops shows a single `main` stream and no strip — zero visual change from before.
- **Identity colors.** Each loop has a color derived from its name, used for its tab and for the sender-colored cards of the `loop_send` messages it delivers. A tab's status dot mirrors that loop's own live state — muted on inactive tabs unless the loop is running (yellow) or erroring.
- **Inter-loop messages** render as compact, scrollable context-inject blocks rather than full user bubbles, so a stream full of deliveries stays readable. A delivery that lands mid-stream is **held until the streaming block ends**, so it never splits an assistant bubble in half; the hold buffer is keyed per agent file, so a held card can never flush into a different agent's stream when you switch agents.
- **Token counters.** The status-bar gauge reflects the viewed loop's own context size and its own auto-compact threshold.
- **Chat placement.** The chat/loop panel can live in the right dock (the default) or be promoted to the center stage as a peer tab to documents and the browser; in center placement its reading column toggles between comfortable and full width.
- **Approvals bell.** A global bell in the title bar aggregates every pending human-in-the-loop request across all agents and loops, with inline approve/reject and a jump-to-context action — so an approval waiting on a backgrounded agent or loop is never lost.
