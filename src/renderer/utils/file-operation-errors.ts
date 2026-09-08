import type { FileOperationResult } from '../../shared/types/ipc.types'

/** Return the user-facing error for a failed file operation, or null for success/cancel. */
export function fileOperationErrorMessage(
  operation: 'open' | 'create',
  result: FileOperationResult,
): string | null {
  if (result.success || !result.error || result.error === 'Cancelled') return null
  return `Failed to ${operation} file:\n\n${result.error}`
}

/** Whether a failed create crossed cleanup and detached the foreground. */
export function fileOperationDetachedForeground(result: FileOperationResult): boolean {
  return !result.success && result.foregroundDetached === true
}

/** Report a failed file operation without treating a cancelled dialog as an error. */
export function reportFileOperationError(
  operation: 'open' | 'create',
  result: FileOperationResult,
  notify: (message: string) => void,
): boolean {
  const message = fileOperationErrorMessage(operation, result)
  if (!message) return false
  notify(message)
  return true
}
