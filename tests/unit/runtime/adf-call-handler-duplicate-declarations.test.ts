import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { withAuthorization } from '../../../src/main/runtime/authorization-context'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

/**
 * A tool declared twice must read the same from code as it does on the turn:
 * first declaration wins, and a later duplicate can raise `restricted` but
 * never lower it (dedupeToolDeclarations). Reading only the first entry let
 * inline code run a tool the turn gates behind approval.
 */
describe('AdfCallHandler code-call gate with duplicate tool declarations', () => {
  function handlerFor(tools: AgentConfig['tools']) {
    const executed: string[] = []
    const handler = new AdfCallHandler({
      toolRegistry: {
        get: () => ({}),
        executeTool: async (name: string) => { executed.push(name); return { content: 'FULL', isError: false } },
      } as never,
      workspace: { insertLog: () => {}, isFileAuthorized: () => false } as never,
      config: { name: 'a', id: 'a', tools } as unknown as AgentConfig,
      provider: {} as never,
    })
    return { handler, executed }
  }

  it('refuses unauthorized code when a later duplicate marks the tool restricted', async () => {
    const { handler, executed } = handlerFor([
      { name: 'mcp_s_get', enabled: true },
      { name: 'mcp_s_get', enabled: true, restricted: true },
    ] as AgentConfig['tools'])
    const result = await handler.handleCall('mcp_s_get', {})
    expect(result.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')
    expect(executed).toEqual([])
  })

  it('refuses unauthorized code when only a disabled duplicate is restricted', async () => {
    // The turn reads this as restricted (sticky); no single entry is enabled+restricted,
    // so the sandbox's fast-fail list does not catch it and the gate must.
    const { handler, executed } = handlerFor([
      { name: 'mcp_s_get', enabled: true },
      { name: 'mcp_s_get', enabled: false, restricted: true },
    ] as AgentConfig['tools'])
    const result = await handler.handleCall('mcp_s_get', {})
    expect(result.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')
    expect(executed).toEqual([])
  })

  it('reads a disabled tool with a restricted duplicate like the single declaration {enabled:false, restricted:true}', async () => {
    // Same rule as the turn: the deduped declaration is disabled+restricted, and
    // authorized code bypasses disabled for a restricted tool.
    const { handler, executed } = handlerFor([
      { name: 'mcp_s_get', enabled: false },
      { name: 'mcp_s_get', enabled: true, restricted: true },
    ] as AgentConfig['tools'])
    const single = handlerFor([{ name: 'mcp_s_get', enabled: false, restricted: true }] as AgentConfig['tools'])
    const result = await withAuthorization(true, () => handler.handleCall('mcp_s_get', {}))
    const singleResult = await withAuthorization(true, () => single.handler.handleCall('mcp_s_get', {}))
    expect(result.errorCode).toBe(singleResult.errorCode)
    expect(result.errorCode).toBeUndefined()
    expect(executed).toEqual(['mcp_s_get'])
  })

  it('still runs a tool with a single unrestricted declaration', async () => {
    const { handler, executed } = handlerFor([{ name: 'mcp_s_get', enabled: true }] as AgentConfig['tools'])
    const result = await handler.handleCall('mcp_s_get', {})
    expect(result.errorCode).toBeUndefined()
    expect(executed).toEqual(['mcp_s_get'])
  })
})
