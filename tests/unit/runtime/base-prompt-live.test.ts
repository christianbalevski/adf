import { describe, expect, it } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'

/** The app system prompt from Settings applies at the next turn, not the next start. */
describe('AgentExecutor base prompt source', () => {
  function assemble(executor: AgentExecutor): string {
    return (executor as unknown as { assembleSystemPrompt(): string }).assembleSystemPrompt()
  }

  it('reads the settings value each turn; a non-string keeps the start value', () => {
    const stub = {} as never
    const session = { getWorkspace: () => ({ readFile: () => null, getMeta: () => null }) } as never
    const executor = new AgentExecutor({ name: 'a', instructions: '', tools: [] } as never, stub, stub, session, 'START PROMPT')
    let setting: unknown = undefined
    executor.setBasePromptSource(() => setting)
    expect(assemble(executor)).toContain('START PROMPT')
    setting = 'EDITED PROMPT'
    const next = assemble(executor)
    expect(next).toContain('EDITED PROMPT')
    expect(next).not.toContain('START PROMPT')
    setting = 42
    expect(assemble(executor)).toContain('EDITED PROMPT')
  })
})
