import { create } from 'zustand'
import type { TrackedDirEntry } from '../../shared/types/ipc.types'

interface TrackedDirsState {
  directories: string[]
  filesByDir: Record<string, TrackedDirEntry[]>
  activeDir: string | null

  setDirectories: (directories: string[]) => void
  setFilesForDir: (dirPath: string, files: TrackedDirEntry[]) => void
  setActiveDir: (dirPath: string | null) => void
  removeDir: (dirPath: string) => void
  updateFileEntry: (filePath: string, updates: Partial<Pick<TrackedDirEntry, 'canReceive' | 'sendMode' | 'autonomous'>>) => void
}

export const useTrackedDirsStore = create<TrackedDirsState>((set) => ({
  directories: [],
  filesByDir: {},
  activeDir: null,

  setDirectories: (directories) => set({ directories }),
  setFilesForDir: (dirPath, files) =>
    set((s) => ({ filesByDir: { ...s.filesByDir, [dirPath]: files } })),
  setActiveDir: (dirPath) => set({ activeDir: dirPath }),
  removeDir: (dirPath) =>
    set((s) => {
      const { [dirPath]: _, ...rest } = s.filesByDir
      return {
        directories: s.directories.filter((d) => d !== dirPath),
        filesByDir: rest,
        activeDir: s.activeDir === dirPath ? null : s.activeDir
      }
    }),
  updateFileEntry: (filePath, updates) =>
    set((s) => {
      let changed = false
      const updated: Record<string, TrackedDirEntry[]> = {}
      for (const [dir, files] of Object.entries(s.filesByDir)) {
        const newFiles = files.map((f) => {
          if (f.filePath !== filePath) return f
          // Only spread if a value actually differs
          const needsUpdate = Object.entries(updates).some(
            ([k, v]) => (f as Record<string, unknown>)[k] !== v
          )
          if (!needsUpdate) return f
          changed = true
          return { ...f, ...updates }
        })
        updated[dir] = newFiles
      }
      return changed ? { filesByDir: updated } : {}
    })
}))
