import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

function makeHandler(identityStatus = true) {
  const workspace = {
    getEnvelopeState: (name: 'identity' | 'credentials') => name === 'identity' ? 'unlocked' : 'locked',
    isPasswordProtected: () => true,
    insertLog: () => {},
  }
  const handler = new AdfCallHandler({
    toolRegistry: { get: () => null } as never,
    workspace: workspace as never,
    config: {
      name: 'identity-status-test',
      id: 'identity-status-test',
      tools: [],
      code_execution: { identity_status: identityStatus },
    } as unknown as AgentConfig,
    provider: {} as never,
  })
  return handler
}

describe('AdfCallHandler identity_status', () => {
  it('returns only non-secret envelope state and legacy password protection state', async () => {
    const result = await makeHandler().handleCall('identity_status', {})

    expect(result).toEqual({
      result: {
        envelopes: { identity: 'unlocked', credentials: 'locked' },
        password_protected: true,
      }
    })
  })

  it('honors the code-execution method toggle', async () => {
    const result = await makeHandler(false).handleCall('identity_status', {})
    expect(result.errorCode).toBe('DISABLED')
  })
})
