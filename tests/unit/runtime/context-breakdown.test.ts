import { describe, it, expect } from 'vitest'
import {
  measureInjectedFiles,
  measureToolSchemas,
  assembleContextBreakdown,
  calibrateContextBreakdown,
  apportion,
} from '../../../src/main/runtime/context-breakdown'
import { renderInjectedFile, MISSING_FILE_SENTINEL } from '../../../src/main/runtime/prompt-file-injection'
import { McpTool } from '../../../src/main/tools/mcp-tool'
import type { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import type { ToolProviderFormat } from '../../../src/shared/types/tool.types'

// Deterministic "tokenizer": one token per character. Lets tests assert exact
// figures without depending on a real tokenizer's segmentation.
const countChars = (text: string): number => text.length

/** An McpTool that is never executed — the manager is a dead stub. */
function makeMcpTool(server: string, toolName: string): McpTool {
  return new McpTool(server, { name: toolName, input_schema: {} }, {} as unknown as McpClientManager)
}

function schema(name: string, description = ''): ToolProviderFormat {
  return { name, description, input_schema: { type: 'object', properties: {} } }
}

describe('measureInjectedFiles', () => {
  it('measures the rendered <injected_file> form, not the raw content', () => {
    const snap = new Map([['mind.md', 'memory']])
    const [entry] = measureInjectedFiles(snap, countChars)
    expect(entry).toEqual({
      path: 'mind.md',
      tokens: renderInjectedFile('mind.md', 'memory').length,
    })
    // Wrapper tags are part of the prompt cost — strictly more than raw content.
    expect(entry.tokens).toBeGreaterThan('memory'.length)
  })

  it('measures a missing file as its short self-closing marker', () => {
    const snap = new Map([['gone.md', MISSING_FILE_SENTINEL]])
    const [entry] = measureInjectedFiles(snap, countChars)
    expect(entry.tokens).toBe('<injected_file path="gone.md" missing="true"/>'.length)
  })

  it('returns entries sorted by path', () => {
    const snap = new Map([['b.md', 'B'], ['a.md', 'A']])
    expect(measureInjectedFiles(snap, countChars).map((e) => e.path)).toEqual(['a.md', 'b.md'])
  })
})

describe('measureToolSchemas', () => {
  it('groups built-in vs per MCP server via instanceof, not name prefix', () => {
    const builtIn = { name: 'fs_read' } // plain object — not an McpTool
    // A built-in whose name starts with mcp_ must stay 'built-in' (prefix
    // parsing would misfile it).
    const trickyBuiltIn = { name: 'mcp_install' }
    const entries = [
      { schema: schema('fs_read'), tool: builtIn },
      { schema: schema('mcp_install'), tool: trickyBuiltIn },
      { schema: schema('mcp_weather_get_forecast'), tool: makeMcpTool('weather', 'get_forecast') },
      { schema: schema('mcp_weather_get_alerts'), tool: makeMcpTool('weather', 'get_alerts') },
      { schema: schema('mcp_files_search'), tool: makeMcpTool('files', 'search') },
    ]
    const { groups } = measureToolSchemas(entries, countChars)

    expect(groups.map((g) => g.source)).toEqual(['built-in', 'weather', 'files'])
    expect(groups[0].tools.map((t) => t.name)).toEqual(['fs_read', 'mcp_install'])
    expect(groups[1].tools.map((t) => t.name)).toEqual(['mcp_weather_get_forecast', 'mcp_weather_get_alerts'])
    expect(groups[2].tools.map((t) => t.name)).toEqual(['mcp_files_search'])
  })

  it('measures serialized JSON per tool and sums per group and overall', () => {
    const a = schema('a', 'short')
    const b = schema('bb', 'a longer description')
    const { groups, totalTokens } = measureToolSchemas(
      [
        { schema: a, tool: {} },
        { schema: b, tool: {} },
      ],
      countChars
    )
    const aTokens = JSON.stringify(a).length
    const bTokens = JSON.stringify(b).length
    expect(groups[0].tools).toEqual([
      { name: 'a', tokens: aTokens },
      { name: 'bb', tokens: bTokens },
    ])
    expect(groups[0].tokens).toBe(aTokens + bTokens)
    expect(totalTokens).toBe(aTokens + bTokens)
  })

  it('handles an empty toolset', () => {
    expect(measureToolSchemas([], countChars)).toEqual({ groups: [], totalTokens: 0 })
  })
})

describe('assembleContextBreakdown', () => {
  it('computes overhead as system prompt + tools (fixed per-request cost)', () => {
    const breakdown = assembleContextBreakdown({
      systemPromptTokens: 12_000,
      systemPromptParts: { base_and_sections: 9_000, runtime_blocks: 200, instructions: 2_700 },
      injectedFiles: [{ path: 'mind.md', tokens: 300 }],
      toolGroups: [{ source: 'built-in', tokens: 40_000, tools: [] }],
      toolsTotalTokens: 40_000,
      dynamicInstructionsTokens: 150,
      messagesTokens: 9_000,
      now: 1234,
    })
    expect(breakdown).toEqual({
      system_prompt_tokens: 12_000,
      // Passed through verbatim: the layers are priced at rebuild, and their
      // sum is allowed to differ from the total by the separators.
      system_prompt_parts: { base_and_sections: 9_000, runtime_blocks: 200, instructions: 2_700 },
      injected_files: [{ path: 'mind.md', tokens: 300 }],
      tool_groups: [{ source: 'built-in', tokens: 40_000, tools: [] }],
      tools_total_tokens: 40_000,
      dynamic_instructions_tokens: 150,
      messages_tokens: 9_000,
      // Dynamic instructions and messages are per-turn, NOT fixed overhead.
      overhead_tokens: 52_000,
      computed_at: 1234,
    })
  })

  it('stamps computed_at with the current time when not injected', () => {
    const before = Date.now()
    const breakdown = assembleContextBreakdown({
      systemPromptTokens: 0,
      systemPromptParts: { base_and_sections: 0, runtime_blocks: 0, instructions: 0 },
      injectedFiles: [],
      toolGroups: [],
      toolsTotalTokens: 0,
      dynamicInstructionsTokens: 0,
      messagesTokens: 0,
    })
    expect(breakdown.computed_at).toBeGreaterThanOrEqual(before)
    expect(breakdown.computed_at).toBeLessThanOrEqual(Date.now())
  })
})

describe('apportion', () => {
  it('splits proportionally and always sums to the target', () => {
    expect(apportion([1, 1, 1], 10)).toEqual([4, 3, 3])
    expect(apportion([4600, 8000, 0, 37000], 94000).reduce((a, b) => a + b, 0)).toBe(94000)
    expect(apportion([0, 0], 5)).toEqual([0, 0])
  })
})

describe('calibrateContextBreakdown', () => {
  const sum = (b: ReturnType<typeof assembleContextBreakdown>) =>
    b.system_prompt_tokens + b.tools_total_tokens + b.dynamic_instructions_tokens + b.messages_tokens

  /** The crypt-dawg shape: system 4.6k + tools 8.0k + conversation 37k estimated. */
  function estimated(messagesTokens = 37_000) {
    return assembleContextBreakdown({
      systemPromptTokens: 4_600,
      systemPromptParts: { base_and_sections: 3_000, runtime_blocks: 600, instructions: 1_000 },
      injectedFiles: [{ path: 'mind.md', tokens: 1_000 }],
      toolGroups: [
        { source: 'built-in', tokens: 6_000, tools: [{ name: 'fs_read', tokens: 2_500 }, { name: 'fs_write', tokens: 3_500 }] },
        { source: 'weather', tokens: 2_000, tools: [{ name: 'mcp_weather_get', tokens: 2_000 }] },
      ],
      toolsTotalTokens: 8_000,
      dynamicInstructionsTokens: 0,
      messagesTokens,
      now: 1,
    })
  }

  it('crypt-dawg: 49.6k estimated, 94k real — the parts sum to the real figure', () => {
    const b = calibrateContextBreakdown(estimated(), {
      lastCallTokens: 94_000,
      prior: { estimated: 37_000, reported: 0 },
      since: { estimated: 0, reported: 0 },
    })
    expect(sum(b)).toBe(94_000)
    expect(b.overhead_tokens).toBe(b.system_prompt_tokens + b.tools_total_tokens)
    expect(b.calibration).toEqual({ last_call_tokens: 94_000, ratio: 94_000 / 49_600, since_last_call_tokens: 0 })
    // Proportions are kept: conversation stays ~74.6% of the whole.
    expect(b.messages_tokens).toBe(Math.round(37_000 * (94_000 / 49_600)))
    // Sub-parts are rescaled consistently with their parent.
    expect(b.tool_groups.reduce((a, g) => a + g.tokens, 0)).toBe(b.tools_total_tokens)
    for (const g of b.tool_groups) expect(g.tools.reduce((a, t) => a + t.tokens, 0)).toBe(g.tokens)
    expect(b.injected_files[0].tokens).toBeLessThanOrEqual(b.system_prompt_tokens)
    expect(b.injected_files[0].tokens).toBe(Math.round(1_000 * (94_000 / 49_600)))
  })

  it('keeps API-reported reasoning exact and scales only the estimated parts', () => {
    const b = calibrateContextBreakdown(estimated(47_000), {
      lastCallTokens: 94_000,
      prior: { estimated: 37_000, reported: 10_000 },
      since: { estimated: 0, reported: 0 },
    })
    expect(sum(b)).toBe(94_000)
    // 84k real over 49.6k estimated; the 10k reasoning is not scaled.
    expect(b.calibration!.ratio).toBeCloseTo(84_000 / 49_600)
    expect(b.messages_tokens).toBe(Math.round(37_000 * (84_000 / 49_600)) + 10_000)
  })

  it('adds content since the last call as an estimate at the same ratio', () => {
    const b = calibrateContextBreakdown(estimated(39_000), {
      lastCallTokens: 94_000,
      prior: { estimated: 37_000, reported: 0 },
      since: { estimated: 1_500, reported: 500 },
    })
    const since = Math.round(1_500 * (94_000 / 49_600)) + 500
    expect(b.calibration!.since_last_call_tokens).toBe(since)
    expect(sum(b)).toBe(94_000 + since)
  })

  it('treats reasoning that over-subtracts as an estimate', () => {
    // 34k reported reasoning leaves 6k for 19.6k estimated parts (ratio
    // 0.31, out of band): it was not all resent, so it is scaled with the rest.
    const b = calibrateContextBreakdown(estimated(), {
      lastCallTokens: 40_000,
      prior: { estimated: 7_000, reported: 34_000 },
      since: { estimated: 0, reported: 0 },
    })
    expect(sum(b)).toBe(40_000)
    expect(b.calibration!.ratio).toBeCloseTo(40_000 / (19_600 + 34_000))
  })

  it('skips calibration when real / estimated leaves the 0.5–3 band', () => {
    const b = estimated()
    const none = { estimated: 0, reported: 0 }
    expect(calibrateContextBreakdown(b, { lastCallTokens: 40, prior: { estimated: 37_000, reported: 0 }, since: none })).toBe(b)
    expect(calibrateContextBreakdown(b, { lastCallTokens: 200_000, prior: { estimated: 37_000, reported: 0 }, since: none })).toBe(b)
    expect(calibrateContextBreakdown(b, { lastCallTokens: 148_800, prior: { estimated: 37_000, reported: 0 }, since: none }).calibration!.ratio).toBe(3)
  })

  it('leaves the estimate untouched without a usable last call', () => {
    const b = estimated()
    expect(calibrateContextBreakdown(b, { lastCallTokens: 0, prior: { estimated: 37_000, reported: 0 }, since: { estimated: 0, reported: 0 } })).toBe(b)
    expect(b.calibration).toBeUndefined()
  })
})
