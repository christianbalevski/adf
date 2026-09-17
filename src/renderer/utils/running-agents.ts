import type { TrackedDirEntry } from '../../shared/types/ipc.types'

/** One row of the sidebar's pinned "Running" list. */
export interface RunningAgentRow {
  file: TrackedDirEntry
  /** Tracked root the file lives under (what clone/delete rescan). */
  dirPath: string
  /**
   * Name of the folder that directly contains the file. Set only when
   * another running agent shares the same display name, so plain rows stay
   * plain and only genuine collisions get a disambiguator.
   */
  folderHint?: string
}

export interface RunningAgentsInput {
  /** Tracked roots in sidebar order. */
  directories: string[]
  /** Unfiltered tree per tracked root. */
  filesByDir: Record<string, TrackedDirEntry[]>
  /** File open in the editor, whose running state lives in the agent store. */
  currentFilePath: string | null
  /** True when the foreground agent is anything but `off`. */
  foregroundRunning: boolean
  /** Paths the background manager currently runs. */
  isBackgroundRunning: (filePath: string) => boolean
}

function displayName(file: TrackedDirEntry): string {
  return file.agentName ?? file.fileName
}

function parentFolderName(filePath: string, dirPath: string): string {
  const parent = filePath.slice(0, filePath.lastIndexOf('/'))
  if (parent === dirPath || parent === '') return dirPath.split('/').pop() ?? dirPath
  return parent.split('/').pop() ?? parent
}

/**
 * Flatten every tracked tree down to the agents that are running right now.
 * Order is by tracked root (sidebar order), then by path, and never by start
 * time, so rows hold still while agents come and go around them.
 */
export function collectRunningAgents(input: RunningAgentsInput): RunningAgentRow[] {
  const rows: RunningAgentRow[] = []
  const walk = (entries: TrackedDirEntry[], dirPath: string, out: RunningAgentRow[]): void => {
    for (const entry of entries) {
      if (entry.isDirectory) {
        walk(entry.children ?? [], dirPath, out)
        continue
      }
      const running = entry.filePath === input.currentFilePath
        ? input.foregroundRunning
        : input.isBackgroundRunning(entry.filePath)
      if (running) out.push({ file: entry, dirPath })
    }
  }
  for (const dirPath of input.directories) {
    const found: RunningAgentRow[] = []
    walk(input.filesByDir[dirPath] ?? [], dirPath, found)
    found.sort((a, b) => a.file.filePath.localeCompare(b.file.filePath))
    rows.push(...found)
  }

  const nameCounts = new Map<string, number>()
  for (const row of rows) {
    const name = displayName(row.file)
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  for (const row of rows) {
    if ((nameCounts.get(displayName(row.file)) ?? 0) > 1) {
      row.folderHint = parentFolderName(row.file.filePath, row.dirPath)
    }
  }
  return rows
}
