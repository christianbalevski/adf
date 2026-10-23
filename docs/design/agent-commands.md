# Agent Commands: owner slash commands that run an agent's lambda

**Status:** Design · Not yet implemented
**Schema impact:** one optional top-level config field, `commands`. No schema version bump, no migration.
**Difficulty:** 6 / 10. Every piece reuses an existing mechanism (lambda execution, `withAuthorization`, the chat queue's safe boundary, the daemon proxy table). The parts that take care are where the elevated flag enters, the deferred loop write and the two transports.

## The idea

An agent registers slash commands in its config. Each one names a lambda. The owner types `/name args` in a Studio composer and the runtime runs that lambda straight away. No model turn. The outcome lands in that loop's history, so the agent sees it next time it runs, and the owner sees it as a card in the chat.

```jsonc
"commands": [
  { "name": "weather", "description": "Today's forecast for a city", "usage": "<city>",
    "lambda": "lib/commands.ts:weather" },
  { "name": "deploy", "description": "Push public/ to the mirror", "lambda": "lib/ops.ts:deploy", "locked": true }
]
```

```ts
// lib/commands.ts
export async function weather({ args, argv }) {
  const res = await adf.sys_fetch({ url: `https://wttr.in/${encodeURIComponent(args)}?format=3` })
  return res.body
}
```

Typing `/weather Berlin` runs `weather` with the agent's normal lambda authority. Typing `/deploy !authorize` runs `deploy` once as authorized code.

## Drift from the brief

Places where the code contradicts what the brief assumed, and how this design resolves each.

1. **The daemon is the default backend.** `DEFAULT_BACKEND_MODE` is `'local'` (`src/main/backend/backend-config.ts`), so Studio's own composer goes through the daemon unless the owner has chosen embedded. Deferring daemon parity would mean the feature does not work by default. Resolution: both transports are in scope (§8).
2. **Authority is per file today. Nothing grants it per invocation.** Triggers, timers, serving routes and `sys_lambda` all derive authority from `workspace.isFileAuthorized(filePath)`. Resolution: commands add the first per-invocation grant, entered in exactly one place (§3.2).
3. **Warm sandboxes are keyed per file because "a file is the unit of authorization"** (`system-scope-handler.ts`, `code-sandbox.ts` `authLevels`). Also, `CodeSandboxService` keeps a finished execution's handler reachable (`retire` / `RetiredExec`) for closures the code left behind. An elevated run of an unauthorized file in a shared worker would mix levels and leave an authorized handler reachable after the run. Resolution: every command runs in its own ephemeral sandbox, destroyed when it finishes (§3.3).
4. **`AdfCallHandler.setAuthorizationContext()` is a sticky mutable fallback.** `sys_lambda` and `SystemScopeHandler` still set it. A caller with no `withAuthorization` scope reads whatever was set last. Resolution: the command runner never calls it. It binds authority only through `withAuthorization` and `handlerAuthorized`, and passes `toolConfig.isAuthorized` explicitly (§3.2).
5. **Restricted calls do not always "fail plainly".** Restricted tools and `restricted_methods` fail with `REQUIRES_AUTHORIZED_CODE`. But a *protection* denial (protected file, meta key or table) from unauthorized main-loop code raises a blocking HIL override (`requestProtectionApproval`). In a side loop it fails closed with `PROTECTION_DENIED`. Resolution: commands behave exactly as other agent code does. A non-elevated command that writes a protected file shows the owner the usual approval card while it waits.
6. **`loop_inject`'s row shape is not usable for the record.** Unkeyed `[Context: …]` rows are dropped by `AgentSession.restoreMessages`: they are audit-only and never replayed. A command record written that way would disappear from the model's view after a restart or idle sweep. Resolution: the record is a plain user-role row with its own marker, replayed like turn-error rows and runtime notices (§4).
7. **Out-of-band HIL entries are renderer-only.** `markApprovalOutcome` stamps entries that the renderer synthesized and nothing persists. They are a model for the *pending* display only, not for the record.
8. **Lambda references are parsed in three places, each a little differently.** `SysLambdaTool.execute`, `SystemScopeHandler.execute` and `MeshServer` each split on the last `:`. `SystemScopeHandler` interpolates the function name into generated code without validating it. Resolution: a shared `parseLambdaRef` in `src/shared/utils/agent-commands.ts` with the identifier check from `sys_lambda` (`/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`). Commands require an explicit `:function`, as serving routes do. Migrating the other call sites is out of scope.
9. **The `ServingApiRoute` zod schema has no `locked` key** (the TS type has it). That causes no harm, because zod is used only for issue detection and the raw config is stored unparsed. Resolution: the commands schema declares `locked` explicitly.
10. **Studio's `/compact` ignores the loop.** `AGENT_COMPACT` and its daemon-mode handler take no loop. Resolution: none here, but don't copy that pattern. The command request carries `loop` explicitly, as `AGENT_INTERRUPT` does.
11. **The lambda call surface has exceptions.** From code, `say` and `ask` are excluded (`EXCLUDED_TOOLS`), and `loop_compact` and `loop_clear` are refused (`LOOP_RESET_TOOLS`). `loop_manage`, `sys_update_config` and `sys_create_adf` never exist in a side loop's derived config (`LOOP_PROHIBITED_TOOLS`), so a command run from an inner loop's composer cannot call them, even with `!authorize`. `loop_manage` works from a main-loop command. Everything else follows the normal two-toggle table.

## 1. Schema

### 1.1 Type (`src/shared/types/adf-v02.types.ts`)

```ts
/** An owner slash command that runs one of the agent's lambdas (docs/design/agent-commands.md). */
export interface AgentCommand {
  /** Typed after the slash. /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/, not a built-in name. */
  name: string
  /** One line for the palette. 1–200 chars. */
  description: string
  /** Argument hint shown after the name, e.g. "<city>". A '<' marks the argument as required. 0–100 chars. */
  usage?: string
  /** "path/file.ts:functionName", the same reference form as ServingApiRoute.lambda. */
  lambda: string
  /** Owner lock: the agent cannot modify or remove this command. */
  locked?: boolean
}
```

Add `commands?: AgentCommand[]` to `AgentConfig`, after `serving`, and to `CreateAgentOptions`. Add the invocation type that the lambda receives:

```ts
export interface AgentCommandInvocation {
  command: string        // name, no slash
  args: string           // everything after the name, `!authorize` removed, single-spaced
  argv: string[]         // args split on whitespace, empties dropped
  invoker: 'owner'
  loop: string           // 'main' or the inner loop's name
  authorized: boolean    // the authority this run actually has
  id: string             // invocation id, also in the loop record
}
```

### 1.2 Rules, in one shared place (`src/shared/utils/agent-commands.ts`, new)

All of these are pure, with no I/O. The zod schema, `sys_update_config`, the runtime and the Studio form all call them.

- `COMMAND_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/`: 1–32 chars, lowercase, starts with a letter, no trailing hyphen. One word, because the palette matches keys word by word.
- `RESERVED_COMMAND_NAMES = ['compact', 'clear', 'skills', 'idle', 'hibernate', 'stop', 'off']`. This is the source of truth. `src/renderer/utils/slash-commands.ts` imports it, and a unit test asserts that every `BUILTIN_COMMANDS` key is in it.
- `parseLambdaRef(ref): { file: string; fn: string } | { error: string }`. Splits on the last `:`. The function name must match the identifier pattern. The file must be non-empty and end in `.ts`, `.js` or `.mjs`. Errors name the fix: `Lambda must be "path/file.ts:functionName" (got "lib/x.ts").`
- `validateAgentCommands(commands): { index: number; field: string; message: string }[]`. Checks the name pattern, reserved names, case-insensitive duplicates, description length, usage length and `parseLambdaRef`. Every message names the fix. For example: `"/stop" is a built-in command. Pick another name.`, or `Command "x-" is not a valid name: use 1–32 lowercase letters, digits and hyphens, starting with a letter.`
- `parseAuthorizeToken(args)` and `splitArgv(args)`, defined in §5.

### 1.3 Zod (`src/main/adf/adf-schema.ts`)

```ts
export const AgentCommandSchema = z.object({
  name: z.string().regex(COMMAND_NAME_PATTERN)
    .describe(`Typed after the slash. 1–32 lowercase letters, digits, hyphens; starts with a letter. Not one of: ${RESERVED_COMMAND_NAMES.join(', ')}. Unique in commands.`),
  description: z.string().min(1).max(200),
  usage: z.string().max(100).optional(),
  lambda: z.string().min(1).describe('"path/file.ts:functionName". The function receives one object: { command, args, argv, invoker, loop, authorized, id }.'),
  locked: z.boolean().optional(),
})
export const AgentCommandsSchema = z.array(AgentCommandSchema).max(64).superRefine(/* validateAgentCommands → ctx.addIssue */)
```

Add `commands: AgentCommandsSchema.optional()` to `AgentConfigSchema`. The `superRefine` goes on the **array**, never on `AgentConfigSchema`. Wrapping the object would make it a `ZodEffects` with no `.shape`, and `sys_update_config`'s typo guard reads `Object.keys(AgentConfigSchema.shape)`. `zodToJsonSchema` drops the `superRefine`, so the reserved-name and uniqueness rules are restated in `.describe()` above. That matters wherever the schema is handed to a model.

### 1.4 Agent writes (`sys_update_config`)

- Add `'commands'` to `DECLARATION_ARRAYS` (`sys-update-config.tool.ts`). Commands then key by `name` for path resolution (`commands.weather.lambda`), and the no-duplicate and no-unlock integrity rules apply.
- `schemaIssueKeys` already rejects any *introduced* violation. A config that was already invalid stays editable, so a future built-in that collides with an existing command does not freeze the config.
- One extra check in `validateField` for `commands`, `commands.N` and `commands.N.lambda`: the referenced file must exist (`workspace.readFile(file) !== null`). The error is `Lambda file "lib/x.ts" not found. Write it first, then register the command.` The function is checked at invocation, not here, because finding a function would mean parsing the source.
- `sys_update_config` stays HIL-gated by default (enabled + restricted in `DEFAULT_TOOLS`), so a command the agent adds needs the owner's approval unless the owner unlocked the tool.

### 1.5 Owner writes

The Studio save (`DOC_SET_AGENT_CONFIG`) does not run zod. The Commands section (Phase 5) validates with `validateAgentCommands` before saving and blocks the save on errors. A missing lambda file is an inline warning, not a block: the owner may be about to create the file. Templates: add `'commands'` to `sectionKeys` in `mergeTemplateWithOverrides` (`adf-template.ts`), and carry locked commands forward the way locked serving routes are (match by `name`). `AdfDatabase` create: `commands: options.commands ?? base.commands`, beside the `pre_llm_hook` line.

### 1.6 Version and spec

No schema version bump and no migration. The config is stored raw JSON in `adf_config`, optional fields have been added this way before (`pre_llm_hook`), and older runtimes ignore the key. Spec: a new `ADF_SPEC_v0.2.md` §5.25 "Commands" (field table and rules), plus one row in §8.6 for the owner-elevated invocation.

## 2. Execution

### 2.1 Where it runs

One function serves every transport: `runOwnerCommand` in `src/main/runtime/owner-command.ts` (new). It is modeled on `interrupt-turn.ts`.

```ts
export type OwnerCommandHost = Pick<AssembledAgent, 'workspace' | 'executor' | 'adfCallHandler' | 'codeSandboxService' | 'loopPool'>
export interface OwnerCommandRequest { name: string; args: string; loop?: string; authorize: boolean; requestId?: string }
export interface OwnerCommandResult {
  id: string; name: string; loop: string
  status: 'ok' | 'error' | 'denied'
  authorized: boolean
  result: string          // the bounded body, exactly as recorded
  durationMs: number
  deferred: boolean       // true: the record waits for the loop's next safe boundary (§4.3)
  seq?: number            // the loop row, when written now
}
export class OwnerCommandRefusedError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409, readonly code: string) { super(message) }
}
export async function runOwnerCommand(host: OwnerCommandHost, req: OwnerCommandRequest): Promise<OwnerCommandResult>
```

### 2.2 Steps

Refusals throw `OwnerCommandRefusedError` and write nothing. Everything after step 4 is recorded.

1. **Request shape.** `args` is a string of at most 4096 chars with no `\n`. `requestId` is absent or matches `/^[A-Za-z0-9_-]{1,64}$/`. Anything else → 400 `invalid_request`. `id = requestId ?? 'cmd_' + nanoid(10)`.
2. **Loop.** `loopName = req.loop || MAIN_LOOP`. If `!host.loopPool.hasLoop(loopName)` → 404 `loop_not_found`, `No loop named "x" on this agent.`. Pick the executor, call handler and workspace: main uses `host.executor`, `host.adfCallHandler` and `host.workspace`. An inner loop uses `getRuntime(loopName)`'s `executor`, `callHandler` and `workspace`. No runtime → 409 `loop_not_running`, `Loop "x" is not running (it is disabled or stopping). Enable it, then run the command again.` If the executor's state is `stopped` → 409 `agent_not_running`.
3. **Sandbox.** `codeSandboxService` or the call handler is null → 409 `code_execution_unavailable`, `This runtime has no code sandbox, so agent commands cannot run here.`
4. **Lookup.** The command comes from the root config, `host.workspace.getAgentConfig().commands`. Commands are agent-level and any loop's composer may run them. No match → 404 `command_not_found`, `No command "/x" on this agent. Add it under Commands in the agent's config.`
5. **Resolve.** Apply `parseLambdaRef(cmd.lambda)`. On an error, record status `error` with that message. Load the source with `loadLambdaSource(p => workspace.readFile(p), file)`. A null result records `error`: `Lambda file "lib/x.ts" not found. Fix commands[].lambda for /x or create the file.` A transpile throw records `error` with its message.
6. **Authority.** `authorized = req.authorize === true || workspace.isFileAuthorized(file)`. A file the owner already authorized runs authorized, exactly as it would from a trigger (§3).
7. **Run.** Build `invocation: AgentCommandInvocation`, then:
   ```ts
   const wrapped = `${source}
   if (typeof ${fn} === 'function') { return await ${fn}(${JSON.stringify(invocation)}); }
   throw new Error('Function "${fn}" not found in "${file}". Declare it at the top level, or fix commands[].lambda for /${name}.');`
   const onAdfCall = (m: string, a: unknown) => withAuthorization(authorized, () => handler.handleCall(m, a))
   const toolConfig = { enabledTools: handler.getEnabledToolNames(), hilTools: handler.getHilToolNames(), isAuthorized: authorized }
   const sandboxId = `${agentId}:cmd:${file}:${id}`
   const result = await withSource(`lambda:${file}:${fn}`, agentId, () => (loopName === MAIN_LOOP ? run() : withLoop(loopName, run)))
   // run = () => codeSandboxService.execute(sandboxId, wrapped, limits.execution_timeout_ms, onAdfCall, toolConfig,
   //                                        { handlerAuthorized: authorized, agent: agentId, ephemeral: true })
   // finally: codeSandboxService.destroy(sandboxId)
   ```
   `fn` is safe to interpolate only because `parseLambdaRef` validated it at step 5, at run time. Do not rely on config validation, since a hand-edited file skips it. Emit `lambda.started` and `lambda.completed`/`lambda.failed` umbilical events with `kind: 'owner_command'`, `command`, `loop` and `authorized` in the payload. Log one `adf_logs` row: origin `command`, event `run`, target `/<name>`, with status and duration.
