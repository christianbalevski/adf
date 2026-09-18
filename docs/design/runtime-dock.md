# Runtime Dock — runtime-specific tools for docked agents

**Status:** Proposal · Exploratory · Not yet implemented
**Schema impact:** `McpServerConfig.transport` gains one value, `'runtime'`. Nothing else in the agent schema changes, and that is the point.
**Difficulty:** 4 for the first cut (transport value, in-process server, one tool group).

## The idea

A runtime is a dock. An agent file mounts into it and, while docked, can reach things that belong to the runtime rather than to the agent: Studio preferences, the suggested-prompt bar, its own tile on the fleet map, the window. When the same file moves to a runtime without those things, nothing breaks. The tools are simply not there.

The agent schema (`.adf`) describes the agent. The dock describes the runtime. Keeping those apart is what lets an agent be portable and lets a runtime grow features without every feature becoming a schema change.

## The line: schema or dock?

Something belongs **in the schema** when any of these is true:

- The agent cannot do its job without it on any runtime: loop, inbox and outbox, tool declarations, model, messaging, code execution.
- It is a boundary the agent must not be able to route around: security, limits, locked fields, identity, credentials.
- It is the agent's own state and must travel with the file: memory, tasks, audit, keyslots.
- A conformance test has to be able to assert it without assuming a runtime.

Something belongs **in the dock** when all of these are true:

- The thing read or written is owned by the runtime, not the agent file: a UI preference, a layout, a list the runtime shows its owner.
- The agent still works, on every runtime, when the tool is absent.
- No conformance test needs it.
- Its absence never weakens a guard. Dock tools may only ever add reach, never decide approvals.

Examples on each side:

| Schema | Dock |
| --- | --- |
| `tools[]`, `security`, `limits`, `mcp.servers[]` | Suggested prompts on the Studio home screen |
| `memory`, `tasks`, `messaging.channels` | The agent's position on the fleet map |
| `code_execution`, `compute` | Studio theme, font, Dock badge, window title |
| `identity`, `locked_fields` | Which folders Studio tracks in the sidebar |

When in doubt, ask "would a headless daemon on another machine need this to run the agent?" If no, it is dock.

## Mechanism: an MCP server the runtime hosts in-process

No new tool registration path. The dock is an ordinary MCP server, so the agent side is the existing `mcp.servers[]` entry, the existing tool sync, the existing per-tool enable and restricted toggles.

- **Server.** A `McpServer` from the MCP SDK, created in the runtime's main process. For Studio, it is created per attach, so each instance knows which agent it serves. Identity comes from the attach, not from a token the agent holds.
- **Transport.** `InMemoryTransport.createLinkedPair()` from the SDK. One end goes to the server, the other is passed to `McpClientManager.connect` as `externalTransport`, the same hook container servers use today. No listener, no port, no credential. Nothing reachable from agent code or from the shared container.
- **Registration in the agent file.**

  ```json
  { "name": "adf-studio", "transport": "runtime", "source": "runtime:studio" }
  ```

  `transport: 'runtime'` is the one schema addition. A runtime that does not host that source fails plainly, "runtime transport 'studio' is not available here", and never tries to spawn anything. `mcp-tool-sync` then marks the tools `removed`, exactly as for any unreachable server, and the agent keeps running. A magic command name on a `stdio` entry was considered and rejected: a hidden rule, and other runtimes would try to spawn it.
- **Discovery.** The server appears in Settings › MCP as "ADF Studio", attached to an agent from the same place as any other server. Attach is the owner's choice of which agents are "docked with access". Self-install through `mcp_install` is off by default.
- **Daemon.** The daemon hosts the same server object over its own transport. Agent files do not change.

## Policy comes from tool granularity

Discovered MCP tools default to `restricted: true`, so every dock write is HIL until the owner unlocks it. Cut the tools so that the owner's existing per-tool switches are the whole policy:

- **One tool per preference group** (suggestions, appearance, tracked folders). Free to unlock.
- **Separate tools for anything that reaches other agents** (global system prompt, agent template). Unlockable, but per tool, so it is a deliberate act.
- **No tool at all for secrets.** Provider keys are not exposed, and the providers read returns names and models only. Absence is a real boundary; a toggle is not.

Writes go through the same settings path as the UI, so validation is shared. Every write is attributed: the setting shows "last changed by <agent>" where the owner looks. The tool call is already visible in the agent's loop, but Settings is where the owner would otherwise see a change with no author.

## Checklist for adding a dock tool

1. Run the schema-or-dock test above. If it is schema, stop here and design it as a schema change.
2. Put the state in user data, not a compiled constant. Keep the built-in value as fallback, with a reset.
3. Define the tool at policy granularity: one tool per thing the owner should be able to grant separately.
4. Register it on the runtime's server. Reads redacted, writes attributed, restricted by default.
5. Never let a dock tool decide or weaken an approval.
6. Document it in the guides beside the setting it touches.
7. Confirm the agent file still passes conformance with the server absent.

## Candidates

- **Suggested prompts (first).** Today `SUGGESTION_POOL` is a compiled constant in `src/renderer/components/home/suggestions.ts`. Move it to user data with the built-in pool as fallback and a reset. Tools: `suggestions_list`, `suggestions_set`. An agent that watches what its owner actually starts can curate the bar. This is preference sovereignty pointed at the app itself.
- **Fleet map self-movement (future, exploratory).** The fleet map is a hex grid the owner arranges by hand. Giving docked agents `fleet_position` (read: own tile, neighbours) and `fleet_move` (write: a target tile, with the same rules the owner's drag obeys) turns the map into a live, game-like environment where agents cluster, spread out or approach the ones they talk to. Positions are runtime layout, not agent state, so this is squarely dock. Owner rules to decide: whether agents may move others, rate limits, and whether a move is HIL by default (probably not, it is harmless).
- **Later.** Dock badge and notifications, theme, tracked folders, opening a page in the Computer tab, window title.

## Related

- The growth vision: agents that start weak and develop with use. A "day-care" is a runtime whose dock offers training tools; the agent comes back stronger, and what it learned travels in the file because memory and skills are schema, not dock.
- `docs/design/mcp-registry-expansion.md`, `docs/design/mcp-credential-identity.md` for how servers are registered and where credentials live.
- `src/main/services/mcp-client-manager.ts` (`externalTransport`), `src/main/services/mcp-tool-sync.ts` (`removed` marking).
