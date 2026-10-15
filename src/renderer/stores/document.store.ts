import { create } from 'zustand'
import type { ResourceWriter } from '../../shared/types/resource-revision.types'

interface DocumentState {
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
  fileName: string | null
  draftInputs: Record<string, string>

  /** `meta` (W3-F): the revision and writer that came with this content; without it they stay. */
  setDocumentContent: (content: string, meta?: { revision?: number; writer?: ResourceWriter | null }) => void
  setFilePath: (path: string | null) => void
  setDirty: (dirty: boolean) => void
  setDraftInput: (filePath: string, value: string) => void
  removeDraftInput: (filePath: string) => void
  reset: () => void
}

export const useDocumentStore = create<DocumentState>((set) => ({
  documentContent: '',
  isDirty: false,
  filePath: null,
  fileName: null,
  draftInputs: {},

  setDocumentContent: (content, meta) =>
    set(meta ? { documentContent: content, isDirty: true, documentRevision: meta.revision, documentWriter: meta.writer ?? null } : { documentContent: content, isDirty: true }),
  setFilePath: (path) =>
    set({
      filePath: path,
      fileName: path
        ? path.split('/').pop()?.replace('.adf', '') ?? null
        : null
    }),
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
  reset: () =>
    set({
      documentContent: '',
      documentRevision: undefined,
      documentWriter: undefined,
      isDirty: false,
      filePath: null,
      fileName: null,
      draftInputs: {}
    })
}))
