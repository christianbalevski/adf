/**
 * Which string seeds an agent's orbital. Same chain as the site
 * (adf-org/src/lib/adf-identity.ts): DID, then public key, then handle, then
 * the file path, so an agent keeps its shape on every surface and device that
 * knows the same identity. Pre-identity files fall through to the handle or
 * path and change shape once they get a DID.
 */

export interface OrbitalSeedSource {
  did?: string | null
  publicKey?: string | null
  handle?: string | null
  filePath?: string | null
}

const present = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0

/** The seed, or null when the source carries nothing to seed from. */
export function orbitalSeedFor(src: OrbitalSeedSource): string | null {
  if (present(src.did)) return src.did.trim()
  if (present(src.publicKey)) return src.publicKey.trim()
  if (present(src.handle)) return src.handle.trim()
  if (present(src.filePath)) return src.filePath
  return null
}
