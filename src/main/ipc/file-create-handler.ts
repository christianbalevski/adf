import type { FileOperationResult } from '../../shared/types/ipc.types'
import type { FileCreateRecoveryOutcome } from './file-create-recovery'

export interface FileCreateDialogResult {
  canceled: boolean
  filePath?: string
}

/**
 * A create the host refused for a reason the caller can act on (a missing or
 * unreviewed template). `code` rides through to the IPC result.
 */
export class FileCreateRefusedError<Code extends string = string> extends Error {
  constructor(message: string, readonly code?: Code) {
    super(message)
    this.name = 'FileCreateRefusedError'
  }
}

export type FileCreateResult = FileOperationResult & { code?: string }

export interface FileCreateTransitionDeps<Workspace> {
  /**
   * Write the new file at `filePath` and return it opened. Throws when nothing
   * usable was made (a FileCreateRefusedError for a refusal with a code).
   */
  createWorkspace: (filePath: string, agentName: string) => Workspace | Promise<Workspace>
  closeWorkspace: (workspace: Workspace) => void
  cleanupCurrentFile: () => Promise<void>
  /** All fallible candidate preparation happens before old-workspace cleanup. */
  prepareWorkspace: (workspace: Workspace, filePath: string) => void
  /** Install prepared workspace with no fallible preparation remaining. */
  installWorkspace: (workspace: Workspace, filePath: string) => void
  /** Best-effort bookkeeping after the foreground switch has committed. */
  onInstalled: (workspace: Workspace, filePath: string) => void
  /** Synchronize main ownership if old cleanup rejects. */
  recoverAfterCleanupFailure?: () => Promise<FileCreateRecoveryOutcome> | FileCreateRecoveryOutcome
  onPostInstallError?: (error: unknown) => void
}

export interface FileCreateHandlerDeps<Workspace> extends FileCreateTransitionDeps<Workspace> {
  showSaveDialog: (options: {
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<FileCreateDialogResult>
}

/**
 * The create transaction boundary shared by FILE_CREATE (path from a save
 * dialog) and FILE_CREATE_QUICK (path generated in the agents folder).
 *
 * Creation is deliberately attempted before cleanupCurrentFile: failures from
 * the destination arbiter, a refused template, or SQLite initialization cannot
 * clear the current foreground workspace. Once installWorkspace returns, the
 * foreground switch is committed; post-install bookkeeping is therefore
 * best-effort and cannot turn a usable new workspace into a reported create
 * failure.
 */
export async function runFileCreateTransition<Workspace>(
  deps: FileCreateTransitionDeps<Workspace>,
  filePath: string,
  agentName: string,
): Promise<FileCreateResult> {
  try {
    let candidate: Workspace | null = null
    let installed = false
    let cleanupFailed = false
    try {
      candidate = await deps.createWorkspace(filePath, agentName)

      // Prepare every fallible candidate callback while the old foreground
      // remains authoritative. A preparation failure cannot clear old state.
      deps.prepareWorkspace(candidate, filePath)

      // Only the transition itself may now release the old foreground. The
      // following install is assignment-only in production.
      try {
        await deps.cleanupCurrentFile()
      } catch (error) {
        cleanupFailed = true
        throw error
      }
      deps.installWorkspace(candidate, filePath)
      installed = true
      const installedWorkspace = candidate
      candidate = null

      try {
        deps.onInstalled(installedWorkspace, filePath)
      } catch (error) {
        // The new workspace is already live. Do not return failure or close
        // it because a recent/tracked/reviewed side effect failed.
        deps.onPostInstallError?.(error)
      }

      return { success: true, filePath }
    } catch (error) {
      if (candidate && !installed) {
        // Creation succeeded, so closing releases the candidate DB handle;
        // it intentionally does not delete the valid destination file.
        try {
          deps.closeWorkspace(candidate)
        } catch (closeError) {
          deps.onPostInstallError?.(closeError)
        }
      }
      if (cleanupFailed) {
        // cleanupCurrentFile can reject after detaching old runtime aliases.
        // Main must not leave the renderer looking at that half-live agent.
        let recovery: FileCreateRecoveryOutcome | undefined
        try {
          recovery = await deps.recoverAfterCleanupFailure?.()
        } catch (recoveryError) {
          deps.onPostInstallError?.(recoveryError)
        }
        const message = error instanceof Error ? error.message : String(error)
        const ownershipNotice = recovery?.retainedByBackground
          ? 'The previous agent remains owned by the background manager; only its foreground view was detached.'
          : recovery?.workspaceCloseFailed
            ? 'The foreground was detached, but closing the previous workspace failed; it may require process cleanup.'
            : recovery?.workspaceCloseAttempted
              ? 'The foreground was detached and no file is open.'
              : 'The foreground was detached; its workspace remains owned by an in-flight start.'
        return {
          success: false,
          foregroundDetached: true,
          filePath,
          error: `${message}\n\n${ownershipNotice} The newly created file was preserved at:\n${filePath}`,
        }
      }
      throw error
    }
  } catch (error) {
    console.error('[IPC] File create error:', error)
    return {
      success: false,
      ...(error instanceof FileCreateRefusedError && error.code ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** FILE_CREATE: a save dialog picks the path, then the shared transition runs. */
export function makeFileCreateHandler<Workspace>(
  deps: FileCreateHandlerDeps<Workspace>,
): (_event: unknown, args: { name: string }) => Promise<FileCreateResult> {
  return async (_event, args) => {
    let result: FileCreateDialogResult
    try {
      console.log('[IPC] FILE_CREATE called with name:', args.name)
      result = await deps.showSaveDialog({
        defaultPath: `${args.name}.adf`,
        filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
      })
    } catch (error) {
      console.error('[IPC] FILE_CREATE error:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Cancelled' }
    }

    const filePath = result.filePath
    const agentName = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.adf$/i, '') || args.name
    console.log('[IPC] FILE_CREATE: Creating file at:', filePath)
    return runFileCreateTransition(deps, filePath, agentName)
  }
}
