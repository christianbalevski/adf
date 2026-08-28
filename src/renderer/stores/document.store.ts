import { create } from 'zustand'

interface DocumentState {
  documentContent: string
  isDirty: boolean
  filePath: string | null
  fileName: string | null
  draftInputs: Record<string, string>

  setDocumentContent: (content: string) => void
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

  setDocumentContent: (content) =>
    set({ documentContent: content, isDirty: true }),
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
      isDirty: false,
      filePath: null,
      fileName: null,
      draftInputs: {}
    })
}))
