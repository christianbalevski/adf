import { useEffect } from 'react'
import { useTrackedDirsStore } from '../stores/tracked-dirs.store'

export function useTrackedDirs() {
  const setDirectories = useTrackedDirsStore((s) => s.setDirectories)
  const setFilesForDir = useTrackedDirsStore((s) => s.setFilesForDir)
  const removeDir = useTrackedDirsStore((s) => s.removeDir)

  const loadDirectories = async () => {
    const { directories } = await window.adfApi.getTrackedDirectories()
    setDirectories(directories)
    await Promise.all(
      directories.map(async (dirPath) => {
        const { files } = await window.adfApi.scanTrackedDirectory(dirPath)
        setFilesForDir(dirPath, files)
      })
    )
  }

  const addDirectory = async () => {
    const { directories } = await window.adfApi.addTrackedDirectory()
    setDirectories(directories)
    await Promise.all(
      directories.map(async (dirPath) => {
        const { files } = await window.adfApi.scanTrackedDirectory(dirPath)
        setFilesForDir(dirPath, files)
      })
    )
  }

  const removeDirectory = async (dirPath: string) => {
    await window.adfApi.removeTrackedDirectory(dirPath)
    removeDir(dirPath)
  }

  const rescanDirectory = async (dirPath: string) => {
    const { files } = await window.adfApi.scanTrackedDirectory(dirPath)
    setFilesForDir(dirPath, files)
  }

  return { loadDirectories, addDirectory, removeDirectory, rescanDirectory }
}

export function useAutoRefresh() {
  const setDirectories = useTrackedDirsStore((s) => s.setDirectories)
  const setFilesForDir = useTrackedDirsStore((s) => s.setFilesForDir)

  useEffect(() => {
    const unsubscribe = window.adfApi.onTrackedDirsChanged(async ({ dirPath }) => {
      // If this directory isn't tracked yet (e.g. auto-tracked by FILE_CREATE),
      // refresh the full directory list so the sidebar picks it up
      const current = useTrackedDirsStore.getState().directories
      if (!current.includes(dirPath)) {
        const { directories } = await window.adfApi.getTrackedDirectories()
        setDirectories(directories)
      }
      const { files } = await window.adfApi.scanTrackedDirectory(dirPath)
      setFilesForDir(dirPath, files)
    })
    return unsubscribe
  }, [])
}
