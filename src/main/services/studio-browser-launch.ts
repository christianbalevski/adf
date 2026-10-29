import { isIP } from 'node:net'

/** Local credentials and launch tickets must never leave the daemon's origin. */
export function localBrowserOrigin(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash ||
    !(host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.')))) {
    throw new Error('Browser sign-in requires this computer’s local daemon address.')
  }
  return url
}

export function validatedBrowserLaunch(baseUrl: string, value: unknown): string {
  const base = localBrowserOrigin(baseUrl)
  if (typeof value !== 'string') throw new Error('Invalid browser launch address.')
  const target = new URL(value)
  const fragment = new URLSearchParams(target.hash.slice(1))
  const ticket = fragment.get('ticket')
  if (target.origin !== base.origin || target.pathname !== '/studio/' || target.search || target.username || target.password ||
    [...fragment.keys()].length !== 1 || !ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new Error('Invalid browser launch address.')
  }
  return target.href
}
