# ADF Skills

Repository-owned ADF skills use the portable package convention documented in
[`docs/guides/skills.md`](../docs/guides/skills.md). Each package has a
`SKILL.md` containing strict `name` and `description` frontmatter. Optional
scripts, references, assets, and host metadata live beside it.

These packages are canonical sources for distribution into an agent's virtual
filesystem under `skills/<name>/`. Installing files does not grant tools,
credentials, authorization, or HIL exemptions.