8. **Outcome.**
   - `result.error` with `errorCode` in `{REQUIRES_AUTHORIZED_CODE, REQUIRES_AUTHORIZED_CALLER, PROTECTION_DENIED}` → `denied`.
   - Any other error, including `TIMEOUT` and `SANDBOX_TERMINATED` → `error`.
   - Otherwise → `ok`.
   - A lambda that catches the error itself and returns is `ok`. Its return value is what it is.
9. **Body.** The return value is already serialized by the sandbox prelude (`serialize()` in `sandbox-prelude.ts`): a string passes through verbatim, anything else becomes 2-space JSON, and `undefined` becomes `(no return value)`. On `error` or `denied`, the body is the error message. Non-empty stdout is appended as `\n\nOutput:\n<stdout>`, as `sys_lambda` does. Then `body = executor.boundToolResult(body, '/' + name)` applies the agent's `limits.max_tool_result_tokens` and `max_tool_result_preview_chars`, with the same truncation text as a tool result (§6).
10. **Record.** `executor.recordOwnerCommand(formatOwnerCommandRow(header, body))` (§4). The return value carries `deferred` and `seq`.

### 2.3 Agent state

Commands use the same gate as system-scope trigger lambdas (`TriggerEvaluator.shouldFire`): they run in every state except off. Idle, active, hibernate, suspended and error all run, because a command is not a model turn.

