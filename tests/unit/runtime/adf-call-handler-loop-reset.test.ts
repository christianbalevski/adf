/**
 * loop_compact / loop_clear are refused from code.
 *
 * They are SIGNALS: their execute() only reports intent, and AgentExecutor runs
 * the real summarize-and-clear pass by matching the model's TOP-LEVEL tool
 * block name. An adf.loop_compact() from sandbox code reaches the tool but
 * never that branch, so it used to return "Compaction initiated for N loop
 * entries" with the loop fully intact — a false success. These pin the plain
 * refusal instead, including for authorized code (the privilege doesn't make
 * the call any less inert).
 */

import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { withAuthorization } from '../../../src/main/runtime/authorization-context'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

function makeHandler() {
  const executed: Array<{ name: string }> = []
  const logs: Array<{ level: string; message: string }> = []

  const workspace = {
    insertLog: (level: string, _origin: string, _event: string | null, _target: string | null, message: string) => {
      logs.push({ level, message })
    },
    isFileAuthorized: () => false,
    getLoopCount: () => 42,
  }

  const config: AgentConfig = {
    name: 'agent-1',
    id: 'agent-1',
    // Declared AND enabled — the refusal must not depend on the tool being off.
    tools: [{ name: 'loop_compact', enabled: true }, { name: 'loop_clear', enabled: true }],
    code_execution: {} as AgentConfig['code_execution'],
  } as unknown as AgentConfig

  const handler = new AdfCallHandler({
    toolRegistry: {
      get: (name: string) => ({ name }),
      executeTool: async (name: string) => {
        executed.push({ name })
        return { content: 'Compaction initiated for 42 loop entries.', isError: false }
      },
    } as never,
    workspace: workspace as never,
    config,
    provider: {} as never,
  })

  return { handler, executed, logs }
}

describe('AdfCallHandler: loop-reset tools from code', () => {
  it.each(['loop_compact', 'loop_clear'])('refuses %s and never calls the tool', async (method) => {
    const { handler, executed } = makeHandler()
    const result = await handler.handleCall(method, {})

    expect(result.error).toBeDefined()
    expect(result.errorCode).toBe('EXCLUDED_TOOL')
    expect(result.error).toContain(method)
    expect(result.error).toContain('direct tool call')
    // The critical part: no optimistic success text reached the caller.
    expect(result.result).toBeUndefined()
    expect(executed).toEqual([])
  })

  it('refuses from authorized code too — authorization cannot make the call take effect', async () => {
    const { handler, executed } = makeHandler()
    const result = await withAuthorization(true, () => handler.handleCall('loop_compact', {}))

    expect(result.errorCode).toBe('EXCLUDED_TOOL')
    expect(executed).toEqual([])
  })

  it('logs the rejection so the dead-end is visible in adf_logs', async () => {
    const { handler, logs } = makeHandler()
    await handler.handleCall('loop_compact', {})

    expect(logs.some(l => l.level === 'warn' && l.message.includes('loop_compact'))).toBe(true)
  })
})
