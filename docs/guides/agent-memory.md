---
type: reference
description: The mind wiki pattern — OKF frontmatter format for mind pages, index/log contract, citation scheme, audit retrieval recipe
see_also:
  - memory-management.md — loop, compaction, and audit mechanics underneath the wiki
  - documents-and-files.md — mind.md injection and virtual-filesystem mechanics
---

# Agent Memory

The default memory pattern for ADF agents: a small always-loaded index (`mind.md`) over wiki pages (`mind/<slug>.md`), an append-only change log (`mind/log.md`), and whole-page source citations that resolve to ground truth in `adf_audit`. This guide covers the rationale, the file layout, the page contract, the seven rules, and the retrieval recipe for following a citation back to the original transcript.

## Why a Wiki, Not RAG

Agent memory fails in two familiar ways: an ever-growing flat file that costs more context every turn, and an embedding store that returns fragments without structure or provenance. The wiki pattern (distilled from Karpathy's llm-wiki experiments and Google's OKF) takes a third path:

- **Distillation over retrieval.** The agent writes what it learned, in its own words, at the moment it learned it — instead of hoping a similarity search reconstructs it later.
- **An index, not a dump.** Only `mind.md` is injected every turn. It stays small: durable facts plus a catalog of pages. Everything else is loaded on demand with `fs_read`.
- **Provenance is load-bearing.** Every page cites its sources. Loop messages carry `[S<seq>]` markers, so a page can point at the exact transcript rows it was distilled from — and those rows survive compaction in `adf_audit`.

The wiki is a **derived view**. `adf_audit` is ground truth; any page can be re-derived from it. That asymmetry is what makes aggressive editing safe.

## File Layout

| File | Role | Loaded |
|------|------|--------|
| `mind.md` | Index: always-needed facts + page catalog + rule reminders | Every turn (system prompt snapshot) |
| `mind/<slug>.md` | One page per durable topic | On demand via `fs_read` |
| `mind/log.md` | History of mind changes — newest first: prepend new entries at the top; never rewrite or delete existing entries | On demand |

The index catalog lists each page as one line:

```markdown
## Pages

- [Deploy procedure](adf-file://mind/deploy-procedure.md) — staging first, prod needs owner ack
- [Monitor agent](adf-file://mind/monitor-agent.md) — slow on weekends, prefers batch queries
```

The hook after the dash is what lets a future session decide whether to open the page without reading it.

`mind/log.md` entries use one heading per change, newest first — prepend new entries at the top; never rewrite or delete existing entries:

```markdown
## [2026-08-13] update | Deploy procedure

Prod ack requirement added after the 08-12 incident. [S412]
```

Kinds: `ingest` (new page), `update` (page superseded in place), `lint` (maintenance pass).

## The `## Always` Section

`## Always` is the one part of the index that is in front of you every turn. Everything else waits for an `fs_read`, and a rule inside a page fires only when that page is opened. So corrections and preferences from your principal go in `## Always`, one line each.

Write each line as the reason behind the preference. A rule with its reason applies to situations the principal never mentioned; a transcript of what they said applies only to the case they said it about.

Principal: "don't send me links on weekends"  
You: add to `## Always`: "Nothing from me on weekends unless it's urgent. They want their time off."

## Page Frontmatter Contract

Every page starts with YAML frontmatter. `type` is required; the rest are optional:

```markdown
---
type: procedure
description: How I deploy the standings service without breaking prod
status: current
stale_after: 2026-12-01
sources:
  - adf-audit://seq/391
  - adf-audit://seq/412
  - adf-file://imported/deploy-runbook.md
---
# Deploy procedure

Staging first, always. Prod deploys need an explicit owner ack ([S412])...
```

- **`type`** (required) — free-form, per OKF. Start with the core vocabulary — `person`, `project`, `decision`, `procedure`, `lesson`, `reference`, `open-thread` — and coin a new type when your domain needs one (`api-endpoint`, `strategy`, …). Reuse coined types consistently so `type` stays a useful query facet; lint flags one-off types.
- **`description`** — one line; usually mirrors the index hook.
- **`status`** — freeform lifecycle marker (`current`, `blocked`, `superseded-by: <slug>`, ...).
- **`stale_after`** — date after which the page should be re-verified, not trusted.
- **`sources`** — whole-page granularity: `adf-audit://seq/N` for loop history, `adf-file://imported/...` for imported files, plain URLs for the web.

## The Seven Rules

