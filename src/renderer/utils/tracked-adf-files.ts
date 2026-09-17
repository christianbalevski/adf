import type { TrackedDirEntry } from '../../shared/types/ipc.types'

export interface TrackedAdfFile {
  filePath: string
  fileName: string
  /** Agent display name from the file's config, when the scan could read it */
  agentName?: string
}

/** Flatten a TrackedDirEntry tree into a list of .adf file entries. */
export function flattenAdfFiles(entries: TrackedDirEntry[]): TrackedAdfFile[] {
  const result: TrackedAdfFile[] = []
  for (const e of entries) {
    if (e.isDirectory && e.children) {
      result.push(...flattenAdfFiles(e.children))
    } else if (!e.isDirectory && e.fileName.endsWith('.adf')) {
      result.push({ filePath: e.filePath, fileName: e.fileName, agentName: e.agentName })
    }
  }
  return result
}

/**
 * Every .adf file under the tracked directories, deduplicated by path.
 * Settings panels use this to offer "connect an agent" pickers; agents
 * outside tracked directories are not listed.
 */
export async function loadTrackedAdfFiles(): Promise<TrackedAdfFile[]> {
  const dirsResult = await window.adfApi?.getTrackedDirectories()
  const dirs = dirsResult?.directories ?? []
  const scans = await Promise.all(dirs.map(async (dir) => {
    try {
      const scanResult = await window.adfApi?.scanTrackedDirectory(dir)
      return scanResult?.files ? flattenAdfFiles(scanResult.files) : []
    } catch {
      // A missing or unreadable directory just contributes nothing.
      return []
    }
  }))
  const all: TrackedAdfFile[] = scans.flat()
  const seen = new Set<string>()
  return all.filter((f) => {
    if (seen.has(f.filePath)) return false
    seen.add(f.filePath)
    return true
  })
}

/** Display label for an ADF file: its agent name, else the file name without extension. */
export function adfDisplayName(f: { fileName: string; agentName?: string }): string {
  return f.agentName?.trim() || f.fileName.replace(/\.adf$/, '')
}

/**
 * Display label for a path that may sit outside the tracked directories: the
 * tracked agent's name when we know it, else the file name without extension.
 * Never the absolute path — it is long and says nothing useful.
 */
export function adfDisplayNameForPath(filePath: string, tracked: TrackedAdfFile[]): string {
  const known = tracked.find((f) => f.filePath === filePath)
  if (known) return adfDisplayName(known)
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  return fileName.replace(/\.adf$/, '')
}
