---
name: tool-search
description: Search the runtime tool catalog by fuzzy matching a natural-language need against tool names, descriptions, and full JSON schemas, then reveal bounded high-confidence enabled matches without changing enablement or security controls.
requires:
  tools: [sys_lambda, sys_get_config]
---

# Tool Search

Use the packaged `skills/tool-search/tool-search.js` when the needed capability may already exist but is not visible in the current tool schema.

Installation grants no permissions and performs no visibility changes. Search is the default task; reveal/reset require an explicit task and access to `sys_update_config` through the normal approval path. Missing tools are prerequisites, not instructions to enable them automatically.

## Search first

Call:

```js
sys_lambda({
  source: 'skills/tool-search/tool-search.js:main',
  args: {
    task: 'search',
    query: 'meta delete',
    max_matches: 5,
    threshold: 0.34
  }
})
```

The live search corpus includes every configured tool, including enabled MCP tools (`mcp_<server>_<tool>`), and each tool's:

- name, including MCP server and tool keywords
- description
- complete JSON schema, including parameter names, enum values, and property descriptions
- current enabled, visible, restricted, locked, and source state

The catalog is capped defensively at 5,000 tools and schema search text at 24,000 characters per tool, so hundreds of MCP tools remain bounded. Full schemas are returned only for the small matched set.

The result includes the complete schema for every match so the caller can inspect the exact contract before using it.

Enabled tools are searched by default. Set `include_disabled: true` only for capability discovery. Revealing a disabled tool does not make it callable, and the reveal task will skip disabled matches.

## Reveal matches

Call:

```js
sys_lambda({
  source: 'skills/tool-search/tool-search.js:main',
  args: {
    task: 'reveal',
    query: 'meta delete',
    max_matches: 3,
    threshold: 0.4
  }
})
```

`reveal` sets only `tools.<name>.visible = true` for matching enabled tools. It does not:

- enable disabled tools
- hide any tool
- alter `restricted`
- alter `locked`
- bypass HIL or authorization

Restricted matches are skipped unless `allow_restricted: true` is explicit. Locked matches are always skipped. Use `dry_run: true` or `apply: false` to preview changes without applying them.

## Bounds

- Default maximum matches: 5
- Hard maximum matches: 10
- Default threshold: 0.34
- Query must contain at least two characters
- Reveal is additive only; explicit reset can hide tools
- Ranking scores are lexical heuristics, not calibrated confidence
- Search text is bounded; full matched schemas can still be large

Use terse intent keywords by default. Examples: `browser screenshot`, `agent create`, `http post`, `timer recurring`, `meta delete`, `pdf read`, `message send`. Tool names, descriptions, and schema vocabulary make these short queries sufficient. Add one discriminating keyword if results are noisy rather than writing a sentence.

## Reset visibility

Keep a small stable working set visible, then reveal other enabled tools only when needed:

```js
sys_lambda({
  source: 'skills/tool-search/tool-search.js:main',
  args: { task: 'reset' }
})
```

The default core is:

- `say`, `ask`
- `fs_read`, `fs_write`, `fs_list`
- `msg_list`, `msg_read`, `msg_send`, `msg_update`
- `sys_code`, `sys_lambda`, `sys_set_state`

Reset leaves enablement unchanged; non-core unlocked tools become hidden. This reduces advertised-schema context without removing capability. Reset updates only changed visibility fields sequentially, not atomically. A denied/failed update may leave earlier changes applied; inspect the live catalog before retrying. Preview first and do not reset another workflow’s visible tools without authorization. Whole-array replacement currently collides with runtime-generated declarations; field updates also preserve all other tool settings. Pass `dry_run: true` to preview. An explicit `core_tools` array can override the baseline, but keep it small. Locked tools are left unchanged.

## Known metadata limitation

Some catalog entries currently expose only a name and no description or schema through `sys_get_config({ section: 'tools' })`. They remain searchable by name, but semantic matching is weaker. Do not invent missing contracts. Inspect the live catalog again after runtime or MCP changes.
