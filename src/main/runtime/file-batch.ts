/**
 * The wire form of an atomic multi-file write (AdfWorkspace.writeFilesAtomic),
 * shared by the daemon route (POST /agents/:id/files/batch) and Studio's
 * embedded DOC_WRITE_INTERNAL_FILES handler, so both decode, bound and refuse
 * a batch the same way.
 */
import {
  AtomicBatchError,
  type AtomicFileWrite,
  type AdfWorkspace,
} from '../adf/adf-workspace'
import { FILE_BATCH_MAX_BYTES, FILE_BATCH_MAX_FILES, type InternalFileBatchInput } from '../../shared/types/file-batch.types'
import { fileRevision, type ResourceWriter } from './resource-revisions'


export interface AgentFileBatchResult {
  agentId: string
  success: true
  /** The revision each written path has now. */
  revisions: Record<string, number>
}

/**
 * HTTP body bound for a batch: the content cap as base64 (4/3), plus room for
 * paths and JSON framing of every file.
 */
export const FILE_BATCH_BODY_LIMIT = Math.ceil(FILE_BATCH_MAX_BYTES * 4 / 3) + FILE_BATCH_MAX_FILES * 2048 + 64 * 1024

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Decode a client batch into workspace writes: text or base64 bytes, nothing
 * else. Bounds and preconditions are decided once, by writeFilesAtomic.
 */
export function decodeAgentFileBatch(input: unknown): AtomicFileWrite[] {
  if (!Array.isArray(input)) throw new AtomicBatchError('files must be an array.', 'invalid_request')
  return input.map((raw): AtomicFileWrite => {
    const file = (raw ?? {}) as InternalFileBatchInput
    const path = typeof file.path === 'string' ? file.path : ''
    let content: Buffer
    if (typeof file.contentBase64 === 'string' && typeof file.content !== 'string') {
      if (file.contentBase64.length % 4 !== 0 || !BASE64.test(file.contentBase64)) {
        throw new AtomicBatchError(`"${path}" contentBase64 is not base64.`, 'invalid_request', path)
      }
      content = Buffer.from(file.contentBase64, 'base64')
    } else if (typeof file.content === 'string' && typeof file.contentBase64 !== 'string') {
      content = Buffer.from(file.content, 'utf-8')
    } else {
      throw new AtomicBatchError(`"${path}" needs exactly one of content or contentBase64.`, 'invalid_request', path)
    }
    // The precondition is passed as sent: validateAtomicBatch (inside writeFilesAtomic) decides it.
    const expect = { mustNotExist: file.mustNotExist, baseRevision: file.baseRevision } as AtomicFileWrite['expect']
    return { path, content, ...(typeof file.mimeType === 'string' ? { mimeType: file.mimeType } : {}), expect }
  })
}

/** How a refused batch answers over HTTP; null for an error that is not a refusal. */
export function atomicBatchFailure(err: unknown): { status: 400 | 403 | 409; code: string; message: string; details: Record<string, unknown> } | null {
  if (!(err instanceof AtomicBatchError)) return null
  const details = { ...(err.details ?? {}), ...(err.path ? { path: err.path } : {}) }
  switch (err.code) {
    case 'stale_revision': return { status: 409, code: 'stale_revision', message: err.message, details }
    case 'protected': return { status: 403, code: 'file_protected', message: err.message, details }
    case 'payload_too_large': return { status: 400, code: 'payload_too_large', message: err.message, details }
    default: return { status: 400, code: 'bad_request', message: err.message, details }
  }
}

/**
 * Decode a client batch, commit it to `workspace` inside `run` (the caller's
 * writer/source context), and answer the revision each path has now. Shared by
 * the daemon route (RuntimeService.writeAgentFiles) and Studio's embedded
 * DOC_WRITE_INTERNAL_FILES handler. Throws AtomicBatchError for a refusal.
 */
export function commitFileBatch(workspace: AdfWorkspace, input: unknown, writer: ResourceWriter, run: (commit: () => void) => void): Record<string, number> {
  const batch = decodeAgentFileBatch(input)
  run(() => workspace.writeFilesAtomic(batch))
  return Object.fromEntries(batch.map((file) => [file.path, fileRevision(workspace, file.path, writer).revision]))
}
