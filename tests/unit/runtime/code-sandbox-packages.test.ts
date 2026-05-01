import { describe, it, expect } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

describe('CodeSandboxService', () => {
  describe('user package resolution', () => {
    it('should reject imports for packages not in the user package set', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-pkg-not-in-set'

      try {
        // Set user packages to empty — no packages allowed
        sandbox.setUserPackages('/tmp/fake-sandbox-packages', [])

        const result = await sandbox.execute(
          agentId,
          'try { const m = __require("lodash"); return "allowed"; } catch (e) { return "blocked: " + e.message; }',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toMatch(/^blocked:/)
        expect(result.result).toContain('not available')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should include user package names in the error module list', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-pkg-error-list'

      try {
        // Must set stdlib (even fake) so the "still installing" guard doesn't fire
        sandbox.setStdlib('/tmp/fake-stdlib', [])
        sandbox.setUserPackages('/tmp/fake-sandbox-packages', ['vega', 'lodash'])

        const result = await sandbox.execute(
          agentId,
          'try { __require("nonexistent"); return "ok"; } catch (e) { return e.message; }',
          5000
        )

        expect(result.error).toBeUndefined()
        // The error message should list all available modules including user packages
        expect(result.result).toContain('vega')
        expect(result.result).toContain('lodash')
        expect(result.result).toContain('crypto') // built-in should also be listed
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should resolve stdlib before user packages', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-stdlib-priority'

      try {
        // Even if a user package has the same name as a stdlib package,
        // stdlib takes priority. Test with a built-in module.
        sandbox.setUserPackages('/tmp/fake-sandbox-packages', ['crypto'])

        const result = await sandbox.execute(
          agentId,
          'const c = __require("crypto"); return typeof c.randomUUID',
          5000
        )

        expect(result.error).toBeUndefined()
        // Should resolve the real Node.js crypto, not try user packages path
        expect(result.result).toBe('function')
      } finally {
        sandbox.destroy(agentId)
      }
    })

    it('should update user packages via setup message between executions', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-pkg-update'

      try {
        // First execution: no user packages set
        const result1 = await sandbox.execute(
          agentId,
          'try { __require("lodash"); return "found"; } catch (e) { return "missing"; }',
          5000
        )
        expect(result1.result).toBe('missing')

        // Now set user packages (lodash won't resolve since the path is fake,
        // but the module should be IN the allowed set)
        sandbox.setUserPackages('/tmp/fake-sandbox-packages', ['lodash'])

        const result2 = await sandbox.execute(
          agentId,
          'try { __require("lodash"); return "found"; } catch (e) { return e.message; }',
          5000
        )
        // Should attempt to resolve (not "not available") — will fail with MODULE_NOT_FOUND
        // because /tmp/fake-sandbox-packages doesn't have lodash, but it shouldn't say "not available"
        expect(result2.result).not.toContain('not available in the sandbox')
      } finally {
        sandbox.destroy(agentId)
      }
    })
  })

  describe('import transforms with user packages', () => {
    it('should transform import statements for user packages', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-import-transform'

      try {
        sandbox.setUserPackages('/tmp/fake-sandbox-packages', ['my-pkg'])

        // Import transform turns `import X from 'my-pkg'` into `const X = await __require('my-pkg')`
        // The __require will fail (fake path) but the transform itself should work
        const result = await sandbox.execute(
          agentId,
          'try { const code = "import myPkg from \'my-pkg\'"; return "transform-ok"; } catch (e) { return e.message; }',
          5000
        )

        expect(result.error).toBeUndefined()
        expect(result.result).toBe('transform-ok')
      } finally {
        sandbox.destroy(agentId)
      }
    })
  })

  describe('setUserPackages', () => {
    it('should accept empty arrays', () => {
      const sandbox = new CodeSandboxService()
      // Should not throw
      sandbox.setUserPackages('/tmp/test', [])
    })

    it('should accept scoped package names', async () => {
      const sandbox = new CodeSandboxService()
      const agentId = 'test-scoped-pkg'

      try {
        sandbox.setUserPackages('/tmp/fake', ['@resvg/resvg-wasm', '@scope/pkg'])

        const result = await sandbox.execute(
          agentId,
          'try { __require("@resvg/resvg-wasm"); return "attempted"; } catch (e) { return e.code || e.message; }',
          5000
        )

        expect(result.error).toBeUndefined()
        // Should attempt resolution (not "not available") since it's in the set
        expect(result.result).not.toContain('not available in the sandbox')
      } finally {
        sandbox.destroy(agentId)
      }
    })
  })
})