**Off fails plainly; the runtime does not start the agent.** With no assembled agent there is no call handler, no sandbox wiring and no executor to record into. Starting the agent would also run its startup turn, which the owner did not ask for. Embedded answers `{ success: false, error: 'Agent is off. Start it, then run /x again.' }`. The daemon answers 409 `agent_not_running`, and its handler maps that to the same sentence.

A turn in flight does not block a command. The lambda runs concurrently, as a trigger lambda would. Only the loop record waits (§4.3).

Concurrency: several commands may run at once. Each has its own sandbox and its own id. There is no queue and no cap beyond `execution_timeout_ms`.

## 3. Authority

### 3.1 Default

A command runs with the agent's normal lambda authority: whatever `workspace.isFileAuthorized(file)` says. Agent-written files are unauthorized, because any `fs_write` clears the flag. So the two-toggle table applies unchanged:

- Restricted tools fail. The worker fast-fails `hilTools`, and the host refuses `restricted`. Both return `REQUIRES_AUTHORIZED_CODE`.
- Methods in `restricted_methods` fail.
- Disabled unrestricted tools fail with `DISABLED`.
- Protection denials raise the override approval in main and fail closed in inner loops (Drift 5).

### 3.2 The elevated flag: where it enters

Only one value can make an unauthorized file run authorized: `OwnerCommandRequest.authorize === true`. It travels as a typed boolean field from exactly two producers:

