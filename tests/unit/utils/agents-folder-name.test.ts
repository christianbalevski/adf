import { describe, expect, it } from 'vitest'
import { defaultAgentsFolderName } from '../../../src/main/utils/agents-folder-name'

describe('defaultAgentsFolderName', () => {
  it('is adf-agents, or adf-agents-<n> for an isolated instance', () => {
    expect(defaultAgentsFolderName({})).toBe('adf-agents')
    expect(defaultAgentsFolderName({ ADF_INSTANCE: '' })).toBe('adf-agents')
    expect(defaultAgentsFolderName({ ADF_INSTANCE: '4' })).toBe('adf-agents-4')
    expect(defaultAgentsFolderName({ ADF_INSTANCE: '../demo' })).toBe('adf-agents-.._demo')
  })
})
