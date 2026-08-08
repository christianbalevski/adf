import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'

afterEach(() => {
  RuntimeGate._resetForTests()
})

describe('RuntimeGate', () => {
  it('resume() reopens the gate after a plain stop()', () => {
    RuntimeGate.stop()
    expect(RuntimeGate.stopped).toBe(true)
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(false)
  })

  it('beginTeardown() closes the gate permanently — resume() becomes a no-op', () => {
    RuntimeGate.beginTeardown()
    expect(RuntimeGate.stopped).toBe(true)
    expect(RuntimeGate.tearingDown).toBe(true)

    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(true)
    expect(RuntimeGate.tearingDown).toBe(true)

    // Repeated resume attempts (autostart, user click, IPC) must all no-op.
    RuntimeGate.resume()
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(true)
  })

  it('beginTeardown() after resume() still wins', () => {
    RuntimeGate.stop()
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(false)
    RuntimeGate.beginTeardown()
    RuntimeGate.resume()
    expect(RuntimeGate.stopped).toBe(true)
  })
})
