import { describe, it, expect } from 'vitest'
import { assertNpmSpec } from '../../../src/main/utils/npm-spec'

describe('assertNpmSpec', () => {
  it('accepts plain registry specs', () => {
    for (const [n, v] of [['lodash'], ['@resvg/resvg-wasm'], ['vega-lite', '^5.21.0'], ['@scope/pkg@1.2.3'], ['x', 'latest'], ['x', '~1.0.0-beta.1']]) {
      expect(() => assertNpmSpec(n, v)).not.toThrow()
    }
  })

  it('rejects anything cmd.exe would interpret', () => {
    for (const [n, v] of [['x & calc'], ['x|calc'], ['x', '1.0 & calc'], ['x@1.0"&calc'], ['x', '>=1 <2'], ['%PATH%'], ['']]) {
      expect(() => assertNpmSpec(n, v)).toThrow()
    }
  })
})
