---
type: guide
description: One file, one agent; the access boundary; execution scopes; portability
see_also:
  - getting-started.md — hands-on first-agent walkthrough
---

# Core Concepts

## One File, One Agent

An `.adf` file holds one **localized agent**: an agent whose identity, state and behaviour are stored in a single `.adf` file, and which a conforming runtime can run from that file alone. The file is the agent's **body**; copying or moving the file copies or moves the agent ([what's inside](../../ADF_SPEC_v0.2.md#13-one-file-one-agent)).

## Access Boundary

An agent's file is modified only by its owner, by the runtime, or by the agent through tools and code. Other agents affect it only by sending messages. See [spec §1.1](../../ADF_SPEC_v0.2.md#11-access-boundary).

## No Secrets in Context

Any content injected into the agent's model context (system prompts, dynamic instructions, context warnings) is stored in the loop and visible in the UI. See [Context Blocks](memory-management.md#context-blocks-no-secrets).

## Spec Stores, Runtime Executes

The ADF specification defines what is stored in the file and what configuration is available. It does not define how code runs, how the UI renders, or how networking works. Those are **runtime** concerns, handled by ADF Studio or the ADF daemon.

This separation means:

- The `.adf` file is portable across any runtime that implements the spec
- Configuration is declarative: it lists triggers, tools, timers and limits, and the runtime executes them
- The runtime handles execution, sandboxing, networking, and UI

## The ADF Stack

ADF has these layers:

| Layer | Component | Description |
|-------|-----------|-------------|
| **UI** | ADF Studio | Visual IDE for editing and observing agents |
| **CLI** | `adf` | Headless interface for running and managing agents |
| **Network** | ADF Mesh | Discovery and transport layer (LAN + Internet) |
| **Transport** | ALF | Message format and addressing ([ALF spec](../../ALF_SPEC_v0.1.md)) |
| **Logic** | ADF runtime | Runs agents from their files and enforces the spec |
| **Spec** | ADF specification | What the file stores ([ADF spec](../../ADF_SPEC_v0.2.md)) |
| **Data** | `.adf` file | One agent; a SQLite database |

## Asynchronous Communication

Agents communicate by store-and-forward messaging. Each agent has an inbox (received messages, `adf_inbox`) and an outbox (sent messages, `adf_outbox`), and a delivered message is stored in both. Delivery is a single attempt: a failed delivery is recorded in the sender's outbox with its status code, and recovery is up to the agent ([Store-and-Forward Reality](messaging.md#store-and-forward-reality)).

## Two Execution Scopes

When something happens (a message arrives, a timer fires, a file is changed), the ADF runtime can respond in two ways:

### System Scope

Runs a lambda; no model call. Use it for routing messages, logging and archiving. System scope fires in all states except `off`. Targets with system scope specify a `lambda` field referencing the function to call (e.g. `"lib/router.ts:onInbox"`).

### Agent Scope

Runs a model turn. Use it for work that needs the model. Agent scope is gated by the agent's current state: it does not fire in hibernate, suspended, or off states (with exceptions for timers in hibernate).

Both scopes operate independently. When both fire for the same event, whichever timer expires first runs first. Ties go to system scope.

## Portability

Sharing the file shares the agent ([what's inside](../../ADF_SPEC_v0.2.md#13-one-file-one-agent)). Messages address the agent by its DID and handle, so moving or renaming the file does not change its address. The config `id` is a 12-character local identifier, not the agent's identity. MCP server configurations travel with the file, but the servers may not be installed on another machine.

Cloning an agent in Studio copies the tables you select and gives the copy a new config `id`. Unless you keep the identity table, the copy also gets new signing keys and a new DID. The clone records the source's DID as its parent.

Agents can also create children from templates programmatically using `sys_create_adf` with the `template` parameter. Template `.adf` files stored in the parent's file store serve as base configs — the child gets fresh identity keys while inheriting the template's config, files, and non-signing credentials. Template authors can use `locked_fields` and `locked: true` flags to enforce invariants that child agents cannot override.
