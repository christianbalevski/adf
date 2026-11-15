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
 * not exist there (an older daemon): the framework's 404, whose message is
 * `Route POST:<url> not found`, unlike the daemon's own 404 for an unknown
 * agent (`Unknown agent "<id>"`).
 */
export function isMissingBatchRoute(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown } | null
  const message = e?.body && typeof e.body === 'object' ? (e.body as { message?: unknown }).message : undefined
  return e?.status === 404 && typeof message === 'string' && /^Route POST:\S+ not found$/.test(message)
}

/**
 * One file of an atomic multi-file write of the open agent (preload
 * `writeInternalFiles`, IPC DOC_WRITE_INTERNAL_FILES, daemon
 * POST /agents/:id/files/batch). Exactly one of `content` / `contentBase64`,
 * and exactly one precondition: `mustNotExist` for a file that must not exist
 * yet, or the `baseRevision` the caller read it at.
 */
export interface InternalFileBatchInput {
  path: string
  content?: string
  contentBase64?: string
  mimeType?: string
  baseRevision?: number
  mustNotExist?: boolean
}

/**
 * What a batch answered. `success: false` was refused and wrote nothing.
 * `success: true` committed every file.
 */
export type InternalFileBatchResult =
  | { success: true; revisions: Record<string, number> }
  | { success: false; error: string; code?: string; path?: string; revision?: number; baseRevision?: number }
