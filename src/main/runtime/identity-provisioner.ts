/**
 * Workspace Identity Hooks (ADF_IDENTITY_SPEC D1/D10)
 *
 * Module-level indirection so creation and agent-start paths (CreateAdfTool,
 * RuntimeService, BackgroundAgentManager) can provision/unlock workspace
 * identity without threading OwnerIdentityService through every constructor.
 * Registered once at boot by the IPC layer, which owns the service. Mirrors
 * the seedMandatoryReasoningModels/setMandatoryReasoningPersister pattern.
 *
 * Both functions are safe no-ops before registration and never throw —
 * identity provisioning must not break file creation or agent start.
 */

import type { AdfWorkspace } from '../adf/adf-workspace'

export interface WorkspaceIdentityHooks {
  /** Idempotent provision/migrate: envelopes, keys, owner/runtime stamps, attestations. */
  ensureIdentity: (workspace: AdfWorkspace) => void
  /** D10 unwrap cascade with this install's keys (runtime slot → owner recovery + re-wrap). */
  unlockEnvelopes: (workspace: AdfWorkspace) => void
  /**
   * False while the host holds no owner key (a daemon before `adf identity`):
   * ensureIdentity is then unlock-only, and callers must not fall back to
   * minting plain, unattested keys. Absent = always able (Studio).
   */
  canProvision?: () => boolean
}

/** Whether the registered host can mint owner-attested identities right now (true when no hooks: legacy behavior). */
export function canProvisionWorkspaceIdentity(): boolean {
  if (!hooks?.canProvision) return true
  try {
    return hooks.canProvision()
  } catch {
    return false
  }
}

let hooks: WorkspaceIdentityHooks | null = null

export function setWorkspaceIdentityHooks(h: WorkspaceIdentityHooks): void {
  hooks = h
}

export function ensureWorkspaceIdentity(workspace: AdfWorkspace): void {
  try {
    hooks?.ensureIdentity(workspace)
  } catch (err) {
    console.warn('[Identity] Workspace identity provisioning failed:', err)
  }
}

export function unlockWorkspaceEnvelopes(workspace: AdfWorkspace): void {
  try {
    hooks?.unlockEnvelopes(workspace)
  } catch (err) {
    console.warn('[Identity] Envelope unlock failed:', err)
  }
}
