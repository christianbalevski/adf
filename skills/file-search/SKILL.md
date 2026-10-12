---
name: file-search
description: Search the agent's virtual filesystem by literal keyword, BM25 relevance, or regex and get ranked paths with line-located snippets plus an explicit coverage report. Use when you need to find which files mention something before reading them, instead of listing and reading files one by one.
requires:
  tools: [sys_lambda, fs_list, fs_read]
---

# File Search

`scripts/file-search.js` is a dependency-free lambda that searches VFS files
through `fs_list` and `fs_read` only. It builds no index, writes nothing, and
changes no configuration. Installing it grants nothing; if `sys_lambda`,
`fs_list`, or `fs_read` is unavailable, stop rather than enabling them.

## Call it

```js
sys_lambda({
  source: 'skills/file-search/scripts/file-search.js:main',
  args: { query: 'rollback procedure', mode: 'bm25', prefix: 'docs/', limit: 5 }
})
```

| Arg | Default | Notes |
|-----|---------|-------|
| `query` | required | ≤ 1000 chars (≤ 256 for regex) |
| `mode` | `exact` | `exact` literal substring · `bm25` ranked keywords · `regex` JavaScript RegExp |
| `prefix` | all files | path prefix, same as `fs_list({ prefix })` |
| `limit` | 20 (max 100) | files returned |
| `case_sensitive` | `false` | exact and regex |
| `max_matches_per_file` | 5 (max 50) | line locations per file; `match_count` is always the full count |
| `max_files` | 2000 (max 5000) | text files read |
| `max_file_bytes` | 512 KB (max 2 MB) | larger files are skipped, not read |
| `max_total_bytes` | 8 MB (max 32 MB) | scan stops once reached |
| `time_budget_ms` | 15000 (max 50000) | checked between files; see regex caveat |
| `ranking` | see below | data-only ranking options |
| `allow_unsafe_regex` | `false` | bypasses the backtracking heuristic |

Values above a maximum are clamped; non-numeric or non-positive values are rejected.

## Read the result

```jsonc
{
  "ok": true, "mode": "bm25", "query": "rollback procedure", "prefix": "docs/",
  "results": [{
    "path": "docs/runbook.md", "score": 2.1043, "match_count": 3,
    "matches": [{ "line": 42, "column": 5, "snippet": "Run the rollback procedure if…" }],
    "matches_truncated": false
  }],
  "total_matching_files": 7, "results_truncated": false,
  "coverage": {
    "complete": true, "listed": 120, "scanned": 96, "bytes_scanned": 811203,
    "skipped": { "binary": 24, "too_large": 0, "read_error": 0,
                 "over_file_cap": 0, "over_byte_budget": 0, "over_time_budget": 0 },
    "skipped_examples": [{ "path": "img/logo.png", "reason": "binary", "detail": "image/png" }],
    "changed_since_listing": 0, "changed_examples": [],
    "long_lines_truncated": 0, "elapsed_ms": 140
  },
  "notes": ["BM25 statistics (IDF, average length) come from the scanned files only."]
}
```

- `line` is 1-indexed and counts `\n` exactly as `fs_read` does, so open a hit
  with `fs_read({ path, start_line: Math.max(1, line - 3), end_line: line + 3 })`.
  `column` is 1-indexed in UTF-16 code units. Snippets are capped at 200
  characters around the match.
- Ordering is deterministic: score descending, then path ascending. Files are
  scanned in path order.
- **Check `coverage.complete` before concluding something is absent.** It is
  `true` only when every listed text file was read in full and none changed
  between `fs_list` and `fs_read`. Binary files are excluded by design and
  only counted. When it is `false`, `notes` says why:
  narrow `prefix`, raise a bound, or read skipped files in ranges.

## Modes

- **exact** — case-insensitive literal substring (regex metacharacters are
  literal). Score is the number of matching lines.
- **bm25** — Okapi BM25 over each whole file: `k1 = 1.2`, `b = 0.75`, IDF
  `ln(1 + (N − n + 0.5)/(n + 0.5))`, plus BM25 over path tokens scaled by
  `path_weight` (0.5). Tokens are lowercased Unicode letter/digit runs, so
  `fs_read` tokenizes as `fs` and `read`. There is no stemming, stop-word
  list, or fuzzy matching: `deploys` does not match `deploy`. IDF and average
  length come from the files scanned in this call, so scores are comparable only
  within one result. Snippets list lines with the most distinct query terms.
