import { describe, it, expect } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

describe('CodeSandboxService', () => {
  describe('environment isolation', () => {
    it('should not expose host process.env to sandbox code', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-env-isolation'

      try {
        // HOST has env vars (PATH, HOME, etc. are always present)
        expect(Object.keys(process.env).length).toBeGreaterThan(0)

        // Sandbox should NOT see them
        const result = await sandbox.execute(
          agentId,
          'JSON.stringify(Object.keys(process.env))',
          5000
        )

        expect(result.error).toBeUndefined()
        const keys = JSON.parse(result.result || '[]')
        expect(keys).not.toContain('HOME')
        expect(keys).not.toContain('PATH')
        expect(keys).not.toContain('USER')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should allow runtime-injected env vars', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-env-injection'

      try {
        // Simulate what code.ts does: prepend env var assignments
        const code = 'process.env["AGENT_NAME"] = "test-agent"; return process.env.AGENT_NAME'
        const result = await sandbox.execute(agentId, code, 5000)

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('test-agent')
      } finally {
        sandbox.destroy(agentId)
      }
    })
  })

  describe('prototype pollution protection', () => {
    it('should freeze Object.prototype in sandbox context', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-proto-freeze'

      try {
        const result = await sandbox.execute(
          agentId,
          'return String(Object.isFrozen(Object.prototype))',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('true')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should silently reject Object.prototype mutation', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-proto-mutation'

      try {
        // Attempt to pollute, then verify it didn't stick
        const result = await sandbox.execute(
          agentId,
          'Object.prototype.polluted = 42; return String(({}).polluted)',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('undefined')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should silently reject Array.prototype mutation', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-array-proto'

      try {
        const result = await sandbox.execute(
          agentId,
          'Array.prototype.evil = "yes"; return String([].evil)',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('undefined')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should prevent cross-execution prototype pollution', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-proto-cross'

      try {
        // First execution: attempt mutation
        await sandbox.execute(agentId, 'Object.prototype.leaked = "yes"', 5000)

        // Second execution on same sandbox: verify it didn't persist
        const result = await sandbox.execute(
          agentId,
          'return String(({}).leaked)',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('undefined')
      } finally {
        sandbox.destroy(agentId)
      }
    })
  })

  describe('module restrictions', () => {
    it('should block os module', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-os-blocked'

      try {
        const result = await sandbox.execute(
          agentId,
          'try { const os = __require("os"); return "allowed"; } catch (e) { return "blocked: " + e.message; }',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toMatch(/^blocked:/)
        expect(result.result).toContain('not available')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should still allow safe modules like crypto', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-crypto-allowed'

      try {
        const result = await sandbox.execute(
          agentId,
          'const crypto = __require("crypto"); return typeof crypto.randomUUID',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('function')
      } finally {
        sandbox.destroy(agentId)
      }
    })
  })
})
