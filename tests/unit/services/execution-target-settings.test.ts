import { describe, expect, it } from 'vitest'
import { resolveAgentComputeTargetSelection } from '../../../src/main/services/execution-target-settings'

const settings = {
  executionTargets: [
    {
      id: 'target-python',
      name: 'Python Tools',
      kind: 'local-container' as const,
      engine: 'docker' as const,
      containerRef: 'python-tools',
      workdir: '/workspace',
    },
    {
      id: 'target-data',
      name: 'Data Tools',
      alias: 'analysis-box',
      kind: 'local-container' as const,
      engine: 'podman' as const,
      containerRef: 'data-tools',
      workdir: '/work',
    },
  ],
}

describe('agent compute target selection', () => {
  it('maps trusted target IDs to safe aliases while preserving built-ins', () => {
    const result = resolveAgentComputeTargetSelection(settings, {
      enabled: true,
      allowed_targets: ['isolated', 'target-python', 'target-data'],
      default_target: 'target-python',
    })

    expect(result.allowedTargets).toEqual(['isolated', 'docker-python-tools', 'analysis-box'])
    expect(result.defaultTarget).toBe('docker-python-tools')
    expect(Object.keys(result.externalTargets)).toEqual(['docker-python-tools', 'analysis-box'])
  })

  it('migrates the legacy single external target as the only allowed default', () => {
    const result = resolveAgentComputeTargetSelection(settings, {
      enabled: false,
      target: 'target-python',
    })

    expect(result.allowedTargets).toEqual(['docker-python-tools'])
    expect(result.defaultTarget).toBe('docker-python-tools')
  })

  it('does not authorize app-level targets for legacy agents without an assignment', () => {
    const result = resolveAgentComputeTargetSelection(settings, { enabled: false })
    expect(result.allowedTargets).toBeUndefined()
    expect(result.defaultTarget).toBeUndefined()
  })
})
