import type { AgentExecutionEvent } from '../../shared/types/ipc.types'
import { toEpochMs } from './relative-time'

export type FilesSort = 'name' | 'recent'

const FILES_SORT_KEY = 'adf-files-sort'

export function loadFilesSort(): FilesSort {
  try {
    return localStorage.getItem(FILES_SORT_KEY) === 'recent' ? 'recent' : 'name'
  } catch {
    return 'name'
  }
}

export function saveFilesSort(sort: FilesSort): void {
  try {
    localStorage.setItem(FILES_SORT_KEY, sort)
  } catch { /* storage full/unavailable — non-fatal, the sort just won't stick */ }
}

/** Newest change first; ties (and unreadable times) by path. */
export function sortByRecent<T extends { path: string; updated_at: string }>(files: readonly T[]): T[] {
  const time = (f: T): number => {
    const t = toEpochMs(f.updated_at)
    return Number.isFinite(t) ? t : -Infinity
  }
  return [...files].sort((a, b) => time(b) - time(a) || a.path.localeCompare(b.path))
}

/** A text write the runtime announced (`file_updated`): the file list may have changed. */
export function isFileUpdatedEvent(event: AgentExecutionEvent | null | undefined): boolean {
  if (event?.type !== 'file_updated') return false
  const path = (event.payload as { path?: unknown } | undefined)?.path
  return typeof path === 'string' && path.length > 0
}

/**
 * One trailing refetch per burst of change signals. `file_updated` covers text
 * writes only; the workspace `files` scope covers every write, delete and
 * rename, so both feed the same debounce and a burst of either costs one list.
 */
export function createDebouncedRefresh(refresh: () => void, delayMs: number): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    trigger: () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refresh()
      }, delayMs)
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
