---
name: subconscious-loops
description: Build a subconscious for an agent out of inner loops. Four loops each run one abstract operation (replay, expectation, association, weighing), process without acting, and give main a short list of what is on its mind. This covers one use of inner loops; loops that complete tasks are a different use and are not covered here.
adf: ">=0.6"
requires:
  tools: [fs_read, fs_write, db_query, db_execute, loop_list, loop_manage, loop_send, sys_get_config, sys_set_timer, sys_set_state]
---

# Build a subconscious from inner loops

## Purpose

An inner loop is a second stream of thinking inside one agent. It shares the agent's files, memory and identity. Inner loops have many uses. A loop can complete a task, draft a report from the agent's own notes, or review a plan before main acts.

This skill covers one use: building the agent a subconscious. It is the use ADF's designer first had in mind for loops, as organelles or inner parts of a mind. These loops process and never act. A handful of them run quietly, and together they make the main loop more aware of time, of its own history and of the person it works for.

The rules below apply to the loops this skill builds. They are not rules for every inner loop.

What the user should notice is main saying something well-timed that nobody asked for. They should never notice the loops.

## The two rules for a subconscious loop

**1. A subconscious loop does not act.** It sends nothing outside the agent, changes no config, and publishes nothing. If you find yourself wanting to give one of these loops a send path or a deliverable, you are building a task loop. That is a valid loop, but it is not part of the subconscious. Build it separately and leave these four alone.

**2. A subconscious loop has an operation and no topic.** A brain has no region for loose ends and no region for prose quality. It has regions that predict, replay and associate, and those specific behaviours come out of them. So define each loop by what it does to whatever passes through it. Inside this set, do not create a "follow-up tracker" or a "style checker". If you want one of those behaviours from the subconscious, check which operation should produce it and fix that loop's goal.

## The four operations

| Loop | What it does | Behaviours that come out of it |
|---|---|---|
| replay | Goes back over recent experience and compresses it into memory. Rereads older memory a few pages at a time and keeps it lean, with each piece in the place where it will be read when needed. | The index that loads every turn stays small. Detail sits in the page for its subject. Memory pages stay current and stay short. Repeated corrections from the principal get noticed as a pattern. An old unfinished matter comes back up when it matters again. |
| expectation | Predicts what should happen next and notices when it does not. | Unanswered questions, missed follow-ups, promises going stale, the agent's writing drifting from its own voice. |
| association | Links things that were not linked. | "This is the same problem as June." A new request connected to an old idea. |
| weighing | Decides what is worth main's attention now. | A short list of what is on the agent's mind. Everything else is dropped. |

The right-hand column is there to help you recognise the output. Never put it in a loop's goal. A loop told to look for unanswered questions will find only those.

Four is a starting set. Add an operation only if you can state it without naming a subject.

## How loops talk to each other and to main

Loops do not send each other messages. They leave traces in a shared table, `local_loop_traces`, and read each other's traces. Replay, expectation and association write traces. Weighing reads them.

