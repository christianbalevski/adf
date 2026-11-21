import { describe, expect, it } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ToolResult } from '../../../src/shared/types/tool.types'

/**
 * abort() (the Stop button) nulls the executor's provider while a tool call
 * may still be finishing. A borderline-size result is then measured with the
 * real tokenizer, which read `this.provider.modelId` and threw — the stop
 * path swallows that as shutdown noise, so the tool's result was dropped.
 */
describe('AgentExecutor tool result limit', () => {
  function makeExecutor(tools: { name: string }[] = [], unregistered: string[] = []) {
    const workspace = { getFilePath: () => '/agents/agent-1.adf', insertLog: () => {} }
    const session = { getWorkspace: () => workspace } as never
    const config = {
      name: 'agent-1',
      id: 'agent-1',
      model: { provider: 'anthropic', model_id: 'claude-test' },
      tools,
      triggers: {},
      limits: { max_tool_result_tokens: 16000 },
    } as unknown as AgentConfig
    // Registered = declared here, as the runtime builders register declared tools.
    const registry = { executeTool: () => {}, get: (name: string) => unregistered.includes(name) ? undefined : tools.find(t => t.name === name) }
    return new AgentExecutor(config, {} as never, registry as never, session)
  }

  type Internals = {
    provider: unknown
    enforceToolResultLimit(result: ToolResult, toolName: string, remedy: string): ToolResult
    shapeToolResult(toolName: string, rawResult: ToolResult): { result: ToolResult }
  }

  it('measures a borderline result after the provider was released by abort()', () => {
    const executor = makeExecutor() as unknown as Internals
    executor.provider = null // what abort() leaves behind

    // Between the 3 and 20 chars/token pre-filters, so it is tokenized.
    const content = 'word '.repeat(12_000)
    const result: ToolResult = { content, isError: false }

    expect(() => executor.enforceToolResultLimit(result, 'fs_read', '')).not.toThrow()
    expect(executor.enforceToolResultLimit(result, 'fs_read', '').content).toBe(content)
  })

  describe('notice for a discarded result', () => {
    const big: ToolResult = { content: 'x'.repeat(16_000 * 21), isError: false }
    const shape = (tools: { name: string }[], toolName: string, unregistered: string[] = []) => {
      const executor = makeExecutor(tools, unregistered) as unknown as Internals
      return executor.shapeToolResult(toolName, big).result.content
    }
    const sysCode = { name: 'sys_code', enabled: true, visible: true }

    it('names the sys_code call for an over-cap tool result', () => {
      const content = shape([sysCode, { name: 'sys_get_config', enabled: true, visible: true }], 'sys_get_config')
      expect(content).toMatch(/^\[TRUNCATED\] Tool "sys_get_config"/)
      expect(content).toContain('Calls made from code are not capped: if running it again is safe, try it from sys_code (`await adf["sys_get_config"]({...})` with the same arguments, without `_async`)')
    })

    it('keeps the old advice when the agent has no sys_code', () => {
      const content = shape([{ name: 'sys_get_config', enabled: true, visible: true }], 'sys_get_config')
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code')
    })

    it('keeps the old advice when sys_code is declared but disabled', () => {
      const content = shape([{ name: 'sys_code', enabled: false, visible: false }, { name: 'sys_get_config', enabled: true, visible: true }], 'sys_get_config')
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code')
    })

    it('keeps the old advice when sys_code is enabled but not registered (no sandbox service)', () => {
      const content = shape([sysCode, { name: 'sys_get_config', enabled: true, visible: true }], 'sys_get_config', ['sys_code'])
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code')
    })

    it('keeps the old advice for a lambda\'s result, the agent\'s own code', () => {
      const content = shape([sysCode, { name: 'sys_lambda', enabled: true, visible: true }], 'sys_lambda')
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code (')
    })

    it('keeps the old advice when any duplicate declaration of the tool is restricted', () => {
      const content = shape([sysCode, { name: 'mcp_s_get', enabled: true, visible: true }, { name: 'mcp_s_get', enabled: true, visible: true, restricted: true }], 'mcp_s_get')
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code')
    })

    it('keeps the old advice for a restricted tool, which inline code may not call', () => {
      const content = shape([sysCode, { name: 'mcp_s_get', enabled: true, visible: true, restricted: true }], 'mcp_s_get')
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code')
    })

    it('quotes a tool name that is not a JS identifier', () => {
      const content = shape([sysCode, { name: 'mcp_my-server_get', enabled: true, visible: true }], 'mcp_my-server_get')
      expect(content).toContain('await adf["mcp_my-server_get"]({...})')
    })
    it('keeps the old advice for sys_code\'s own result, not to call itself', () => {
      const content = shape([sysCode], 'sys_code')
      expect(content).toContain('Request a smaller or more specific result.')
      expect(content).not.toContain('sys_code (')
    })
  })
})
