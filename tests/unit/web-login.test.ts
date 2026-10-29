import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionRenewal, pollBrowserPairing, readBrowserSession, redeemLaunchTicket, startBrowserPairing, takeLaunchTicket } from '../../src/web/login'

const authenticated = { authenticated: true, storageScope: 'a'.repeat(32), recoveryScope: 'b'.repeat(64) }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('browser sign-in', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('removes every launch-ticket fragment before any network request and keeps navigation context', async () => {
    const actions: string[] = []
    const history = { state: { tab: 'editor' }, replaceState: vi.fn(() => { actions.push('strip') }) }
    const fetcher = vi.fn(async () => { actions.push('fetch'); return response(authenticated) })
    const storage = { setItem: vi.fn(() => { throw new Error('Credentials must not use browser storage') }) }
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    const ticket = takeLaunchTicket({ pathname: '/studio/', search: '?window=agent&file=test.adf', hash: '#ticket=one-use-secret&section=settings&ticket=duplicate' }, history)
    expect(ticket).toBe('one-use-secret')
    expect(history.replaceState).toHaveBeenCalledWith({ tab: 'editor' }, '', '/studio/?window=agent&file=test.adf#section=settings')
    await expect(redeemLaunchTicket(ticket!)).resolves.toEqual(authenticated)
    expect(actions).toEqual(['strip', 'fetch'])
    expect(fetcher).toHaveBeenCalledWith('/web/session', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ ticket }) }))
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('leaves unrelated fragments intact and distinguishes an empty ticket', () => {
    const history = { state: null, replaceState: vi.fn() }
    expect(takeLaunchTicket({ pathname: '/studio/', search: '', hash: '#settings' }, history)).toBeNull()
    expect(history.replaceState).not.toHaveBeenCalled()
    expect(takeLaunchTicket({ pathname: '/studio/', search: '', hash: '#ticket=' }, history)).toBe('')
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/studio/')
  })

  it('treats an unauthenticated session as signed out without swallowing connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ error: 'Sign in again' }, 401))
      .mockResolvedValueOnce(response({ error: 'Daemon unavailable', code: 'unavailable' }, 503)))
    await expect(readBrowserSession()).resolves.toBeNull()
    await expect(readBrowserSession()).rejects.toMatchObject({ message: 'Daemon unavailable', status: 503, code: 'unavailable' })
  })

  it('rejects incomplete or malformed authenticated replies', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ ...authenticated, storageScope: '' }))
      .mockResolvedValueOnce(response({ ...authenticated, recoveryScope: '../another-user' })))
    for (let i = 0; i < 3; i++) await expect(readBrowserSession()).rejects.toThrow('incomplete sign-in')
  })

  it('preserves an expired one-use-link error without retrying redemption', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: 'This link expired', code: 'ticket_expired' }, 401))
    vi.stubGlobal('fetch', fetcher)
    await expect(redeemLaunchTicket('old-ticket')).rejects.toMatchObject({ message: 'This link expired', status: 401, code: 'ticket_expired' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('starts a pairing request with the entered code and waits for host approval', async () => {
    const signal = new AbortController().signal
    const expiresAt = '2026-10-29T17:30:00.000Z'
    const fetcher = vi.fn().mockResolvedValue(response({ state: 'pending', expiresAt }, 202))
    vi.stubGlobal('fetch', fetcher)
    await expect(startBrowserPairing('123-456', '  My iPad  ', signal)).resolves.toEqual({ state: 'pending', expiresAt })
    expect(fetcher).toHaveBeenCalledWith('/web/pair', expect.objectContaining({ method: 'POST', credentials: 'same-origin', signal, body: JSON.stringify({ code: '123456', deviceName: 'My iPad' }) }))
  })

  it('returns a session only after host approval, preserving denial and wrong-code errors', async () => {
    const expiresAt = '2026-10-29T17:30:00.000Z'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ state: 'pending', expiresAt }))
      .mockResolvedValueOnce(response({ state: 'denied' }))
      .mockResolvedValueOnce(response({ state: 'approved', ...authenticated }))
      .mockResolvedValueOnce(response({ error: 'Wrong pairing code', code: 'wrong_code' }, 403)))
    await expect(pollBrowserPairing()).resolves.toEqual({ state: 'pending', expiresAt })
    await expect(pollBrowserPairing()).resolves.toEqual({ state: 'denied' })
    await expect(pollBrowserPairing()).resolves.toEqual({ state: 'approved', ...authenticated })
    await expect(startBrowserPairing('123456', 'Browser')).rejects.toMatchObject({ status: 403, code: 'wrong_code' })
  })

  it('rejects invalid pairing expiry and approved replies without a usable session', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ state: 'pending', expiresAt: 'never' }))
      .mockResolvedValueOnce(response({ state: 'approved', authenticated: true }))
      .mockResolvedValueOnce(response({ state: 'pending', expiresAt: 123 })))
    await expect(startBrowserPairing('123456', 'Browser')).rejects.toThrow('could not start pairing')
    await expect(pollBrowserPairing()).rejects.toThrow('incomplete sign-in')
    await expect(pollBrowserPairing()).rejects.toThrow('could not complete pairing')
  })

  it('passes cancellation through and never stores or returns an accidental credential field', async () => {
    const signal = new AbortController().signal
    const fetcher = vi.fn().mockResolvedValue(response({ ...authenticated, token: 'must-not-propagate' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(readBrowserSession(signal)).resolves.toEqual(authenticated)
    expect(fetcher).toHaveBeenCalledWith('/web/session', expect.objectContaining({ signal, credentials: 'same-origin' }))
    const aborted = new DOMException('Aborted', 'AbortError')
    fetcher.mockRejectedValueOnce(aborted)
    await expect(pollBrowserPairing(signal)).rejects.toBe(aborted)
  })
})


describe('browser renewal cancellation', () => {
  it('does not issue a renewal after logout while recovery is still pending', async () => {
    const renewal = new BrowserSessionRenewal()
    let saved!: () => void
    const preserve = () => new Promise<void>(resolve => { saved = resolve })
    const read = vi.fn().mockResolvedValue(authenticated)
    const complete = vi.fn()
    const work = renewal.run(preserve, read, complete)
    renewal.stop()
    saved()
    await work
    expect(read).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('aborts an in-flight renewal and ignores a response that wins the abort race', async () => {
    const renewal = new BrowserSessionRenewal()
    let finish!: (session: typeof authenticated) => void
    let signal!: AbortSignal
    const read = vi.fn((abort: AbortSignal) => { signal = abort; return new Promise<typeof authenticated>(resolve => { finish = resolve }) })
    const complete = vi.fn()
    const work = renewal.run(async () => {}, read, complete)
    await Promise.resolve()
    renewal.stop()
    expect(signal.aborted).toBe(true)
    finish(authenticated)
    await work
    expect(complete).not.toHaveBeenCalled()
  })

  it('renews once after successful recovery and refuses renewal if recovery fails', async () => {
    const renewal = new BrowserSessionRenewal()
    const actions: string[] = []
    const read = vi.fn(async () => { actions.push('read'); return authenticated })
    const complete = vi.fn()
    await Promise.all([
      renewal.run(async () => { actions.push('preserve') }, read, complete),
      renewal.run(async () => {}, read, complete),
    ])
    expect(actions).toEqual(['preserve', 'read'])
    expect(complete).toHaveBeenCalledExactlyOnceWith(authenticated)
    const quota = new Error('quota')
    read.mockClear()
    await expect(new BrowserSessionRenewal().run(async () => { throw quota }, read, complete)).rejects.toBe(quota)
    expect(read).not.toHaveBeenCalled()
  })
})
