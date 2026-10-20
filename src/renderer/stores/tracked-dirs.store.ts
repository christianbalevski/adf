import { create } from 'zustand'
import type { TrackedDirEntry } from '../../shared/types/ipc.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'

/** One runtime's tracked folders and their agents. */
export interface TrackedDirsSlice {
  directories: string[]
  filesByDir: Record<string, TrackedDirEntry[]>
}

type EntryUpdates = Partial<Pick<TrackedDirEntry, 'canReceive' | 'sendMode' | 'autonomous' | 'agentName' | 'pendingName' | 'reviewed'>>

/**
 * Tracked folders per runtime (docs/design/multi-runtime.md §5.3). The
 * top-level fields are This computer's slice (an agent window's: its own
 * runtime's), exactly as before; every other runtime of the set has a slice
 * in `byRuntime`. Every action takes an optional runtime id last; omitted,
 * it acts on the top-level slice.
 */
interface TrackedDirsState extends TrackedDirsSlice {
  activeDir: string | null
  /** Runtimes other than This computer. */
  byRuntime: Record<RuntimeId, TrackedDirsSlice>

  setDirectories: (directories: string[], runtimeId?: RuntimeId) => void
  setFilesForDir: (dirPath: string, files: TrackedDirEntry[], runtimeId?: RuntimeId) => void
  setActiveDir: (dirPath: string | null) => void
  removeDir: (dirPath: string, runtimeId?: RuntimeId) => void
  updateFileEntry: (filePath: string, updates: EntryUpdates, runtimeId?: RuntimeId) => void
  /** A runtime left the set: its slice goes. */
  dropRuntime: (runtimeId: RuntimeId) => void
}

const EMPTY_SLICE: TrackedDirsSlice = { directories: [], filesByDir: {} }

const isTop = (runtimeId?: RuntimeId | null): boolean => !runtimeId || runtimeId === LOCAL_RUNTIME

/** The slice of `runtimeId` (omitted or `local`: the top-level one). */
export function selectTrackedSlice(s: Pick<TrackedDirsState, 'directories' | 'filesByDir' | 'byRuntime'>, runtimeId?: RuntimeId | null): TrackedDirsSlice {
  if (isTop(runtimeId)) return s
  return s.byRuntime[runtimeId!] ?? EMPTY_SLICE
}

/** Apply `change` to one runtime's slice; the result is the state patch. */
function onSlice(s: TrackedDirsState, runtimeId: RuntimeId | undefined, change: (slice: TrackedDirsSlice) => Partial<TrackedDirsSlice> | null): Partial<TrackedDirsState> {
  if (isTop(runtimeId)) return change(s) ?? {}
  const slice = s.byRuntime[runtimeId!] ?? EMPTY_SLICE
  const patch = change(slice)
  if (!patch) return {}
  return { byRuntime: { ...s.byRuntime, [runtimeId!]: { directories: slice.directories, filesByDir: slice.filesByDir, ...patch } } }
}

export const useTrackedDirsStore = create<TrackedDirsState>((set) => ({
  directories: [],
  filesByDir: {},
  activeDir: null,
  byRuntime: {},

  setDirectories: (directories, runtimeId) => set((s) => onSlice(s, runtimeId, () => ({ directories }))),
  setFilesForDir: (dirPath, files, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (slice) => ({ filesByDir: { ...slice.filesByDir, [dirPath]: files } }))),
  setActiveDir: (dirPath) => set({ activeDir: dirPath }),
  removeDir: (dirPath, runtimeId) =>
    set((s) => {
      const patch = onSlice(s, runtimeId, (slice) => {
        const { [dirPath]: _, ...rest } = slice.filesByDir
        return { directories: slice.directories.filter((d) => d !== dirPath), filesByDir: rest }
      })
      return isTop(runtimeId) ? { ...patch, activeDir: s.activeDir === dirPath ? null : s.activeDir } : patch
    }),
  updateFileEntry: (filePath, updates, runtimeId) =>
    set((s) => onSlice(s, runtimeId, (slice) => {
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
      for (const [dir, files] of Object.entries(slice.filesByDir)) updated[dir] = patch(files)
      return changed ? { filesByDir: updated } : null
    })),
  dropRuntime: (runtimeId) =>
    set((s) => {
      if (isTop(runtimeId) || !(runtimeId in s.byRuntime)) return s
      const { [runtimeId]: _, ...rest } = s.byRuntime
      return { byRuntime: rest }
    }),
}))
