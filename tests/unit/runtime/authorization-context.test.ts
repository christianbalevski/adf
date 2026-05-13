/**
 * Regression coverage for the authorization-context plumbing.
 *
 * The shipped bug: AdfCallHandler stored authorization on a single mutable
 * field. A trigger lambda fired from an authorized file would set it to true,
 * but any nested sys_lambda or concurrent sys_code call would clobber it back
 * to false (or to the inner file's auth) and never restore it. The outer
 * authorized lambda's later `task_resolve` then failed with
 * REQUIRES_AUTHORIZED_CODE despite running from an authorized file.
 *
 * These tests pin the ALS-based fix so a future refactor can't regress the
 * scoping rules silently.
 */

import { describe, expect, it } from 'vitest'
import { withAuthorization, currentAuthorization } from '../../../src/main/runtime/authorization-context'

describe('authorization-context', () => {
  it('returns undefined outside any withAuthorization scope', () => {
    expect(currentAuthorization()).toBeUndefined()
  })

  it('exposes the wrapped value inside the callback', () => {
    withAuthorization(true, () => {
      expect(currentAuthorization()).toBe(true)
    })
    withAuthorization(false, () => {
      expect(currentAuthorization()).toBe(false)
    })
  })

  it('preserves the value across async boundaries inside the callback', async () => {
    await withAuthorization(true, async () => {
      expect(currentAuthorization()).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 1))
      expect(currentAuthorization()).toBe(true)
    })
  })

  it('innermost wins for nested calls — and the inner scope does NOT leak back to the outer', () => {
    withAuthorization(true, () => {
      expect(currentAuthorization()).toBe(true)
      withAuthorization(false, () => {
        expect(currentAuthorization()).toBe(false)
      })
      // The original bug shape: after a nested unauthorized call returns,
      // the outer authorized scope must still be authorized.
      expect(currentAuthorization()).toBe(true)
    })
  })

  it('keeps two parallel async scopes isolated', async () => {
    // Models the parallel-trigger race: an authorized lambda and an
    // unauthorized lambda dispatched in the same tick must not see each
    // other's authorization flag through a shared mutable field.
    const authorized = withAuthorization(true, async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return currentAuthorization()
    })
    const unauthorized = withAuthorization(false, async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return currentAuthorization()
    })

    expect(await authorized).toBe(true)
    expect(await unauthorized).toBe(false)
  })

  it('returns the callback result so callers can chain through', () => {
    const result = withAuthorization(true, () => 42)
    expect(result).toBe(42)
  })
})
