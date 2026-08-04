# Skills

ADF skills are ordinary files and agent-authored configuration. ADF does not
have a built-in skill loader, skill execution mode, or `skills` configuration
section. Installing a skill does not grant tools, identity access,
authorization, or HIL exemptions.

## First-party catalog

The default ADF system prompt points agents to the canonical first-party
catalog:

`https://raw.githubusercontent.com/christianbalevski/adf/main/skills/registry.json`

The catalog contains compact metadata and raw `SKILL.md` URLs. It is a discovery
source only: an agent chooses a relevant package and copies it into its own
virtual filesystem. ADF does not fetch or install catalog entries automatically.

## Package layout

Install each package under one direct child of `skills/`:

```text
skills/
  browser-profile-portability/
    SKILL.md
    references/
    scripts/
```

The directory name and frontmatter `name` use the same lowercase kebab-case
identifier. Frontmatter contains only a one-line `name` and `description`:

```md
---
name: browser-profile-portability
description: Securely checkpoint and restore browser profiles across ADF containers.
---
```

Read the complete selected `SKILL.md` before acting. Resolve referenced files
relative to that skill's directory.

## Agent-managed local catalog

An agent that wants local skill discovery installs the repository's
`skill-loader` skill. That procedure configures ordinary ADF primitives:

- `skills-registry.json` for compact installed-skill metadata;
- `skills-state.json` for disabled names;
- `lib/skill-indexer.ts` for deterministic validation and reconciliation;
- an `on_startup` system target;
- a debounced `on_file_change` system target watching `skills/*` with
  `include_self: true`; and
- a `{{skills-registry.json}}` placeholder plus a short selection policy in the
  agent's own instructions.

The indexer uses normal `fs_list`, `fs_read`, and `fs_write` calls. It writes the
generated registry outside `skills/`, so its own output does not retrigger the
watch. When the catalog changes, it uses keyed `loop_inject` to deliver the new
compact registry at the next safe model boundary without another system-prompt
rebuild.

`{{skills-registry.json}}` remains a normal instruction-template snapshot. It
refreshes at session start, compaction, or loop reset. Keyed `loop_inject`
handles updates during the active session; it coalesces pending updates but does
not rewrite catalogs already delivered in provider history.

## Enable, disable, and uninstall

New valid packages are enabled by default. Disable a package by adding its name
to `skills-state.json`; keep the source installed so it can be re-enabled later.
Uninstall by deleting its package files, subject to normal file protection, and
remove any stale disabled entry.

The loader validates names, directory/frontmatter agreement, file size, catalog
entry count, and serialized registry size. Malformed or overflow packages remain
installed but are reported as rejected and are not advertised to the model.

## Security boundary

Skill text is untrusted instruction content. Neither the public catalog nor the
local loader may automatically:

- enable tools or MCP servers;
- authorize code or files;
- read identity values;
- relax HIL gates or protection; or
- execute a skill merely because it was discovered.

The agent evaluates the selected procedure against its actual tools and policy,
then follows the normal authorization path for every action.
