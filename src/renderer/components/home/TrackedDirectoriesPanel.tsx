import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { CloneDialog } from '../common/CloneDialog'

/**
 * Tracked Directories file browser, shown at the bottom of the home screen.
 *
 * Restores the directory tree that briefly lived (and was removed) in
 * `WelcomeScreen` so the user can add directories and open .adf files
 * without diving into the Sidebar. Re-using the same data sources as the
 * Sidebar keeps the two views in sync via `useAutoRefresh()` (which is
 * already mounted by Sidebar; the panel here doesn't subscribe itself).
 */
export function TrackedDirectoriesPanel() {
  const { addDirectory, removeDirectory } = useTrackedDirs()
  const directories = useTrackedDirsStore((s) => s.directories)
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)
  const { openFile } = useAdfFile()

  return (
    <div className="w-full max-w-3xl mt-2 px-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 font-medium">
          Tracked directories
        </h3>
        <button
          onClick={addDirectory}
          className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
        >
          + Add Directory
        </button>
      </div>

      {directories.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500 text-center py-4 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-lg">
          Track a directory to see its .adf files here.
        </p>
      ) : (
        <div className="space-y-3">
          {directories.map((dirPath) => {
            const dirName = dirPath.split('/').pop() || dirPath
            const files = filesByDir[dirPath] ?? []
            return (
              <div key={dirPath} className="border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-800">
                <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-100 dark:border-neutral-700">
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300 truncate" title={dirPath}>
                    {dirName}
                  </span>
                  <button
                    onClick={() => removeDirectory(dirPath)}
                    className="text-xs text-neutral-400 hover:text-red-500 ml-2 shrink-0"
                  >
                    Remove
                  </button>
                </div>
                {files.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">No .adf files</p>
                ) : (
                  <div className="py-1">
                    {files.map((entry) => (
                      <TreeNode
                        key={entry.filePath}
                        entry={entry}
                        depth={0}
                        dirPath={dirPath}
                        onOpen={openFile}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// --- Tree node + file row (lifted from AppShell unchanged) ---

interface TreeEntry {
  filePath: string
  fileName: string
  isDirectory?: boolean
  children?: TreeEntry[]
}

function TreeNode({
  entry,
  depth,
  dirPath,
  onOpen,
}: {
  entry: TreeEntry
  depth: number
  dirPath: string
  onOpen: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  if (entry.isDirectory) {
    return (
      <div>
        <div
          onClick={() => setExpanded((p) => !p)}
          className="flex items-center gap-1.5 py-1.5 px-3 text-xs cursor-pointer text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
            {expanded ? '▼' : '▶'}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="flex-1 truncate">{entry.fileName}</span>
        </div>
        {expanded && entry.children && (
          <div>
            {entry.children.map((child) => (
              <TreeNode
                key={child.filePath}
                entry={child}
                depth={depth + 1}
                dirPath={dirPath}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <FileRow
      filePath={entry.filePath}
      fileName={entry.fileName}
      dirPath={dirPath}
      depth={depth}
      onOpen={() => onOpen(entry.filePath)}
    />
  )
}

function FileRow({ filePath, fileName, onOpen, dirPath, depth = 0 }: {
  filePath: string
  fileName: string
  onOpen: () => void
  dirPath: string
  depth?: number
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { rescanDirectory } = useTrackedDirs()

  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  const handleClone = () => {
    setMenuOpen(false)
    setCloneOpen(true)
  }

  const handleDelete = async () => {
    setMenuOpen(false)
    const ok = window.confirm(`Delete "${fileName}"? This cannot be undone.`)
    if (!ok) return
    await window.adfApi.deleteFile(filePath)
    await rescanDirectory(dirPath)
  }

  return (
    <div className="relative flex items-center group">
      <button
        onClick={onOpen}
        className="flex-1 py-1.5 text-xs text-left text-neutral-600 dark:text-neutral-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-700 dark:hover:text-blue-300 flex items-center gap-2 min-w-0"
        style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '12px' }}
      >
        <span className="truncate">{fileName}</span>
      </button>
      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={(e: ReactMouseEvent) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          className="px-1.5 py-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 opacity-0 group-hover:opacity-100 transition-opacity text-sm"
          title="File actions"
        >
          &#x22EE;
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg py-1 text-xs">
            <button
              onClick={handleClone}
              className="w-full px-3 py-1.5 text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              Clone
            </button>
            <div className="border-t border-neutral-200 dark:border-neutral-700 my-1" />
            <button
              onClick={handleDelete}
              className="w-full px-3 py-1.5 text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              Delete
            </button>
          </div>
        )}
      </div>
      <CloneDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        filePath={filePath}
        dirPath={dirPath}
        onCloned={() => rescanDirectory(dirPath)}
      />
    </div>
  )
}
