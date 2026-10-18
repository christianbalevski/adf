/**
 * Who a request authenticated as, set by the request guard
 * (request-guard.ts) and read by the routes that must refuse device tokens
 * whatever the peer address (requireLocalCaller, requireLocalProof, a
 * session's `pid`), and by revocation to find a device's sessions.
 */

import type { IncomingMessage } from 'node:http'

export type RequestAuth =
  /** The install's token (`daemon-token` / ADF_DAEMON_TOKEN). */
  | { kind: 'master' }
  /** A device token (remote-access.md §4). */
  | { kind: 'device'; deviceId: string; label: string }
  /** No token needed (GET /health, /remote/hello, /pair/*) or none configured. */
  | { kind: 'none' }

const auths = new WeakMap<IncomingMessage, RequestAuth>()

export function setRequestAuth(raw: IncomingMessage, auth: RequestAuth): void {
  auths.set(raw, auth)
}

export function getRequestAuth(raw: IncomingMessage | undefined): RequestAuth | undefined {
  return raw ? auths.get(raw) : undefined
}

/** The device id of a request made with a device token, else null. */
export function deviceIdOf(raw: IncomingMessage | undefined): string | null {
  const auth = getRequestAuth(raw)
  return auth?.kind === 'device' ? auth.deviceId : null
}

export const DEVICE_TOKEN_REFUSED_MESSAGE =
  'A device token cannot do this: only this computer\'s own clients (ADF Studio and adf on the host) can. Run it on the host.'
