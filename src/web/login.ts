export interface BrowserSession {
  authenticated: true
  storageScope: string
  recoveryScope: string
}
export type BrowserPairing =
  | { state: 'pending'; expiresAt: string }
  | { state: 'denied' }
  | ({ state: 'approved' } & BrowserSession)

/** Consume the launch fragment before any request or renderer mount. It never
 * becomes a query parameter, browser-storage value, or persistent history entry. */
export function takeLaunchTicket(address: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState' | 'state'>): string | null {
  const fragment = new URLSearchParams(address.hash.slice(1))
  if (!fragment.has('ticket')) return null
  const ticket = fragment.get('ticket')
  fragment.delete('ticket')
  const remainder = fragment.toString()
  history.replaceState(history.state, '', address.pathname + address.search + (remainder ? `#${remainder}` : ''))
  return ticket || ''
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null)
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (!response.ok) throw Object.assign(new Error(typeof body.error === 'string' ? body.error : `Could not connect to Studio (${response.status}).`), { code: body.code, status: response.status })
  return body
}

function session(body: Record<string, unknown>): BrowserSession {
  if (body.authenticated !== true || typeof body.storageScope !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.storageScope) || typeof body.recoveryScope !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.recoveryScope)) {
    throw new Error('Studio returned an incomplete sign-in. Open it again with adf web or the desktop app.')
  }
  return { authenticated: true, storageScope: body.storageScope, recoveryScope: body.recoveryScope }
}

export async function readBrowserSession(signal?: AbortSignal): Promise<BrowserSession | null> {
  const response = await fetch('/web/session', { credentials: 'same-origin', signal })
  if (response.status === 401) return null
  return session(await json(response))
}

export async function redeemLaunchTicket(ticket: string, signal?: AbortSignal): Promise<BrowserSession> {
  return session(await json(await fetch('/web/session', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
  })))
}

export async function startBrowserPairing(code: string, deviceName: string, signal?: AbortSignal): Promise<Extract<BrowserPairing, { state: 'pending' }>> {
  const body = await json(await fetch('/web/pair', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.replace(/[\s-]/g, ''), deviceName: deviceName.trim() }),
  }))
  if (body.state !== 'pending' || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) {
    throw new Error('Studio could not start pairing. Open a new pairing code on the host computer.')
  }
  return { state: 'pending', expiresAt: body.expiresAt }
}

export async function pollBrowserPairing(signal?: AbortSignal): Promise<BrowserPairing> {
  const body = await json(await fetch('/web/pair', { credentials: 'same-origin', signal }))
  if (body.state === 'approved') return { ...session(body), state: 'approved' }
  if (body.state === 'denied') return { state: 'denied' }
  if (body.state === 'pending' && typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt))) {
    return { state: 'pending', expiresAt: body.expiresAt }
  }
  throw new Error('Studio could not complete pairing. Open a new pairing code on the host computer.')
}

/** One expiry renewal per page. Logout cancels it before deleting cookies;
 * even a response that beats AbortSignal must not reload the signed-out page. */
export class BrowserSessionRenewal {
  private controller: AbortController | null = null
  private stopped = false

  async run(preserve: () => Promise<void>, read: (signal: AbortSignal) => Promise<BrowserSession | null>, complete: (session: BrowserSession | null) => void): Promise<void> {
    if (this.stopped || this.controller) return
    const controller = new AbortController()
    this.controller = controller
    await preserve()
    if (this.stopped || controller.signal.aborted) return
    const session = await read(controller.signal)
    if (!this.stopped && !controller.signal.aborted) complete(session)
  }

  stop(): void { this.stopped = true; this.controller?.abort() }
}