- **IPC** `AGENT_RUN_COMMAND`, args `{ filePath?, loop?, name, args, authorize, requestId }`. The only caller is the Studio composer.
- **HTTP** `POST /agents/:id/commands/:name/run`, body `{ args?, loop?, authorize?, requestId? }`. The bearer token is required (`request-guard.ts`).

Inside the runtime the flag is consumed once, at step 6, into the local `authorized`. From there it reaches code only through:

- the `withAuthorization(authorized, …)` closure bound to this execution's `onAdfCall`;
- `handlerAuthorized: authorized` and `toolConfig.isAuthorized: authorized` on this one `execute()` call.

It is never written to config, files, `adf_meta`, the task table or `AdfCallHandler` state. `setAuthorizationContext` is never called.

**Scope is one invocation:**

- **Sandbox.** The sandbox id contains the invocation id and is ephemeral, destroyed in `finally`. Closures, timers and module state the lambda left behind die with it, so a retired authorized handler cannot be reached later (Drift 3).
- **Nested `sys_lambda`.** It runs at the *target* file's own authorization (`SysLambdaTool` uses `isFileAuthorized(target)`). Elevation does not spread to other files. An elevated caller *may* call authorized files, by the existing call-chain rule.
- **`_async: true` tool calls** made during the run keep the authorization captured at schedule time (`executeAsyncToolFromLambda`). That is work the elevated run started. It is recorded in `adf_tasks` with origin `lambda` and is not a leak. The guide states it.
- **Timers or triggers** that the lambda creates run later at their own lambda file's authorization, as always.

### 3.3 Why the agent has no path to it

| Agent route | Why it cannot elevate |
| --- | --- |
| `loop_send`, `loop_inject`, `msg_send`, channel messages, chat text | The runtime never parses slash commands out of any text. Commands enter only through the two typed entry points above. A chat containing `/deploy !authorize` is a chat. |
| Its own lambdas, triggers, timers, serving routes, middleware | Sandbox code has no IPC. `runOwnerCommand` is not an `adf.*` method and is not registered as a tool. |
| HTTP to the daemon | Needs the bearer token, which agent code does not hold. `sys_fetch` refuses the daemon port even with `allow_local_fetch` (`guarded-fetch.ts` `daemonPort`). |
| A crafted composer string | Agent text never enters the composer input. The composer's only programmatic fills are the owner's own restored draft and palette completion of a key we built. The `!authorize` token is parsed in the renderer and sent as the boolean. The runtime treats `args` as opaque data. |
| The palette list | Command names and descriptions are agent-writable and are rendered as sanitized text (`sanitizeDisplayText`), never as actions. The `authorize` flag comes only from the owner's own keystrokes. |
| Changing what `/deploy` runs | The agent can rewrite the file or, with approval, the registration. That is the risk the owner accepts when typing `!authorize`: they authorize the code as it is at that moment, as with authorizing a file. `locked: true` stops registration changes. It does not stop file edits, and the guide says so. |

Existing exposure, unchanged by this design: an agent with `compute.host_access` and a host shell can already read the daemon token file and call `PATCH /agents/:id/files/authorized`. Commands add no new route for it. Paired remote devices (device tokens) can call the run route, as they can call the file-authorize route today. Neither route is in `isLocalOnlyRoute`.

## 4. The loop record

### 4.1 Why not a synthetic tool_use / tool_result pair

A tool exchange has to be an assistant `tool_use` followed by the matching user `tool_result`. Fabricating one breaks providers in concrete ways:

- **Anthropic with extended thinking** rejects an assistant turn containing `tool_use` that does not begin with a signed thinking block, and a synthetic block cannot be signed.
- **OpenRouter's `reasoning_details` round-trip** has the same problem.
- Several providers reject `tool_use` naming a tool absent from the request's `tools`. A command is not a tool.
- **OpenAI** requires `tool` messages to follow an assistant `tool_calls` message. **Gemini** pairs `functionCall`/`functionResponse` the same way.

A fabricated assistant turn would also put words in the model's mouth. `handleLoopInject` already refuses synthetic tool exchanges for exactly these reasons.

### 4.2 Representation

The record is **one user-role row** with a text block. The first line is a marker and a JSON header; the rest is the body.

```
[Owner command] {"v":1,"id":"cmd_k3Jx9aQ2pL","command":"/weather Berlin","lambda":"lib/commands.ts:weather","authorized":false,"status":"ok","duration_ms":412}
Berlin: ⛅️ +14°C
```

- `src/shared/utils/owner-command-row.ts` (new) owns `OWNER_COMMAND_MARKER = '[Owner command] '`, `formatOwnerCommandRow(header, body)` and `parseOwnerCommandRow(text): { header, body } | null`. The parse requires the marker, valid JSON on line 1, `v === 1`, a string `id`, and `status` in the enum. Anything else is `null`, so the row is read as ordinary text.
- `command` is the line as the runtime understood it: `/<name>` plus `args`. It never contains `!authorize`; `authorized` says so instead.
- The model sees exactly this text. The UI renders it from the same text (§7). No Secrets: there is no hidden field and nothing is filtered on restore.
- The row is a record, never an instruction. Nothing re-executes it, and nothing grants authority because of it. An owner who types the marker into a chat makes their own row render as a card. The agent cannot write a user row that starts with it: `loop_inject` stamps `[Context: …]`, `loop_send` stamps `[from loop:…]`, and inbound messages arrive wrapped in trigger text.
- Every provider accepts it. It is user text, the shape `deliverQueuedChats` already appends after tool results. Consecutive user messages are already normal in this runtime, and the AI SDK provider conversions accept them.

### 4.3 When it is written (`AgentExecutor`)

New public method `recordOwnerCommand(text: string): { deferred: boolean; seq?: number }`:

