import { create } from 'zustand'
import type { ResourceWriter } from '../../shared/types/resource-revision.types'
import type { RuntimeId } from '../../shared/runtime-tag'
import { windowRuntime } from '../utils/window-kind'
import type { SelectionComment } from '../utils/selection-comment'

interface DocumentState {
  /** Distinguishes successive opens, including A → B → A and reopening A. */
  viewGeneration: number
  documentContent: string
  /**
   * W3-F: the revision `documentContent` is and who wrote it, when the backend
   * said (the batch, a document read, document_updated). The README tab saves
   * over it and names the writer when a change overtakes unsaved text.
   */
  documentRevision?: number
  documentWriter?: ResourceWriter | null
  isDirty: boolean
  filePath: string | null
  /**
   * The runtime of the open agent (docs/design/multi-runtime.md §5.3): its
   * calls go to `apiFor(runtimeId)`. An agent window's is its own runtime;
   * the main window's moves with the agent it opens.
   */
  runtimeId: RuntimeId
  fileName: string | null
  draftInputs: Record<string, string>
  /** Comments on file selections waiting in an agent's composer, by agent key: part of its draft. */
  draftComments: Record<string, SelectionComment[]>

  /** `meta` (W3-F): the revision and writer that came with this content; without it they stay. */
  setDocumentContent: (content: string, meta?: { revision?: number; writer?: ResourceWriter | null }) => void
  /** `runtimeId`: the runtime of the agent at `path`; omitted, the open agent's runtime stays. */
  setFilePath: (path: string | null, runtimeId?: RuntimeId) => void
  setDirty: (dirty: boolean) => void
  setDraftInput: (filePath: string, value: string) => void
  removeDraftInput: (filePath: string) => void
  /** An agent's waiting comments; an empty list removes the entry. */
  setDraftComments: (key: string, comments: SelectionComment[]) => void
  reset: () => void
}

export const useDocumentStore = create<DocumentState>((set) => ({
  viewGeneration: 0,
  documentContent: '',
  isDirty: false,
  filePath: null,
  runtimeId: windowRuntime,
  fileName: null,
  draftInputs: {},
  draftComments: {},

  setDocumentContent: (content, meta) =>
    set(meta ? { documentContent: content, isDirty: true, documentRevision: meta.revision, documentWriter: meta.writer ?? null } : { documentContent: content, isDirty: true }),
  setFilePath: (path, runtimeId) =>
    set((s) => ({
      viewGeneration: s.viewGeneration + 1,
      filePath: path,
      ...(runtimeId ? { runtimeId } : {}),
      fileName: path
        ? path.split('/').pop()?.replace('.adf', '') ?? null
        : null
    })),
  setDirty: (dirty) => set({ isDirty: dirty }),
  setDraftInput: (filePath, value) =>
    set((s) => ({ draftInputs: { ...s.draftInputs, [filePath]: value } })),
  removeDraftInput: (filePath) =>
    set((s) => {
      if (!(filePath in s.draftInputs)) return s
      const next = { ...s.draftInputs }
      delete next[filePath]
      return { draftInputs: next }
    }),
  setDraftComments: (key, comments) =>
    set((s) => {
      const next = { ...s.draftComments }
      if (comments.length > 0) next[key] = comments
      else delete next[key]
      return { draftComments: next }
    }),
  reset: () =>
    set((s) => ({
      viewGeneration: s.viewGeneration + 1,
      documentContent: '',
      documentRevision: undefined,
      documentWriter: undefined,
      isDirty: false,
      filePath: null,
      runtimeId: windowRuntime,
      fileName: null,
      draftInputs: {},
      draftComments: {}
    }))
}))
