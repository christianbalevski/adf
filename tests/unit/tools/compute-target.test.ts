import { describe, expect, it } from 'vitest'
import { availableTargets, resolveTarget, type ComputeCapabilities } from '../../../src/main/tools/built-in/compute-target'

function caps(overrides: Partial<ComputeCapabilities> = {}): ComputeCapabilities {
  return {
    hasIsolated: false,
    hasShared: true,
    hasHost: false,
    agentId: 'agent-1',
    ...overrides,
  }
}

describe('compute target resolution', () => {
  it('uses the configured external target without adding a new tool surface', () => {
    const capabilities = caps({
      externalTargets: {
        'docker-python-tools': {
          id: 'target-python',
          name: 'Python tools',
          kind: 'local-container',
          engine: 'docker',
          containerRef: 'python-tools',
          workdir: '/workspace',
        },
      },
      allowedTargets: ['shared', 'docker-python-tools'],
      defaultTarget: 'docker-python-tools',
    })

    expect(availableTargets(capabilities)).toEqual(['shared', 'docker-python-tools'])
    expect(resolveTarget(undefined, capabilities)).toBe('docker-python-tools')
    expect(resolveTarget('shared', capabilities)).toBe('shared')
  })

  it('does not expose external when the trusted target cannot be resolved', () => {
    const capabilities = caps({ allowedTargets: ['shared', 'docker-missing'], defaultTarget: 'docker-missing' })
    expect(availableTargets(capabilities)).toEqual(['shared'])
    expect(() => resolveTarget(undefined, capabilities)).toThrow('Configured compute target')
    expect(() => resolveTarget('docker-missing', capabilities)).toThrow('Authorize this registered target')
  })

  it('never grants registered external targets to legacy agents without an allowlist', () => {
    const capabilities = caps({
      externalTargets: {
        'docker-private': {
          id: 'target-private', name: 'Private', kind: 'local-container', engine: 'docker',
          containerRef: 'private', workdir: '/workspace',
        },
      },
    })
    expect(availableTargets(capabilities)).toEqual(['shared'])
  })
})