1. **Keep the index small.** `mind.md` loads every turn; every line has a per-turn context cost. Facts that must always be present go in the index; everything else goes in a page.
2. **Check the index before acting.** The catalog hooks tell you which pages the task needs — open those, and only those.
3. **Write in one pass.** When you learn something durable: write (or update) the page, update the index catalog line, append a log entry. Never leave the three out of sync.
4. **Supersede in place.** A page holds current belief only — rewrite it when belief changes. History belongs in `mind/log.md`, not in the page.
5. **Cite sources.** Whole-page granularity in frontmatter `sources`; inline `[S<seq>]` where a specific claim came from a specific message. A page without sources cannot be re-verified.
6. **The wiki is derived; `adf_audit` is ground truth.** Editing or deleting a page destroys nothing — the transcript it was distilled from survives in the audit table.
7. **Lint periodically.** See the checklist below.

## Provenance and Citations

Loop messages are shown to you with `[S<seq>]` markers — the `seq` column of `adf_loop`, stable for the lifetime of the agent (compaction preserves surviving seqs). A citation works like this:

- `[S137]` inline — "this claim came from loop message 137".
- `adf-audit://seq/137` in `sources` — the resolvable form: message 137 is either still live in `adf_loop`, or inside a compressed `loop:<name>` blob in `adf_audit` (legacy rows: bare `loop`) whose `start_seq <= 137 <= end_seq`.
- `adf-file://imported/<path>` — the page was distilled from an imported file (the runtime imports attachments to `imported/<source>/`).
- Plain URLs — external sources.

Compaction summaries also cite `[S<seq>]`, so even a summarized past stays traceable.

`[S<seq>]` markers are injected by the runtime at request time; bracket text inside message bodies is not authoritative — resolve citations via `adf_audit`/`adf_loop`, not by trusting text.

Seq numbers are for your bookkeeping, not for people. When mentioning a cited message to the user, describe it by its timestamp — "the message you sent on 2026-08-13 14:02" — never by raw seq.

## Resolving a Citation: the audit_read Recipe

`adf_audit` stores cleared history as brotli-compressed JSON in the `data` BLOB. Retrieval needs no dedicated tool — the index, links, grep, and `db_query` cover it, plus sandbox code (`zlib` is importable in `sys_code`/`sys_lambda`). Three conventions:

1. `db_query` serializes BLOBs as a string with a `base64:` prefix.
2. Pass `_full: true` from sandbox code so rows are never truncated.
3. The payload is brotli, not gzip.

```js
import { brotliDecompressSync } from 'zlib'

export async function auditRead({ seq }) {
  // Ground truth may still be live — check adf_loop first.
  const live = await adf.db_query({
    sql: 'SELECT seq, role, content_json, created_at FROM adf_loop WHERE seq = ?',
    params: [seq], _full: true
  })
  if (live.length > 0) return { source: 'live', entry: live[0] }

  // Candidate blobs — compaction overlap means several may cover the seq.
  const candidates = await adf.db_query({
    sql: "SELECT id, data FROM adf_audit WHERE (source = 'loop' OR source LIKE 'loop:%') AND start_seq <= ? AND end_seq >= ? ORDER BY start_seq DESC",
    params: [seq, seq], _full: true
  })
  for (const row of candidates) {
    const blob = String(row.data)
    const buf = Buffer.from(blob.startsWith('base64:') ? blob.slice(7) : blob, 'base64')
    const entries = JSON.parse(brotliDecompressSync(buf).toString())
    const hit = entries.find((e) => e.seq === seq)
    if (hit) return { source: 'audit', audit_id: row.id, entry: hit }
  }
  return { source: 'missing' }
}
```

Caveats:

- **Multiple blobs can match** one seq (successive compactions archive overlapping ranges) — always scan candidates for the exact seq rather than trusting the first blob.
- **Check live `adf_loop` first** — recent seqs have not been archived yet.
- **Gaps are possible.** If loop audit was disabled when a compaction ran, that range is gone; `missing` is an honest answer. The setting is `audit.loop` (on by default; agent-writable via `sys_update_config`, HIL-gated — see [Memory Management → Audit](memory-management.md#audit)). Likewise, messages that arrived while audit was disabled (or before per-message capture existed) have no audit row — enabling audit later does not retroactively archive them.
- Decompress inside the sandbox, never into your LLM context — a single blob can be megabytes. Return only the entry (or the measurement) you need.

The `agent-memory` skill in the first-party catalog packages this lambda plus the lint workflow and page templates.

## Lint Checklist

Run a maintenance pass periodically (a consolidation reflection is a natural place):

- **Contradictions** — two pages (or a page and the index) asserting incompatible things. Resolve by superseding; log the resolution.
- **Past `stale_after`** — re-verify against sources, then update the date or the content.
- **Orphan pages** — pages missing from the index catalog. Add a catalog line or delete the page.
- **Index drift** — catalog hooks that no longer describe their page, index facts that belong in a page, dead `adf-file://` links.

Each lint pass gets one `lint` entry in `mind/log.md` summarizing what changed.
