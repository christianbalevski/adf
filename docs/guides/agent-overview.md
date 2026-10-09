---
type: reference
description: How the agent Overview scores Experience, Reach, Access and Autonomy, what each input measures, agent metrics, the Contents rows with memory strata, and how the panel folds to fit
see_also:
  - memory-management.md — compaction, the compaction threshold and loop audit, which the contexts-worked count reads
  - tools.md — tool access controls (enabled, restricted) that the Access and Autonomy factors read
  - ../daemon/api-guide.md — the same numbers over HTTP
---

# Agent Overview

The Overview is the agent card in Studio's right dock. It shows a header (status line, description, context fill, next wake, 7-day cost, model, age), four stats (Reach, Access, Autonomy, Experience), the agent's metrics, and three lower sections: Coming up (the next three timer wakes), Activity (finished turns per local day over 14 days, with cost per day) and Contents.

This page states how every number is computed. The scoring is in `src/shared/utils/agent-stats.ts`; the inputs are measured in `src/main/services/agent-vitals.ts`. The tables below are checked against the exported constants (and `MEMORY_STRATA_DAYS` in `src/shared/types/agent-vitals.types.ts`) by `tests/unit/shared/agent-overview-doc.test.ts`.

The daemon serves the same reads: [`GET /agents/:id/vitals`](../daemon/api-reference.md#op-getagentvitals) (header, stats, metrics) and [`GET /agents/:id/activity`](../daemon/api-reference.md#op-getagentactivity) (the lower sections). See the [API guide](../daemon/api-guide.md).

## Experience

Experience is a level on an unbounded curve. It is derived from what the `.adf` file holds at read time, so it goes down when the agent deletes its own work (memory, skills, tables, files). Nothing is stored or accumulated.

### Signals

XP is the sum of the signal XP values below.

| Signal | Constant | Weight | XP |
|--------|----------|--------|----|
| Contexts of work | `EXPERIENCE_WEIGHTS.contextsWorked` | 10 | contexts × 10 |
| Memory tokens | `EXPERIENCE_WEIGHTS.memoryTokensSqrt` | 2.6 | √tokens × 2.6 |
| Skills | `EXPERIENCE_WEIGHTS.skills` | 80 | skills × 80 |
| Database tables | `EXPERIENCE_WEIGHTS.localTables` | 10 | tables × 10 |
| Database rows | `EXPERIENCE_WEIGHTS.localRowsSqrt` | 7 | √rows × 7 |
| Files written | `EXPERIENCE_WEIGHTS.filesWritten` | 2 | files × 2 |
| Agents created | `EXPERIENCE_WEIGHTS.agentsSpawned` | 75 | children × 75 |
| Messages | `EXPERIENCE_WEIGHTS.messages` | 0.01 | messages × 0.01 |
| Days active | `EXPERIENCE_WEIGHTS.ageDays` | 0.5 | days × 0.5 × activity |
| Activity divisor | `EXPERIENCE_WEIGHTS.ageActivityContexts` | 10 | activity = min(1, contexts / 10) |

A missing, negative or non-finite input counts as 0. Memory tokens and rows are square-rooted, so 10 times the memory gives about 3.2 times the XP. Age XP is scaled by activity, so an agent with no work earns nothing by waiting.

### Measurement

The **write cutoff** is the agent's creation time plus 10 seconds. Creation time is `adf_created_at` in `adf_meta`, else `config.metadata.created_at`. Writes at or before the cutoff are the creation itself (seeded and template files). When the creation time is unknown, every file counts as the agent's own.

| Signal | How it is measured |
|--------|--------------------|
| Contexts of work | Summed over every loop the file knows: `main`, `config.loops`, loops with rows in `adf_loop`, and deleted loops archived in `adf_audit`. Per loop: past contexts plus the current context's fill. Rounded to 2 decimals. |
| Memory tokens | (total `size` of `adf_files` rows under `mind/`, minus 166 bytes) / 4, rounded, floored at 0. 166 is the byte length of the seeded `mind/log.md` header (`DEFAULT_MIND_LOG_CONTENT`). |
| Skills | Distinct names `<name>` of `skills/<name>/` directories holding a file changed after the write cutoff, plus every name in `skills-registry.json` whose `skills/<name>/` directory has no file at or before the cutoff. Starter skills that the agent has not changed do not count. |
| Database tables | Number of tables named `local_*` (name matches `local_[A-Za-z0-9_]+`). |
| Database rows | `COUNT(*)` summed over the first 50 `local_*` tables by name. |
| Files written | `adf_files` rows with `updated_at` after the write cutoff, excluding paths under `mind/` (counted as memory tokens) and `skills-registry.json` (rewritten by the runtime). Skill files count. |
| Agents created | Agents in the last fleet scan (running agents plus `.adf` files in tracked directories) whose `adf_parent_did` equals this agent's DID, any DID in `adf_did_history`, or `config.id`. The signal is omitted until a fleet scan has run. Studio and the daemon redo the scan when it is older than 30 seconds. |
| Messages | The `adf_loop` AUTOINCREMENT high-water mark: max of the `sqlite_sequence` row for `adf_loop` and `MAX(seq)`. `seq` is shared by all loops, so this is the number of loop rows ever written and survives compaction, clears and loop deletion. |
| Days active | (now − creation time) / 86 400 000 ms. XP uses the fraction; the card shows the floor. |

Contexts of work per loop:

- **Past contexts.** Each archived loop snapshot in `adf_audit` (source `loop` for the main loop before schema 29, or `loop:<name>`) counts min(1, (`size_bytes` / 4) / (0.5 × threshold)). A compaction is one context; a small slice clear is a fraction. With [loop audit](memory-management.md#audit) off nothing is archived, so the count of live `[Loop Compacted` summary rows in that loop is used instead. The larger of the two counts.
- **Current context.** Only for a loop with live rows: min(1, tokens / threshold). Tokens are the loop's context baseline (`context_baseline_tokens` or `context_baseline_tokens:<loop>` in `adf_meta`, the size of its next request) or, without one, the loop's `content_json` bytes / 4.
- **Threshold** is the loop's [compaction threshold](memory-management.md#compact-threshold), resolved as the executor resolves it. A deleted loop uses the main loop's.

### Level curve

| Constant | Value |
|----------|-------|
| `EXPERIENCE_CURVE.scale` | 5 |
| `EXPERIENCE_CURVE.exponent` | 2.25 |

```
xpForLevel(L) = 5 · (L − 1)^2.25        (Lv 1 starts at 0)
level(XP)     = largest L ≥ 1 with xpForLevel(L) ≤ XP
progress      = (XP − xpForLevel(level)) / (xpForLevel(level + 1) − xpForLevel(level))
```

| Level | Starts at XP |
|-------|--------------|
| 2 | 5 |
| 3 | 23.8 |
| 5 | 113.1 |
| 10 | 701.5 |
| 15 | 1 895.6 |
| 20 | 3 768.5 |
| 25 | 6 374.5 |
| 30 | 9 758.1 |

A higher level costs more XP, but each band is a smaller share of the total (Lv 20 spans 3 768.5 to 4 229.5, about 11%). There is no top level.

The card's next-level hint converts the missing XP into three alternatives: contexts = ⌈XP / 10⌉; memory tokens = ⌈((√current tokens × 2.6 + XP) / 2.6)² − current tokens⌉; skills = ⌈XP / 80⌉.

### Example

A heavily used agent, months old (the `HEAVY_XP` calibration fixture in `tests/unit/shared/agent-stats.test.ts`):

| Signal | Value | XP |
|--------|-------|----|
| Contexts of work | 150 | 1 500 |
| Memory tokens | 20 000 | 367.7 |
| Skills | 10 | 800 |
| Database tables | 5 | 50 |
| Database rows | 8 000 | 626.1 |
| Files written | 40 | 80 |
| Agents created | 3 | 225 |
| Messages | 30 000 | 300 |
| Days active | 120 (activity 1) | 60 |
| **Total** | | **4 008.8** |

4 008.8 is between xpForLevel(20) = 3 768.5 and xpForLevel(21) = 4 229.5: Lv 20, 52% through the level. Work (contexts) is 37% of the XP.

## Reach, Access and Autonomy

These three stats score the agent's configuration, not its history. Each stat has a list of factors with fixed points. Every factor is capped, so each stat has a fixed maximum.

- **Reach**: who can reach the agent and whom it reaches.
- **Access**: what the agent can do.
- **Autonomy**: how much the agent does with no one in the chat.

### Arithmetic

```
fill  = clamp(points / max, 0, 1)
level = 1 + round(19 × fill)
```

An empty configuration is Lv 1 and a configuration with every factor at its cap is Lv 20. The card's bar shows `fill`.

A factor is **gated** when using it needs human approval: a tool marked `restricted` ([Tools](tools.md)), a restricted MCP server, a sealed credential or sealed signing key. Gated points count toward the level; the card draws them hatched. Other positive factors are open.

Mitigations are factors with negative points. They are subtracted from the open points first; if open points go below 0, the rest is subtracted from the gated points, floored at 0. `points = open + gated`.

A stat is drawn in the warning colour (`high`) when open points / max ≥ 0.6, which is open points alone reaching Lv 12.

| Constant | Value |
|----------|-------|
| `POWER_LEVEL_MAX` | 20 |
| `POWER_HIGH_OPEN_SHARE` | 0.6 |

When a count factor is capped by number of items (MCP servers, adapters), the heaviest items count, open before gated on a tie, then in config order. Items past the cap are still listed on the card at 0 points.

### Maximums

`POWER_MAX` is the sum of every positive factor at its cap, computed from the tables below. For a factor with alternatives (visibility tier, send mode, timer speed, signing key), the largest alternative counts.

| Stat | Constant | Max points |
|------|----------|------------|
| Access | `POWER_MAX.access` | 19.25 |
| Reach | `POWER_MAX.reach` | 21.5 |
| Autonomy | `POWER_MAX.autonomy` | 15.5 |

### Access

Tools: each tool below that is enabled adds its points. Gated when the tool is restricted.

| Tool | Constant | Points |
|------|----------|--------|
| `fs_read` | `ACCESS_TOOL_POINTS.fs_read` | 0.25 |
| `fs_write` | `ACCESS_TOOL_POINTS.fs_write` | 0.25 |
| `fs_delete` | `ACCESS_TOOL_POINTS.fs_delete` | 0.25 |
| `sys_code` | `ACCESS_TOOL_POINTS.sys_code` | 0.5 |
| `sys_lambda` | `ACCESS_TOOL_POINTS.sys_lambda` | 0.25 |
| `sys_fetch` | `ACCESS_TOOL_POINTS.sys_fetch` | 0.5 |
| `db_execute` | `ACCESS_TOOL_POINTS.db_execute` | 0.25 |
| `adf_shell` | `ACCESS_TOOL_POINTS.adf_shell` | 0.5 |
| `ws_connect` | `ACCESS_TOOL_POINTS.ws_connect` | 0.5 |
| `stream_bind` | `ACCESS_TOOL_POINTS.stream_bind` | 0.5 |
| `fs_transfer` | `ACCESS_TOOL_POINTS.fs_transfer` | 0.5 |
| `mcp_install` | `ACCESS_TOOL_POINTS.mcp_install` | 1 |
| `compute_exec` | `ACCESS_TOOL_POINTS.compute_exec` | 1 |

Other factors:

| Factor | Constant | Points | Rule |
|--------|----------|--------|------|
| Host command target | `ACCESS_POINTS.computeHostTarget` | 1.5 | `compute_exec` enabled and `host` in `compute.allowed_targets` or `compute.target`. Gated when `compute_exec` is restricted. |
| Own compute container | `ACCESS_POINTS.computeEnabled` | 0.5 | `compute.enabled` |
| MCP servers on the host | `ACCESS_POINTS.hostAccess` | 2 | `compute.host_access` |
| Sandbox network | `ACCESS_POINTS.codeNetwork` | 1 | `code_execution.network` |
| npm package | `ACCESS_POINTS.npmPackage` | 0.25 | Per entry in `code_execution.packages` |
| npm package cap | `ACCESS_POINTS.npmPackageCap` | 1 | Total for packages |
| MCP server | `ACCESS_POINTS.mcpServer` | 0.5 | Per entry in `mcp.servers`. Gated when the server is restricted. |
| MCP server credentials | `ACCESS_POINTS.mcpCredentials` | 0.25 | Per server with `oauth`, `bearer_token_env_var`, or a non-empty `env_keys`, `env_schema`, `header_env` or `credential_files`. Gated like its server. |
| MCP server cap | `ACCESS_POINTS.mcpServerCap` | 6 | Servers that count, heaviest first |
| Stored credential | `ACCESS_POINTS.credential` | 0.25 | Per `adf_identity` row whose purpose does not start with `crypto:`. Sealed rows (an `encryption_algo` other than `plain`) are gated. |
| Credential cap | `ACCESS_POINTS.credentialCap` | 1.5 | Shared by plain and sealed rows; plain rows claim it first |
| Signing key, unsealed | `ACCESS_POINTS.privateKeyPlain` | 1 | `crypto:signing:private_key` row stored plain |
| Signing key, sealed | `ACCESS_POINTS.privateKeySealed` | 0.5 | Same row, sealed. Gated. |

### Reach

Inbound points apply only when `messaging.receive` is true. They depend on `messaging.visibility`:

| Visibility | Constant | Points |
|------------|----------|--------|
| `off` | `VISIBILITY_POINTS.off` | 0 |
| `directory` | `VISIBILITY_POINTS.directory` | 0.5 |
| `localhost` | `VISIBILITY_POINTS.localhost` | 1 |
| `lan` | `VISIBILITY_POINTS.lan` | 2 |
| `public` | `VISIBILITY_POINTS.public` | 4 |

| Factor | Constant | Points | Rule |
|--------|----------|--------|------|
| Sends on its own | `REACH_POINTS.sendProactive` | 1 | `msg_send` enabled and `messaging.mode` is `proactive`. Gated when `msg_send` is restricted. |
| Replies only | `REACH_POINTS.sendRespondOnly` | 0.5 | `msg_send` enabled and any other mode except `listen_only`. Gated when `msg_send` is restricted. |
| Public web page | `REACH_POINTS.publicPage` | 3 | `serving.public.enabled` |
| HTTP API route | `REACH_POINTS.apiRoute` | 0.5 | Per entry in `serving.api` |
| HTTP API route cap | `REACH_POINTS.apiRouteCap` | 3 | Total for routes |
| Shared files | `REACH_POINTS.sharedFiles` | 1 | `serving.shared.enabled` |
| Channel adapter | `REACH_POINTS.adapter` | 2.5 | Per enabled entry in `adapters` |
| Channel adapter, DMs restricted | `REACH_POINTS.adapterRestrictedDm` | 1 | Adapter whose `policy.dm` is `allowlist` or `none` |
| Adapter cap | `REACH_POINTS.adapterCap` | 3 | Adapters that count, heaviest first |
| WebSocket connection | `REACH_POINTS.wsConnection` | 0.5 | Per enabled entry in `ws_connections` |
| WebSocket connection cap | `REACH_POINTS.wsConnectionCap` | 2 | Total for connections |

Mitigations, applied only when inbound points are above 0:

| Mitigation | Constant | Points | Rule |
|------------|----------|--------|------|
| Allow list | none | −inbound / 2 | `messaging.allow_list` is not empty |
| Signed messages only | `REACH_POINTS.signedOnly` | -0.5 | `security.allow_unsigned` is false or `security.require_signature` is true |

### Autonomy

| Factor | Constant | Points | Rule |
|--------|----------|--------|------|
| Autonomous | `AUTONOMY_POINTS.autonomous` | 3 | `autonomous` |
| Autostart | `AUTONOMY_POINTS.autostart` | 2 | `autostart` |
| Timers | `AUTONOMY_POINTS.timers` | 1 | At least one non-expired row in `adf_timers` |
| Fast timer | `AUTONOMY_POINTS.timerFast` | 2 | Fastest timer interval ≤ 5 minutes |
| Hourly timer | `AUTONOMY_POINTS.timerHourly` | 1 | Fastest timer interval ≤ 1 hour (and > 5 minutes) |
| Trigger target | `AUTONOMY_POINTS.trigger` | 0.25 | Per target of each enabled trigger except `on_chat` |
| Trigger cap | `AUTONOMY_POINTS.triggerCap` | 1.5 | Total for trigger targets |
| Starts conversations | `AUTONOMY_POINTS.proactive` | 0.5 | `msg_send` enabled and `messaging.mode` is `proactive`. Gated when `msg_send` is restricted. |
| Creates agents | `AUTONOMY_POINTS.createAgents` | 3 | `sys_create_adf` enabled. Gated when restricted. |
| Changes its own config | `AUTONOMY_POINTS.updateConfig` | 1 | `sys_update_config` enabled. Gated when restricted. |
| Inner loop | `AUTONOMY_POINTS.sideLoop` | 0.5 | Per entry in `config.loops` |
| Inner loop cap | `AUTONOMY_POINTS.sideLoopCap` | 1.5 | Total for inner loops |
| Restricted tool (mitigation) | `AUTONOMY_POINTS.restrictedTool` | -0.25 | Per enabled tool marked restricted |
| Restricted tool floor | `AUTONOMY_POINTS.restrictedToolCap` | -1 | Lowest total for the mitigation |

A timer's interval is `every_ms` for an `interval` schedule. For a `cron` schedule only the minute field is read: `*` is 1 minute and `*/N` is N minutes; any other cron has no interval. A one-time timer has none.

### Example

A newly created agent with the default tools, `messaging.receive` true, `localhost` visibility, `proactive` mode, unsigned messages allowed, and the shipped triggers (`on_inbox` with 1 target, `on_timer` with 2):

| Stat | Factors | Points | Fill | Level |
|------|---------|--------|------|-------|
| Access | `fs_read` 0.25, `fs_write` 0.25, `sys_code` 0.5, `sys_lambda` 0.25, `sys_fetch` 0.5 | 1.75 / 19.25 | 0.091 | 1 + round(1.73) = 3 |
| Reach | localhost 1, sends on its own 1 | 2 / 21.5 | 0.093 | 1 + round(1.77) = 3 |
| Autonomy | triggers 3 × 0.25 = 0.75, starts conversations 0.5, `sys_update_config` 1 (gated), 1 restricted tool −0.25 | 2 / 15.5 (open 1, gated 1) | 0.129 | 1 + round(2.45) = 3 |

No stat is `high`.

## Agent metrics

An agent publishes metrics by writing `adf_meta` keys of the form `metric:<name>`, for example with [`sys_set_meta`](tools.md#sys_set_meta). The Overview lists the first 20 by key, with the prefix removed. Metrics do not affect any level. Parsing is in `src/shared/utils/agent-metrics.ts`; the daemon returns the parsed fields too.

A value is either a plain string, shown as stored, or a JSON object:

```json
{"value": 64, "label": "Disk used", "unit": "%", "min": 0, "max": 100, "target": 80}
```

| Field | Type | Effect |
|-------|------|--------|
| `value` | number or string | REQUIRED. The value shown. |
| `label` | string | Replaces `<name>` as the row's name. |
| `unit` | string | Shown after the value (`%` without a space). |
| `min` | number | Start of the bar's range. Defaults to 0. |
| `max` | number | When set, above `min`, and `value` is a number: a thin bar of (value − min) / (max − min), clamped to 0..1. |
| `target` | number | With a bar: a tick at the target's position. Without `max`: the value reads `value / target unit`. |

A value that is not such an object (invalid JSON, an array, no `value`, or a `value` that is neither a number nor a string) is shown as the raw string. Fields of the wrong type are ignored.

Examples:

- `metric:disk` = `{"value": 64, "label": "Disk used", "unit": "%", "max": 100, "target": 80}` shows **Disk used**, a bar at 64 % with a tick at 80 %, and `64%`.
- `metric:focus` = `{"value": 42, "unit": "h", "target": 50}` shows **focus** and `42 / 50 h`.

## Contents

The Contents section reads paths, timestamps and sizes from `adf_files` (never content) and counts `local_*` tables. It has one row per group. Memory is what the agent recorded in `mind/` since it was created; skills are loaded artifacts that hint at what it can do. The two are kept apart: there is no shared bar or token total.

| Row | Shows | Computed as | Opens |
|-----|-------|-------------|-------|
| Memory | `~20k tokens · 12 files`, and `N updated this week` | Files under `mind/`; total bytes / 4, rounded (the seeded log header is included). Strip: see [Memory strata](#memory-strata). Updated this week: `mind/` files whose `updated_at` is within the last 7 days; not shown when 0. | Files |
| Skills | `5 skills · ~18k tokens` | Skills, by the rule under [Measurement](#measurement); bytes of the files under `skills/<name>/` for those skills / 4, rounded | Agent > Skills |
| Tables | `3 tables · 2.1k rows` | `local_*` tables, first 50 by name; rows summed over those tables | Files |

A row with a count of 0 is not shown. The section is hidden when all three are 0.

### Memory strata

Under the Memory row a thin strip splits the current `mind/` tokens by when each file was last updated. It is computed from the files as they are now, with no history kept: each file's bytes go to one band by its `updated_at`, and each band's bytes / 4, rounded, are its tokens. The seeded `mind/log.md` header is taken off that file's bytes, as for the Experience memory signal, so the band totals can be slightly below the row's token count.

| Band | Constant | Days | Last updated |
|------|----------|------|--------------|
| `week` | `MEMORY_STRATA_DAYS.week` | 7 | at most 7 days ago |
| `month` | `MEMORY_STRATA_DAYS.month` | 30 | more than 7 and at most 30 days ago |
| `quarter` | `MEMORY_STRATA_DAYS.quarter` | 90 | more than 30 and at most 90 days ago |
| `older` | | | more than 90 days ago |

A file updated exactly on a boundary belongs to the younger band. The strip's width is the total; segments run oldest (left, darkest) to newest (right, lightest). A band with 0 tokens has no segment, and the strip is hidden when all bands are 0. Each segment's tooltip gives its tokens and age, for example `~12k tokens last updated over 90 days ago`. The daemon returns the bands as `contents.mind.strata`.

## Fitting the panel

The Overview does not scroll at its usual sizes. When its content is taller than the dock, it folds sections in this order, one at a time, until it fits:

1. The Activity chart becomes a fact in the facts line (`5 turns / 14d`).
2. The Contents rows and the strata strip become one line in the Contents title row (`Memory ~20k · 5 skills · 3 tables`).

Each fold remembers the height it saved. When space returns, folds are undone in reverse order, each only when the content plus the height it saved fits, so a section does not fold and unfold repeatedly. If the content is still too tall with both folded, the panel scrolls.

## Header cost

The 7-day cost is the sum of `cost_usd` in the per-agent usage ledger for this agent's `config.id` over the last 7 local calendar days, today included. It is absent when the ledger has no rows for the agent in that window. It is marked partial when some calls in the window had tokens but no price; the sum is then a lower bound. The Activity chart's cost per day reads the same ledger.

## Caching

Each read (vitals and activity) has a cheap part and a heavy part.

- **Cheap part** (config, identity rows, timers, metrics, the message high-water mark, next wakes): re-read when the source changes. For an agent open in this process the source key is the connection's `total_changes()`, re-read at most every 2 seconds. For a file no one has open it is the mtime and size of the file and its WAL, read through one read-only open.
- **Heavy part** (the `adf_files` scan, `local_*` row counts, contexts of work, the per-day turn scan): reused for up to 30 seconds (`HEAVY_MIN_AGE_MS`) even when the database changed.
- **Force** (`force=1` on the daemon endpoints): re-reads the cheap part and re-reads the heavy part unless it is younger than 2 seconds (`FORCE_MIN_INTERVAL_MS`).
- The activity read is also dropped when the local date changes.

The `[Loop Compacted` summary scan and the per-day turn scan are incremental: each later read reads only `adf_loop` rows above the last scan's highest `seq`.
