/**
 * "Did this tool call touch the document the UI is showing?"
 *
 * The chat panel used to re-read the whole document over IPC after EVERY
 * `fs_write` result, because the result event carried only name/id/result — it
 * could not tell a write to `notes/scratch.md` from a write to the document.
 * Main now derives the write's target path(s) (`ToolCallResultTargets`) and the
 * agent's document path, and this decides.
 *
 * The bias is deliberate: an undeterminable target refreshes. A stale document
 * on screen is a correctness bug; an extra read is only a cost.
 */

/** VFS paths are POSIX-relative. Fold the spellings that mean the same file. */
export function normalizeVfsPath(path: string): string {
  let p = path.trim().replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p.startsWith('/')) p = p.slice(1)
  // The VFS is case-insensitive in practice (SQLite path keys are written by
  // the model, which is inconsistent about README.md vs readme.md).
  return p.toLowerCase()
}

/**
 * `README.md` and `document.md` are the two built-in spellings of the document
 * (`AdfWorkspace.writeDocument` maps both onto the stored document row), so a
 * write to either is a write to the document whichever one the row carries.
 */
const DOCUMENT_ALIASES = new Set(['readme.md', 'document.md'])

function isSameDocument(target: string, documentPath: string): boolean {
  const t = normalizeVfsPath(target)
  const d = normalizeVfsPath(documentPath)
  if (t === d) return true
  return DOCUMENT_ALIASES.has(t) && DOCUMENT_ALIASES.has(d)
}

/**
 * The VFS paths a tool call writes to, or `undefined` when they cannot be known
 * from the input alone.
 *
 * Only the built-in fs tools declare their target in their input. `adf_shell`
 * (redirection), `sys_code` / `sys_lambda` (arbitrary workspace writes) and MCP
 * tools deliberately return `undefined` — "I don't know" is the honest answer
 * and it keeps the always-refresh behaviour for them.
 */
export function deriveToolTargetPaths(name: string, input: unknown): string[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const args = input as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined

  switch (name) {
    case 'fs_write':
    case 'fs_delete': {
      const path = str(args.path)
      return path ? [normalizeVfsPath(path)] : undefined
    }
    case 'fs_transfer': {
      // Only a transfer INTO the VFS can change a workspace file. Anything
      // else (vfs → isolated/host/shared) leaves the document untouched.
      if (args.to !== 'vfs') return []
      const dest = str(args.save_as) ?? str(args.path)
      return dest ? [normalizeVfsPath(dest)] : undefined
    }
    default:
      return undefined
  }
}

/**
 * Decide whether a `tool_call_result` should trigger a document re-read.
 *
 * - No `targetPaths` → not determinable. Preserves the previous behaviour
 *   exactly: refresh for `fs_write`, do nothing for anything else.
 * - `targetPaths` present but no `documentPath` → refresh (fail safe).
 * - Both present → refresh only on a match.
 */
export function shouldRefreshDocument(payload: {
  name?: string
  targetPaths?: string[]
  documentPath?: string
}): boolean {
  const { name, targetPaths, documentPath } = payload
  if (!targetPaths) return name === 'fs_write'
  if (targetPaths.length === 0) return false
  if (!documentPath) return true
  return targetPaths.some((p) => isSameDocument(p, documentPath))
}
