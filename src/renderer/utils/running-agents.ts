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

/** One avatar in the collapsed sidebar's rail. */
export interface RailAgent {
  file: TrackedDirEntry
  /** Tracked root, when the file is in one (the row menu needs it). */
  dirPath?: string
  /** The open agent while it is not running: shown first, above a divider. */
  openOnly?: boolean
}

function findEntry(entries: TrackedDirEntry[], filePath: string): TrackedDirEntry | null {
  for (const e of entries) {
    if (e.isDirectory) {
      const hit = findEntry(e.children ?? [], filePath)
      if (hit) return hit
    } else if (e.filePath === filePath) {
      return e
    }
  }
  return null
}

/**
 * The collapsed rail: every running agent in the Running list's order, and
 * the open agent when it is not one of them. The open agent goes first then,
 * so what the stage shows is always on the rail. An open file outside every
 * tracked root still gets an avatar, from its path alone.
 */
export function collectRailAgents(
  running: RunningAgentRow[],
  input: Pick<RunningAgentsInput, 'directories' | 'filesByDir' | 'currentFilePath'>
): RailAgent[] {
  const rail: RailAgent[] = running.map((r) => ({ file: r.file, dirPath: r.dirPath }))
  const open = input.currentFilePath
  if (!open || running.some((r) => r.file.filePath === open)) return rail
  for (const dirPath of input.directories) {
    const entry = findEntry(input.filesByDir[dirPath] ?? [], open)
    if (entry) return [{ file: entry, dirPath, openOnly: true }, ...rail]
  }
  const fileName = open.split('/').pop() ?? open
  return [{ file: { filePath: open, fileName, agentName: fileName.replace(/\.adf$/i, '') }, openOnly: true }, ...rail]
}
