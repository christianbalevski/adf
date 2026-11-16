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
