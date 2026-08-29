# First-Class Skills — Design & Plan

Status: draft, 2026-08-28. **§2–§5 describe what was first built; §8 records the
post-review simplification and supersedes them where they disagree.**

## 1. Position

Skills today are an agent-space convention (`ADF_SPEC_v0.2.md` §5.1): agents bootstrap the `skill-loader` skill, which installs a ~120-line indexer lambda, triggers, and an instruction placeholder by hand. This proposal promotes the **mechanics** into the runtime — discovery, indexing, injection, install, Studio surface — while the **authority model does not move**: the runtime still never executes skill text, authorizes files, enables tools, or relaxes HIL. `requires` remains a checklist, never a grant.

Mental model: skills are to instructions what MCP is to capabilities. The design mirrors the existing MCP treatment (curated registry, install tool, Studio UI) minus anything that touches config or tools.

## 2. Data model

Two sources of truth, one derived file:

```
skills/<name>/SKILL.md     presence = installed; frontmatter = name/description (unchanged format)
skills-state.json          exception list { "schema": 1, "disabled": [...] }; absent = all enabled
        │
        ▼  runtime indexer (workspace layer, debounced ~250ms)
skills-registry.json       derived, runtime-owned, protection read_only, "$notes" marks it generated
        │
        ▼  {{skills-registry.json}} placeholder → prompt injection
```

- **No per-skill state in `adf_config`.** Presence-in-VFS = installed makes config/VFS drift unrepresentable; muting a skill is a file write, not a HIL-gated `sys_update_config`; skills stay portable by copying `skills/` + `skills-state.json`.
- Config gains only subsystem policy: `skills: { enabled: boolean, catalogs?: string[] }` (default `{ enabled: false }`, catalogs default `[ADF_SKILLS_REGISTRY_URL]`). Standard Section lock applies.
- Registry keeps the skill-loader schema-1 shape and limits verbatim (48 skills, 256KB/file, 32KB registry, kebab name regex, rejected-with-reason list) so agents that already ran the loader are adopted as-is. Disabled skills appear as bare names with no description — rediscoverable at ~zero token cost.

## 3. Runtime changes

1. **Spec**: §4.1 reserves `skills/*` (protection `none`) and `skills-registry.json` / `skills-state.json`. §5.1 rewords from "runtime MUST NOT infer skill installation" to "runtime indexes and injects the catalog but MUST NOT execute skill text, authorize files, enable tools, or relax HIL."
2. **Indexer** (`src/main/adf/` or `src/main/runtime/`): hook the workspace write/delete path in `adf-workspace.ts` (same layer that clears `authorized` on agent writes) for paths matching `skills/*/SKILL.md` and `skills-state.json`. Every writer funnels through it — agent `fs_write`, Studio `writeInternalFile`, daemon HTTP PUT, `skill_install` — so there is no sync step. Port the skill-loader lambda's validation logic verbatim. Replaces the agent-installed lambda + `on_startup`/`on_file_change` triggers.
3. **Injection**: new `_skills` / `_skills_stub` prompt pair in `adf-defaults.ts` (four-place convention: `DEFAULT_TOOL_PROMPTS`, labels, conditions, `assemblePrompt` gate on `config.skills.enabled`), mirroring `_serving`/`_serving_stub`. `_skills` embeds `{{skills-registry.json}}` and the doctrine: read full SKILL.md before acting; skills are instructions not authority; to mute a skill, edit `disabled` in `skills-state.json`. Rides `prompt-file-injection.ts` unchanged → snapshot semantics, provenance tags, and free Context Breakdown accounting via `measureInjectedFiles()`. Settings migration backfills the token into customized prompts (sibling of the `{{mind.md}}` migration, `settings-migrations.ts:205`).
4. **Live updates**: mid-session reindex does not rewrite the snapshot; the runtime emits keyed `loop_inject` (`category`/`key: 'skills_registry'`, "supersedes previous catalogs" payload) exactly as the loader does today, now with runtime origin. Compaction/`loop_clear` re-snapshot the file.
5. **Tools**: `skill_install` / `skill_remove` in `src/main/tools/built-in/`, modeled on `mcp-install.tool.ts`: fetch from configured catalogs, validate frontmatter, write resources first and `SKILL.md` last (half-installs never index), report `{installed, rejected}`. `requires` is checked and *reported* against current config, never acted on. Files land `protection: none`, `authorized: 0`. Install is approval-free (writes untrusted text into a capped prompt-space namespace — lower stakes than `mcp_install`). No `skill_toggle` tool: `fs_write` on the state file is the affordance, documented in `_skills`.
6. **Migration**: on first index, adopt an existing `skills-registry.json` and flip it to `read_only`; legacy loader lambda writes then bounce (superseded). Update `skill-loader/SKILL.md`: "on runtime ≥ this version, remove your triggers and lambda."

