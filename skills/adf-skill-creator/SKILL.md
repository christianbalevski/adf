---
name: adf-skill-creator
description: Create or update portable skills for ADF agents using the repository and adf_files skill conventions. Use when defining reusable agent workflows, packaging deterministic helpers or references, registering a skill, or deciding which behavior belongs in instructions, lambdas, triggers, tools, identity, or compute.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, fs_list]
---

# Create an ADF Skill

Create concise, inspectable skills that rely on agent reasoning while making security and lifecycle invariants explicit.

## Follow the package convention

Place each package at `skills/<normalized-name>/` in the repository or agent VFS:

```text
skills/<name>/SKILL.md
skills/<name>/scripts/       # optional deterministic helpers
skills/<name>/references/    # optional detailed material
skills/<name>/assets/        # optional output inputs
skills/<name>/agents/openai.yaml  # optional host UI metadata
```

Require `SKILL.md` YAML frontmatter with `name` and `description`; optionally add `adf` (minimum runtime version, e.g. `">=0.2"`) and `requires` (`tools:` — tool names the procedures call; `config:` — exact config paths that must be truthy). Use lowercase letters, digits, and hyphens for `name`. Make the description state both what the skill does and when it should activate. `requires` is a precondition checklist the installing agent verifies — never a grant; a skill must not enable its own requirements during installation. The full convention lives in `docs/guides/skills.md`.

Keep the body imperative and compact. Put essential workflow and safety rules in `SKILL.md`; move detailed references or deterministic code into the appropriate optional directory. Resolve every relative resource path from the skill directory.

## Map behavior to ADF primitives

- Store portable instructions and resources in `adf_files`.
- Use `sys_code` for one-off orchestration and `sys_lambda` for reusable executable behavior.
- Use system-scope triggers and timers for deterministic hot-path work that should not wake the model.
- Use `compute_exec` for the isolated container or another configured target; inspect whether it is restricted instead of assuming it is.
- Use `fs_transfer` to cross the VFS/compute boundary.
- Use `adf_identity` for secrets and portable encrypted credentials. Never put secrets in skill text.
- Use MCP for external capability providers.
- Treat restricted tools and authorized files as runtime policy. A skill never grants itself authorization or disables HIL.
- Return small status objects from code and keep bulk or secret data out of the model loop.

## Design for capability differences

Start workflows with a preflight that inspects available tools, restrictions, execution targets, packages, browser state, paths, versions, and limits. Adapt when equivalent safe primitives exist. Stop with a precise capability requirement when a security or correctness invariant cannot be met.

Separate agent judgment from deterministic mechanics. Let the agent select the workflow and handle exceptional state; use scripts or lambdas for parsing, encryption, checksums, atomic writes, validation, and other operations where improvisation increases risk.

## Register and validate

Ensure the skill indexer can parse the frontmatter and that the generated catalog contains the normalized name, description, `SKILL.md` path, enabled state, and digest. Only the compact catalog belongs in automatic context; the agent reads the full skill when its description matches the task.

Validate the package structure, scan it for secrets and host-specific assumptions, exercise at least one realistic activation request, and test failure paths involving missing tools, denied authorization, interrupted writes, restart, and compaction when applicable.
