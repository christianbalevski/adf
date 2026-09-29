# MCP servers

MCP servers give an agent more tools. Each is attached per agent; its tools
appear as `mcp_<name>_<tool>`.

## Add a server

Select the agent, then `/mcp add` (or `a` on Inspect › MCP). Sources:

| Source | Example |
|---|---|
| The catalog (ADF Studio's curated list; `/` filters) | `/mcp add brave-search` |
| An npm package | `/mcp add npm:@scope/server` |
| A Python package (run with uvx) | `/mcp add python:mcp-server-fetch` |
| A remote server by URL, with an optional token | `/mcp add https://example.com/mcp` |

The form asks for a name, arguments when the server takes them, where it
runs, and the keys it needs (as dots).

- **Keys** are sealed in the agent's identity store under your owner
  identity, never in its config. The identity dialog opens first when it is
  not ready. Locked credentials get the Unlock / Replace / Cancel choice
  ([details](identity-and-security.md#locked-credentials)).
- **Where it runs:** a container by default (the shared one, or the agent's
  own), isolated from your machine; on the host only for agents with host
  access, for servers that need your files, apps or logins.

Each step then shows as it happens: installing the package on the daemon (it
can take a minute), sealing the keys, attaching, connecting. The last step
shows the tools found, or the error with the server's last log lines. New
tools start restricted: the agent asks before using them.

## Manage servers

`/mcp` lists the selected agent's servers with state (`● connected`,
`✗ error`, `not running`), tool count and where each runs. `Enter` opens one:

| Key | Action |
|---|---|
| `t` | Tools: `Space` turns one on or off |
| `e` | Replace credential values (shown as `set • (hidden)` or `not set`) |
| `l` | All recent logs |
| `r` | Restart (connects it now) |
| `d` | Remove (asks; its stored credentials are deleted) |

Also `/mcp restart <name>`, `/mcp logs <name>`, `/mcp remove <name>`. Which
tools need approval, are shown or locked: `/tools` ([Agent
settings](agent-settings.md)).

One-shot: `adf mcp <agent>` (configured and live state), `adf mcp` (servers
registered on the daemon).

## Not in the terminal app

Remote servers that sign in with OAuth in the browser, and servers with a
one-time sign-in step, are set up in ADF Studio (Settings → MCP). The dialog
says so instead of adding a half-working server.
