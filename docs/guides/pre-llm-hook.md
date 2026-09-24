---
type: guide
description: Transform a normal conversational provider request with a workspace lambda
see_also: [code-execution.md, authorized-code.md, inner-loops.md]
---

# Pre-LLM request hooks

`pre_llm_hook` optionally runs a workspace lambda immediately before each **normal conversational** provider request. It can rewrite the request-local system prompt, messages, provider-facing tool definitions, and model request options.

It is for bounded transformations such as adding a policy reminder, selecting a smaller presented tool set, adapting a provider option, or running a fast RAG lambda with the existing `adf.*` capabilities. It is deliberately a small interception point, not a separate built-in RAG or tool-selection subsystem, and it is never a way to grant capabilities.

## Configuration

```json
{
  "pre_llm_hook": {
    "source": "lib/request-policy.ts:transform",
    "scope": "all",
    "timeout_ms": 5000
  }
}
```

- `source` is a workspace `.js` or `.ts` lambda path, optionally followed by `:functionName`; omitted function name means `main`.
- `scope` is `all` (default: main and every current/future inner loop), `main`, or `loops`.
- `loops` is required only for `scope: "loops"`; it is a non-empty unique list of named **inner** loops. It cannot contain `main`.
- `timeout_ms` is optional. It is always capped by `limits.execution_timeout_ms`.

Target named inner loops without requiring that they already exist:

```json
{
  "pre_llm_hook": {
    "source": "lib/request-policy.ts:transform",
    "scope": "loops",
    "loops": ["researcher", "reviewer"]
  }
}
```

The hook is an explicit runtime lambda entry point. It does **not** require—or expose—`sys_lambda` as a conversational tool. Its private execution bridge may call nested `adf.sys_lambda` only when the independent `code_execution.sys_lambda` gate and normal source-authorization rules allow it. That private backend does not register `sys_lambda` for ordinary LLM calls or for unrelated `sys_code` executions; those remain declaration- and enabled-state dependent.

## Contract

The lambda receives one JSON-safe object:

```ts
async function transform({ request, loop }) {
  // loop.name is "main" or the current inner-loop name
  return {
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    options: request.options,
  }
}
```

`request.options` may contain:

- `maxTokens`, `temperature`, `topP`, `thinkingBudget`
- `reasoning`
- `dynamicInstructions`
- `providerParams`

The lambda must return a complete replacement `request` object—not the outer `{ request, loop }` object. Returned values must be JSON, use valid conversational message/tool shapes, and preserve valid tool-use/tool-result pairing.

Example: present just two existing tool schemas on ordinary conversational calls.

```ts
export function transform({ request }) {
  return {
    ...request,
    tools: request.tools.filter((tool) =>
      tool.name === 'fs_read' || tool.name === 'fs_write'
    ),
  }
}
```

### Fast RAG with an existing lambda

A hook can call an existing retrieval lambda and return its enriched messages
with the rest of the original request unchanged. This is a normal `adf.*` call:
the nested `sys_lambda` follows its own file authorization and execution gates.
For example, `lib/fast-rag.ts:enrichMessages` can retrieve from an approved
index and return `{ messages: LLMMessage[] }`.

```ts
export async function transform({ request, loop }) {
  const enrichment = await adf.sys_lambda({
    source: 'lib/fast-rag.ts:enrichMessages',
    args: {
      messages: request.messages,
      loop: loop.name,
    },
  })

  return {
    ...request,
    messages: enrichment.messages,
  }
}
```

The retrieval lambda must return valid conversational messages. The hook still
returns the full replacement request, and a retrieval failure fails that call
closed rather than sending the un-enriched original request. Hook workers are
fresh request-scoped sandbox workers, so do not rely on module/global state
persisting between tool rounds.

## Boundaries and failures

- The hook runs after context repair and immediately before each normal conversational call, including later calls after tool results.
- It does **not** run for `adf.model_invoke()` or automatic history compaction. Calling `adf.model_invoke()` inside a hook uses that direct path and does not recurse.
- Abort signal and streaming callbacks stay runtime-owned; a hook cannot replace them.
- Each hook invocation runs in a fresh, isolated worker and is destroyed on completion, failure, or abort. Worker termination is the supported prompt cancellation mechanism; because the VM has no per-execution interrupt, termination would cancel other executions sharing that worker, which is why hooks do not share workers with ordinary callers.
- A malformed result, missing source, execution error, timeout, or cancellation fails the current call closed. The original request is never silently dispatched. An already-dispatched host-side `adf.*` RPC cannot be retracted by abort; worker termination prevents the sandbox continuation and late writes, but the host handler may finish independently.
- Hook code gets a private `adf.*` RPC bridge with the same live loop-specific restrictions, HIL rules, and source-file authorization semantics as other lambdas. Its nested `sys_lambda` backend is hook-local and independently gated by `code_execution.sys_lambda`; ordinary shared tool registration is unchanged. Inner-loop hooks use their loop's attenuated handler.
- Changing `request.tools` changes only what the provider is shown. Actual tool execution still uses the loop's original enabled-tool snapshot, validation, HIL, and file/protection checks. A hook cannot grant a tool or bypass authorization.

See [code execution](code-execution.md) and [authorized code](authorized-code.md) for lambda capabilities and file authorization.