## 4. Studio changes

1. **Skills sub-tab**: add `'skills'` to `AgentSubTab` in `app.store.ts`, branch in `RightDock.tsx`, new `SkillsPanel.tsx` beside `AgentFiles.tsx`. Reads `getInternalFiles()` filtered on `skills/` + the registry/state files. Shows per skill: name, description, enable toggle (writes `skills-state.json` via `writeInternalFile`), requires-satisfaction badges vs live config, and indexer rejection diagnostics.
2. **Catalog browser**: install UI over `config.skills.catalogs`, mirroring the MCP-registry install flow. Optional `agents/openai.yaml` (`interface.display_name` / `default_prompt`) supplies UI metadata; fall back to name + description.
3. **Config Section**: `<Section title="Skills">` in `AgentConfig.tsx` for `enabled` + catalog URLs, standard lock.
4. **Daemon parity**: existing file endpoints already cover headless; optional sugar `PATCH /agents/:id/skills/:name` for toggle.

## 5. Slash commands

The runtime-owned registry backs a `/` palette in the Studio composer. Typing `/` on an empty line opens a filterable list (arrows + Enter/Tab to pick, Esc to dismiss); a `/` line that matches no command is sent as an ordinary message rather than swallowed.

- **Built-ins** (`/compact`, `/clear`, `/skills`, `/skills disable|enable <name>`) call IPC directly — runtime actions, no model turn. `/clear` is the existing loop clear (`clearChat`); `/skills` is the right dock's own navigation; mute/unmute goes through the same serialized `skills-state.json` writer the Skills panel uses, so a checkbox and a command can never lose each other's edit. `/compact` needed the one piece of new surface: `AgentExecutor.compactNow()` behind `AGENT_COMPACT`, which refuses mid-turn and refills an idle-swept session before summarizing.
- **Skill commands** (`/<skill-name> ...`) never execute anything: they compose a user message from `interface.default_prompt` ("Use $name to …") or the name+description fallback, then send it down the composer's ordinary send path. The agent then follows its standing read-the-SKILL.md instruction. Invariant intact.

Muted skills stay listed (greyed, "(muted)"), because invoking one only sends text.

**Daemon parity: not built.** The daemon's agent API is a REST resource surface (`/agents/:id/chat`, `/files`, `/timers`, …) with no command-ish route to extend and no compaction route at all, so mirroring the palette there would mean inventing a new surface rather than reusing one. Left for whenever a channel adapter actually needs it.

## 6. Invariants (unchanged, test targets)

- Runtime never executes skill text; `scripts/` in packages stay inert.
- `requires` never grants: install/enable never touches config, tools, approvals, or `authorized`.
- Skill-written files keep `authorized: 0` until a human flips it.
- No per-skill tool gating or sandboxing (that's MCP's job).
- Eval SC-3 `skill-install-from-catalog` (`agentland-evals.md`) remains valid and should pass more easily.

## 7. Phases

| Phase | Scope | Ships value alone? |
|---|---|---|
| 1 | Spec edits; workspace indexer; `_skills`/`_skills_stub` + placeholder + migration; keyed loop_inject from runtime | ✅ zero-setup skills for every agent |
| 2 | `skill_install` / `skill_remove` tools; `skills.catalogs` config | ✅ agent self-install |
| 3 | Studio: Skills sub-tab, config Section, catalog browser | ✅ human management |
| 4 | Slash-command palette (built-ins + skill commands) | optional — built; daemon sugar routes skipped (§5) |

