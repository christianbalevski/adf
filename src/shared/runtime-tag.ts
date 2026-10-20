/**
 * The runtime tag of runtime-aware IPC (docs/design/multi-runtime.md §4.1).
 *
 * A runtime-scoped invoke, send or push names its runtime with
 * `{ $runtime: '<runtime id>' }` as its first argument. No tag means the
 * primary runtime: `local` (This computer). Traffic of the primary runtime
 * is never tagged, so a Studio with This computer only sends exactly the
 * bytes it sent before.
 *
 * Shared by main and preload; no Electron, no Node.
 */

/** `local`, `remote:<name>` (a saved connection) or `remote` (the slot of studio-backend.json). */
export type RuntimeId = string

export const LOCAL_RUNTIME: RuntimeId = 'local'

export interface RuntimeTag {
  $runtime: RuntimeId
}

/** A plain object with exactly the key `$runtime` and a string value. */
export function isRuntimeTag(value: unknown): value is RuntimeTag {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === '$runtime' && typeof (value as RuntimeTag).$runtime === 'string'
}

/** The tag for `id`, or null for the untagged runtime. */
export function runtimeTag(id: RuntimeId | null | undefined): RuntimeTag | null {
  return id && id !== LOCAL_RUNTIME ? { $runtime: id } : null
}

/** The arguments of a call without its tag, and the runtime the tag named (null: no tag). */
export function splitRuntimeTag<T extends unknown[]>(args: T): { runtimeId: RuntimeId | null; args: unknown[] } {
  if (args.length > 0 && isRuntimeTag(args[0])) return { runtimeId: args[0].$runtime, args: args.slice(1) }
  return { runtimeId: null, args }
}

/**
 * The key of a notification across runtimes (§6.1): the plain id for the
 * untagged runtime, `<runtime id>\n<id>` for any other, so equal ids on two
 * runtimes stay distinct.
 */
export function noticeKey(runtimeId: RuntimeId | null | undefined, id: string): string {
  return runtimeId && runtimeId !== LOCAL_RUNTIME ? `${runtimeId}\n${id}` : id
}

/** The refusals of §4.3. */
export const NO_RUNTIME_SENTENCE = 'This call has no runtime.'
export const CLOSED_WINDOW_SENTENCE = 'This agent window is closed.'
export function notConnectedSentence(id: RuntimeId): string {
  return `${id} is not connected.`
}
export function otherRuntimeSentence(name: string): string {
  return `This window shows an agent on ${name}.`
}
