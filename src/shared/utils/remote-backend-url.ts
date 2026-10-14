/**
 * Remote daemon URL rules (design §9.2). Shared so Settings → Backend can show
 * the plain-HTTP confirmation before main refuses the save.
 *
 * - `https:` is accepted.
 * - `http:` to loopback (an SSH tunnel) or a tailnet address
 *   (100.64.0.0/10, fd7a:115c:a1e0::/48) is accepted.
 * - Any other `http:` URL needs the user's explicit confirmation, because the
 *   token would cross the network unencrypted.
 */

export type RemoteUrlClass = 'https' | 'loopback' | 'tailnet' | 'insecure-http' | 'invalid'

export interface RemoteUrlCheck {
  kind: RemoteUrlClass
  /** Normalized URL (no trailing slash) when `kind` is not `invalid`. */
  url: string | null
  /** Why the URL is invalid. */
  reason?: string
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function isTailnetHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) {
    const second = Number(v4[2])
    return Number(v4[1]) === 100 && second >= 64 && second <= 127
  }
  // WHATWG URL keeps IPv6 hosts bracketed and in canonical compressed form.
  return /^\[fd7a:115c:a1e0:/.test(host)
}

export function checkRemoteDaemonUrl(raw: string): RemoteUrlCheck {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'invalid', url: null, reason: 'Enter the daemon URL.' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { kind: 'invalid', url: null, reason: 'This is not a URL. Example: https://adf.example.com' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { kind: 'invalid', url: null, reason: 'The URL must start with https:// or http://.' }
  }
  if (parsed.username || parsed.password) {
    return { kind: 'invalid', url: null, reason: 'Put the token in the Token field, not in the URL.' }
  }
  if (parsed.search || parsed.hash) {
    return { kind: 'invalid', url: null, reason: 'The URL must not contain ? or #.' }
  }
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  if (parsed.protocol === 'https:') return { kind: 'https', url }
  const host = parsed.hostname.toLowerCase()
  if (isLoopbackHost(host)) return { kind: 'loopback', url }
  if (isTailnetHost(host)) return { kind: 'tailnet', url }
  return { kind: 'insecure-http', url }
}

/** Origin of a URL accepted by `checkRemoteDaemonUrl`, or null. */
export function remoteUrlOrigin(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
