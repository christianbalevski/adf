/**
 * Authorization context — AsyncLocalStorage-backed per-call authorization flag.
 *
 * Each entry point that runs sandbox code (system-scope trigger lambdas,
 * sys_lambda, sys_code, middleware, taps, runtime resolveTask) wraps its
 * onAdfCall closure in `withAuthorization(authorized, ...)`. AdfCallHandler
 * reads the value via `currentAuthorization()` so authorization travels with
 * the call rather than living on a shared mutable field.
 *
 * Why ALS instead of a single mutable flag: parallel sandboxes and nested
 * sys_lambda calls used to clobber each other's authorization state — an
 * authorized outer lambda would lose its privileges after invoking an
 * unauthorized inner lambda, and a concurrent sys_code call from the LLM loop
 * would flip the flag to false mid-execution. Per-async-context storage scopes
 * authorization to the call that established it.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

interface AuthorizationContext {
  authorized: boolean
}

const store = new AsyncLocalStorage<AuthorizationContext>()

/**
 * Run `fn` with the given authorization flag in scope. Nested calls override.
 * Returns `fn`'s result so callers can chain through directly.
 */
export function withAuthorization<T>(authorized: boolean, fn: () => T): T {
  return store.run({ authorized }, fn)
}

/**
 * Read the current authorization flag, or undefined if no withAuthorization()
 * scope is active. Callers should fall back to whatever default is appropriate
 * (typically `false`).
 */
export function currentAuthorization(): boolean | undefined {
  return store.getStore()?.authorized
}
