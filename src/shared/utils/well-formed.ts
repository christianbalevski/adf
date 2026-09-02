/**
 * UTF-16 well-formedness helpers.
 *
 * JS strings are UTF-16 and `String#slice` cuts at code-unit offsets, so any
 * fixed-length truncation (`text.slice(0, 200)`) can split an emoji / astral
 * character in half and leave a lone surrogate behind. JSON.stringify emits it
 * as a `\ud83d` escape, which strict JSON parsers reject — the ChatGPT codex
 * backend answers such a body with an opaque `400 {"detail":"Bad Request"}`.
 * Every string that reaches a provider request must therefore be well-formed.
 */

// High surrogate not followed by a low one, or low surrogate not preceded by a high one.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** True when the string contains at least one lone surrogate. */
export function hasLoneSurrogate(s: string): boolean {
  LONE_SURROGATE_RE.lastIndex = 0
  return LONE_SURROGATE_RE.test(s)
}

/** Replace every lone surrogate with U+FFFD (same contract as ES2024 `toWellFormed`). */
export function toWellFormed(s: string): string {
  const native = (s as { toWellFormed?: () => string }).toWellFormed
  if (typeof native === 'function') return native.call(s)
  return s.replace(LONE_SURROGATE_RE, '�')
}

/**
 * `String#slice` that never splits a surrogate pair: a dangling half at either
 * cut edge is dropped. Interior lone surrogates are left untouched (they were
 * already in the source; use `toWellFormed` for those).
 */
export function sliceWellFormed(s: string, start: number, end?: number): string {
  let out = s.slice(start, end)
  if (out.length === 0) return out
  const first = out.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1)
  if (out.length === 0) return out
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/**
 * Walk a JSON-shaped value and repair every string in place (objects and
 * arrays are mutated). Returns how many strings were changed. Primitive input
 * is returned untouched — the caller must use the return value only as a count.
 */
export function repairStringsDeep(value: unknown): number {
  let repaired = 0
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (!hasLoneSurrogate(node)) return node
      repaired++
      return toWellFormed(node)
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = visit(node[i])
      return node
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      for (const key of Object.keys(obj)) obj[key] = visit(obj[key])
      return node
    }
    return node
  }
  visit(value)
  return repaired
}
