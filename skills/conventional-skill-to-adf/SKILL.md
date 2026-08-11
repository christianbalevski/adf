---
name: conventional-skill-to-adf
description: Convert a conventional SKILL.md package into a portable ADF skill without losing its intent, safety rules, resources, or deterministic helpers. Use when importing a Codex or other filesystem-oriented skill whose assumptions about files, shell access, secrets, tools, approvals, persistence, or background execution do not match ADF.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, fs_list]
---

# Convert a Conventional Skill to ADF

Preserve the source skill's purpose and important constraints while replacing environmental assumptions with explicit ADF primitives.

## Inspect before converting

Read the complete source `SKILL.md` and every directly required resource. Inventory its triggers, inputs, outputs, filesystem access, shell commands, packages, network services, credentials, long-running behavior, authorization assumptions, and platform dependencies. Identify which instructions require agent reasoning and which mechanics should remain deterministic.

## Translate the environment

Apply these mappings:

- Repository or portable files → `adf_files` paths beneath the skill package.
- Temporary or heavy working data → isolated compute storage.
- Cross-boundary files → `fs_transfer`.
- Shell/process execution → `compute_exec` with an explicitly selected target when needed.
- Reusable code → `sys_lambda`; one-off orchestration → `sys_code`.
- Background/watch behavior → system-scope triggers or timers.
- Secrets, tokens, and portable credentials → `adf_identity` with code access only where required.
- External APIs and applications → an enabled MCP server or `sys_fetch` under existing middleware.
- User confirmation or privileged behavior → restricted tools, authorized code, and normal HIL.
- Mutable operational state → VFS files, identity entries, or local tables according to sensitivity and structure.

Do not translate host paths mechanically into `/workspace`. Decide whether each item belongs in the ADF VFS, isolated container, shared container, external configured target, or nowhere. Do not assume `compute_exec` is restricted; inspect configuration. Do not make a skill authorized merely because the source skill expected unrestricted local execution.

## Repackage the skill

Create `skills/<normalized-name>/SKILL.md` with frontmatter containing `name` and `description`, plus `adf` (minimum runtime version) and `requires` (`tools:` and `config:`) whenever the converted procedures depend on specific ADF tools or configuration. Declare only what the skill calls; `requires` is a precondition checklist, never a grant. Rewrite the description to name ADF-specific activation scenarios without changing the underlying purpose. Keep the main workflow concise and imperative. Copy only required scripts, references, and assets; update relative links and remove environment-specific generated files.

Add a capability preflight and explicit failure behavior. Ensure secret or bulk results stay inside code and never enter the model loop. Preserve source safety rules, and strengthen them where ADF authorization, sharing, or encrypted identity changes the threat model.

## Validate fidelity

Compare the converted package against the source for every supported task, important invariant, required resource, and expected output. Validate registration, test at least one normal request and one missing-capability path, and document intentional differences such as unsupported host access, interactive UI requirements, or owner authorization.
