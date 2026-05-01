import { dirname, sep } from 'path'
import type { Visibility } from '../../shared/types/adf-v02.types'

export type Scope = 'directory' | 'localhost' | 'lan' | 'public'

const SCOPE_ORDER: Record<Scope, number> = {
  directory: 0,
  localhost: 1,
  lan: 2,
  public: 3
}

/**
 * Classify a remote socket address into a network scope.
 * Undefined/loopback → 'localhost'; RFC1918/link-local/ULA → 'lan'; anything else → 'public'.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are unwrapped before classification.
 */
export function classifyRemote(addr: string | undefined | null): 'localhost' | 'lan' | 'public' {
  if (!addr) return 'localhost'

  let a = addr.trim()
  if (!a) return 'localhost'

  // Strip IPv6 zone id
  const pctIdx = a.indexOf('%')
  if (pctIdx >= 0) a = a.slice(0, pctIdx)

  // Unwrap IPv4-mapped IPv6
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a.startsWith('::FFFF:')) a = a.slice(7)

  // Unix socket path or non-TCP origin
  if (a.startsWith('/')) return 'localhost'

  // IPv6 loopback and link-local
  const lower = a.toLowerCase()
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'localhost'
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return 'lan' // fe80::/10
  // Unique local addresses fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'lan'

  // IPv4
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const o1 = parseInt(m[1], 10)
    const o2 = parseInt(m[2], 10)
    if (o1 === 127) return 'localhost'
    if (o1 === 10) return 'lan'
    if (o1 === 192 && o2 === 168) return 'lan'
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return 'lan'
    if (o1 === 169 && o2 === 254) return 'lan'
    return 'public'
  }

  // Unknown/malformed host — treat as public (safer default; won't pass tier checks for anything ≤ lan)
  return 'public'
}

/**
 * Determine the same-runtime delivery scope between two ADF file paths.
 * Returns 'directory' when the sender's ADF directory is an ancestor (inclusive) of the recipient's,
 * or when they share the same directory; otherwise returns 'localhost'.
 *
 * - senderAdf === null (foreground/untracked) → 'localhost' (degraded mode).
 * - Self-send (same path) → 'directory' (same dir counts as ancestor).
 */
export function ancestorScope(senderAdf: string | null | undefined, recipientAdf: string): 'directory' | 'localhost' {
  if (!senderAdf) return 'localhost'

  const senderDir = dirname(senderAdf)
  const recipientDir = dirname(recipientAdf)

  if (senderDir === recipientDir) return 'directory'

  // senderDir must be an ancestor: recipientDir starts with senderDir + sep
  const senderPrefix = senderDir.endsWith(sep) ? senderDir : senderDir + sep
  if (recipientDir.startsWith(senderPrefix)) return 'directory'

  return 'localhost'
}

/**
 * Returns true iff a requester at `scope` is permitted to reach an agent declared at `visibility`.
 * 'off' is never permitted. Otherwise: scope must be ≤ visibility in the tier ordering.
 */
export function permits(visibility: Visibility, scope: Scope): boolean {
  if (visibility === 'off') return false
  return SCOPE_ORDER[scope] <= SCOPE_ORDER[visibility]
}

/**
 * Human-readable rejection reason, matching strings across HTTP and in-process transports.
 */
export function denialReason(visibility: Visibility): string {
  if (visibility === 'off') return 'agent not accepting messages'
  return 'visibility tier mismatch'
}
