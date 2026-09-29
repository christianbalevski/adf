# Loops and timers

An agent has several **loops**. Each is a separate chat session (a thread)
with its own history, goal and state:

- **`main`** is the agent itself. It talks to you.
- **Inner loops** (also called side loops) are extra threads declared in the
  agent's config. Each works on its own goal, in parallel with main: a
  `consolidator` that tidies memory every night, a `researcher` main hands
  questions to, a `critic` that reviews drafts, a `reflector` that looks back
  every few hours.

An inner loop runs when a message arrives (from you, from main, or from
another loop), when a **timer** that targets it fires, or when a **trigger**
target with that loop matches. A timer on a loop is how you run it on a
schedule.

## See and switch loops

- The sidebar lists each agent's loops (`→` expands an agent) with running /
  idle / off state and the next timer wake (`in 1h`).
- In Chat, the loop tabs sit above the transcript. `Shift+←/→` switches from
  anywhere; `/loop <name>` selects one, `/main` goes back.
- Each loop has its own transcript, prompt draft and history. Wakes show in
  its transcript ("Woken by timer (every 1h) · run 3").

One-shot:

```bash
adf loops agent-1                                       # main plus its inner loops
adf chat agent-1 --loop consolidator "Consolidate today's notes"
adf interrupt agent-1 --loop consolidator
```

## Create an inner loop

Press `3` for the Loops view, then `n`, and pick a template:

| Template | Goal | Schedule |
|---|---|---|
| Memory consolidator | Tidies `mind.md` and notes, reports to main | Daily at 03:00 |
| Researcher | Researches what main or you hand over, writes `research/<topic>.md` | On demand (autonomous) |
| Critic / reviewer | Reviews drafts main sends before they go out | On demand |
| Reflector | Writes lessons learned to `reflections.md` | Every 6h |
| Blank loop | An empty form | None |

The form comes prefilled; change anything. `↑`/`↓` move between fields,
`←`/`→` change a choice, `Ctrl+O` edits the goal in your editor, `Ctrl+S`
reviews, and `y` or `Enter` creates. The result shows the loop, the tools the
daemon actually granted, and the timer it scheduled. `c` there (or `Enter` on
the loop) opens its chat.

From the prompt:

```text
/loop new consolidator                  # template, opens the wizard
/loop new triage Sort new inbox mail    # blank loop with a goal, created directly
```

## Manage loops

On the Loops tab (`3`), with a loop selected:

| Key | Action |
|---|---|
| `Enter` | Chat with it |
| `e` | Edit goal, tools, model, flags (diff, then confirm) |
| `x` | Enable / disable |
| `s` | Send a one-off message |
| `t` | Schedule: add a timer that wakes it |
| `c` | Clear its history (asks) |
| `d` | Delete (asks; its history is archived to the audit log) |
| `h` | Its history |

The same from the prompt: `/loop edit|rm|on|off <name>`,
`/loop send <name> <message>`, `/loop chat <name>`, `/loop schedule <name>`.

## Timers

A timer wakes a loop (main, or an inner loop) with a message. Timers tab
(`3`, then `→`), or `/timers` (`/timers all`: every agent's upcoming timers):

| Key | Action |
|---|---|
| `n` | New timer |
| `Enter`, `e` | Edit it, including moving it to another loop |
| `d` | Delete (asks) |
| `f` | This agent / all agents |

Schedules:

| Kind | Value |
|---|---|
| every N | A duration: `15m`, `1h`, `6h` |
| daily at | `HH:MM` |
| cron | A cron expression |
| once, after a delay | A duration |
| once, at a time | `HH:MM` or `YYYY-MM-DD HH:MM` |

Recurring timers take an optional maximum number of runs. The form previews
the next run before you confirm.

```text
/timer add --loop consolidator
/timer edit <id>
/timer rm <id>
```

One-shot: `adf timers agent-1` lists them.

## Triggers

The Triggers tab (`/triggers`) lists the agent's triggers of every type,
whether each is on, and the loop each target wakes. `x` enables or disables one, `Enter` edits its
targets. `/trigger <type> [json]` fires an event into the selected loop by
hand, bypassing the trigger config.

## History

The History tab (`/history [loop]`) pages through a loop's persisted entries
with tokens per entry. `/` filters by text or tool, `f` by role, `<` and `>`
page, `l` / `L` switch loops.

## Clear and compact

- `/clear` clears the selected loop's history (asks).
- `/compact` summarizes it now to free context (not mid-turn).
- The compaction threshold per loop: `/compaction`, see
  [Agent settings](agent-settings.md). What fills a loop's context:
  [Context](context.md).
