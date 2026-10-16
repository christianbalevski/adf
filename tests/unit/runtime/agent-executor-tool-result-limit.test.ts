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
  function makeExecutor() {
    const workspace = { getFilePath: () => '/agents/agent-1.adf', insertLog: () => {} }
    const session = { getWorkspace: () => workspace } as never
    const config = {
      name: 'agent-1',
      id: 'agent-1',
      model: { provider: 'anthropic', model_id: 'claude-test' },
      tools: [],
      triggers: {},
      limits: { max_tool_result_tokens: 16000 },
    } as unknown as AgentConfig
    return new AgentExecutor(config, {} as never, { executeTool: () => {} } as never, session)
  }

  type Internals = {
    provider: unknown
    enforceToolResultLimit(result: ToolResult, toolName: string): ToolResult
  }

  it('measures a borderline result after the provider was released by abort()', () => {
    const executor = makeExecutor() as unknown as Internals
    executor.provider = null // what abort() leaves behind

    // Between the 3 and 20 chars/token pre-filters, so it is tokenized.
    const content = 'word '.repeat(12_000)
    const result: ToolResult = { content, isError: false }

    expect(() => executor.enforceToolResultLimit(result, 'fs_read')).not.toThrow()
    expect(executor.enforceToolResultLimit(result, 'fs_read').content).toBe(content)
  })
})
