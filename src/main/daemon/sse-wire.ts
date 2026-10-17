// JSON for daemon SSE frames (`GET /events`, the client session stream).
//
// What the wire preserves, compared with Electron IPC (structured clone),
// which is what embedded Studio sends the renderer:
//
// - Plain objects, arrays, strings, finite numbers, booleans and null:
//   preserved exactly.
// - A property whose value is `undefined` (or a function or symbol) is
//   omitted, so the receiver reads it as `undefined`. A missing key MUST be
//   treated as equal to an `undefined` one: consumers and the parity
//   normalizer MUST NOT tell them apart (`'key' in obj`, `hasOwnProperty`).
//   Inside an array, `undefined` becomes `null`.
// - `NaN`, `Infinity` and `-Infinity` become `null`.
// - A `BigInt` becomes its decimal string (`10n` → `"10"`). IPC keeps a
//   BigInt; JSON.stringify would throw.
// - A reference cycle is cut: the repeated object becomes the string
//   `"[Circular]"`. IPC keeps the cycle; JSON.stringify would throw. An object
//   reached twice without a cycle is written twice, as JSON.stringify does.
// - `toJSON` is honoured: a `Date` becomes its ISO string, a Node `Buffer`
//   becomes `{ type: 'Buffer', data: [...] }`. IPC keeps both types.
// - Map, Set, typed arrays other than Buffer, and class instances become
//   plain objects of their own enumerable properties (`{}` for Map and Set);
//   an `Error` becomes `{}` plus its own enumerable properties (no message).
//   Executor events do not carry them.
//
// The serializer never throws: a value that fails even the tolerant pass (a
// throwing getter or toJSON) is written as `{"unserializable": "<reason>"}`.

/** JSON text for `value`; never throws (see the rules above). */
export function safeJsonStringify(value: unknown): string {
  try {
    // Fast path: everything the executor emits in practice.
    return JSON.stringify(value) ?? 'null'
  } catch {
    // A BigInt or a cycle somewhere; retry with the tolerant replacer.
  }
  try {
    return JSON.stringify(value, tolerantReplacer()) ?? 'null'
  } catch (err) {
    return JSON.stringify({ unserializable: err instanceof Error ? err.message : String(err) })
  }
}

/** JSON text for `value`, or the reason it cannot be written (a throwing getter or toJSON). Never throws. */
export function trySafeJsonStringify(value: unknown): { json: string } | { error: string } {
  try {
    return { json: JSON.stringify(value) ?? 'null' }
  } catch {
    // A BigInt or a cycle somewhere; retry with the tolerant replacer.
  }
  try {
    return { json: JSON.stringify(value, tolerantReplacer()) ?? 'null' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** BigInt → decimal string; an object already on the current path → "[Circular]". */
function tolerantReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  // Ancestors of the value being written: `this` is the holder of `value`,
  // so everything above the holder has been left and is popped.
  const path: object[] = []
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object' || value === null) return value
    while (path.length > 0 && path[path.length - 1] !== this) path.pop()
    if (path.includes(value)) return '[Circular]'
    path.push(value)
    return value
  }
}

/** A named control frame (`stream.hello`, `stream.gap`): no `id:` line, so the resume cursor is unchanged. */
export function sseControl(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${safeJsonStringify(data)}\n\n`
}

/**
 * One data frame. `body` is the frame's JSON object without its cursor (one
 * serialization shared by every session); the cursor is spliced in first.
 */
export function sseFrame(cursor: number, name: string, body: string): string {
  const rest = body.length > 2 ? `,${body.slice(1)}` : '}'
  return `id: ${cursor}\nevent: ${name}\ndata: {"cursor":${cursor}${rest}\n\n`
}