- **regex** — JavaScript `RegExp`, `i` flag unless `case_sensitive`. Score is
  the number of matching lines. Patterns that match the empty string are
  rejected.

```js
// Literal identifier, case-sensitive, in source files only.
sys_lambda({ source: 'skills/file-search/scripts/file-search.js:main',
  args: { query: 'loadConfig(', prefix: 'src/', case_sensitive: true } })

// Pattern search.
sys_lambda({ source: 'skills/file-search/scripts/file-search.js:main',
  args: { query: 'TODO\\(\\w+\\)', mode: 'regex', limit: 50 } })
```

## Ranking options

`ranking` is plain data, validated strictly; unknown keys are rejected at the
top level and inside each `boosts` entry (which takes only `prefix` and
`weight`), functions are rejected wherever they appear, and no caller code ever
runs inside the scan.

```js
ranking: {
  k1: 1.2,            // 0–3, BM25 term-frequency saturation
  b: 0.75,            // 0–1, BM25 length normalization
  path_weight: 0.5,   // 0–5, weight of path-token BM25; 0 = content only
  boosts: [           // ≤ 10; longest matching prefix multiplies the score
    { prefix: 'docs/', weight: 2 },
    { prefix: 'archive/', weight: 0 }   // 0 drops those files from results
  ],
  sort: 'score'       // or 'path'
}
```

Boosts and `sort` apply in all modes; `k1`, `b`, and `path_weight` affect BM25 only.
To extend ranking, add a validated field to `validateRanking` and the scoring
step in `search`, and cover it in `tests/`.

## Limits and caveats

- **Binary files** are files whose `mime_type` is not textual (the runtime's own
  text-MIME rule), files without a MIME type, and text files containing a NUL
  byte. They are counted under `skipped.binary`, never searched. Use the
  document skills to extract text from PDFs and Office files.
- **Large files** over `max_file_bytes` are skipped before reading, based on the
  `fs_list` size. Read them in ranges with `fs_read` `start_line`/`end_line`.
- **Stale listings.** The `fs_list` row can be out of date by the time a file is
  read. After each `fs_read` the lambda rechecks the returned `mime_type` and
  the UTF-8 byte length of the returned content, and applies `max_file_bytes`,
  `max_total_bytes`, and `bytes_scanned` to that actual length: a file that
  turned binary is skipped as `binary`, one that grew past a cap is skipped as
  `too_large` or `over_byte_budget` (the latter stops the scan). Any size or
  MIME difference is counted in `changed_since_listing` with examples, and
  makes `coverage.complete` false. Files added or removed after listing are not
  detected.
- **Memory is not capped before reading.** `fs_read` returns the whole file, so
  a file that grew after listing is already in sandbox memory before the
  lambda can measure it. The byte caps limit what is searched and counted, not
  what one `fs_read` loads, so under concurrent writes peak memory per file is
  bounded only by the file's size at read time.
- **Budgets** stop the scan in path order; later paths appear under
  `over_file_cap`, `over_byte_budget`, or `over_time_budget`.
- **Regex is not interruptible.** `time_budget_ms` is checked between files, not
  inside a match. A pattern with catastrophic backtracking can block until the
  sandbox execution timeout (`limits.execution_timeout_ms`, default 60 s) kills
  the whole call, with no partial result. A heuristic rejects common dangerous
  shapes (nested quantifiers like `(a+)+`, quantified alternations like
  `(a|aa)+`, backreferences). Passing that check is not a safety guarantee.
  `allow_unsafe_regex: true` skips the check; use it only on small,
  narrowly-prefixed scans. Regex is applied to the first 4000 characters of
  each line, and any line cut this way is counted in `long_lines_truncated`
  (coverage is then not complete). Exact and BM25 modes see whole lines.
- **Cost** is one `fs_read` per eligible file on every call. There is no index
  or cache, so use `prefix` on large filesystems.
- `README.md` and `mind.md` are searched only if `fs_list` lists them.
