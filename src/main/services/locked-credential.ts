/**
 * Owner credential writes while the agent's credentials envelope is locked
 * in this process (sealed to another owner, or to this owner while the
 * owner identity is not available). One rule for embedded Studio
 * (IDENTITY_SET, PROVIDER_CREDENTIAL_SET), the daemon's credential routes
 * and its path-addressed file ops:
 *
 * - a plain write is never made silently: it would store a new value
 *   unsealed, or destroy a sealed value nobody here can read;
 * - the owner chooses: Replace (a locked sealed value is deleted unread,
 *   the new value stored unsealed and sealed once the envelope unlocks,
 *   and the override logged to the agent's adf_logs) or Cancel.
 *
 * Agent code never reaches this (set_identity / shell export write through
 * AdfWorkspace.setIdentity, which keeps refusing over a sealed value).
 * Key material (`crypto:*`) is not an owner credential: callers handle it.
 */

import type { AdfWorkspace } from '../adf/adf-workspace'
import { envelopeFromAlgo } from '../crypto/envelope-crypto'

export interface LockedCredential {
  purpose: string
  /** The credentials envelope's state here: `locked` (a share password opens it) or `foreign` (nothing here does). */
  envelopeState: string
  /** A value is stored sealed and cannot be read here: a replace discards it unread. */
  sealed: boolean
}

/** Null when `purpose` can be written as usual (sealed when its envelope is unlocked, plain in a file without envelopes). */
export function lockedCredentialWrite(ws: AdfWorkspace, purpose: string): LockedCredential | null {
  const state = ws.getEnvelopeState('credentials')
  const envelopeLocked = state === 'locked' || state === 'foreign'
  const row = ws.getIdentityRow(purpose)
  const rowEnvelope = row ? envelopeFromAlgo(row.encryption_algo) : null
  const sealed = rowEnvelope !== null && ws.getEnvelopeState(rowEnvelope) !== 'unlocked'
  if (!envelopeLocked && !sealed) return null
  return { purpose, envelopeState: state, sealed }
}

/** The adf_logs line of an owner override (also the console line's text). */
export function lockedCredentialReplaceMessage(locked: LockedCredential): string {
  return locked.sealed
    ? `Owner replaced locked sealed credential "${locked.purpose}" (the old value was discarded unread); the new value is stored unsealed until the credentials envelope unlocks.`
    : `Owner stored credential "${locked.purpose}" while the credentials envelope is ${locked.envelopeState}; it is stored unsealed until the envelope unlocks.`
}

/**
 * The owner chose Replace: delete a locked sealed value unread, store the
 * new one unsealed (keeping the row's code access), and record the
 * override in the agent's adf_logs (always, whatever the log level).
 */
export function replaceLockedCredential(ws: AdfWorkspace, locked: LockedCredential, value: string, log: (line: string) => void): void {
  const codeAccess = ws.getIdentityRow(locked.purpose)?.code_access ?? false
  if (locked.sealed) ws.deleteIdentity(locked.purpose)
  ws.setIdentity(locked.purpose, value, codeAccess)
  const message = lockedCredentialReplaceMessage(locked)
  log(message)
  try { ws.getDatabase().insertLog('warn', 'runtime', 'credential_replaced', locked.purpose, message) } catch { /* non-fatal */ }
}

/** The answer when the owner cancels (both modes show it as the save's error). */
export function lockedCredentialCancelled(locked: Pick<LockedCredential, 'purpose' | 'sealed'>): string {
  return locked.sealed
    ? `Not saved: "${locked.purpose}" is sealed and the agent's credentials are locked, so it can't be overwritten unless you replace it.`
    : `Not saved: the agent's credentials are locked, and "${locked.purpose}" would be stored unsealed.`
}
