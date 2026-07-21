import { describe, expect, it } from 'vitest'
import { validateTarget } from '../../../src/main/services/external-execution.service'

describe('external execution target validation', () => {
  const target = {
    id: 'target-python',
    name: 'Python tools',
    kind: 'local-container' as const,
    engine: 'docker' as const,
    containerRef: 'python-tools',
    workdir: '/workspace',
  }

  it('accepts a user-owned local container reference', () => {
    expect(() => validateTarget(target)).not.toThrow()
  })

  it('rejects option-like container references and relative workdirs', () => {
    expect(() => validateTarget({ ...target, containerRef: '--privileged' })).toThrow('invalid')
    expect(() => validateTarget({ ...target, workdir: '../workspace' })).toThrow('absolute Unix path')
  })
})
