import type { CreateAgentOptions } from '../../shared/types/adf-v02.types'
import type { FileOperationResult } from '../../shared/types/ipc.types'
import type { FileCreateRecoveryOutcome } from './file-create-recovery'

export interface FileCreateDialogResult {
  canceled: boolean
  filePath?: string
}

export interface FileCreateHandlerDeps<Workspace> {
  showSaveDialog: (options: {
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<FileCreateDialogResult>
  buildCreateOptions: (agentName: string, filePath: string) => CreateAgentOptions
  createWorkspace: (filePath: string, options: CreateAgentOptions) => Workspace
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

/**
 * The FILE_CREATE transaction boundary used by the Electron IPC handler.
 *
 * Creation is deliberately attempted before cleanupCurrentFile: failures from
 * the destination arbiter or SQLite initialization cannot clear the current
 * foreground workspace. Once installWorkspace returns, the foreground switch
 * is committed; post-install bookkeeping is therefore best-effort and cannot
 * turn a usable new workspace into a reported create failure.
 */
export function makeFileCreateHandler<Workspace>(
  deps: FileCreateHandlerDeps<Workspace>,
): (_event: unknown, args: { name: string }) => Promise<FileOperationResult> {
  return async (_event, args) => {
    try {
      console.log('[IPC] FILE_CREATE called with name:', args.name)
      const result = await deps.showSaveDialog({
        defaultPath: `${args.name}.adf`,
        filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
      })
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Cancelled' }
      }

      const filePath = result.filePath
      const agentName = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.adf$/i, '') || args.name
      console.log('[IPC] FILE_CREATE: Creating file at:', filePath)

      let candidate: Workspace | null = null
      let installed = false
      let cleanupFailed = false
      try {
        // This is the race-safe creation boundary: createWorkspace must use
        // an exclusive no-replace primitive, not this handler's preflight.
        candidate = deps.createWorkspace(filePath, deps.buildCreateOptions(agentName, filePath))

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

        console.log('[IPC] FILE_CREATE: Success')
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
      console.error('[IPC] FILE_CREATE error:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
