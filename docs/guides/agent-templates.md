---
type: guide
description: The .adf files new agents are made from, the three Studio ships, what an instance carries, and how to edit, share and pick a template
see_also:
  - getting-started.md — the home composer and its chips
  - creating-agents.md — the per-agent configuration an instance ends up with
  - settings.md — the other Settings pages
  - security-and-identity.md — identity, claiming and stored credentials
---

# Agent Templates

Every agent ADF Studio creates starts from a template. A template is an ordinary `.adf` file in the templates folder, so anything an agent can hold, a template can hold and pass on: config, files, local tables, timers, peers and stored credentials.

The templates folder sits in the app's user data directory and is shown at the bottom of Settings > Agent templates. It is not a tracked folder, so templates never appear in the sidebar and never run.

## The three Studio ships

Studio writes these three files the first time it lists the folder, and writes back any that go missing.

**Standard** is what new agents start from until you make another template the default. It is the code defaults with nothing changed: code execution (`sys_code`, `sys_lambda`) and web fetch (`sys_fetch`) are on, container compute and host access are off, and every escalation, such as `sys_update_config`, asks you before it runs.

**Sandboxed** is an agent that can read and write its own files, talk to you, and message other agents, and nothing else. Off in this template: code execution (`sys_code`, `sys_lambda`), web fetch (`sys_fetch`), package installs (`npm_install`), MCP server installs (`mcp_install`), container execution (`compute_exec`), container compute and host access. The escalations that stay on still ask you first, and the agent can still ask you to turn any of the above back on.

**Full access** is an agent that runs code, fetches the web, uses a container and the host machine, installs packages and MCP servers, changes its own config and creates other agents, without asking you first. On with no approval prompt: `sys_code`, `sys_lambda`, `sys_fetch`, `compute_exec`, `npm_install`, `mcp_install`, `sys_update_config` and `sys_create_adf`. Container compute is enabled and host access is granted. Start agents from this template only for work you would run yourself.

The guard block is unchanged in all three. `security.allow_local_fetch` and stream binding are locked in code for every agent, so no template can pre-grant them. See [Settings > Security Guard & Locked Fields](settings.md#security-guard--locked-fields).

## What a new agent gets

New agents get everything in a template except its identity and history.

Carried into the new agent:

- The config, with a new config id, the new agent's name, and the provider and model resolved as below
- Every file in the template's virtual filesystem
- Agent-created `local_*` tables, with their contents
- Timers, with run counts reset and every wake time recomputed from now, so a template that sat on disk does not hand its agent a backlog of past-due timers
- Peers (`adf_peers`)
- Stored credentials, which stay sealed to this install and open in the new agent

Left behind:

- Identity: signing keys, the identity envelope, attestations, DIDs and DID history
- History: loop, inbox, outbox, tasks, logs and audit

The agent gets a fresh identity when it is created, and it is marked reviewed, exactly like an agent made from the home screen today. There is no claim step. The template's DID is recorded as the new agent's parent DID, so lineage is kept without the identity travelling.

A template's own run state is not a setting either. The new agent starts in the state its config names for a new agent, whatever state the template file was left in.

## Picking a template in the composer

The home composer's **Start from** chip is the template the next agent is built from. The menu lists the shipped templates first, then your own, with tags for the default and for anything **Not reviewed**. **Manage templates…** at the bottom opens Settings > Agent templates.

The chip next to it is the provider chip, which sets both the provider and the model the agent starts on. Its menu groups every connected provider and lists that provider's models underneath, with **Add provider…** to connect another in place.

The precedence is: the chip wins, and the template pre-fills the chip. Picking a template sets the provider chip to the template's provider when this Studio has that provider connected, along with the template's model. Otherwise the chip falls back to the app default provider with no model. Whatever the chips show when you send is what the agent starts on, and a blank model falls back to the provider's default model. The provider is copied into the new agent's config without its key, so the agent works with the app key and travels without it. Settings > Agent templates also holds **Default provider**, used when the template leaves Provider unset.

## Editing a template

Open Settings > Agent templates and click a row. Two editors open under the list:

- **Files in `<name>`**: the starting text of `README.md`, `mind.md` and `soul.md`, and **Extra files**, any other files copied into every new agent. **Add files…** copies files from disk into the template, up to 25 MB each, and `×` removes one. Seed files cannot be removed; clear their text instead.
- The agent config editor, the same one on an agent's **Agent** tab, bound to the template file. Name, instructions, model, tools, triggers, limits and the rest are edited exactly as they are on a live agent.

Edits are written to the template file as you type. The list re-reads itself when the folder changes on disk, and never overwrites an edit you are still making.

Each row's actions menu holds:

- **Make default**: the template every new agent starts from unless the **Start from** chip says otherwise, including blank agents made from the sidebar `+`
- **Duplicate**: a copy under a new name, with its own identity and no history
- **Reveal in Finder**: opens the templates folder with the file selected
- **Reset to shipped**: only on the three shipped rows, and it replaces your changes with the version Studio ships
- **Delete**: moves the file to the trash

**New template…** under the list creates an empty template from the code defaults.

A row also carries tags: **Shipped**, **Default**, **Not reviewed**, and **Has run** when the file has loop history. A template that has run still gives its agents no history.

## Templates from other people

Any `.adf` file in the templates folder is a template. Use **Reveal in Finder** to open the folder and drop one in; it appears in the list.

A file whose identity is missing or belongs to someone else is listed as **Not reviewed**. Its **Review** button opens the same review dialog a shared agent opens, showing what the file asks for. Accepting it claims the template, which gives it a fresh identity under your ownership.

Sending from the home screen with an unreviewed template creates nothing and opens that review first. Accept it and the send goes through. Review happens once per template, never once per agent.

## Agents created by other agents

Settings > Agent templates has a dropdown, **Template for agents created by agents**, with a **None (code defaults)** option. With a template chosen, children made with `sys_create_adf` start from it. They get its config, its files and its local tables, and never its credentials or identity rows, so an agent cannot gain credentials by making a child. The choice does not apply when the parent names a template file of its own in the `template` parameter, described in [Tools > sys_create_adf](tools.md#sys_create_adf).

## The old Settings template

Studio used to keep one agent template in app settings, as a set of config overrides plus seed files. It is moved once, the first time the templates folder is listed. A non-empty old template becomes a template file named **My defaults** and is made the default; an empty one is dropped. A banner at the top of the tab says where it went, with **Dismiss** to clear it. Nothing reads the old setting afterwards.
