# ADF Skills

[`registry.json`](registry.json) is the machine-readable catalog of first-party
ADF skills. Repository packages are canonical sources for copying into an
agent's virtual filesystem under `skills/<name>/`.

- [`adf-skill-creator`](adf-skill-creator/SKILL.md) — create portable ADF skills.
- [`browser-profile-portability`](browser-profile-portability/SKILL.md) — securely carry browser sessions and saved passwords between containers.
- [`conventional-skill-to-adf`](conventional-skill-to-adf/SKILL.md) — adapt filesystem-oriented skills to ADF primitives.
- [`skill-loader`](skill-loader/SKILL.md) — configure discovery and live indexing entirely in agent space.

The package convention is documented in
[`docs/guides/skills.md`](../docs/guides/skills.md). Installing a package does
not grant tools, credentials, authorization, or HIL exemptions.
