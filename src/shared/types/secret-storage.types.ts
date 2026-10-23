/** How ADF Studio stores its own secrets (src/main/services/secret-storage-policy.ts). */
export type SecretStoragePolicy = 'keyring' | 'plaintext'

/** What Settings → Identity shows. Names and counts only, never values. */
export interface SecretStorageView {
  /** The saved choice; `keyring` when nothing is saved. */
  policy: SecretStoragePolicy
  keyringAvailable: boolean
  /** Secrets stored as plain text in the settings file right now. */
  plaintextSecrets: number
  /** Secrets that cannot be saved right now (keyring chosen, keychain unavailable). Always false for `studio-copies`. */
  writesBlocked: boolean
  /** Secrets Studio holds in its settings file, encrypted or not. */
  storedSecrets: number
  /**
   * `inside-studio`: Studio runs the agents and saves secrets itself.
   * `studio-copies`: agents run on the ADF daemon, which keeps its own secrets;
   * these are the copies Studio's settings file still holds.
   */
  scope: 'inside-studio' | 'studio-copies'
}