Main does not get memos either. Weighing keeps a small block in `mind.md`, which main reads from the file (see Main's side):

```
## On my mind
<!-- loops:start -->
- [<date>, t<trace id>] <one plain sentence: what was noticed, with the names and dates that make it checkable>
<!-- loops:end -->
```

Five lines at most, 30 words each, each line gone after three days. This is the only place loop output reaches main in normal running. `loop_send` with wake is for one case: something due within hours that cannot wait for main's next turn. Weighing alone may use it, once a day at most.

Loops may write memory pages under `mind/` (replay does this as its main work). Replay also tends memory that already exists. It moves detail out of the index into the page that owns it, moves history to the log or the archive, merges duplicates, and shortens out-of-date text after copying it to `mind-archive/`. It writes a `misplaced` trace when something in `## Always` should move, and a `resurfaced` trace when something old still matters. Weighing decides whether that trace reaches main, the same as any other. Loops never edit `README.md`, `soul.md` or the `## Always` section of `mind.md`. A proposed rule goes into a trace and main decides.

## Setup (main does this)

Loops cannot create loops or change config, and these loops get no timer tool. Main does every step here through the normal config and approval path. This skill grants nothing.

1. Read the loops guide listed in `https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/index.md` for the current config shape. Do not guess field names.
2. Run `loop_list`. Leave existing loops as they are. Task loops can run beside the subconscious. Do not convert one into a subconscious loop, because its stream and its habits carry the old job; create new loops.
3. Create the two tables and add the `## On my mind` block to `mind.md`. The SQL and the block are in [references/loop-goals.md](references/loop-goals.md). Seed each loop's `last_seq` in `local_loop_state` at a recent point, such as main's last compaction. Otherwise its first run reads the whole history.
4. Create the loops with the goals from that file, copied whole. Give each loop only file and database tools plus `loop_list`, `loop_send` and `sys_set_state`. No messaging, no config, no timers, no shell. The runtime also adds `loop_compact` and `loop_clear` to every loop when they are enabled and not restricted on the agent, whatever the allow-list says; they ship disabled. Create each loop with `autostart` false, since these loops run on timers. Loops start from their goal alone, so the goal must be copied whole; check it against the 4,000-character limit.
5. Use the model the principal has set for non-main loops. If they have set none, ask. These goals are abstract and a weak model may write vague traces, so tell the principal that when you ask. A loop whose model names a provider that cannot be built does not start. A same-provider model that cannot be built falls back to the agent's model and is logged as `loop_model_override_ignored`. After the loop's first run, check `adf_logs` for that entry and for provider errors.
6. Set one timer per loop. Starting cadence: expectation every 3 hours, replay twice a day, association once a day, weighing 20 minutes after each expectation run. Loops that find nothing new cost one short turn. Lower the cadence before you raise it.
7. Start with expectation and weighing. Add replay and association after the first pair has produced lines that main used, or sooner if the principal wants all four running. On the first agent built with this skill, replay was added a day later and still produced more used lines in week one than expectation (6 of 10), mostly old unfinished matters and stale memory. Starting replay with the first pair is reasonable.

## Main's side

- Your injected copy of `mind.md` is a snapshot from your last compaction or clear, and weighing edits the file while you run. Read the block with `fs_read` at the start of a turn where you have room to use it, and treat the file as current.
- Read the block as your own thoughts. Do not tell the principal that a loop noticed something, and do not recite the list.
- Use a line when the moment fits: the subject comes up, or there is a quiet opening and the thing is worth the principal's time. Holding a line and never using it is fine.
- When you use a line or decide against it, delete it from the block and set the trace to `used` or `dropped` with a few words in `note`. Weighing reads these to learn what you found useful. If you skip this step the loops cannot improve. Bind the note as a parameter in `db_execute`; a semicolon inside an SQL string literal is rejected as a second statement.
- After replay runs, check `pending_moves` in `local_loop_state`. Replay lists there any text longer than about 1 KB that should move, because a loop retypes what it copies and the copy comes back close but not exact (on the first agent, quote and dash characters changed). Do these moves by code: write the new place, compare the bytes, then remove the old. Moves left for four days came back as a `resurfaced` trace.
- Loops read your stream a few hours behind you. Some traces will be about things you already handled; weighing should drop those, and when one reaches the block anyway, drop it with a note saying where you handled it.
- Rules proposed in `pattern` traces are proposals. Apply your normal test before adding anything to `## Always`.

## Review

After seven days, and weekly after that on a recurring timer, run:

```sql
SELECT loop, kind, status, COUNT(*) FROM local_loop_traces
WHERE created_at > datetime('now','-7 days') GROUP BY loop, kind, status;
```

Then read twenty traces yourself. Check:

- **Used lines.** How many surfaced lines did main use? Did any lead to something the principal reacted to? This is the number that matters. Count a find a line led main to, even when the find was about something else. On the first agent, a line about a stale address on the agent card sent main into its config, where it found a real problem the line never mentioned.
- **Vague traces.** A trace that names no person, file, message or date is a failure, even with a source attached. Many of these means the goal or the model is wrong.
- **Noise.** If the block is always full, weighing is too generous. If main drops most lines, the same.
- **One-note loops.** If every surprise is the same kind of thing, the loop has turned into a worker. Find the wording in its goal that narrowed it. A real issue that recurs (the same problem flagged three times because it was not fixed) is not one-note.
- **Cost.** Count stream rows per loop in `adf_loop`. On the first agent, weighing every 3 hours wrote 667 rows in a week to decide 27 traces, because it runs even when there are no new traces. If cost matters, look there first.

Fix a weak loop by rewriting its operation in plainer words or by changing its model. Do not fix it by giving it a topic. A subconscious loop that has produced nothing used after two reviews gets deleted, and you tell the principal. Delete it; do not leave it disabled. A disabled loop still sits in the agent's config and in the principal's view, and deleting archives its stream to the audit log, so nothing is lost. At each review, also list any other inner loop that is disabled or no longer used, and ask the principal before deleting it.

## Boundaries

- The traces table holds private context. Keep it and the `mind.md` block out of every serving route.
- A subconscious loop that needs a tool outside the list above has drifted into task work. Stop and move that work to main or to a separate task loop.
- Do not raise the five-line cap or the cadence to make the loops look busier.
- Do not add a single-job loop to this set, however useful the job is. If the job suits a loop, make it a task loop outside this skill. Otherwise put it on a timer for main, in a lambda, or in a separate agent.