- **No turn active** (`!this.isTurnActive()`): write now. `seq = this.session.getWorkspace().appendToLoop('user', [{ type: 'text', text }])`. That workspace is the loop-scoped one the session holds. If the session is hydrated (`getMessages().length > 0`), also call `session.addMessage({ role: 'user', content: [...] }, undefined, { skipLoop: true, seq })`. An empty, idle-swept session is left alone: the next dispatch's rehydrate reads the row from the loop. Writing into an empty session would suppress that rehydrate and truncate history. Then emit `context_injected` with `{ category: 'owner_command', content: text, seq }`. Return `{ deferred: false, seq }`.
- **A turn is active** (any `activeTurnCount`, which includes manual compaction and system-scope turns): push the text onto a new `pendingOwnerCommandRecords: string[]` and return `{ deferred: true }`. Writing now could land the row between an assistant `tool_use` row and its `tool_result` row. Restore would then replay it in the middle of the pair.

`private flushOwnerCommandRecords()` writes each queued record, oldest first, through `session.addMessage` (which persists) plus `flushToLoop`, and emits `context_injected` for each. It is called at exactly these points:

1. **The model boundary** in `executeTurnImpl`, immediately after `this.session.drainContextInjections()` and before `this.deliverQueuedChats('next_step')`. The previous tool batch is complete there. Owner chats queued in the same window follow the command records, in arrival order of kind.
2. **Turn release**, in `runClaimedTurn`'s `finally` and `compactNow`'s `finally`, when `activeTurnCount` reaches 0, just before `onTurnSettled`.
3. **Teardown**, first thing in `discardQueuedChats(reason)`. All three stop/off sites go through it, and they already write a notice row there.

So the agent sees a command that ran mid-turn at its next model call. It is never in the middle of a tool exchange, and it is never lost when the turn ends with no further call. A command does not set `ownerChatUnanswered` and never starts a turn.

If the agent stops while a command runs: the lambda's sandbox is reaped by `destroyForAgent` (status `error`, `SANDBOX_TERMINATED`). `recordOwnerCommand` on a disposed executor is a no-op, apart from one `adf_logs` warning. The caller still gets its result.

## 5. Syntax: `!authorize`

**Rule.** In an agent command's argument text, a standalone whitespace-delimited token exactly equal to `!authorize` (case-sensitive) sets `authorize = true` and is removed. Every occurrence is removed. A token written `\!authorize` is passed to the lambda as the literal `!authorize`, with the backslash dropped from that token only. The token means nothing for built-ins and skill commands.

```ts
export function parseAuthorizeToken(args: string): { args: string; authorize: boolean }
export function splitArgv(args: string): string[]   // args.split(/\s+/).filter(Boolean)
```

Both live in `src/shared/utils/agent-commands.ts`. The renderer calls `parseAuthorizeToken`, and the runtime computes `argv` with `splitArgv`.

**Why anywhere in the line, rather than first-position-only or a modifier key:**

- Owners append flags where they think of them (`/deploy prod !authorize`). A position rule would quietly treat a misplaced token as data, which reads as "authorized" while running unauthorized.
- A modifier key (for example Cmd+Shift+Enter) is invisible: it is not in the typed text, the draft or the record. The token is visible in the composer before Enter, and the palette shows it (§7.2).
- A collision with real data is unlikely (`!` plus that exact word), and the escape covers it.
- The runtime never sees the token, only the boolean. That is the real boundary. The syntax is just how the owner sets the boolean.

## 6. Lambda contract

- **Arguments:** one object, `AgentCommandInvocation` (§1.1). `invoker` is always `'owner'` for now. The field exists so the channel forward-path (§10) can add values without changing the signature.
- **Return:** any value. The serialization and body rules are in §2.2 step 9.
- **Bounds:** new public `AgentExecutor.boundToolResult(content: string, label: string): string`. It wraps the private `enforceToolResultLimit({ content }, label)` and returns `.content`. It uses the same `max_tool_result_tokens` / `max_tool_result_preview_chars` limits and the same `[TRUNCATED] …` head/tail preview. The bounded body is what is recorded and what the transport returns. Nothing unbounded is kept.
- **Timeout:** `limits.execution_timeout_ms`, as for `sys_lambda` and serving routes.
- **What it may call:** everything its authority allows, through `adf.*`, including `loop_manage` from the main loop. The exceptions are in Drift 11.
- **No routing:** the lambda returns a value. It never decides where the result goes.

## 7. The palette and the chat

### 7.1 Data

`src/renderer/utils/slash-commands.ts`:

- `SlashCommandKind = 'builtin' | 'skill' | 'agent'`.
- `SlashCommand` gains `agentCommand?: string` (the command name) and `locked?: boolean`. `muted` now also applies to agent rows.
- New signature: `buildSlashCommands(entries: readonly RegistryEntry[], agentCommands: readonly AgentCommand[] = [], opts: { agentRunning: boolean } = { agentRunning: true })`.
  - **Order:** built-ins, then agent commands (sorted by name), then skills. The existing `seen` set gives first-wins.
  - **Clashes:** a built-in always wins (validation also forbids the clash). An agent command beats a skill of the same name, which is then left out of the palette. A registered command is a deliberate, approval-gated config entry. A skill is a file drop with no approval, so the explicit registration wins. Shadowing gains the agent nothing: the command runs at the authority the agent already has unless the owner types `!authorize`. The Skills panel still lists the shadowed skill.
  - Agent rows: `key = name`, `label = usage ? '/' + name + ' ' + sanitizeDisplayText(usage) : '/' + name`, `description = sanitizeDisplayText(description) || 'no description'`, `locked`, `muted = !opts.agentRunning`. Entries that fail `validateAgentCommands` are dropped, as skill names that do not sanitize to themselves are.
- `needsArgument` already treats a `<` in the label as a required argument, so `usage: "<city>"` makes Enter complete the row instead of running it.
- `RESERVED_COMMAND_NAMES` is imported from shared. A test pins `BUILTIN_COMMANDS` keys ⊆ that list.

### 7.2 Composer (`AgentLoop.tsx`, `LoopStream`)

