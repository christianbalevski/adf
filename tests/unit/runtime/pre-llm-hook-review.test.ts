import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdfWorkspace } from "../../../src/main/adf/adf-workspace";
import { AgentRuntimeBuilder } from "../../../src/main/runtime/agent-runtime-builder";
import { CodeSandboxService } from "../../../src/main/runtime/code-sandbox";
import { createHeadlessAgent } from "../../../src/main/runtime/headless";
import { PreLlmHookConfigSchema } from "../../../src/main/adf/adf-schema";
import { preLlmHookApplies } from "../../../src/main/runtime/pre-llm-hook";
import {
  createDispatch,
  createEvent,
  type AdfEventDispatch,
} from "../../../src/shared/types/adf-event.types";
import type {
  AgentConfig,
  LoopConfig,
  PreLlmHookConfig,
  ToolDeclaration,
} from "../../../src/shared/types/adf-v02.types";
import type {
  CreateMessageOptions,
  LLMProvider,
} from "../../../src/main/providers/provider.interface";
import type {
  ContentBlock,
  LLMResponse,
} from "../../../src/shared/types/provider.types";

/** Deliberately review-owned integration coverage for the pre-provider hook. */

class CapturingProvider implements LLMProvider {
  readonly name = "pre-llm-review-provider";
  readonly modelId = "pre-llm-review-model";
  readonly calls: CreateMessageOptions[] = [];

  constructor(
    private readonly respond: (
      options: CreateMessageOptions,
      call: number,
    ) => Promise<LLMResponse> | LLMResponse = () => textResponse("provider ok"),
  ) {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(options);
    return this.respond(options, this.calls.length);
  }

  async validateConfig(): Promise<{ valid: boolean }> {
    return { valid: true };
  }
}

