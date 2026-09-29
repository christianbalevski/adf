# Agent settings

Inspect › Settings (`4`, then the Settings tab; `/inspect settings`) is
Studio's agent config as rows. Instructions, Tools and Compaction open
dialogs; Autonomous, Autostart, Receive messages, Host access, Visibility,
Send mode, Inbox mode and "New MCP tools need approval" flip in place with
`Enter` or `Space`. Turning on autonomy or host access, and LAN or public
visibility, asks first with Studio's warnings. `l` locks the highlighted
section so the agent cannot change it itself (`locked_fields`; you still
can). Every change re-reads the config, changes only what you edited, saves
and reports the result.

## Instructions

`/instructions` opens an editor in the app: `Enter` is a newline, `Ctrl+S`
saves, `Ctrl+O` continues in your external editor, `Esc` cancels (asking when
there are unsaved changes). `/instructions edit` (or `e` on the Settings tab)
goes straight to the external editor. If the daemon's copy changed meanwhile,
saving asks before overwriting.

## Tools

`/tools [filter]` lists Studio's tool groups plus one group per MCP server,
each tool with enabled, shown, approval required and locked:

| Key | Action |
|---|---|
| `Space`, `Enter` | Enable / disable (on a group header: the whole group, locked tools skipped) |
| `v` | Show / hide in the agent's tool list (hidden tools stay callable from code) |
| `r` | Require approval: a model call waits for you |
| `l` | Lock / unlock a built-in tool for the agent |
| `/` | Filter |

Studio's rules apply: a locked tool cannot be enabled or shown, turn tools
(`say`, `ask`, `sys_set_state`) have no approval toggle, and a hidden tool
must be enabled. Refusals show as warnings.

## Compaction

When a loop's context reaches its threshold, its history is summarized
(compacted). `/compaction` lists main and every inner loop with its threshold
(default, inherits main, or set) and the context in use:

| Key | Action |
|---|---|
| `Enter`, `e` | Set the threshold: `80000`, `80k`, `default`, `inherit` |
| `d` | Back to the default (main) or to main's threshold (an inner loop) |
| `c` | Compact that loop now (asks) |

`/compaction 80k` sets the selected loop's threshold directly. `/compact`
compacts the selected loop now. What fills the context: [Context](context.md).

## Model

`/model` picks the selected agent › loop's model (a picker, or
`/model [provider/]model`). On main it changes the agent config; on an inner
loop it sets that loop's override (`/model inherit` clears it). See
[Models and providers](models-and-providers.md).

## Config

Inspect › Config (`/config`) shows the full agent config as a tree, or JSON
with `/json on`. `e` (or `/config edit`) opens it in your external editor;
on save it is validated against the schema and the changed keys are shown for
you to confirm.

One-shot: `adf config <agent>` prints it.

## Other Inspect tabs

Status (state, loops, triggers, website), Usage (tokens by model), MCP,
Channels, Identities (metadata only), Logs (`f` follows), Tables (the agent's
database tables), Tasks (`/tasks`: approvals and async tool calls; `y`, `n`,
`a`, `N` feedback, `A` approve all) and Events (this agent's live events; `l`
narrows to the selected loop). Secrets are redacted everywhere.
