/**
 * A loop's authorized code reaches only the tools the loop was granted.
 *
 * adf-call-handler lets authorized code call a `restricted` tool even when the
 * declaration is disabled (`authorizedBypass`). deriveLoopConfig therefore
 * carries `restricted` on GRANTED tools only: a host-restricted tool the loop
 * was not given must come back plain-disabled, so the loop's authorized code
 * cannot reach it through the bypass.
 */

import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { withAuthorization } from '../../../src/main/runtime/authorization-context'
import { deriveLoopConfig } from '../../../src/main/adf/derive-loop-config'
import { CODE_EXECUTION_DEFAULTS } from '../../../src/shared/types/adf-v02.types'
import type { AgentConfig, LoopConfig } from '../../../src/shared/types/adf-v02.types'

function setup() {
  const executed: string[] = []
  const registry = {
    get: (name: string) => ({ name }),
    executeTool: async (name: string) => {
      executed.push(name)
      return { content: `${name} ran`, isError: false }
    },
  }
  const workspace = {
    insertLog: () => { /* not asserted */ },
    isFileAuthorized: () => true,
    getLoopName: () => 'reflector',
  }
  const hostConfig = {
    name: 'agent-1',
    id: 'agent-1',
    model: { provider: 'anthropic', model_id: 'claude' },
    tools: [
      { name: 'fs_read', enabled: true, visible: true },
      { name: 'shell_exec', enabled: true, visible: true, restricted: true },
      { name: 'db_execute', enabled: true, visible: true, restricted: true },
    ],
    code_execution: { ...CODE_EXECUTION_DEFAULTS },
  } as unknown as AgentConfig
  const loop: LoopConfig = { name: 'reflector', enabled: true, tools: ['fs_read', 'db_execute'] } as LoopConfig

  const host = new AdfCallHandler({
    toolRegistry: registry as never,
    workspace: workspace as never,
    config: hostConfig,
    provider: {} as never,
  })
  const loopHandler = host.forLoop(workspace as never, deriveLoopConfig(hostConfig, loop))
  return { host, loopHandler, executed }
}

describe('loop authorized code and host-restricted tools', () => {
  it('cannot call a host-restricted tool the loop was not granted', async () => {
    const { loopHandler, executed } = setup()
    const result = await withAuthorization(true, () => loopHandler.handleCall('shell_exec', {}))
    expect(result.errorCode).toBe('DISABLED')
    expect(executed).toEqual([])
  })

  it('can call a granted restricted tool, as main\'s authorized code can', async () => {
    const { loopHandler, executed } = setup()
    const result = await withAuthorization(true, () => loopHandler.handleCall('db_execute', {}))
    expect(result.error).toBeUndefined()
    expect(executed).toEqual(['db_execute'])
  })

  it('unauthorized loop code is refused a granted restricted tool', async () => {
    const { loopHandler, executed } = setup()
    const result = await withAuthorization(false, () => loopHandler.handleCall('db_execute', {}))
    expect(result.errorCode).toBe('REQUIRES_AUTHORIZED_CODE')
    expect(executed).toEqual([])
  })

  it('main\'s authorized code still reaches the tool the loop lacks', async () => {
    const { host, executed } = setup()
    const result = await withAuthorization(true, () => host.handleCall('shell_exec', {}))
    expect(result.error).toBeUndefined()
    expect(executed).toEqual(['shell_exec'])
  })
})
