/**
 * W3-F: what Studio main answers the renderer for a save that someone else's
 * write overtook, in both backends. The renderer's editors save with the
 * revision they last saw (preload `{ baseRevision }`); a stale one answers
 * `{ success: false, error, conflict }` instead of `{ success: true, revision }`,
 * and the editor offers Reload (their text) or Keep mine (the save again with
 * `conflict.revision` as its base). A save without a base never conflicts.
 *
 * `conflict.content` / `conflict.config` carry what is there now, so the
 * renderer can show it, reload it, and tell a real conflict from a revision
 * that only moved (the content it based its edit on is still current: it
 * saves again without asking).
 */
import type { ResourceConflict, ResourceWriter } from '../../shared/types/resource-revision.types'
import { describeWriter } from '../../shared/types/resource-revision.types'

/** Embedded Studio's writer: its own window. */
export const STUDIO_WRITER: ResourceWriter = Object.freeze({ kind: 'client', client: 'studio' }) as ResourceWriter

/** The renderer's base revision from an IPC argument (absent or not a number: none). */
export function baseRevisionArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export interface ConflictAnswer {
  success: false
  error: string
  conflict: ResourceConflict
}

/** The renderer's answer for a refused save. */
export function conflictAnswer(conflict: ResourceConflict): ConflictAnswer {
  const what = conflict.resource === 'config' ? 'The config' : conflict.resource === 'document' ? 'The document' : conflict.resource
  return {
    success: false,
    error: `${what} changed (by ${describeWriter(conflict.writer)}) since you loaded it. Reload it, or keep your version.`,
    conflict,
  }
}
