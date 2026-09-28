// src/main/tui is an ES module scope (its package.json says so, because ink is
// ESM with top-level await), while the rest of src/main runs as CommonJS under
// tsx. Node cannot see named exports through tsx's CJS output, so VALUE
// imports from outside src/main/tui go through a namespace import + this shim:
//
//   import * as loopParserNs from '../../shared/utils/loop-parser'
//   const { parseLoopToDisplay } = cjs(loopParserNs)
//
// Under vitest (pure ESM) the namespace already has the names; under tsx they
// live on `default` (= module.exports). Type-only imports need nothing.

export function cjs<T extends object>(namespace: T): T {
  const exports = (namespace as { default?: unknown }).default
  if (!exports || typeof exports !== 'object') return namespace
  return Object.assign({}, exports, namespace) as T
}
