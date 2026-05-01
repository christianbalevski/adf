# Core Concepts

Understanding these foundational ideas will help you get the most out of ADF Studio.

## Sovereignty

Each ADF agent is an autonomous entity. It controls its own document, memory, and state. Other agents can only influence it through messages — never through direct access. A human can modify anything in the file, but an agent can only modify itself through its approved tools.

This means when you share an `.adf` file, you're sharing a fully self-contained agent. It doesn't depend on external configuration or shared state.

## One Agent, One Document

The agent-document pairing is the atomic unit of ADF. Each `.adf` file contains exactly one agent paired with one primary document (`document.md`). The document is always markdown — a simple, secure, and flexible interface between the agent and the human. It can be notes, a dashboard, an essay, or whatever suits the agent's purpose.

Supporting files can exist alongside the primary document (in the agent's virtual filesystem), but they're subordinate to it. If you need multiple primary documents, you need multiple agents. For executable logic, agents use lambdas — scripts that can be registered to triggers, set on timers, or bound as API route handlers.

## Spec Stores, Runtime Executes

The ADF specification defines what is stored in the file and what configuration is available. It does not define how code runs, how the UI renders, or how networking works. Those are **runtime** concerns handled by ADF Studio (or the ADF CLI).

This separation means:

- The `.adf` file is portable across any runtime that implements the spec
- Configuration is declarative — you define *what* the agent should do, not *how*
- The runtime handles execution, sandboxing, networking, and UI

## The ADF Stack

The ADF ecosystem consists of layered components:

| Layer | Component | Description |
|-------|-----------|-------------|
| **UI** | ADF Studio | Visual IDE for editing and observing agents |
| **CLI** | `adf` | Headless interface for running and managing agents |
| **Network** | ADF Mesh | Discovery and transport layer (LAN + Internet) |
| **Transport** | ADF Protocol | Rules for packet structure and addressing |
| **Logic** | ADF Runtime | Engine that enforces the spec |
| **Spec** | ADF Specification | The rules (this documentation reflects) |
| **Data** | `.adf` file | The atomic unit — a SQLite database |

## Asynchronous Communication

Agents communicate via store-and-forward messaging, not synchronous API calls. Each agent has an **inbox** (received messages) and an **outbox** (sent messages). This design supports:

- **Offline-first operation** — agents don't need to be online simultaneously
- **High-latency tolerance** — messages queue until delivery is possible
- **Auditability** — every message is persisted in both sender and receiver

## Two Execution Scopes

When something happens (a message arrives, a timer fires, a file is changed), the ADF runtime can respond in two ways:

### System Scope

Runs a lambda function. This is fast, cheap, and deterministic. Use it for infrastructure tasks like routing messages, logging, and archiving. System scope fires in all states except `off`. Targets with system scope specify a `lambda` field referencing the function to call (e.g. `"lib/router.ts:onInbox"`).

### Agent Scope

Wakes the LLM and starts a conversation loop. This is smart, expensive, and probabilistic. Use it for reasoning, decision-making, and complex tasks. Agent scope is gated by the agent's current state — it won't fire in hibernate, suspended, or off states (with exceptions for timers in hibernate).

Both scopes operate independently. When both fire for the same event, whichever timer expires first runs first. Ties go to system scope.

## Portability

An `.adf` file is fully self-contained. Sharing one file transfers everything:

- Agent configuration and identity
- Document and mind content
- Conversation history
- Inbox and outbox
- Timers and schedules
- All supporting files
- Local database tables

The agent's ID ensures messages address the same agent even if the file is moved or renamed. MCP configurations travel with the file but may not be resolvable on other machines.

To share an agent template without identity data, use clone with the `--clean` flag to strip identity, generate a fresh ID, and clear history.
