# ADF Skills

[`registry.json`](registry.json) is the machine-readable catalog of first-party
ADF skills. Repository packages are canonical sources for copying into an
agent's virtual filesystem under `skills/<name>/`.

- [`adf-skill-creator`](adf-skill-creator/SKILL.md) — create portable ADF skills.
- [`agent-memory`](agent-memory/SKILL.md) — maintain the mind.md wiki with audit-grounded citations: retrieval lambda, lint workflow, page templates.
- [`browser-profile-portability`](browser-profile-portability/SKILL.md) — securely carry browser sessions and saved passwords between containers.
- [`conventional-skill-to-adf`](conventional-skill-to-adf/SKILL.md) — adapt filesystem-oriented skills to ADF primitives.
- [`self-observation`](self-observation/SKILL.md) — quantify your own behavioral patterns from loop and audit history with hot-path code.
- [`skill-loader`](skill-loader/SKILL.md) — configure discovery and live indexing entirely in agent space.
- [`soul-creation`](soul-creation/SKILL.md) — give an agent a distinct voice by creating or replacing its soul.md.

The package convention is documented in
[`docs/guides/skills.md`](../docs/guides/skills.md). Installing a package does
not grant tools, credentials, authorization, or HIL exemptions.