function textResponse(text: string): LLMResponse {
  return {
    id: `response-${Math.random()}`,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function toolResponse(
  name: string,
  input: Record<string, unknown>,
): LLMResponse {
  return {
    id: `tool-${Math.random()}`,
    content: [
      { type: "tool_use", id: `tool-use-${Math.random()}`, name, input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function chatDispatch(text = "original user text"): AdfEventDispatch {
  return createDispatch(
    createEvent({
      type: "chat",
      source: "pre-llm-hook-review",
      data: {
        message: {
          seq: 0,
          role: "user",
          content_json: [{ type: "text", text }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: "agent" },
  );
}

function textOf(content: string | ContentBlock[]): string {
  return typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("");
}

interface RunningAgent {
  dir: string;
  filePath: string;
  workspace: AdfWorkspace;
  provider: CapturingProvider;
  sandbox: CodeSandboxService;
  agent: Awaited<ReturnType<AgentRuntimeBuilder["build"]>>;
}

const running: RunningAgent[] = [];

async function startAgent(
  opts: {
    hook?: PreLlmHookConfig;
    hookSource?: string;
    files?: Record<string, string>;
    tools?: ToolDeclaration[];
    loops?: LoopConfig[];
    provider?: CapturingProvider;
    limits?: Partial<AgentConfig["limits"]>;
    codeExecution?: Partial<NonNullable<AgentConfig["code_execution"]>>;
  } = {},
): Promise<RunningAgent> {
  const dir = mkdtempSync(join(tmpdir(), "adf-pre-llm-review-"));
  const filePath = join(dir, "review.adf");
  const provider = opts.provider ?? new CapturingProvider();

  // Use the headless creator only to make a real .adf. Its short-lived runtime
  // has no sandbox; the tested daemon runtime is assembled below.
  const created = createHeadlessAgent({
    filePath,
    name: "pre-llm-review",
    provider: new CapturingProvider(),
    createOptions: { tools: opts.tools ?? [] },
  });
  created.dispose();

  const workspace = AdfWorkspace.open(filePath);
  const config = workspace.getAgentConfig();
  // `AdfDatabase.create()` retains its standard tools for an empty creation
  // override. Set the exact declared surface here so review cases genuinely
  // exercise hook operation with no LLM-facing code-tool declaration.
  config.tools = opts.tools ?? [];
  config.pre_llm_hook = opts.hook;
  config.loops = opts.loops ?? [];
  config.limits = { ...config.limits, ...opts.limits };
  config.code_execution = { ...config.code_execution, ...opts.codeExecution };
  // A hook failure is structural. Do not hide its observation behind the
  // executor's later automatic provider-recovery timer in these tests.
  config.recovery = { ...(config.recovery ?? {}), auto_retry: false };
  workspace.setAgentConfig(config);
  if (opts.hookSource !== undefined)
    workspace.writeFile(
      opts.hook?.source.split(":")[0] ?? "lib/hook.js",
      opts.hookSource,
    );
  for (const [path, content] of Object.entries(opts.files ?? {}))
    workspace.writeFile(path, content);

  const sandbox = new CodeSandboxService();
  const agent = await new AgentRuntimeBuilder({
    codeSandboxService: sandbox,
  }).build({
    workspace,
    filePath,
    config: workspace.getAgentConfig(),
    provider,
  });
  const item: RunningAgent = {
    dir,
    filePath,
    workspace,
    provider,
    sandbox,
    agent,
  };
  running.push(item);
  return item;
}

afterEach(async () => {
  while (running.length > 0) {
    const item = running.pop()!;
    try {
      await item.agent.disposeAsync();
    } catch {
      /* cleanup */
    }
    try {
      rmSync(item.dir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  }
});

describe("pre-LLM hook review — schema and selection", () => {
  it("normalizes omitted scope to all and rejects ambiguous named-loop selectors", () => {
    const valid = PreLlmHookConfigSchema.safeParse({ source: "lib/hook.js" });
    expect(valid.success).toBe(true);
    if (valid.success) expect(valid.data.scope).toBe("all");

    for (const invalid of [
      { source: "lib/hook.js", scope: "loops" },
      { source: "lib/hook.js", scope: "loops", loops: [] },
      { source: "lib/hook.js", scope: "loops", loops: ["main"] },
      { source: "lib/hook.js", scope: "loops", loops: ["review", "review"] },
      { source: "lib/hook.js", scope: "all", loops: ["review"] },
      { source: "lib/hook.js", scope: "main", loops: ["review"] },
      { source: "lib/hook.js", timeout_ms: 999 },
    ]) {
      expect(PreLlmHookConfigSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("applies all/main/named selectors dynamically and validates malformed config even off-target", () => {
    const cfg = (hook: PreLlmHookConfig) =>
      ({ pre_llm_hook: hook }) as AgentConfig;
    expect(preLlmHookApplies(cfg({ source: "x" }), "main")).toBe(true);
    expect(
      preLlmHookApplies(cfg({ source: "x", scope: "all" }), "new-future-loop"),
    ).toBe(true);
    expect(preLlmHookApplies(cfg({ source: "x", scope: "main" }), "main")).toBe(
      true,
    );
    expect(
      preLlmHookApplies(cfg({ source: "x", scope: "main" }), "review"),
    ).toBe(false);
    expect(
      preLlmHookApplies(
        cfg({ source: "x", scope: "loops", loops: ["review"] }),
        "review",
      ),
    ).toBe(true);
    expect(
      preLlmHookApplies(
        cfg({ source: "x", scope: "loops", loops: ["review"] }),
        "unknown",
      ),
    ).toBe(false);
    expect(() =>
      preLlmHookApplies(
        cfg({ source: "x", scope: "all", loops: ["review"] }),
        "unselected",
      ),
    ).toThrow(/Pre-LLM hook failed.*only allowed/i);
  });

  it("accepts persisted AgentConfig hook shape and keeps its explicit source", async () => {
    const started = await startAgent({
      hook: { source: "lib/hook.js" },
      hookSource: "export function main({ request }) { return request }",
    });
    // New blank agents intentionally retain legacy-empty model/instructions
    // fields, so validate the hook section directly rather than mistake that
    // unrelated baseline schema drift for a hook persistence failure.
    const persisted = started.workspace.getAgentConfig().pre_llm_hook;
    expect(PreLlmHookConfigSchema.safeParse(persisted).success).toBe(true);
    expect(persisted).toMatchObject({ source: "lib/hook.js" });
  });
});

describe("pre-LLM hook review — provider boundary", () => {
  it("preserves no-hook conversational request behavior", async () => {
    const started = await startAgent();
    await started.agent.dispatch(chatDispatch("no hook"));

    expect(started.provider.calls).toHaveLength(1);
    expect(textOf(started.provider.calls[0].messages[0].content)).toContain(
      "no hook",
    );
    expect(started.provider.calls[0].system).not.toContain("review-hook");
  });

  it("runs with LLM-disabled sys_lambda, transforms a request only, and leaves session history untouched", async () => {
    const started = await startAgent({
      // The DB getter backfills every omitted DEFAULT_TOOL, so explicitly
      // declare disabled sys_lambda rather than using tools: [] as a proxy.
      tools: [{ name: "sys_lambda", enabled: false, visible: false }],
      hook: { source: "lib/hook.js" },
      hookSource: `
        export function main({ request, loop }) {
          request.messages[0].content = [{ type: 'text', text: 'provider-only rewrite' }]
          return { ...request, system: request.system + '|review-hook:' + loop.name }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch("durable original"));

    expect(started.agent.registry.get("sys_lambda")).toBeTruthy(); // internal nested-lambda backend
    expect(started.provider.calls).toHaveLength(1);
    expect(
      started.provider.calls[0].tools?.map((tool) => tool.name),
    ).not.toContain("sys_lambda");
    expect(started.provider.calls[0].system).toContain("|review-hook:main");
    expect(textOf(started.provider.calls[0].messages[0].content)).toBe(
      "provider-only rewrite",
    );
    expect(
      started.agent.session
        .getMessages()
        .map((message) => textOf(message.content))
        .join("\n"),
    ).toContain("durable original");
    expect(
      started.agent.session
        .getMessages()
        .map((message) => textOf(message.content))
        .join("\n"),
    ).not.toContain("provider-only rewrite");
  });

  it("runs once for every normal tool round while preserving runtime streaming callbacks and abort signal", async () => {
    const provider = new CapturingProvider((options, call) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.onTextDelta).toEqual(expect.any(Function));
      expect(options.onThinkingDelta).toEqual(expect.any(Function));
      options.onTextDelta!(`stream-${call}`);
      if (call === 1)
        return toolResponse("fs_read", {
          path: "README.md",
          start_line: 1,
          end_line: 1,
          _reason: "review",
        });
      return textResponse("done");
    });
    const started = await startAgent({
      provider,
      tools: [{ name: "fs_read", enabled: true, visible: true }],
      hook: { source: "lib/hook.js" },
      hookSource: `
        export function main({ request }) {
          globalThis.reviewRounds = (globalThis.reviewRounds || 0) + 1
          return { ...request, system: request.system + '|round:' + globalThis.reviewRounds }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch());

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.map((call) => call.system)).toEqual([
      expect.stringContaining("|round:1"),
      expect.stringContaining("|round:2"),
    ]);
  });

  it("selects main and future named inner loops without affecting unselected streams", async () => {
    const namedProvider = new CapturingProvider();
    const named = await startAgent({
      provider: namedProvider,
      hook: { source: "lib/hook.js", scope: "loops", loops: ["future-review"] },
      hookSource: `export function main({ request, loop }) { return { ...request, system: request.system + '|loop:' + loop.name } }`,
    });
    await named.agent.loopPool.createLoop({
      name: "future-review",
      goal: "review hook targeting",
      enabled: true,
      tools: [],
    });
    await named.agent.dispatch(chatDispatch("main not selected"));
    await named.agent.dispatchTo(
      "future-review",
      chatDispatch("future selected"),
    );

    expect(namedProvider.calls).toHaveLength(2);
    expect(namedProvider.calls[0].system).not.toContain("|loop:");
    expect(namedProvider.calls[1].system).toContain("|loop:future-review");

    const mainProvider = new CapturingProvider();
    const main = await startAgent({
      provider: mainProvider,
      loops: [
        { name: "other-review", goal: "not main", enabled: true, tools: [] },
      ],
      hook: { source: "lib/hook.js", scope: "main" },
      hookSource: `export function main({ request, loop }) { return { ...request, system: request.system + '|loop:' + loop.name } }`,
    });
    await main.agent.dispatch(chatDispatch("main selected"));
    await main.agent.dispatchTo(
      "other-review",
      chatDispatch("loop unselected"),
    );

    expect(mainProvider.calls).toHaveLength(2);
    expect(mainProvider.calls[0].system).toContain("|loop:main");
    expect(mainProvider.calls[1].system).not.toContain("|loop:");
  });
});

describe("pre-LLM hook review — failure and authority boundaries", () => {
  it("fails closed on a missing source and on invalid replacement output without dispatching a provider request", async () => {
    const missing = await startAgent({ hook: { source: "lib/missing.js" } });
    await missing.agent.dispatch(chatDispatch());
    expect(missing.provider.calls).toHaveLength(0);
    expect(missing.agent.executor.getState()).toBe("error");

    const invalid = await startAgent({
      hook: { source: "lib/hook.js" },
      hookSource: `export function main() { return ['not', 'a', 'request'] }`,
    });
    await invalid.agent.dispatch(chatDispatch());
    expect(invalid.provider.calls).toHaveLength(0);
    expect(invalid.agent.executor.getState()).toBe("error");
    expect(
      invalid.workspace
        .getLoop()
        .some((entry) =>
          textOf(entry.content_json).includes("Pre-LLM hook failed"),
        ),
    ).toBe(true);
  });

  it("enforces the configured execution ceiling and never dispatches after a timed-out hook", async () => {
    const started = await startAgent({
      hook: { source: "lib/hook.js", timeout_ms: 5_000 },
      limits: { execution_timeout_ms: 1_000 },
      hookSource: `export async function main({ request }) { await new Promise(resolve => setTimeout(resolve, 1500)); return request }`,
    });
    const began = Date.now();
    await started.agent.dispatch(chatDispatch());
    const elapsed = Date.now() - began;

    expect(started.provider.calls).toHaveLength(0);
    expect(started.agent.executor.getState()).toBe("error");
    // CodeSandbox gives RPC/worker teardown an extra buffer, but must not run
    // the 1.5s lambda through as if the hook's requested 5s were authoritative.
    expect(elapsed).toBeLessThan(4_000);
  }, 10_000);

  it("keeps the original execution snapshot authoritative when a hook advertises a disabled privileged tool", async () => {
    const provider = new CapturingProvider((_options, call) =>
      call === 1
        ? toolResponse("sys_update_config", {
            path: "description",
            value: "pwned",
          })
        : textResponse("finished"),
    );
    const started = await startAgent({
      provider,
      // Explicit disabled declaration survives config backfill and ensures the
      // advertised hook schema cannot widen the pre-hook execution snapshot.
      tools: [{ name: "sys_update_config", enabled: false, visible: false }],
      hook: { source: "lib/hook.js" },
      hookSource: `
        export function main({ request }) {
          return {
            ...request,
            tools: [{ name: 'sys_update_config', description: 'not a grant', input_schema: { type: 'object' } }]
          }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch());

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].tools?.map((tool) => tool.name)).toEqual([
      "sys_update_config",
    ]);
    expect(started.workspace.getAgentConfig().description).not.toBe("pwned");
    expect(JSON.stringify(provider.calls[1].messages)).toContain(
      'sys_update_config\\" is not enabled',
    );
  });

  it("keeps disabled LLM sys_lambda blocked despite backend registration, while hook code can use its separately code_execution-gated nested lambda", async () => {
    const provider = new CapturingProvider((_options, call) =>
      call === 1
        ? toolResponse("sys_lambda", {
            source: "lib/nested.js",
            args: { value: "llm-should-not-run" },
          })
        : textResponse("finished"),
    );
    const started = await startAgent({
      provider,
      // sys_lambda's normal LLM declaration is disabled, while its nested
      // code-execution method remains independently CE-config-gated.
      tools: [{ name: "sys_lambda", enabled: false, visible: false }],
      hook: { source: "lib/hook.js" },
      files: {
        "lib/nested.js": `export function main({ value }) { return 'nested:' + value }`,
      },
      hookSource: `
        export async function main({ request }) {
          const writeBlocked = await adf.fs_write({ path: 'should-not-exist.txt', content: 'no' })
            .then(() => false, () => true)
          const nested = await adf.sys_lambda({ source: 'lib/nested.js', args: { value: 'ok' } })
          return { ...request, system: request.system + '|writeBlocked:' + writeBlocked + '|' + nested }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch());

    expect(started.provider.calls).toHaveLength(2);
    expect(started.provider.calls[0].system).toContain(
      "|writeBlocked:true|nested:ok",
    );
    expect(started.workspace.readFile("should-not-exist.txt")).toBeNull();
    expect(
      started.provider.calls[0].tools?.map((tool) => tool.name),
    ).not.toContain("sys_lambda");
    expect(JSON.stringify(started.provider.calls[1].messages)).toContain(
      'sys_lambda\\" is not enabled',
    );
  });

  it("denies nested sys_lambda when code_execution.sys_lambda is disabled, independently of its LLM tool declaration", async () => {
    const started = await startAgent({
      tools: [{ name: "sys_lambda", enabled: false, visible: false }],
      codeExecution: { sys_lambda: false },
      hook: { source: "lib/hook.js" },
      hookSource: `
        export async function main({ request }) {
          const denied = await adf.sys_lambda({ source: 'lib/nested.js' })
            .then(() => false, error => error.code === 'DISABLED')
          return { ...request, system: request.system + '|nestedCeDenied:' + denied }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch());

    expect(started.provider.calls).toHaveLength(1);
    expect(started.provider.calls[0].system).toContain("|nestedCeDenied:true");
  });

  it("rejects an unauthorized hook source from calling a restricted nested tool even when that tool is advertised", async () => {
    const started = await startAgent({
      tools: [
        {
          name: "sys_get_meta",
          enabled: true,
          visible: true,
          restricted: true,
        },
      ],
      hook: { source: "lib/hook.js" },
      hookSource: `
        export async function main({ request }) {
          const denied = await adf.sys_get_meta({ key: 'secret' }).then(() => false, error => error.code === 'REQUIRES_AUTHORIZED_CODE')
          return { ...request, system: request.system + '|restrictedDenied:' + denied }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch());

    expect(started.provider.calls).toHaveLength(1);
    expect(started.provider.calls[0].system).toContain(
      "|restrictedDenied:true",
    );
  });

  it("keeps direct and nested model_invoke outside the hook recursion boundary", async () => {
    const provider = new CapturingProvider((options) => {
      if (textOf(options.messages[0].content) === "nested model call")
        return textResponse("nested-ok");
      return textResponse("outer-ok");
    });
    const started = await startAgent({
      provider,
      hook: { source: "lib/hook.js" },
      hookSource: `
        export async function main({ request }) {
          const nested = await adf.model_invoke({ prompt: 'nested model call' })
          return { ...request, system: request.system + '|nested:' + nested }
        }
      `,
    });

    await started.agent.dispatch(chatDispatch());

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].system).toBe("");
    expect(provider.calls[1].system).toContain("|nested:nested-ok");
  });
});

describe("pre-LLM hook review — live config fanout", () => {
  it("keeps sys_lambda absent and disabled in an inner loop while a named scope hook still runs there", async () => {
    const provider = new CapturingProvider((_options, call) =>
      call === 1
        ? toolResponse("sys_lambda", { source: "lib/never.js" })
        : textResponse("done"),
    );
    const started = await startAgent({
      provider,
      loops: [
        {
          name: "inner-review",
          goal: "validate side-loop tool attenuation",
          enabled: true,
          tools: [],
        },
      ],
      hook: { source: "lib/hook.js", scope: "loops", loops: ["inner-review"] },
      hookSource: `export function main({ request, loop }) { return { ...request, system: request.system + '|inner:' + loop.name } }`,
    });

    await started.agent.dispatchTo(
      "inner-review",
      chatDispatch("inner trigger"),
    );

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].system).toContain("|inner:inner-review");
    expect(provider.calls[0].tools?.map((tool) => tool.name)).not.toContain(
      "sys_lambda",
    );
    expect(
      started.agent.loopPool
        .getRuntime("inner-review")!
        .derived.tools.find((tool) => tool.name === "sys_lambda")?.enabled,
    ).toBe(false);
    expect(JSON.stringify(provider.calls[1].messages)).toContain(
      'sys_lambda\\" is not enabled',
    );
  });

  it("activates a hook added through the normal live config-change choke point without requiring a restart", async () => {
    const started = await startAgent({ tools: [] });
    started.workspace.writeFile(
      "lib/hook.js",
      `export function main({ request }) { return { ...request, system: request.system + '|hot-enabled' } }`,
    );
    const updated = started.workspace.getAgentConfig();
    updated.pre_llm_hook = { source: "lib/hook.js" };
    started.workspace.setAgentConfig(updated);
    started.agent.applyConfigChange(updated);

    await started.agent.dispatch(chatDispatch());

    expect(started.provider.calls).toHaveLength(1);
    expect(started.provider.calls[0].system).toContain("|hot-enabled");
  });
});
