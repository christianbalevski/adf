# ADF Feature Guides

Every guide is fetchable as raw markdown at `https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/<name>.md`.

## Getting Oriented

- **getting-started.md** — create your first agent and have a conversation
- **core-concepts.md** — the foundational ideas behind ADF
- **creating-agents.md** — create an agent and configure its settings
- **settings.md** — global app settings shared across all agents
- **agent-states.md** — the agent lifecycle states and how to control them

## Execution & Automation

- **triggers.md** — events that wake the agent (on_inbox, on_chat, on_timer, etc.)
- **timers.md** — one-time, recurring, and cron-based scheduling
- **tools.md** — tool access controls (enabled/visible/restricted) and every built-in tool
- **code-execution.md** — the sandbox, sys_code, sys_lambda, and lambdas
- **adf-object.md** — the global `adf` RPC proxy available in code execution
- **authorized-code.md** — privileged code, HIL approval, and restricted tools
- **tasks.md** — deferred and asynchronous tool executions in adf_tasks
- **compute.md** — shared/isolated containers and host command execution
- **mcp-integration.md** — connecting external MCP tool servers

## Memory & Files

- **memory-management.md** — managing the loop (history) and mind (working memory)
- **documents-and-files.md** — the virtual filesystem, README.md, and mind file
- **logging.md** — structured runtime logs in adf_logs

## Communication & Mesh

- **messaging.md** — DID-based agent-to-agent messaging, from basic sends to collaboration
- **contacts.md** — agent-level contact management: what to remember, whom to trust, how to route
- **middleware.md** — custom middleware lambdas in the message and request pipelines
- **lan-discovery.md** — finding agents across machines via mDNS
- **websocket.md** — persistent bidirectional connections and NAT traversal
- **serving.md** — HTTP serving: public files, shared globs, API lambdas

## Security & Observability

- **security-and-identity.md** — the identity and secret-protection stack: owner/runtime/agent identity (seed phrase, DIDs, lineage), envelope encryption, sharing agents with a password, claiming foreign files, and attestations (ownership + agent-negotiated trust)
- **security-architecture.md** — trust boundaries, defense layers, hardening controls
- **umbilical.md** — the real-time event stream of an agent's own activity
- **umbilical-events.md** — reference for every umbilical event type
