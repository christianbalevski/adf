import { describe, it, expect } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../../src/main/runtime/code-sandbox'

/**
 * Async output drain + expression auto-result + require stub.
 *
 * Regression suite for "node + adf.* is mute": output produced after the
 * wrapper IIFE settled (unawaited .then chains, setTimeout callbacks,
 * in-flight adf.* calls) used to be lost because stdout was snapshotted and
 * deleted immediately on settle.
 */
describe('CodeSandboxService async output drain', () => {
  it('captures output from an unawaited adf.* promise .then chain', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-adf-then-output'

    const onAdfCall = async (method: string): Promise<AdfCallResult> => {
      // Deliberately slow so the IIFE settles while the call is in flight
      await new Promise((r) => setTimeout(r, 30))
      return { result: JSON.stringify({ ok: true, method }) }
    }

    try {
      const result = await sandbox.execute(
        agentId,
        'adf.fs_list({}).then(r => console.log("adf-result: " + JSON.stringify(r))); return "kicked off"',
        5000,
        onAdfCall
      )

      expect(result.error).toBeUndefined()
      expect(result.result).toBe('kicked off')
      expect(result.stdout).toContain('adf-result:')
      expect(result.stdout).toContain('"ok":true')
      expect(result.stdout).toContain('fs_list')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('captures adf.* .catch output when the call fails', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-adf-catch-output'

    const onAdfCall = async (): Promise<AdfCallResult> => {
      await new Promise((r) => setTimeout(r, 20))
      return { error: 'boom', errorCode: 'INTERNAL_ERROR' }
    }

    try {
      const result = await sandbox.execute(
        agentId,
        'adf.fs_read({ path: "x" }).catch(e => console.log("caught: " + e.message)); return 1',
        5000,
        onAdfCall
      )

      expect(result.error).toBeUndefined()
      expect(result.stdout).toContain('caught: boom')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('captures setTimeout callback output after the IIFE settles', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-settimeout-output'

    try {
      const result = await sandbox.execute(
        agentId,
        'setTimeout(() => console.log("tick"), 10); return "done"',
        5000
      )

      expect(result.error).toBeUndefined()
      expect(result.result).toBe('done')
      expect(result.stdout).toContain('tick')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('drains multiple macrotask rounds (chained timers within the quiet window)', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-chained-timers'

    try {
      const result = await sandbox.execute(
        agentId,
        'setTimeout(() => { console.log("first"); setTimeout(() => console.log("second"), 20); }, 10); return 1',
        5000
      )

      expect(result.error).toBeUndefined()
      expect(result.stdout).toContain('first')
      expect(result.stdout).toContain('second')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('bounds the drain — does not wait for genuinely long timers', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-drain-bounded'

    try {
      const t0 = Date.now()
      const result = await sandbox.execute(
        agentId,
        'setTimeout(() => console.log("late"), 5000); return "x"',
        3000
      )
      const elapsed = Date.now() - t0

      expect(result.error).toBeUndefined()
      expect(result.result).toBe('x')
      expect(result.stdout).not.toContain('late')
      // Should exit after the quiet window (~80ms), well before the 5s timer
      // or the 3s execution timeout.
      expect(elapsed).toBeLessThan(2000)
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('drains output in the fn_exec (sys_lambda) path', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-fn-exec-drain'

    try {
      // Spin up the worker first — executeFnCall requires an active worker
      await sandbox.execute(agentId, 'return 1', 5000)

      const result = await sandbox.executeFnCall(
        agentId,
        'call_test_drain',
        'setTimeout(() => console.log("fn-tick"), 10); return "ok"',
        {}
      )

      expect(result.error).toBeUndefined()
      expect(result.result).toBe('ok')
      expect(result.stdout).toContain('fn-tick')
    } finally {
      sandbox.destroy(agentId)
    }
  })
})

describe('CodeSandboxService expression auto-result', () => {
  it('reports the value of a single-expression program', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-expr-result'

    try {
      const result = await sandbox.execute(agentId, '1 + 2', 5000)
      expect(result.error).toBeUndefined()
      expect(result.result).toBe('3')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('awaits a top-level-await expression and reports its value', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-expr-await'

    try {
      const result = await sandbox.execute(agentId, 'await Promise.resolve("hello")', 5000)
      expect(result.error).toBeUndefined()
      expect(result.result).toBe('hello')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('awaits an unawaited adf.* expression so node -e "adf.x()" is not mute', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-expr-adf'

    const onAdfCall = async (method: string): Promise<AdfCallResult> => ({
      result: JSON.stringify({ tool: method, items: [1, 2] })
    })

    try {
      const result = await sandbox.execute(agentId, 'adf.fs_list({})', 5000, onAdfCall)
      expect(result.error).toBeUndefined()
      expect(result.result).toContain('fs_list')
      expect(result.result).toContain('"items"')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('keeps statement semantics for multi-statement code (result stays undefined without return)', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-stmt-semantics'

    try {
      const result = await sandbox.execute(agentId, 'const x = 5; console.log("x is", x)', 5000)
      expect(result.error).toBeUndefined()
      expect(result.result).toBeUndefined()
      expect(result.stdout).toContain('x is 5')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('still supports explicit return statements', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-explicit-return'

    try {
      const result = await sandbox.execute(agentId, 'return 40 + 2', 5000)
      expect(result.error).toBeUndefined()
      expect(result.result).toBe('42')
    } finally {
      sandbox.destroy(agentId)
    }
  })
})

describe('CodeSandboxService require stub', () => {
  it('throws an actionable error pointing at import instead of a bare ReferenceError', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-require-stub'

    try {
      const result = await sandbox.execute(
        agentId,
        'try { require("crypto"); return "allowed" } catch (e) { return "err: " + e.message }',
        5000
      )

      expect(result.error).toBeUndefined()
      expect(result.result).toMatch(/^err: /)
      expect(result.result).toContain('require is not available')
      expect(result.result).toContain('use import (top-level) instead')
    } finally {
      sandbox.destroy(agentId)
    }
  })

  it('stubs require in the fn_exec (sys_lambda) context too', async () => {
    const sandbox = new CodeSandboxService()
    const agentId = 'test-require-stub-fn'

    try {
      await sandbox.execute(agentId, 'return 1', 5000)
      const result = await sandbox.executeFnCall(
        agentId,
        'call_test_require',
        'try { require("fs"); return "allowed" } catch (e) { return e.message }',
        {}
      )

      expect(result.error).toBeUndefined()
      expect(result.result).toContain('require is not available')
    } finally {
      sandbox.destroy(agentId)
    }
  })
})
