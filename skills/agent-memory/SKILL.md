---
name: agent-memory
description: Maintain a mind.md wiki — small always-loaded index, mind/ pages with typed frontmatter, append-only log — with whole-page source citations resolvable to adf_audit ground truth. Use when setting up durable memory, installing the audit_read retrieval lambda, writing or superseding memory pages, or running a periodic memory lint.
adf: ">=0.2"
requires:
  tools: [db_query, fs_write, sys_code, sys_lambda]
---

# Agent Memory

Your memory is a wiki: `mind.md` is the index (injected every turn — keep it small), `mind/<slug>.md` are the pages (loaded on demand), `mind/log.md` is the append-only history. Pages cite their sources; sources resolve to the transcript — live `adf_loop` rows or brotli-compressed blobs in `adf_audit`. The wiki is derived; `adf_audit` is ground truth. Full pattern: `https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/agent-memory.md`.

The seven rules live in your system prompt and at the bottom of the default `mind.md`. This skill adds the three concrete pieces the rules assume: the retrieval lambda, the lint workflow, and page templates.

## Install the audit_read lambda

Loop messages carry `[S<seq>]` markers. To follow a citation back to the original message, write this to `lib/audit-read.js` with `fs_write`, then call it via `sys_lambda({ source: "lib/audit-read.js:auditRead", args: { seq: 137 } })` (or import the logic in `sys_code`). Note: `db_query` is disabled by default — enable it in your tool config before this skill works.

```js
import { brotliDecompressSync } from 'zlib'

// Resolve a loop seq (an [S<seq>] citation) to its original entry.
export async function auditRead({ seq }) {
  // Recent seqs are not archived yet — check the live loop first.
  const live = await adf.db_query({
    sql: 'SELECT seq, role, content_json, created_at FROM adf_loop WHERE seq = ?',
    params: [seq], _full: true
  })
  if (live.length > 0) return { source: 'live', entry: live[0] }

  // Candidate blobs — successive compactions can archive overlapping ranges,
  // so several blobs may cover this seq. Scan each for the exact entry.
  const candidates = await adf.db_query({
    sql: "SELECT id, data FROM adf_audit WHERE source = 'loop' AND start_seq <= ? AND end_seq >= ? ORDER BY start_seq DESC",
    params: [seq, seq], _full: true
  })
  for (const row of candidates) {
    const blob = String(row.data)
    const buf = Buffer.from(blob.startsWith('base64:') ? blob.slice(7) : blob, 'base64')
    const entries = JSON.parse(brotliDecompressSync(buf).toString())
    const hit = entries.find((e) => e.seq === seq)
    if (hit) return { source: 'audit', audit_id: row.id, entry: hit }
  }
  // Honest miss: audit may have been disabled during a compaction, or the seq never existed.
  return { source: 'missing' }
}
```

Conventions this depends on — none guessable:

- `db_query` serializes the `data` BLOB as a string with a **`base64:` prefix**.
- Pass **`_full: true`** from sandbox code so rows are never truncated.
- The payload is **brotli**, not gzip; `zlib` is importable in the sandbox.
- Decompress in the sandbox, never into your context — a blob can be megabytes. Return only the entry you need.

## Lint workflow

Run periodically (a consolidation reflection is the natural slot). One pass, one `lint` entry in `mind/log.md`:

1. **Contradictions** — read the index and skim pages it references; where two assertions conflict, resolve by superseding the losing page (rule 4) and note the resolution in the log.
2. **Past `stale_after`** — for each expired page, re-verify against its `sources` (via `auditRead` for `adf-audit://seq/N` entries), then update the content or push the date.
3. **Orphans** — `fs_list` under `mind/`; any page absent from the index catalog gets a catalog line or gets deleted (safe — the audit record remains).
4. **Index drift** — catalog hooks that no longer describe their page, always-loaded facts that belong in a page, dead `adf-file://` links.

## Page templates

Every page: YAML frontmatter with required `type`, then `# Title`, then content with inline `[S<seq>]` where a claim traces to a specific message. Optional keys: `description`, `status`, `stale_after`, `sources` (whole-page granularity: `adf-audit://seq/N`, `adf-file://imported/...`, URLs). `type` is free-form: start with the core set below, coin a domain type when none fits, and reuse coined types consistently — the lint flags one-offs.

- **person** — who they are, how to reach them, preferences, reliability observed. Hook: their role in one line.
- **project** — goal, current state, next step, blockers. `status` mandatory in practice; supersede aggressively.
- **decision** — what was decided, by whom, the alternatives rejected and why. Cite the deciding message (`[S<seq>]`).
- **procedure** — numbered steps, preconditions, failure modes. `stale_after` recommended — procedures rot.
- **lesson** — what happened, what you now believe, what you changed. The page most worth citing precisely.
- **reference** — distilled external material; `sources` carries the URL or `adf-file://imported/...` origin.
- **open-thread** — an unanswered question with the evidence so far. Carry it until answered or killed; killing it is a log entry.

Minimal example:

```markdown
---
type: lesson
description: Batch queries to monitor agent on weekends
stale_after: 2027-01-01
sources:
  - adf-audit://seq/391
---
# Monitor agent is slow on weekends

Response latency triples Sat–Sun ([S391]). I batch non-urgent queries for Monday.
```
