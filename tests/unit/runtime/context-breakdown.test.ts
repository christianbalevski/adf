import { describe, it, expect } from 'vitest'
import {
  measureInjectedFiles,
  measureToolSchemas,
  assembleContextBreakdown,
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
