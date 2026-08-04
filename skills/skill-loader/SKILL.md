---
name: skill-loader
description: Install, repair, or maintain a file-backed ADF skill catalog. Use when an agent needs to discover SKILL.md packages under skills/, keep skills-registry.json current while running, enable or disable installed skills, or configure the skill indexer trigger.
---

# Skill Loader

Keep skills as ordinary files. Do not create an execution subsystem, silently
authorize code, enable tools, or execute a discovered skill.

## Install the loader

1. Inspect `skills`, `triggers.on_file_change`, `code_execution`, and the
   available code-execution methods. Require `skills_reconcile`, keyed
   `loop_inject`, and `on_file_change.filter.include_self`. If any are absent,
   explain the missing runtime capability and use startup reconciliation only.
2. Set `skills.enabled` to `true` (and custom `root`, `registry`, or `state`
   paths only when necessary). Keep the catalog and state outside `skills/`.
3. Ensure instructions contain the small, static policy below. Never inject all
   skill bodies into instructions.

   ```text
   Available skills:
   {{skills-registry.json}}

   When a task matches an available skill, read its complete SKILL.md before acting.
   ```

4. Write `lib/skill-indexer.ts` with this deterministic lambda:

   ```ts
   export async function refresh() {
     const reconciled = await adf.skills_reconcile({})
     if (reconciled?.error) return reconciled

     const registry = reconciled.registry
     let injection_error
     try {
       await adf.loop_inject({
         content: `This catalog supersedes previous skill catalogs:\n${JSON.stringify(registry)}`,
         category: 'skills_registry',
         key: 'skills_registry'
       })
     } catch (error) {
       injection_error = error instanceof Error ? error.message : String(error)
     }
     return {
       changed: reconciled.changed,
       skill_count: Object.keys(registry.skills).length,
       rejected: reconciled.rejected,
       injection_error
     }
   }
   ```

5. Add this debounced system trigger, preserving unrelated targets:

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

6. Run `adf.skills_reconcile({})`, inspect its `rejected` list, then invoke the
   lambda once to place the current catalog at the next safe model boundary.

## Maintain packages

- Install a package at exactly `skills/<lowercase-kebab-name>/SKILL.md`.
  Frontmatter must contain only matching `name` and a one-line `description`.
- Let the trigger reconcile after complete writes. For multi-file installs,
  write `SKILL.md` last so partial packages stay undiscoverable.
- Disable by adding the name to `skills-state.json`'s `disabled` list, then
  reconcile. Do not delete the package to disable it.
- Uninstall by deleting `skills/<name>/` after checking file protection, remove
  its disabled override, then reconcile. Do not use authorized code to bypass
  protected-file deletion.
- Read the full selected `SKILL.md` and only the referenced resources needed
  for the current task.

## Boundaries and recovery

- `skills_reconcile` validates metadata and writes generated registry state; it
  never runs skill instructions, enables tools, or changes HIL/authorization.
- The key `skills_registry` coalesces pending catalog updates. Historical loop
  entries remain auditable; a catalog already delivered in provider history is
  not rewritten, so the injected text must explicitly state that it supersedes
  prior catalogs. ADF records the runtime-derived origin automatically.
- A normal `{{skills-registry.json}}` placeholder is a session snapshot. The
  injection handles mid-session updates; startup, compaction, and loop reset
  make the file snapshot canonical again.
- If a catalog update rejects a package, surface path and reason. Do not index
  malformed frontmatter, oversized files, mismatched names, or nested packages.
- Respect the runtime's catalog count and byte limits. Rejected overflow entries
  remain installed but unavailable until the catalog is reduced.
