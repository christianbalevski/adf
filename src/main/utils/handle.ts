import { basename } from 'path'

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Derive a URL-safe handle from an ADF file path.
 * Lowercases the basename (without .adf), replaces non-alphanumeric with hyphens,
 * and collapses consecutive hyphens.
 */
export function deriveHandle(filePath: string): string {
  return basename(filePath, '.adf')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'agent'
}

/**
 * Validate that a string is a legal handle (URL-safe slug).
 */
export function isValidHandle(handle: string): boolean {
  return handle.length > 0 && handle.length <= 64 && HANDLE_PATTERN.test(handle)
}