- `slashCommands` becomes a `useMemo` over the skill entries (still read from `skills-registry.json` when the palette opens, now held as state), `config?.commands` and `agentState !== 'off'`. `config` is the root config in the agent store, so every loop's composer lists the same commands. Config pushes (`DOC_AGENT_CONFIG_CHANGED`) refresh it.
- **Display:**
  - A muted row (agent off) is greyed and says `Start the agent to run this.`
  - A locked row carries the lock glyph, with the tooltip `Locked by the owner: the agent cannot change or remove it.` (the `common/Tooltip.tsx` portal; native `title` does not render in this window).
  - While the typed line holds a standalone `!authorize` and the active row is an agent row, the row shows an amber "authorized run" badge. Its description becomes `Runs once as authorized code: restricted tools and methods are allowed.` The owner sees the elevation before pressing Enter.
- `runSlashCommand`, new branch for `kind === 'agent'`:
  1. `setInput('')`.
  2. `const { args, authorize } = parseAuthorizeToken(rawArgs)`, then `const requestId = nanoid()`.
  3. Add a local pending entry: `{ id: nanoid(), type: 'context', content: '', metadata: { category: 'owner_command', ownerCommand: { id: requestId, command: '/' + name + (args ? ' ' + args : ''), authorized: authorize, status: 'running' } } }`.
  4. `const res = await openApi()?.runAgentCommand({ filePath, loop, name, args, authorize, requestId })`. `filePath` is captured at submit, as `AGENT_INTERRUPT` captures it.
  5. On `success: false`, remove the pending entry and `say('/' + name + ' — ' + res.error)`. That covers refusals: off, unknown command, loop not running.
  6. On `deferred: true`, patch the pending entry with `status` and `result`, plus the note `Recorded after the agent's current step.` The record's `context_injected` event replaces it later.
  7. Otherwise do nothing. The event has already replaced the pending entry, or will shortly.
- Muted rows still send. The runtime's refusal is the single source of the error text.

### 7.3 Showing the record

- `classifyInjectedText` (`src/shared/utils/loop-parser.ts`) checks `parseOwnerCommandRow` first and returns `{ content: body, metadata: { category: 'owner_command', ownerCommand: header } }`. Both `parseLoopToDisplay` and `parseLoopWithToolPairs` already route user text through it, so reload works with no other parser change.
- Add `'owner_command'` to `InjectedCategory`. `isNoticeCategory` returns true for it, so it is a standalone row and never folded into the agent's step block. The TUI's existing `context` case shows it as a context line for free.
- `useAgent.ts`, `context_injected`: also classify when `isOwnerCommandRow(payload.content)`. When the result is an owner command, call the new store action `settleOwnerCommand(entry, loop)`. It removes any entry whose `metadata.ownerCommand.id` matches and that has no `seq`, then appends the new entry.
- `OwnerCommandRow.tsx` (new, `src/renderer/components/agent/`) renders entries with category `owner_command` as a tool-call card. The header reads `You ran /weather Berlin`, with a status chip (ok / error / permission denied / running) and an "authorized" badge when `authorized`. The body is the result, collapsed past a few lines, with a "Raw" toggle that shows the stored row text. For `denied`, the card adds a UI-only hint: `Run again with !authorize to allow restricted calls for this one run.` The hint is not in the row, so the model never reads it. `AgentLoop.tsx`'s row switch dispatches this category to the component.

## 8. Transport: embedded and daemon

| Layer | Change |
| --- | --- |
| `src/shared/constants/ipc-channels.ts` | `AGENT_RUN_COMMAND: 'adf:agent:run-command'` |
| `src/preload/api.ts`, `src/preload/index.ts` | `runAgentCommand(args: { filePath?: string; loop?: string; name: string; args: string; authorize: boolean; requestId?: string }): Promise<{ success: true } & OwnerCommandResult \| { success: false; error: string; code?: string }>` |
| Embedded: `src/main/ipc/index.ts` | `ipcMain.handle(IPC.AGENT_RUN_COMMAND, …)`, beside `AGENT_INTERRUPT`, with the same foreground/background resolution: `currentAssembledAgent` when `filePath` is absent or is the open file, else `backgroundAgentManager.getAgent(filePath)?.assembledAgent`. No agent → `{ success: false, error: 'Agent is off. Start it, then run /<name> again.', code: 'agent_not_running' }`. Call `backgroundAgentManager.ensureSessionHydrated(filePath)` first for background agents. Map `OwnerCommandRefusedError` to `{ success: false, error: message, code }`. |
| Daemon runtime: `src/main/runtime/runtime-service.ts` | `async runAgentCommand(agentId, name, body): Promise<OwnerCommandResult>`. `requireAgent`, then `runOwnerCommand(managed.agent, …)`, mapping `OwnerCommandRefusedError` to `RuntimeLoopError(message, statusCode, code)`. |
| Daemon HTTP: `src/main/daemon/http-api.ts` | `POST /agents/:id/commands/:name/run`, beside `/compact`. 404 for an unknown agent. An open document that is not running → `notRunning(reply, id)`, 409 `agent_not_running`. Otherwise `200 OwnerCommandResult`. An `error` or `denied` *outcome* is still 200: the command ran and is recorded. Add it to `docs/daemon/openapi.json`. |
| Daemon client: `src/shared/daemon-client/client.ts`, `types.ts` | `runCommand(agentId, name, body): Promise<OwnerCommandResult>` → `this.post(\`/agents/${enc(agentId)}/commands/${enc(name)}/run\`, body)` |
| Studio daemon mode: `src/main/backend/daemon-mode/documents/agent-handlers.ts` | `[IPC.AGENT_RUN_COMMAND]` resolves `agentId` as the `AGENT_INTERRUPT` handler does (a background path through `ctx.runningAgentAt`). It calls `client.runCommand` and maps `agent_not_running` and 404 to the embedded sentences, and other daemon errors to `{ success: false, error: errorMessage(err), code: daemonCode(err) }`. |
| `src/main/backend/channel-map.ts` | `[IPC.AGENT_RUN_COMMAND]: proxied('invoke', ['POST /agents/:id/commands/:name/run'], { note: 'filePath may name a background agent; loop selects the stream. authorize is the owner\'s per-invocation grant.' })` |

