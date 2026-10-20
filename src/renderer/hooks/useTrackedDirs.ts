import { useEffect, useMemo } from 'react'
import { useTrackedDirsStore, selectTrackedSlice } from '../stores/tracked-dirs.store'
import { apiFor } from '../utils/runtime-api'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'

/**
 * The tracked folders of one runtime (docs/design/multi-runtime.md §5.4):
 * This computer when `runtimeId` is omitted, as before.
 */
export function trackedDirsActions(runtimeId?: RuntimeId) {
  const store = () => useTrackedDirsStore.getState()
  const rt = runtimeId && runtimeId !== LOCAL_RUNTIME ? runtimeId : undefined
  const api = () => apiFor(rt)

  const scanAll = async (directories: string[]) => {
    await Promise.all(
      directories.map(async (dirPath) => {
        const { files } = await api().scanTrackedDirectory(dirPath)
        store().setFilesForDir(dirPath, files, rt)
      })
    )
  }

  const loadDirectories = async () => {
    const { directories } = await api().getTrackedDirectories()
    store().setDirectories(directories, rt)
    await scanAll(directories)
  }

  const addDirectory = async () => {
    const { directories } = await api().addTrackedDirectory()
    store().setDirectories(directories, rt)
    await scanAll(directories)
  }

  const removeDirectory = async (dirPath: string) => {
    await api().removeTrackedDirectory(dirPath)
    store().removeDir(dirPath, rt)
  }

  const rescanDirectory = async (dirPath: string) => {
    const { files } = await api().scanTrackedDirectory(dirPath)
    store().setFilesForDir(dirPath, files, rt)
  }

  /** TRACKED_DIRS_CHANGED of this runtime: rescan that folder (and the list, for a folder not tracked yet). */
  const onChanged = async (dirPath: string) => {
    // If this directory isn't tracked yet (e.g. auto-tracked by FILE_CREATE),
    // refresh the full directory list so the sidebar picks it up
    const current = selectTrackedSlice(store(), rt).directories
    if (!current.includes(dirPath)) {
      const { directories } = await api().getTrackedDirectories()
      store().setDirectories(directories, rt)
    }
    await rescanDirectory(dirPath)
  }

  return { loadDirectories, addDirectory, removeDirectory, rescanDirectory, onChanged }
}

export function useTrackedDirs(runtimeId?: RuntimeId) {
  const { loadDirectories, addDirectory, removeDirectory, rescanDirectory } = useMemo(() => trackedDirsActions(runtimeId), [runtimeId])
  return { loadDirectories, addDirectory, removeDirectory, rescanDirectory }
}

export function useAutoRefresh() {
  useEffect(() => {
    const { onChanged } = trackedDirsActions()
    const unsubscribe = window.adfApi.onTrackedDirsChanged(async ({ dirPath }) => {
      await onChanged(dirPath)
    })
    return unsubscribe
  }, [])
}
