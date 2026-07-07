import { describe, expect, it } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { CODE_EXECUTION_DEFAULTS } from '../../../src/shared/types/adf-v02.types'

/** Config keys that are not callable methods. */
const NON_METHOD_KEYS = new Set(['network', 'packages', 'restricted_methods'])

describe('code execution method schemas', () => {
  it('every method in CODE_EXECUTION_DEFAULTS has a schema for the Studio viewer', () => {
    const schemas = AdfCallHandler.getCodeExecutionSchemas()
    const methods = Object.keys(CODE_EXECUTION_DEFAULTS).filter((k) => !NON_METHOD_KEYS.has(k))
    for (const method of methods) {
      expect(schemas[method], `missing schema for "${method}"`).toBeDefined()
      expect(schemas[method].name).toBe(method)
      expect(schemas[method].description.length).toBeGreaterThan(0)
      expect(schemas[method].input_schema).toHaveProperty('type', 'object')
    }
  })
})
