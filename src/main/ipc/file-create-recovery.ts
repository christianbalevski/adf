export interface FileCreateRecoveryOutcome {
  /** The old foreground aliases are no longer safe to expose. */
  foregroundDetached: true
  /** The old assembled agent was adopted by the background manager. */
  retainedByBackground: boolean
  /** Whether recovery attempted to close the old foreground workspace. */
  workspaceCloseAttempted: boolean
  /** Whether that close attempt failed; no closed-file claim is safe then. */
  workspaceCloseFailed: boolean
  /** Whether recovery attempted to unregister the old mesh foreground. */
  meshUnregistered: boolean
}

export interface FileCreateRecoveryDeps {
  retainedByBackground: boolean
  /** AGENT_START still owns the workspace; do not close it from recovery. */
  startInFlight: boolean
  unregisterMesh: () => void
  closeWorkspace: () => void
  clearForeground: () => void
  onRecoveryError?: (error: unknown) => void
}

/**
 * Synchronize the FILE_CREATE failure boundary after cleanupCurrentFile rejects.
 *
 * cleanupCurrentFile may have detached foreground aliases before its fallible
 * transition/dispose await. This helper deliberately does not attempt rollback:
 * it preserves a background manager's ownership, avoids closing an in-flight
 * AGENT_START workspace, clears the foreground boundary, and reports only the
 * cleanup actions it actually attempted.
 */
export function recoverFileCreateCleanupFailure(
  deps: FileCreateRecoveryDeps,
): FileCreateRecoveryOutcome {
  let meshUnregistered = false
  let workspaceCloseAttempted = false
  let workspaceCloseFailed = false

  // An adopted background agent owns its mesh registration. Never tear down a
  // legitimately retained background service while detaching the foreground.
  if (!deps.retainedByBackground && !deps.startInFlight) {
    try {
      deps.unregisterMesh()
      meshUnregistered = true
    } catch (error) {
      deps.onRecoveryError?.(error)
    }
  }

  // An in-flight AGENT_START still owns this workspace until its own continuation
  // either adopts or disposes it. Recovery must not close it underneath that path.
  if (!deps.retainedByBackground && !deps.startInFlight) {
    workspaceCloseAttempted = true
    try {
      deps.closeWorkspace()
    } catch (error) {
      workspaceCloseFailed = true
      deps.onRecoveryError?.(error)
    }
  }

  deps.clearForeground()

  return {
    foregroundDetached: true,
    retainedByBackground: deps.retainedByBackground,
    workspaceCloseAttempted,
    workspaceCloseFailed,
    meshUnregistered,
  }
}
