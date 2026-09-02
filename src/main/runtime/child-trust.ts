/**
 * Spawned-child trust hook.
 *
 * An agent that another agent creates via sys_create_adf is trusted by
 * construction: the HIL gate sits on the tool call, not on the child. Review /
 * accept exists for foreign ADFs (different owner/operator), never for a child
 * the user's own agent spawned under an approved call.
 *
 * Module-level indirection (mirrors identity-provisioner) so the tool marks
 * the child reviewed regardless of which host assembled the parent — Studio
 * foreground, Studio background, or the daemon. Per-host `onChildCreated`
 * wiring previously covered only the fresh foreground start, so a child
 * spawned by a background parent was never marked and refused to start when
 * brought to the foreground.
 *
 * Safe no-op before registration; never throws.
 */

import type { AgentConfig } from '../../shared/types/adf-v02.types'

let registrar: ((config: AgentConfig) => void) | null = null

export function setChildTrustRegistrar(fn: ((config: AgentConfig) => void) | null): void {
  registrar = fn
}

export function markChildTrusted(config: AgentConfig): void {
  try {
    registrar?.(config)
  } catch (err) {
    console.warn(`[ChildTrust] Failed to mark spawned child ${config.id} trusted:`, err)
  }
}
