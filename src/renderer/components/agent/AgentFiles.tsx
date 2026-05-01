import { useState, useEffect, useCallback, useRef } from 'react'
import { useDocumentStore } from '../../stores/document.store'
import { useEditorTabsStore } from '../../stores/editor-tabs.store'
import { Dialog } from '../common/Dialog'

type FileProtectionLevel = 'read_only' | 'no_delete' | 'none'

interface FileEntry {
  path: string
  size: number
  mime_type?: string
  protection: FileProtectionLevel
  authorized: boolean
  created_at: string
  updated_at: string
}

interface LocalTable {
  name: string
  row_count: number
}

const CORE_FILES = new Set(['document.md', 'mind.md'])

interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
  file?: FileEntry
}

function buildFileTree(files: FileEntry[]): FileTreeNode[] {
  const rootFiles: FileTreeNode[] = []
  const dirMap = new Map<string, FileEntry[]>()

  for (const file of files) {
    const slashIdx = file.path.indexOf('/')
    if (slashIdx === -1) {
      rootFiles.push({ name: file.path, path: file.path, isDir: false, children: [], file })
    } else {
      const topDir = file.path.slice(0, slashIdx)
      if (!dirMap.has(topDir)) dirMap.set(topDir, [])
      dirMap.get(topDir)!.push(file)
    }
  }

  function buildSubtree(entries: FileEntry[], prefix: string): FileTreeNode[] {
    const localFiles: FileTreeNode[] = []
    const subDirMap = new Map<string, FileEntry[]>()

    for (const file of entries) {
      const rest = file.path.slice(prefix.length + 1)
      const slashIdx = rest.indexOf('/')
      if (slashIdx === -1) {
        localFiles.push({ name: rest, path: file.path, isDir: false, children: [], file })
      } else {
        const subDir = rest.slice(0, slashIdx)
        if (!subDirMap.has(subDir)) subDirMap.set(subDir, [])
        subDirMap.get(subDir)!.push(file)
      }
    }

    const dirNodes: FileTreeNode[] = Array.from(subDirMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, children]) => ({
        name,
        path: `${prefix}/${name}`,
        isDir: true,
        children: buildSubtree(children, `${prefix}/${name}`),
      }))

    localFiles.sort((a, b) => a.name.localeCompare(b.name))
    return [...dirNodes, ...localFiles]
  }

  const topDirNodes: FileTreeNode[] = Array.from(dirMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, children]) => ({
      name,
      path: name,
      isDir: true,
      children: buildSubtree(children, name),
    }))

  rootFiles.sort((a, b) => a.name.localeCompare(b.name))
  return [...topDirNodes, ...rootFiles]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function AgentFiles() {
  const filePath = useDocumentStore((s) => s.filePath)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [tables, setTables] = useState<LocalTable[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [expandedTable, setExpandedTable] = useState<string | null>(null)
  const [tableData, setTableData] = useState<{ columns: string[]; rows: Record<string, unknown>[] }>({ columns: [], rows: [] })
  const [viewingFile, setViewingFile] = useState<{ path: string; content: string; binary: boolean; meta: FileEntry } | null>(null)
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const [creatingFile, setCreatingFile] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const newFileInputRef = useRef<HTMLInputElement>(null)
  const folderRenameRef = useRef<HTMLInputElement>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggleDir = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }, [])

  const countFiles = useCallback((node: FileTreeNode): number => {
    if (!node.isDir) return 1
    return node.children.reduce((sum, child) => sum + countFiles(child), 0)
  }, [])

  const fetchFiles = useCallback(() => {
    window.adfApi?.getInternalFiles().then((result) => {
      setFiles(result?.files ?? [])
    })
  }, [])

  const fetchTables = useCallback(() => {
    window.adfApi?.listLocalTables().then((result) => {
      setTables(result?.tables ?? [])
    })
  }, [])

  useEffect(() => {
    fetchFiles()
    fetchTables()
    setExpandedTable(null)
  }, [filePath, fetchFiles, fetchTables])

  useEffect(() => {
    if (editingPath && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingPath])

  useEffect(() => {
    if (renamingFolder && folderRenameRef.current) {
      folderRenameRef.current.focus()
      folderRenameRef.current.select()
    }
  }, [renamingFolder])

  useEffect(() => {
    if (creatingFile && newFileInputRef.current) {
      newFileInputRef.current.focus()
    }
  }, [creatingFile])

  const handleCreateFile = async () => {
    const trimmed = newFilePath.trim()
    if (!trimmed) {
      setCreatingFile(false)
      setNewFilePath('')
      return
    }
    await window.adfApi?.uploadFile(trimmed, [], undefined)
    setCreatingFile(false)
    setNewFilePath('')
    fetchFiles()
  }

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)

    // Collect all files with relative paths (handles directories)
    const items = Array.from(e.dataTransfer.items)
    const entries = items
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => entry != null)

    if (entries.length > 0) {
      const allFiles: { path: string; file: File }[] = []
      const readEntry = (entry: FileSystemEntry, prefix: string): Promise<void> => {
        if (entry.isFile) {
          return new Promise((resolve) => {
            (entry as FileSystemFileEntry).file((file) => {
              allFiles.push({ path: prefix ? `${prefix}/${entry.name}` : entry.name, file })
              resolve()
            })
          })
        }
        return new Promise((resolve) => {
          const reader = (entry as FileSystemDirectoryEntry).createReader()
          const readBatch = () => {
            reader.readEntries(async (entries) => {
              if (entries.length === 0) { resolve(); return }
              const newPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
              for (const child of entries) await readEntry(child, newPrefix)
              readBatch()
            })
          }
          readBatch()
        })
      }
      for (const entry of entries) await readEntry(entry, '')
      for (const { path, file } of allFiles) {
        const buffer = await file.arrayBuffer()
        const data = Array.from(new Uint8Array(buffer))
        await window.adfApi?.uploadFile(path, data, file.type || undefined)
      }
    } else {
      // Fallback for browsers without webkitGetAsEntry
      for (const file of Array.from(e.dataTransfer.files)) {
        const buffer = await file.arrayBuffer()
        const data = Array.from(new Uint8Array(buffer))
        await window.adfApi?.uploadFile(file.name, data, file.type || undefined)
      }
    }
    fetchFiles()
  }, [fetchFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const handleOpenInEditor = useCallback(async (path: string) => {
    const result = await window.adfApi?.readInternalFile(path)
    if (result?.content != null) {
      useEditorTabsStore.getState().openTab(path, result.binary ? '' : result.content, result.binary)
    }
  }, [])

  const handleDelete = async (path: string) => {
    await window.adfApi?.deleteInternalFile(path)
    useEditorTabsStore.getState().closeTab(path)
    fetchFiles()
  }

  const handleCycleProtection = async (path: string, current: FileProtectionLevel) => {
    const next: FileProtectionLevel = current === 'none' ? 'no_delete' : current === 'no_delete' ? 'read_only' : 'none'
    await window.adfApi?.setFileProtection(path, next)
    fetchFiles()
    setViewingFile((prev) => prev && prev.path === path ? { ...prev, meta: { ...prev.meta, protection: next } } : prev)
  }

  const handleToggleAuthorized = async (path: string, current: boolean) => {
    await window.adfApi?.setFileAuthorized(path, !current)
    fetchFiles()
    setViewingFile((prev) => prev && prev.path === path ? { ...prev, meta: { ...prev.meta, authorized: !current } } : prev)
  }

  const startRename = (path: string) => {
    setEditingPath(path)
    setEditValue(path)
    setRenamingFolder(null)
  }

  const startFolderRename = (folderPath: string) => {
    setRenamingFolder(folderPath)
    // Only edit the last segment (folder name), not the full path
    const lastSlash = folderPath.lastIndexOf('/')
    setFolderRenameValue(lastSlash === -1 ? folderPath : folderPath.slice(lastSlash + 1))
    setEditingPath(null)
  }

  const commitRename = async () => {
    if (!editingPath || editValue === editingPath) {
      setEditingPath(null)
      return
    }
    const result = await window.adfApi?.renameInternalFile(editingPath, editValue)
    if (result?.success) {
      setViewingFile((prev) => prev && prev.path === editingPath ? { ...prev, path: editValue } : prev)
    } else {
      setEditValue(editingPath)
    }
    setEditingPath(null)
    fetchFiles()
  }

  const commitFolderRename = async () => {
    if (!renamingFolder) { setRenamingFolder(null); return }
    // Reconstruct full new path from parent prefix + edited name
    const lastSlash = renamingFolder.lastIndexOf('/')
    const newFullPath = lastSlash === -1 ? folderRenameValue : renamingFolder.slice(0, lastSlash + 1) + folderRenameValue
    if (newFullPath === renamingFolder || !folderRenameValue.trim()) {
      setRenamingFolder(null)
      return
    }
    await window.adfApi?.renameFolder(renamingFolder, newFullPath)
    setRenamingFolder(null)
    fetchFiles()
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitRename()
    } else if (e.key === 'Escape') {
      setEditingPath(null)
    }
  }

  const handleFolderRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitFolderRename()
    } else if (e.key === 'Escape') {
      setRenamingFolder(null)
    }
  }

  const handleViewFile = async (path: string) => {
    const result = await window.adfApi?.readInternalFile(path)
    const meta = files.find((f) => f.path === path)
    if (result?.content != null && meta) {
      setViewingFile({ path, content: result.content, binary: result.binary, meta })
    }
  }

  const toggleTable = async (name: string) => {
    if (expandedTable === name) {
      setExpandedTable(null)
      return
    }
    setExpandedTable(name)
    const result = await window.adfApi?.queryLocalTable(name, 50)
    if (result) {
      setTableData({ columns: result.columns, rows: result.rows })
    }
  }

  const handleDropTable = async (name: string) => {
    await window.adfApi?.dropLocalTable(name)
    if (expandedTable === name) {
      setExpandedTable(null)
    }
    fetchTables()
  }

  return (
    <div className="absolute inset-0 flex flex-col min-w-0 overflow-hidden">
      {/* Fixed header: drop zone + buttons */}
      <div className="shrink-0">
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`m-3 mb-2 p-4 border-2 border-dashed rounded-lg text-center text-xs transition-colors ${
            dragOver
              ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
              : 'border-neutral-300 dark:border-neutral-600 text-neutral-400 dark:text-neutral-500'
          }`}
        >
          Drop files or folders here to upload
        </div>
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400 dark:text-neutral-500 font-medium">
            Files ({files.length})
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const result = await window.adfApi?.pickAndImport()
                if (result?.count) fetchFiles()
              }}
              className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer"
            >
              + Upload
            </button>
            {!creatingFile && (
              <button
                onClick={() => setCreatingFile(true)}
                className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer"
              >
                + New File
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable file list */}
      <div className="flex-1 overflow-y-auto min-h-0">
      <div className="px-3 pb-3 space-y-0.5">
        {creatingFile && (
          <div className="flex items-center gap-1 mb-1">
            <input
              ref={newFileInputRef}
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile()
                else if (e.key === 'Escape') {
                  setCreatingFile(false)
                  setNewFilePath('')
                }
              }}
              onBlur={handleCreateFile}
              placeholder="path/to/file.txt"
              className="flex-1 text-xs px-2 py-1 border border-blue-400 rounded bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 outline-none min-w-0"
            />
          </div>
        )}
        {(() => {
          const tree = buildFileTree(files)

          const renderFileRow = (file: FileEntry, displayName: string, depth: number) => {
            return (
              <div
                key={file.path}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
                style={{ paddingLeft: `${8 + depth * 16}px` }}
                onClick={() => {
                  if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
                  clickTimerRef.current = setTimeout(() => {
                    handleViewFile(file.path)
                  }, 250)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (clickTimerRef.current) {
                    clearTimeout(clickTimerRef.current)
                    clickTimerRef.current = null
                  }
                  handleOpenInEditor(file.path)
                }}
                title={`Click to preview, double-click to open in editor: ${file.path}`}
              >
                <span className="text-xs truncate flex-1 min-w-0 text-neutral-700 dark:text-neutral-300">
                  {displayName}
                </span>
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
                  {formatSize(file.size)}
                </span>
                {file.authorized && (
                  <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
                    authorized
                  </span>
                )}
                {file.protection !== 'none' && (
                  <span
                    className={`shrink-0 px-1.5 py-0.5 text-[10px] rounded ${
                      file.protection === 'read_only'
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                        : 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {file.protection === 'read_only' ? 'read-only' : 'no-delete'}
                  </span>
                )}
              </div>
            )
          }

          const renderNode = (node: FileTreeNode, depth: number): React.ReactNode => {
            if (!node.isDir) {
              return renderFileRow(node.file!, node.name, depth)
            }

            const isCollapsed = collapsedDirs.has(node.path)
            const fileCount = countFiles(node)

            return (
              <div key={node.path}>
                {renamingFolder === node.path ? (
                  <div
                    className="flex items-center gap-1.5 px-2 py-1"
                    style={{ paddingLeft: `${8 + depth * 16}px` }}
                  >
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-3 text-center shrink-0">
                      {isCollapsed ? '\u25B6' : '\u25BC'}
                    </span>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
                      {isCollapsed ? '\uD83D\uDCC1' : '\uD83D\uDCC2'}
                    </span>
                    <input
                      ref={folderRenameRef}
                      value={folderRenameValue}
                      onChange={(e) => setFolderRenameValue(e.target.value)}
                      onKeyDown={handleFolderRenameKeyDown}
                      onBlur={commitFolderRename}
                      className="flex-1 text-xs px-1 py-0 border border-blue-400 rounded bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 outline-none min-w-0"
                    />
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-1.5 w-full px-2 py-1 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    style={{ paddingLeft: `${8 + depth * 16}px` }}
                  >
                    <button
                      onClick={() => toggleDir(node.path)}
                      className="text-[10px] text-neutral-400 dark:text-neutral-500 w-3 text-center shrink-0 hover:text-neutral-600 dark:hover:text-neutral-300 cursor-pointer"
                    >
                      {isCollapsed ? '\u25B6' : '\u25BC'}
                    </button>
                    <span
                      className="flex items-center gap-1.5 flex-1 min-w-0 cursor-default"
                      onDoubleClick={() => startFolderRename(node.path)}
                      title="Double-click to rename folder"
                    >
                      <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
                        {isCollapsed ? '\uD83D\uDCC1' : '\uD83D\uDCC2'}
                      </span>
                      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400 truncate">
                        {node.name}
                      </span>
                    </span>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0 ml-auto">
                      {fileCount}
                    </span>
                  </div>
                )}
                {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
              </div>
            )
          }

          return tree.map((node) => renderNode(node, 0))
        })()}
        {files.length === 0 && (
          <div className="text-center py-2">
            <p className="text-xs text-neutral-400 dark:text-neutral-500">No files yet.</p>
          </div>
        )}
      </div>

      {/* Tables section */}
      {tables.length > 0 && (
        <div className="px-3 pb-3 space-y-1 border-t border-neutral-200 dark:border-neutral-700 pt-3 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400 dark:text-neutral-500 font-medium mb-1">
            Tables ({tables.length})
          </div>
          {tables.map((table) => {
            const isExpanded = expandedTable === table.name
            return (
              <div key={table.name}>
                <div className="flex items-center group">
                  <button
                    onClick={() => toggleTable(table.name)}
                    className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800 text-left min-w-0"
                  >
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                      {isExpanded ? '\u25BC' : '\u25B6'}
                    </span>
                    <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1 truncate font-mono">
                      {table.name}
                    </span>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
                      {table.row_count} row{table.row_count !== 1 ? 's' : ''}
                    </span>
                  </button>
                  {table.name.startsWith('local_') && (
                  <button
                    onClick={() => handleDropTable(table.name)}
                    className="shrink-0 px-1.5 py-0.5 text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 cursor-pointer"
                    title={`Drop table ${table.name}`}
                  >
                    Drop
                  </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="mt-1 mb-2 mx-1 overflow-x-auto rounded border border-neutral-200 dark:border-neutral-700">
                    {tableData.columns.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">Empty table</div>
                    ) : (
                      <table className="w-max text-[11px]">
                        <thead>
                          <tr className="bg-neutral-50 dark:bg-neutral-800">
                            {tableData.columns.map((col) => (
                              <th
                                key={col}
                                className="px-2 py-1 text-left font-medium text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700 whitespace-nowrap"
                              >
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tableData.rows.map((row, i) => (
                            <tr
                              key={i}
                              className="border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                            >
                              {tableData.columns.map((col) => (
                                <td
                                  key={col}
                                  className="px-2 py-1 text-neutral-700 dark:text-neutral-300 whitespace-nowrap max-w-[200px] truncate"
                                  title={String(row[col] ?? '')}
                                >
                                  {String(row[col] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {table.row_count > 50 && (
                      <div className="px-2 py-1 text-[10px] text-neutral-400 dark:text-neutral-500 bg-neutral-50 dark:bg-neutral-800 border-t border-neutral-200 dark:border-neutral-700">
                        Showing first 50 of {table.row_count} rows
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      </div>

      {/* File viewer modal */}
      <Dialog
        open={viewingFile !== null}
        onClose={() => setViewingFile(null)}
        title={viewingFile?.path ?? ''}
        wide
      >
        {viewingFile && (
          <>
            {/* Rename (below title) */}
            {!CORE_FILES.has(viewingFile.path) && (
              <div className="mb-3">
                {editingPath === viewingFile.path ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={handleRenameKeyDown}
                    className="w-full text-xs px-2 py-1.5 border border-blue-400 rounded bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 outline-none"
                  />
                ) : (
                  <button
                    onClick={() => startRename(viewingFile.path)}
                    className="text-[11px] text-blue-500 dark:text-blue-400 hover:underline cursor-pointer"
                  >
                    Rename
                  </button>
                )}
              </div>
            )}

            {/* Metadata bar */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400 mb-3 pb-3 border-b border-neutral-200 dark:border-neutral-700">
              <span>
                <span className="text-neutral-400 dark:text-neutral-500">Size</span>{' '}
                <span className="text-neutral-700 dark:text-neutral-300">{formatSize(viewingFile.meta.size)}</span>
              </span>
              {viewingFile.meta.mime_type && (
                <span>
                  <span className="text-neutral-400 dark:text-neutral-500">Type</span>{' '}
                  <span className="text-neutral-700 dark:text-neutral-300 font-mono">{viewingFile.meta.mime_type}</span>
                </span>
              )}
              <span>
                <span className="text-neutral-400 dark:text-neutral-500">Protection</span>{' '}
                <span className={
                  viewingFile.meta.protection === 'read_only'
                    ? 'text-red-600 dark:text-red-400'
                    : viewingFile.meta.protection === 'no_delete'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-neutral-700 dark:text-neutral-300'
                }>{viewingFile.meta.protection === 'read_only' ? 'read-only' : viewingFile.meta.protection === 'no_delete' ? 'no-delete' : 'none'}</span>
              </span>
              <span>
                <span className="text-neutral-400 dark:text-neutral-500">Authorized</span>{' '}
                <span className={viewingFile.meta.authorized ? 'text-green-600 dark:text-green-400' : 'text-neutral-700 dark:text-neutral-300'}>
                  {viewingFile.meta.authorized ? 'yes' : 'no'}
                </span>
              </span>
              <span>
                <span className="text-neutral-400 dark:text-neutral-500">Created</span>{' '}
                <span className="text-neutral-700 dark:text-neutral-300">{formatDate(viewingFile.meta.created_at)}</span>
              </span>
              <span>
                <span className="text-neutral-400 dark:text-neutral-500">Modified</span>{' '}
                <span className="text-neutral-700 dark:text-neutral-300">{formatDate(viewingFile.meta.updated_at)}</span>
              </span>
            </div>

            {viewingFile.binary ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Binary file ({formatSize(viewingFile.meta.size)}). Cannot display inline.
              </p>
            ) : (
              <pre className="whitespace-pre-wrap overflow-auto max-h-[40vh] text-xs font-mono text-neutral-800 dark:text-neutral-200 bg-neutral-50 dark:bg-neutral-900 rounded-lg p-3 border border-neutral-200 dark:border-neutral-700">
                {viewingFile.content}
              </pre>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
              {!CORE_FILES.has(viewingFile.path) && (
                <button
                  onClick={() => handleToggleAuthorized(viewingFile.path, viewingFile.meta.authorized)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${
                    viewingFile.meta.authorized
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800'
                      : 'text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }`}
                  title={viewingFile.meta.authorized ? 'Click to deauthorize' : 'Click to authorize'}
                >
                  {viewingFile.meta.authorized ? 'Authorized' : 'Unauthorized'}
                </button>
              )}
              {!CORE_FILES.has(viewingFile.path) && (
                <button
                  onClick={() => handleCycleProtection(viewingFile.path, viewingFile.meta.protection)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${
                    viewingFile.meta.protection === 'read_only'
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                      : viewingFile.meta.protection === 'no_delete'
                      ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800'
                      : 'text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }`}
                  title={`Click to cycle protection (current: ${viewingFile.meta.protection})`}
                >
                  Protection: {viewingFile.meta.protection === 'read_only' ? 'read-only' : viewingFile.meta.protection === 'no_delete' ? 'no-delete' : 'none'}
                </button>
              )}

              <div className="flex-1" />

              <button
                onClick={() => window.adfApi?.downloadInternalFile(viewingFile.path)}
                className="px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
                title="Download file to disk"
              >
                Download
              </button>

              {!CORE_FILES.has(viewingFile.path) && (
                <button
                  onClick={() => {
                    handleDelete(viewingFile.path)
                    setViewingFile(null)
                  }}
                  disabled={viewingFile.meta.protection !== 'none'}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                    viewingFile.meta.protection !== 'none'
                      ? 'text-neutral-300 dark:text-neutral-600 border border-neutral-200 dark:border-neutral-700 cursor-not-allowed'
                      : 'text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/30 cursor-pointer'
                  }`}
                  title={viewingFile.meta.protection !== 'none' ? 'Cannot delete protected files' : 'Delete file'}
                >
                  Delete
                </button>
              )}

              <button
                onClick={() => setViewingFile(null)}
                className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
              >
                Close
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  )
}
