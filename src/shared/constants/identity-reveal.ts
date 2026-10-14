/**
 * Which stored identity values may be shown to the owner (the agent
 * Identity panel's Reveal, IDENTITY_GET), in every mode.
 *
 * Key material (`crypto:*`: the agent's signing key, envelope descriptors,
 * KDF rows) is never revealed: the agent's private signing key is what makes
 * its DID provable, and nothing in the UI needs it. Studio (embedded and
 * daemon mode) answers a Reveal of such a row with `REVEAL_REFUSED_REASON`;
 * the daemon's reveal routes never return it.
 */

export const KEY_MATERIAL_PURPOSE = /^crypto:/

export function isKeyMaterialPurpose(purpose: string): boolean {
  return KEY_MATERIAL_PURPOSE.test(purpose)
}

export const REVEAL_REFUSED_REASON = 'Signing keys and other key material can\'t be revealed.'
