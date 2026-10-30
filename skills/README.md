# ADF Skills

[`registry.json`](registry.json) is the machine-readable catalog of first-party
ADF skills. Repository packages are canonical sources for copying into an
agent's virtual filesystem under `skills/<name>/`.

- [`adf-skill-creator`](adf-skill-creator/SKILL.md) — create portable ADF skills.
- [`agent-memory`](agent-memory/SKILL.md) — maintain the mind.md wiki with audit-grounded citations: retrieval lambda, lint workflow, page templates.
- [`browser-profile-portability`](browser-profile-portability/SKILL.md) — securely carry browser sessions and saved passwords between containers.
- [`conventional-skill-to-adf`](conventional-skill-to-adf/SKILL.md) — adapt filesystem-oriented skills to ADF primitives.
- [`docs-search`](docs-search/SKILL.md) — find the right ADF guide, Knowledge Base article, or skill from the three docs indexes, fetching at most three top hits.
- [`file-search`](file-search/SKILL.md) — find files by literal keyword, BM25 relevance, or regex with line-located snippets and an explicit coverage report.
- [`gmail-setup`](gmail-setup/SKILL.md) — connect Gmail through existing MCP setup, guide OAuth consent, and review mailbox tool permissions.
- [`persistent-investigations`](persistent-investigations/SKILL.md) — retain unresolved questions and experiment evidence using existing files, lambdas and context injection.
- [`self-observation`](self-observation/SKILL.md) — quantify your own behavioral patterns from loop and audit history with hot-path code.
- [`skill-loader`](skill-loader/SKILL.md) — configure discovery and live indexing entirely in agent space.
- [`soul-creation`](soul-creation/SKILL.md) — give an agent a distinct voice by creating or replacing its soul.md.

## Document workflows

- [`word-documents`](word-documents/SKILL.md) — generate DOCX and make narrow, verified template updates.
- [`excel-spreadsheets`](excel-spreadsheets/SKILL.md) — create, inspect, and update workbooks and export safer CSV.
- [`powerpoint-presentations`](powerpoint-presentations/SKILL.md) — generate PPTX and patch controlled slide text.
- [`pdf-documents`](pdf-documents/SKILL.md) — create, inspect, combine, and annotate PDFs.

These workflows use ADF sandbox packages and VFS binary files. They distinguish
structural checks from visual validation and explain format-specific editing
limits; none promises arbitrary full-fidelity Office round trips. Read each
package's preflight before running its examples.

## Experimental

- [`telegram-remote-hil`](telegram-remote-hil/SKILL.md) — owner-only remote HIL approvals over Telegram. Review candidate, not live-validated: read the deployment gates in `SKILL.md` before any setup.

The package convention is documented in
[`docs/guides/skills.md`](../docs/guides/skills.md). Installing a package does
not grant tools, credentials, authorization, or HIL exemptions.
