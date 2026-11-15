/** Most files one atomic multi-file write may carry. Package bounds derive from it. */
export const FILE_BATCH_MAX_FILES = 256
/** Most content bytes (decoded) one atomic multi-file write may carry, all files together. */
export const FILE_BATCH_MAX_BYTES = 8 * 1024 * 1024

/**
 * The batch's bounds, as an early stop before anything is fetched or sent
 * (discovery from tree sizes, the read protocol's running total). The batch
 * itself (validateAtomicBatch) remains the authority.
 */
export function batchBoundsProblem(files: number, bytes: number): string | null {
  if (files > FILE_BATCH_MAX_FILES) return `${files} files (at most ${FILE_BATCH_MAX_FILES}, SKILL.md and license files included)`
  if (bytes > FILE_BATCH_MAX_BYTES) return `${bytes} bytes in all (at most ${FILE_BATCH_MAX_BYTES})`
  return null
}

/**
 * An ADF runtime without the batch route (an older daemon) or without import
 * decisions on its package answers: refused in these words, never written
 * another way (there is no non-atomic fallback).
 */
export const RUNTIME_PREDATES_ATOMIC_INSTALLS = 'This ADF runtime predates atomic skill installs; update it.'
/** The `code` a host answers for such a runtime. */
export const RUNTIME_OUTDATED_CODE = 'runtime_outdated'

/**
 * A daemon's answer to POST /agents/:id/files/batch that means the route does
 * not exist there (an older daemon): a 404 in the HTTP framework's error
 * envelope (`{ statusCode, error, message }`), which carries its text in
 * `message`. The daemon's own 404s (an unknown agent included) carry theirs in
 * `error` and never have a `message`. Keyed on that shape, not on the
 * framework's wording; `code` cannot tell them apart (the daemon adds
 * `code: 'not_found'` to every 404 it sends, the framework's too).
 */
export function isMissingBatchRoute(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown } | null
  if (e?.status !== 404 || !e.body || typeof e.body !== 'object') return false
  return typeof (e.body as { message?: unknown }).message === 'string'
}
