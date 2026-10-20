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
  updateFileEntry: (filePath: string, updates: Partial<Pick<TrackedDirEntry, 'canReceive' | 'sendMode' | 'autonomous' | 'agentName' | 'pendingName' | 'reviewed'>>) => void
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
      // Nested folders too: an agent in a subfolder is a child entry.
      const patch = (files: TrackedDirEntry[]): TrackedDirEntry[] => {
        let local = false
        const next = files.map((f) => {
          if (f.isDirectory) {
            const children = f.children ? patch(f.children) : f.children
            if (children === f.children) return f
            local = true
            return { ...f, children }
          }
          if (f.filePath !== filePath) return f
          // Only spread if a value actually differs
          const needsUpdate = (Object.keys(updates) as Array<keyof typeof updates>).some(
            (key) => f[key] !== updates[key]
          )
          if (!needsUpdate) return f
          local = true
          return { ...f, ...updates }
        })
        if (local) changed = true
        return local ? next : files
      }
      const updated: Record<string, TrackedDirEntry[]> = {}
      for (const [dir, files] of Object.entries(s.filesByDir)) updated[dir] = patch(files)
      return changed ? { filesByDir: updated } : {}
    })
}))
