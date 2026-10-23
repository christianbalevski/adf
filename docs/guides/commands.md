---
type: guide
description: Register owner slash commands that run lambdas without a model turn, with per-invocation authorization and durable outcomes
see_also:
  - code-execution.md — writing lambdas
  - authorized-code.md — restricted calls and file authority
  - inner-loops.md — selecting a loop
---

# Owner slash commands

Register a lambda as a command when your owner needs a repeatable action from a Studio composer without a model turn. Write the file first, then register its reference with `sys_update_config`. Config updates require owner approval by default.

```ts
// lib/commands.ts
export async function status({ args, argv, loop }) {
  return { loop, requested: args || 'summary', words: argv }
}
```

```json
{
  "commands": [
    {
      "name": "status",
      "description": "Show the requested status",
      "usage": "[topic]",
      "lambda": "lib/commands.ts:status"
    }
  ]
}
```

The owner types `/status jobs` in any loop's composer. The lambda receives one object: `{ command, args, argv, invoker: 'owner', loop, authorized, id }`. `command` is the name without `/`; `args` is single-spaced text and `argv` is its whitespace-separated words. `loop` names the composer stream. Commands always come from the agent's root config.

Return a string or JSON-compatible value. The result appears in a chat card and a durable user-role `[Owner command]` row in that loop's history, ready for your next model turn. Errors and permission denials are also recorded. Results use the agent's normal tool-result bounds, including stdout. A command may run while a model turn is in progress; its history row waits for the next safe boundary and Studio shows “Recorded after the agent's current step.”

## Permission denied, then authorized

A command uses its file's existing authority. For example:

```ts
// lib/commands.ts
export async function rename({ args }) {
  return await adf.sys_update_config({ path: 'name', value: args })
}
```

Register `rename` with lambda `lib/commands.ts:rename` and usage `<name>`. With the default enabled, restricted `sys_update_config`, an unauthorized file running `/rename Helper` produces a permission-denied card. The owner may type `/rename Helper !authorize` to grant authority to that invocation. There is no extra confirmation. The card and record show that it ran authorized.

Only a standalone `!authorize` token grants authority. It can appear anywhere in the arguments and is removed before the lambda receives them. Repetitions still grant one invocation. Write `\!authorize` to pass a literal `!authorize` argument; `!authorized` and `x!authorize` are ordinary text. The grant does not authorize the file or a later invocation. A nested `adf.sys_lambda` still uses the target file's authority. Work scheduled with `_async: true` retains the authorization captured when this invocation scheduled it and is tracked in `adf_tasks` with origin `lambda`. Timers and triggers created by the command run later at their own target files' authority.

Each invocation has an ephemeral sandbox that is destroyed when the command finishes, including its retained closures, timers and module state. The owner grants authority to the code as it exists at that moment. A locked registration prevents changes to the command definition; it does not prevent edits to its lambda file.

Embedded Studio, the TUI, and the local or remote daemon support commands. A paired remote device may send `authorize: true` to `POST /agents/:id/commands/:name/run`, using its authenticated device token. Ordinary chat, channel messages and agent tool calls cannot grant this per-invocation authority.

## Terminal app

Select an agent and loop, then type `/` to see its registered commands alongside the TUI's commands. Tab completes a name; Enter runs it once its argument hint is satisfied. Commands also appear in `/help` and the Ctrl+K palette. TUI built-ins and their aliases keep precedence: for a registration named `status`, use `/command status` to run the lambda instead of the TUI's `/status`. `/command <name> [args]` works for every registered command.

Add `!authorize` exactly as in Studio; the prompt shows “Authorized run” before submission. Argument parsing is identical to Studio: `args` contains normalized text and `argv` splits on whitespace, without shell-style quote grouping. A lambda can parse commas or other delimiters itself. Results appear in the selected loop's transcript with status and authorization; Enter expands the result. Commands may wait for the normal approval controls and do not block the prompt. They never start an off agent or create a model turn.

## Managing a loop

A main-loop command can call `loop_manage`, subject to the tool's normal settings:

```ts
// lib/commands.ts
export async function loops({ args }) {
  return await adf.loop_manage({ action: 'get', name: args })
}
```

Register `loops` with lambda `lib/commands.ts:loops`. The owner runs `/loops reflection` from the main composer to inspect an existing loop named `reflection`. Inner-loop commands use their selected loop's tools: `loop_manage`, `sys_update_config` and `sys_create_adf` are unavailable there, including on authorized runs. `say` and `ask` are unavailable to lambdas; `loop_compact` and `loop_clear` are refused. Return the command's answer instead.

## Registration rules

Names have 1–32 lowercase letters, digits or hyphens, start with a letter and cannot end in a hyphen. Names must be unique and cannot be `compact`, `clear`, `skills`, `idle`, `hibernate`, `stop` or `off`. There may be at most 64 commands. Descriptions contain 1–200 characters; optional usage hints contain at most 100. A `<` in a usage hint makes the palette complete the name before running a command without arguments.

Lambda references require an explicit function: `path/file.ts:functionName` (`.js` and `.mjs` also work). Write the file before registering through `sys_update_config`. The function must exist at the top level when invoked. The owner can also edit registrations under Commands in the agent config. Only the owner or authorized code can set `locked: true`; an owner lock prevents the agent from changing or removing the registration.

Commands run while idle, active, hibernating, suspended or in an error state. An off agent refuses the command and must be started by the owner. Multiple commands may run concurrently in separate temporary sandboxes. Refusals such as an unknown command or a disabled loop do not write history rows. Commands are available in Studio composers and the TUI prompt; channel messages and ordinary chat text do not invoke them.