## 8. Post-review simplification

Everything above describes what was built. After reviewing it, the maintainer
cut three pieces of it. This section records what changed and why; where §2–§5
disagree with it, this section is current.

**1. No `skill_install` / `skill_remove`.** §3.5 argued the tools were a
convenience. Reviewed against the actual authority model, they were a *fake
gate*: `skill_install` fetched a document and wrote `skills/<name>/SKILL.md`,
which any agent holding `fs_write` and `sys_fetch` — already SSRF-guarded — can
do directly and unaided. `skill_remove` was `fs_delete` with a name check. So
they gated nothing, and cost two tool schemas, a config dependency, and a second
code path for a sequence the agent can perform in three obvious steps. Deleted.
`guarded-fetch.ts` stays: the Studio catalog IPC still uses it.

**2. No `skills` config section.** §2 gave the subsystem `{ enabled, catalogs }`.
Neither survived review. `enabled: false` decoded to "this agent has skills and
the runtime declines to mention them" — an incoherent state, not a policy, and
it bought a genuinely expensive amount of machinery: an enabled check in three
files, an `applySkillsConfigChange` fan-out on every config write path, and a
protection-downgrade-on-disable path that existed solely to un-strand a file the
disable itself had stranded. `catalogs` only ever fed the Studio browser, which
now reads an app-level source list (Settings → Agent runtime → Skills, persisted
as `skillCatalogSources`). Indexing is unconditional; the registry is materialized at
workspace open (empty object and all) so `{{skills-registry.json}}` always
resolves; the registry is always runtime-owned at `read_only`.

The prompt followed: `_skills_stub` is gone, `_skills` is unconditional, and it
was rewritten from seven numbered rules to five bullets. The old section spent
its length re-explaining things the model already knows. The base prompt's
Documentation paragraph, which repeated the catalog URL and the install advice,
is now a pointer to the section that owns them.

**3. Panel is a list, not a switch.** The disabled empty state, the "Enable
skills" button and its retry ladder had nothing left to do. Clicking a row now
opens that skill's `SKILL.md` in the editor — the registry only carries a
description, and the package is what a human actually wants to read.

**4. The marketplace's default registry is removable.** The catalog browser
merges every configured source at once, and the source list lives in app
settings (`skillCatalogSources`), edited at Settings → Agent runtime → Skills.
The first-party registry was originally *implicit* in that list: always fetched,
always first in merge order, never stored, and therefore not removable. That
made Studio force a registry on people who never asked for one, so it was
demoted to an ordinary default.

The semantics are now positional rather than privileged:

- **Absent** `skillCatalogSources` — the never-configured state, and every
  settings file written before this change — resolves to
  `[ADF_SKILLS_REGISTRY_URL]`. That back-compat read is why no migration exists.
- **Present** is exactly the human's list. It may name the default anywhere in
  it, omit it entirely, or be empty. Https validation, first-wins dedupe and the
  eight-source cap apply to every row uniformly, the default included.

So merge precedence is list order — what Settings shows, top to bottom — not an
identity check on the first-party URL. Settings renders the default as a normal
removable row carrying a "Default" tag, and offers a one-click *Add default
registry* when the list has lost it. Zero sources is a legitimate state: the
browser says "No catalog sources configured" and points back at Settings rather
than reporting an empty fetch. None of this touches the `_skills` prompt
section, which points agents at the first-party catalog as documentation — an
agent's `sys_fetch` has never been governed by Studio's browsing preferences.

The through-line: skills collapse to full uniformity with the `public/` and
`mind/` conventions. Files are the interface, presence is the state, and the
runtime's only job is to index and inject.

Two changes landed alongside, outside the skills story proper: `/skills
disable|enable` was dropped in favor of the panel (with `/idle`, `/hibernate`
and `/stop` added on the runtime actions Studio already exposes), and
`bare_prompt` was added beside `include_base_prompt` as a per-agent escape hatch
that suppresses every runtime-authored prompt section — `_skills` included.
