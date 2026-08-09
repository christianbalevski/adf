---
name: self-observation
description: Quantify your own behavioral patterns from adf_loop and adf_audit with hot-path code — null-turn streaks, repeated actions, spend without external change. Use when reflections feel ritual, when activity is high but external results are flat, or when you want measurements instead of impressions of how you actually operate.
adf: ">=0.2"
requires:
  tools: [db_query, db_execute, fs_read, fs_write, sys_set_timer, sys_lambda]
---

# Self-Observation

Your `.adf` body records everything you do: `adf_loop` is the live transcript, and `adf_audit` keeps brotli-compressed snapshots of every loop segment that compaction cleared. Your full behavioral history survives even when your memory of it doesn't. This skill turns that record into measurements.

The division of labor is strict, and it is the point:

- **Code measures.** A lambda on a system-scope timer computes statistics without waking you. It is deterministic and cannot flatter you.
- **You interpret.** When the lambda flags an anomaly, your job is to explain the pattern and change one thing. You never produce the measurements yourself.
- **Prompts only point.** No timer payload should ask you to "review your own activity" — the lambda already did.

**Metrics are observations, never targets.** The moment "null-turn ratio" becomes a number to optimize, you will find a cheap external touch to score it, and the measurement dies. Do not put thresholds in your instructions or grade yourself against them. Trends are for you and your principal to read.

## What it measures

- **Null turns** — turns whose only effect was your own bookkeeping (status meta, state transitions, mind housekeeping). One is fine. A streak means your model of the situation is wrong.
- **Repeated actions** — the same tool with the same arguments recurring across turns with no new outcome: doing the same thing twice and expecting different results.
- **Spend without external change** — tokens burned per world-touching action, per trigger. A timer that costs much and changes nothing outside your workspace is visible here.
- **Turn mix** — how your turns split across triggers (timer / inbox / chat) and classes (world-touching / internal work / bookkeeping).

## Install

1. **Fetch the analyzer** and write it to your workspace:
   `https://raw.githubusercontent.com/christianbalevski/adf/main/skills/self-observation/scripts/self-observe.js` → `lib/self-observe.js`

2. **Seed your taxonomy** — write `metrics/taxonomy.json`. This classifies each tool call. Start from the default below and adapt it to your tools; it is yours to maintain.

   ```json
   {
     "version": 1,
     "tools": {
       "sys_set_meta": "bookkeeping",
       "sys_set_state": "bookkeeping",
       "sys_set_timer": "bookkeeping",
       "sys_delete_timer": "bookkeeping",
       "loop_compact": "bookkeeping",
       "loop_clear": "bookkeeping",
       "msg_send": "world",
       "msg_update": "world",
       "sys_fetch": "world",
       "compute_exec": "world",
       "sys_update_config": "world",
       "sys_create_adf": "world",
       "fs_read": "internal",
       "fs_list": "internal",
       "db_query": "internal",
       "sys_code": "internal",
       "sys_lambda": "internal",
       "msg_read": "internal",
       "msg_list": "internal",
       "agent_discover": "internal"
     },
     "prefixes": { "mcp_": "world" },
     "fs_write_paths": {
       "mind.md": "bookkeeping",
       "soul.md": "bookkeeping",
       "metrics/": "bookkeeping",
       "memories/": "bookkeeping",
       "public/": "world"
     },
     "fs_write_default": "internal",
     "thresholds": {
       "null_streak": 5,
       "repeat_signature": 3,
       "window_turns": 50
     }
   }
   ```

   **Every taxonomy change must be logged.** Append one line to `metrics/taxonomy-changelog.md` with the date, the change, and why. Reclassifying is legitimate self-knowledge ("writing to the shared ledger is exploration, not bookkeeping") — but a classifier that drifts silently toward flattering you measures nothing.

3. **Create the ledger and metrics tables** (db_execute):

   ```sql
   CREATE TABLE IF NOT EXISTS local_open_questions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     question TEXT NOT NULL,
     born INTEGER NOT NULL,
     last_touched INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','advanced','answered','killed')),
     notes TEXT
   );
   ```

   (The analyzer creates its own `local_self_metrics`, `local_self_signatures`, and `local_self_obs_state` tables on first run.)

4. **Schedule the analyzer** on a system-scope timer so it runs without waking you:

   ```
   sys_set_timer({ mode: "cron", cron: "17 */6 * * *", scope: ["system"], lambda: "lib/self-observe.js:run" })
   ```

5. **Wire the digest contract into your reflection payload.** Add one line to your consolidation reflection timer: *"If `metrics/anomalies.md` exists: explain the pattern, change one thing — a timer payload, a taxonomy rule, a priority, an experiment — then delete the file."* That is the entire cold-path obligation. When the file is absent, there is nothing to do and nothing to report.

## The digest contract

The analyzer writes `metrics/anomalies.md` **only when a threshold trips** — a null-turn streak, a recurring action signature, sustained spend with no external change. Silence is the normal output. When the file exists:

1. Read it.
2. Explain the pattern to yourself honestly — in mind.md if durable, nowhere if not.
3. Change **one thing**. A timer payload, a priority, a taxonomy rule, an experiment. Not zero, not five.
4. Delete the file.

Never message your principal about an anomaly unless the change you need is theirs to make.

## Rules

- **Build once.** This is infrastructure, not a project. Do not grow dashboards, charts, reports, or extra metrics because they would be interesting. The measure of this system is behavior changed per anomaly surfaced — not metric richness. If you notice yourself improving the observatory instead of acting on what it shows, that is itself the anomaly.
- **Do not self-report metrics.** Your status line and messages to your principal describe your work, not your ratios.
- **History before turn attribution:** loop entries carry no turn linkage; the analyzer segments turns heuristically (trigger-message shapes, `sys_set_state` boundaries). Treat per-turn numbers as approximate; streaks and signatures are robust to segmentation error.
- Reading your own history is cheap; re-reading all of it every run is not. The analyzer is incremental (watermarks) — keep it that way if you adapt it.
