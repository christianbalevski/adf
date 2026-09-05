---
type: index
description: Task-oriented Knowledge Base for humans and agents using ADF capabilities
---

# Knowledge Base

The Knowledge Base is a consultable reference for explanations, discoveries, troubleshooting notes, and task recipes. It complements—not replaces—feature contracts and executable agent workflows. Use it to route a job to a reusable capability, then follow linked guides for configuration details and security boundaries.

## Where does this belong?

- **Feature guides** describe supported feature contracts: behavior, configuration, tool/API surfaces, and security boundaries. Link to them rather than copying those contracts into a KB article.
- **Knowledge Base articles** are consultable references: they explain how capabilities fit together for a task and collect verified discoveries, troubleshooting notes, and concise recipes. Commands alone do not make an article a skill.
- **[Skills](../guides/skills.md)** own the canonical executable agent workflow. They are installable, reusable packages with explicit prerequisites, triggers or invocation conditions, ordered steps, success checks, and optional helper resources; their `SKILL.md` and resources are installed into an agent's VFS. A skill should link to a feature guide for the contract it uses rather than duplicating that contract.

When a feature contract already exists, link to its guide. Put task context, explanations, discoveries, and troubleshooting in the KB without duplicating the guide or skill. Make a skill when the workflow itself should be installed and reused by agents with explicit prerequisites and success checks. The repository's [first-party skills catalog](../../skills/README.md) lists canonical package sources; its machine-readable [`registry.json`](../../skills/registry.json) supports agent routing. Read the relevant guide before changing configuration or crossing a security boundary, and verify experiment-specific or untested behavior before relying on it.

## Articles

- [Desktop applications with isolated compute](desktop-apps.md) — Run an already-available Linux GUI application in an agent's dedicated container, share the container's visible `DISPLAY=:99` between processes, move files through the VFS airlock, and validate screenshots without treating ADF as a full desktop or generic GUI automation framework.
