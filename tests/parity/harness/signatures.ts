import { verifyAttestation } from '../../../src/main/services/attestation.service'
import type { AlfAttestation } from '../../../src/shared/types/adf-v02.types'

/**
 * Signatures in a recording are verified, not blanked (normalize R10).
 *
 * Every object that looks like an attestation (`issuer`, `subject`,
 * `signature: 'ed25519:…'`), including one serialized as a JSON string (the
 * `raw_json` column), is checked with the product's verifyAttestation against
 * its issuer DID. The normalizer then prints `<sig:valid#n>` or
 * `<sig:INVALID#n>`. A signature found outside any attestation is not in the
 * map and stays raw, which makes it a visible (and unstable) difference until
 * it gets a rule of its own.
 */
const ATTESTATION_COLUMNS = ['issuer', 'subject', 'role', 'issued_at', 'expires_at', 'scope', 'signature']

export function verifySignatures(root: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('{') && value.includes('"signature"')) {
        try { visit(JSON.parse(value)) } catch { /* not JSON */ }
      }
      return
    }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const o = value as Record<string, unknown>
    if (typeof o.issuer === 'string' && typeof o.subject === 'string' && typeof o.signature === 'string' && o.signature.startsWith('ed25519:')) {
      // An adf_attestations row carries the attestation's columns plus `id`
      // and `raw_json`, the whole signed cert (a v2 cert signs `v` and
      // `claims` too, which have no column). It is verified on `raw_json`,
      // and each column must equal the cert's field (nulls = absent). Every
      // occurrence must verify: a signature next to fields it does not sign
      // is INVALID.
      let ok: boolean
      if ('raw_json' in o) {
        let cert: Record<string, unknown> | null = null
        try { cert = JSON.parse(String(o.raw_json)) as Record<string, unknown> } catch { cert = null }
        ok = !!cert && ATTESTATION_COLUMNS.every((k) => (o[k] ?? undefined) === (cert![k] ?? undefined)) &&
          verifyAttestation(cert as unknown as AlfAttestation)
      } else {
        ok = verifyAttestation(o as unknown as AlfAttestation)
      }
      out.set(o.signature, (out.get(o.signature) ?? true) && ok)
    }
    for (const v of Object.values(o)) visit(v)
  }
  visit(root)
  return out
}
