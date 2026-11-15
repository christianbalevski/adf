// eslint-disable-next-line no-control-regex -- refusing control characters in a path is the point
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

/** Longest path an agent file may have. */
export const VFS_PATH_MAX_LENGTH = 1024

/**
 * Why `path` is not a usable agent file path, or `null` when it is. Rules:
 * non-empty, at most VFS_PATH_MAX_LENGTH characters, relative (no leading
 * `/`), forward slashes only, no control characters, and no empty, `.` or
 * `..` segments.
 */
export function vfsPathProblem(path: string): string | null {
  if (!path) return 'Path is required.'
  if (path.length > VFS_PATH_MAX_LENGTH) return `Path is longer than ${VFS_PATH_MAX_LENGTH} characters.`
  if (path.includes('\\')) return 'Use forward slashes.'
  if (CONTROL_CHARACTERS.test(path)) return 'Path contains control characters.'
  if (path.startsWith('/')) return 'Path must be relative.'
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return 'Path may not contain empty, "." or ".." segments.'
  return null
}