Remote mode (another computer's daemon) uses the same proxied route through `apiFor(runtimeId)`, with nothing extra. Live display needs no new push: the record arrives as an ordinary `context_injected` executor event, which the focused client session gets in full (`client-sessions.ts`). In embedded mode, the executor's `AGENT_EVENT` push carries it.

## 9. Config UI

A "Commands" section in `AgentConfig.tsx`, added to the Automation group in `config-nav-model.ts` (`['Triggers', 'Hooks', 'Commands', 'Umbilical Taps']`). Its section lock is `locked_fields: ['commands']`. The body lives in a new `AgentCommandsSection.tsx`, with a pure model in `agent-commands-config.ts` (draft ⇄ config, validation via `validateAgentCommands`). `AgentConfig.tsx` only mounts it, which keeps edits to that 300 KB file to a few lines.

Each row has name, description, usage, lambda and a lock toggle. The lambda field is a text input with a datalist of the agent's `.ts`/`.js`/`.mjs` files (`getInternalFiles`) and a function-name suffix. Errors show inline and block the save. A missing file shows as a warning. The section hint reads `Slash commands the owner can run from the composer. Each runs one of this agent's lambdas, with no model turn.`

## 10. Out of scope

Channels (Telegram, Discord), buttons, dry-run/preview, the terminal app and the `adf` CLI are out of scope.

Forward note for channels: an adapter would call the same `runOwnerCommand` with an `invoker` value naming the surface. The runtime, not the lambda, would route the returned body back to that surface. The lambda never routes.

## Implementation phases

Phase 1 lands first. After it, phases 2, 4 and 5 can run in parallel: they touch disjoint files. Phase 3 needs Phase 2's `runOwnerCommand` signature, which this doc fixes, so it can start in parallel against that signature and merge after Phase 2. Phase 6 can be written at any time.

| Phase | Scope | Files | Parallel with |
| --- | --- | --- | --- |
| **1. Schema and shared rules** | `AgentCommand`, `AgentCommandInvocation`, `commands` on `AgentConfig` and `CreateAgentOptions`. Shared validator and parsers. Zod. `sys_update_config` declaration array and file check. Template merge. DB create. Spec §5.25 and §8.6. | `src/shared/types/adf-v02.types.ts`, `src/shared/utils/agent-commands.ts` (new), `src/main/adf/adf-schema.ts`, `src/main/tools/built-in/sys-update-config.tool.ts`, `src/main/adf/adf-template.ts`, `src/main/adf/adf-database.ts`, `ADF_SPEC_v0.2.md` | none (lands first) |
| **2. Runtime runner and loop record** | `runOwnerCommand`. Executor `recordOwnerCommand`, `flushOwnerCommandRecords`, `boundToolResult`. Row format and parse. `classifyInjectedText` branch and `isNoticeCategory`. | `src/main/runtime/owner-command.ts` (new), `src/main/runtime/agent-executor.ts`, `src/shared/utils/owner-command-row.ts` (new), `src/shared/utils/loop-parser.ts` | 4, 5 |
| **3. Transport** | IPC channel, preload, embedded handler, runtime-service method, daemon route and openapi, daemon client, daemon-mode handler, channel map. Parity scenario. | `src/shared/constants/ipc-channels.ts`, `src/preload/api.ts`, `src/preload/index.ts`, `src/main/ipc/index.ts`, `src/main/runtime/runtime-service.ts`, `src/main/daemon/http-api.ts`, `docs/daemon/openapi.json`, `src/shared/daemon-client/client.ts`, `src/shared/daemon-client/types.ts`, `src/main/backend/daemon-mode/documents/agent-handlers.ts`, `src/main/backend/channel-map.ts`, `tests/parity/harness/fixtures.ts`, `tests/parity/commands/*` (new) | 4, 5 (after 2 merges) |
| **4. Palette and chat** | Third kind, clash order, muted, locked and authorize display, composer branch, pending entry, `settleOwnerCommand`, `OwnerCommandRow`. | `src/renderer/utils/slash-commands.ts`, `src/renderer/components/agent/SlashCommandPalette.tsx`, `src/renderer/components/agent/AgentLoop.tsx`, `src/renderer/components/agent/OwnerCommandRow.tsx` (new), `src/renderer/stores/agent.store.ts`, `src/renderer/hooks/useAgent.ts` | 2, 3, 5 |
| **5. Config UI** | Commands section. | `src/renderer/components/agent/AgentCommandsSection.tsx` (new), `src/renderer/components/agent/agent-commands-config.ts` (new), `src/renderer/components/agent/AgentConfig.tsx` (mount only), `src/renderer/components/agent/config-nav-model.ts`, `src/shared/constants/docs-links.ts` | 2, 3, 4 |
| **6. Docs** | Agent-first guide with worked examples (a status command, a denied-then-authorized run, a command that calls `loop_manage`). Index entry. A row in the authorized-code execution-contexts table. | `docs/guides/commands.md` (new), `docs/guides/index.md`, `docs/guides/authorized-code.md` | all |

Phase 4 calls `openApi().runAgentCommand`. Until Phase 3 merges, its tests stub the preload surface.

## Test plan

Run with `npm test`. With Studio running, use the `ELECTRON_RUN_AS_NODE` vitest invocation instead.

**Phase 1:** `tests/unit/shared/agent-commands.test.ts`, `tests/unit/adf/commands-schema.test.ts`, `tests/unit/tools/sys-update-config-commands.test.ts`
- Name rule: accepts `a`, `weather`, `deploy-prod`. Rejects `A`, `9x`, `x-`, a 33-char name, `/x`, `two words`.
- Every reserved name is rejected with the built-in message. `BUILTIN_COMMANDS` keys ⊆ `RESERVED_COMMAND_NAMES`.
- Duplicates are rejected case-insensitively.
- `parseLambdaRef`: missing `:fn`, a non-identifier fn (`a.ts:x-y`, `a.ts:x;y`) and a bad extension are rejected. `lib/a.b.ts:run` is accepted.
- The schema rejects an invalid entry. `AgentConfigSchema.shape` still has `commands`, so it is not wrapped in effects. `zodToJsonSchema(AgentCommandSchema)` keeps the name `pattern` and the restated description.
- `sys_update_config`: append succeeds when the file exists. A missing file is refused with the fix sentence. A duplicate name is refused. A locked command cannot be modified, removed or unlocked. `commands.weather.lambda` resolves by name. A pre-existing invalid entry does not freeze other edits.
- Template merge carries locked commands forward. Create with `commands` persists them.

**Phase 2:** `tests/unit/runtime/owner-command.test.ts`, `tests/unit/runtime/owner-command-record.test.ts`, `tests/unit/shared/owner-command-row.test.ts`
- **Refusals:** unknown loop (404), disabled loop (409), unknown command (404), bad `args` (newline, more than 4096 chars), bad `requestId`, no sandbox. None writes a row.
- **Outcomes:**
  - `ok`: string return verbatim, object return as 2-space JSON, `undefined` as `(no return value)`, stdout appended.
  - `error`: missing file, missing function (the message names the fix), a throw, a timeout.
  - `denied`: an unauthorized lambda calling `sys_update_config` (enabled+restricted) and a `restricted_methods` member.
- **Elevation:**
  - With `authorize: true`, the same lambda succeeds and records `authorized: true`.
  - An owner-authorized file runs authorized without the flag.
  - After an elevated run, a second unauthorized run of the same file is denied again, and a stored closure from the first run cannot make an authorized call. The sandbox was destroyed, so the call is refused or orphaned.
  - `setAuthorizationContext` is never called (spy).
  - A nested `adf.sys_lambda` into an unauthorized file runs unauthorized.
- **Inner loop:** a command run with `loop: 'x'` uses that loop's call handler. `loop_manage` and `sys_update_config` fail there even when elevated. The record lands in loop `x`'s stream.
- **Record:**
  - Idle and hydrated: the row is written, added to the session with its seq, and `context_injected` is emitted.
  - Idle and swept (empty session): the row is written, the session stays empty, and the next dispatch rehydrates it.
  - Mid-turn: `deferred: true`. No row lands between a `tool_use` row and its `tool_result` row. The row appears after the tool-result row at the next model boundary. A turn that ends with no further call flushes the row at release. Stop and off flush before the discard notice.
- **Restore:** `restoreMessages` keeps the row.
- **Format:** `formatOwnerCommandRow`/`parseOwnerCommandRow` round-trip. Malformed JSON, a wrong `v` or an unknown `status` parse as `null`. `command` never contains `!authorize`.
- **Bounds:** a 1 MB return is truncated with the tool-result `[TRUNCATED]` text under the agent's limits.
- **Display:** `classifyInjectedText` and `parseLoopToDisplay` yield a `context` entry with category `owner_command`, and `isNoticeCategory('owner_command')` is true.

**Phase 3:** `tests/unit/daemon/commands-route.test.ts`, `tests/backend/channel-map.test.ts` (existing, now covers the new entry), `tests/unit/ipc/run-command.test.ts`
- The route returns 404, 409 `agent_not_running`, 400 and 200 for each outcome. It requires the bearer token. A chat body containing `/x !authorize` does not run a command.
- The embedded handler resolves foreground and background agents and returns the off sentence.
- The daemon-mode handler maps errors to the embedded sentences.
- **Parity scenario** `agent-command` (`tests/parity/commands/scenarios.ts`, run through `parityCases`). Fixture `agent-1` gets `commands` and a seeded `lib/commands.ts`; add `commands?` and `files?: Record<string, string>` to `FixtureSpec`. The scenario:
  1. Open and start.
  2. `AGENT_RUN_COMMAND` `/echo hi` → ok and its `context_injected` push.
  3. `/cfg`, whose lambda calls `adf.sys_update_config` → denied.
  4. `/cfg` with `authorize: true` → ok.
  5. `/nope` → refused, with no push.
  6. `AGENT_INVOKE` a chat. Its recorded LLM request has the three `[Owner command]` rows as user messages and no `tool_use` or `tool_result` for them.
  7. `DOC_GET_CHAT`, then stop.

  The embedded recording is committed. `daemon.test.ts` diffs the daemon run with no new gap entry.

**Phase 4:** `tests/unit/renderer/slash-commands.test.ts` (extend), `tests/unit/renderer/owner-command-entry.test.ts`
- Order is built-ins, then agent, then skills. A built-in-named agent command is dropped. An agent command shadows a same-named skill. Invalid entries are dropped. Usage `<city>` makes `needsArgument` true. Agent rows are muted when the agent is not running.
- `parseAuthorizeToken`: `!authorize` at the start, middle and end; repeated; `\!authorize` passes through; `!authorized` and `x!authorize` are not tokens.
- The `settleOwnerCommand` store action replaces the pending entry by id and leaves entries that have a seq alone.
- The composer: a `/cmd !authorize` submit sends `authorize: true`, and the token is not in `args`. A refusal removes the pending entry and says the error.

**Phase 5:** `tests/unit/renderer/agent-commands-config.test.ts`
- Draft round-trip. Validation messages match the shared validator. A save is blocked on errors. A missing file is only a warning. The section-lock key is `commands`.

## Open questions

1. **May the agent set `locked: true` on a command it adds?** Serving routes allow it today (only paths ending in `locked` are refused). The palette shows the lock as an *owner* lock, though, so an agent-set lock would mislabel it. **Recommendation:** in `checkDeclarationIntegrity`, refuse a `commands` entry carrying `locked: true` from an unauthorized caller with `Only the owner can lock a command.` Then the badge always means the owner.
2. **Should paired remote devices be able to send `authorize: true`?** They can already authorize files through `PATCH /agents/:id/files/authorized`, so allowing it adds no power. **Recommendation:** allow it, and say so in the guide. If you'd rather make elevation local-only, refuse `authorize: true` from device tokens in the route handler. Don't put the whole route in `isLocalOnlyRoute`, because a remote device should still be able to run commands without elevation.
