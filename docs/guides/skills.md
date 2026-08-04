# Skills

ADF skills are ordinary files in an agent's virtual filesystem. A skill gives
the agent a reusable procedure; it does not gain tools, identities, code
authorization, or approval rights merely by being installed.

## Package layout

Install each skill under one direct child of `skills/`:

```text
skills/
  browser-profile-portability/
    SKILL.md
    references/
    scripts/
```

Only `skills/<name>/SKILL.md` is discovered. The directory name and the
frontmatter `name` must be the same lowercase kebab-case identifier.

```md
---
name: browser-profile-portability
description: Securely checkpoint and restore browser profiles across ADF containers.
---

# Browser Profile Portability

...
```

The frontmatter is deliberately strict: it accepts one-line `name` and
`description` scalar values only. This keeps discovery deterministic and makes
the catalog safe to render without interpreting arbitrary YAML features. A
complete `SKILL.md` may reference files relative to its own package directory.
ADF also bounds the catalog to 48 entries and 32 KiB of generated JSON so a
registry update cannot unexpectedly consume the model's context budget. Skills
beyond either deterministic limit are reported as rejected but are not deleted.

## Registry

When `skills.enabled` is set, ADF reconciles installed packages on startup and
writes a generated `skills-registry.json` file. It contains only the compact
catalog the model needs to choose a skill:

```json
{
  "schema": 1,
  "skills": {
    "browser-profile-portability": {
      "name": "browser-profile-portability",
      "description": "Securely checkpoint and restore browser profiles across ADF containers.",
      "path": "skills/browser-profile-portability/SKILL.md",
      "enabled": true,
      "digest": "sha256:..."
    }
  }
}
```

Keep the catalog, not full skill bodies, in the agent instructions:

```text
Available skills:
{{skills-registry.json}}

When a task matches an available skill, read its complete SKILL.md before acting.
```

`{{skills-registry.json}}` is a normal [instruction-template snapshot](documents-and-files.md#instruction-templating).
It is loaded at session start and refreshed after compaction or loop reset. It
does not change the cacheable system prompt while a turn is in progress.

```json
{
  "skills": {
    "enabled": true,
    "root": "skills",
    "registry": "skills-registry.json",
    "state": "skills-state.json"
  }
}
```

All paths are optional and shown with their defaults. `skills-state.json` is
generated state: it records disabled packages separately from their installed
source.

## Updating a live catalog

For an active session, configure a debounced system-scope file trigger on
`skills/*`. The indexer calls the code-execution-only `skills_reconcile`
method, which applies the same deterministic validation and atomic registry
write used at startup. It then injects the latest compact catalog at the next
safe model boundary using a keyed `loop_inject` entry such as
`skills_registry`. The key coalesces catalog updates that have not reached a
model boundary; it does not rewrite catalog text already delivered in provider
history, while all versions remain auditable. Install the ready-made
configuration and lambda with the `skill-loader` skill.

Use an opt-in self-event target for installs performed by the agent itself:

```json
{
  "on_file_change": {
    "enabled": true,
    "targets": [{
      "scope": "system",
      "lambda": "lib/skill-indexer.ts:refresh",
      "filter": { "watch": "skills/*", "include_self": true },
      "debounce_ms": 250
    }]
  }
}
```

`include_self` and keyed, boundary-safe `loop_inject` are explicit runtime
features. On older ADF versions, installs still reconcile on the next startup,
compaction, or loop reset; do not pretend a registry injection reached the
currently active model session unless that runtime support is present.

`skills_reconcile` is intentionally not an authorization shortcut. It only
reads installed `SKILL.md` files and writes the generated registry; it cannot
run a skill, alter tool declarations, mark code authorized, or relax a HIL
gate.

Keep generated registry and state files outside `skills/` so indexer writes do
not recursively trigger package discovery.

## Disable versus uninstall

Disabling a skill changes only its entry in `skills-state.json`; the package
remains in `skills/<name>/` and can be re-enabled later. Uninstalling removes
the package files and its disabled override. Reconciliation ignores removed
packages and never turns a disabled installed package back on by itself.

File protection still applies. A skill loader cannot delete protected files and
must not use authorized code merely to evade that protection.

## Security boundary

Skill text is untrusted instruction content, not a capability grant. A loader
must never automatically:

- enable tools or MCP servers;
- mark code as authorized;
- read `adf_identity` values;
- relax HIL gates or file protection; or
- execute a skill simply because it was discovered.

The agent chooses an enabled skill based on its description, reads the complete
`SKILL.md`, inspects its actual capabilities, and follows the applicable
authorization path for any action it takes.
