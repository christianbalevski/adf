import { create } from 'zustand'

interface DocumentState {
  documentContent: string
  mindContent: string
  isDirty: boolean
  filePath: string | null
  fileName: string | null
  draftInputs: Record<string, string>

  setDocumentContent: (content: string) => void
  setMindContent: (content: string) => void
  setFilePath: (path: string | null) => void
  setDirty: (dirty: boolean) => void
  setDraftInput: (filePath: string, value: string) => void
  reset: () => void
}

export const useDocumentStore = create<DocumentState>((set) => ({
  documentContent: '',
  mindContent: '',
  isDirty: false,
  filePath: null,
  fileName: null,
  draftInputs: {},

  setDocumentContent: (content) =>
    set({ documentContent: content, isDirty: true }),
  setMindContent: (content) => set({ mindContent: content }),
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
  reset: () =>
    set({
      documentContent: '',
      mindContent: '',
      isDirty: false,
      filePath: null,
      fileName: null,
      draftInputs: {}
    })
}))
