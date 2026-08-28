import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// The real guard resolves DNS; unit tests must not. Its own policy is covered
// by tests/unit/tools/sys-fetch-ssrf.test.ts — what matters here is that this
// module CALLS it, on every hop, with the daemon port.
vi.mock('../../../src/main/utils/ssrf-guard', () => ({
  checkFetchTarget: vi.fn(async () => null as string | null),
}))

import { checkFetchTarget as realGuard } from '../../../src/main/utils/ssrf-guard'
import {
  DEFAULT_DAEMON_PORT,
  MAX_FETCH_REDIRECTS,
  daemonGuardPort,
  guardedFetch,
} from '../../../src/main/utils/guarded-fetch'

const checkFetchTarget = vi.mocked(realGuard)

const OK = 'https://example.test/a'

interface ResInit {
  status?: number
  headers?: Record<string, string>
  /** Deliver the body in pieces with no content-length, i.e. chunked. */
  chunks?: string[]
}

/** A Response stand-in with a REAL ReadableStream, so the streaming cap runs. */
function res(body: string, init: ResInit = {}) {
  const status = init.status ?? 200
  const pieces = init.chunks ?? [body]
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
      controller.close()
    },
    cancel() { cancelled = true },
  })
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => init.headers?.[key.toLowerCase()] ?? null },
    body: stream,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    get cancelled() { return cancelled },
  }
}

function routes(map: Record<string, ReturnType<typeof res>>) {
  return vi.fn(async (url: string) => map[url] ?? res('missing', { status: 404 }))
}

const OPTS = { maxBytes: 1024, timeoutMs: 5000 }

describe('guardedFetch', () => {
  beforeEach(() => {
    checkFetchTarget.mockClear()
    checkFetchTarget.mockResolvedValue(null)
  })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ADF_DAEMON_PORT })

  it('returns the body and the content type on a plain success', async () => {
    vi.stubGlobal('fetch', routes({ [OK]: res('hello', { headers: { 'content-type': 'text/plain' } }) }))
    const result = await guardedFetch(OK, OPTS)
    expect(result).toEqual({ bytes: Buffer.from('hello'), contentType: 'text/plain' })
  })

  // The whole point of the module. A single-arg checkFetchTarget call leaves
  // the daemon tier inert, and loopback is default-open — so a catalog that
  // 302s to 127.0.0.1:7385 would reach the unauthenticated control API.
  it('passes daemonPort to the guard on every hop', async () => {
    const hop = 'https://example.test/b'
    vi.stubGlobal('fetch', routes({
      [OK]: res('', { status: 302, headers: { location: hop } }),
      [hop]: res('done'),
    }))

    await guardedFetch(OK, OPTS)

    expect(checkFetchTarget).toHaveBeenCalledTimes(2)
    for (const call of checkFetchTarget.mock.calls) {
      expect(call[1]).toEqual({ allowLocal: false, daemonPort: DEFAULT_DAEMON_PORT })
    }
    expect(checkFetchTarget.mock.calls.map((c) => c[0])).toEqual([OK, hop])
  })

  it('honours ADF_DAEMON_PORT at call time', async () => {
    process.env.ADF_DAEMON_PORT = '9911'
    expect(daemonGuardPort()).toBe(9911)
    vi.stubGlobal('fetch', routes({ [OK]: res('hi') }))
    await guardedFetch(OK, OPTS)
    expect(checkFetchTarget.mock.calls[0][1]).toEqual({ allowLocal: false, daemonPort: 9911 })
  })

  it('falls back to the default port when the env var is unusable', () => {
    process.env.ADF_DAEMON_PORT = 'not-a-port'
    expect(daemonGuardPort()).toBe(DEFAULT_DAEMON_PORT)
  })

  // The https check used to run once, on the URL the caller supplied. The guard
  // itself permits http, so a redirect to http:// was followed.
  it('blocks a redirect that downgrades to http', async () => {
    const insecure = 'http://169.254.169.254/latest/meta-data/'
    const fetchMock = routes({
      [OK]: res('', { status: 302, headers: { location: insecure } }),
      [insecure]: res('AWS credentials'),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await guardedFetch(OK, OPTS)

    expect(result).toEqual({ error: 'only https URLs may be fetched (got "http:")' })
    // Never even attempted.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([OK])
  })

  it('refuses a non-https URL up front', async () => {
    const fetchMock = routes({})
    vi.stubGlobal('fetch', fetchMock)
    expect(await guardedFetch('http://example.test/a', OPTS))
      .toEqual({ error: 'only https URLs may be fetched (got "http:")' })
    expect(await guardedFetch('file:///etc/passwd', OPTS))
      .toEqual({ error: 'only https URLs may be fetched (got "file:")' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces the guard\'s rejection instead of fetching', async () => {
    checkFetchTarget.mockResolvedValue('Blocked: link-local')
    const fetchMock = routes({ [OK]: res('secret') })
    vi.stubGlobal('fetch', fetchMock)
    expect(await guardedFetch(OK, OPTS)).toEqual({ error: 'Blocked: link-local' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops at the redirect cap', async () => {
    const map: Record<string, ReturnType<typeof res>> = {}
    for (let i = 0; i <= MAX_FETCH_REDIRECTS + 2; i++) {
      map[`https://example.test/${i}`] = res('', {
        status: 302,
        headers: { location: `https://example.test/${i + 1}` },
      })
    }
    vi.stubGlobal('fetch', routes(map))
    expect(await guardedFetch('https://example.test/0', OPTS))
      .toEqual({ error: `too many redirects (>${MAX_FETCH_REDIRECTS})` })
  })

  it('reports a redirect with no location header', async () => {
    vi.stubGlobal('fetch', routes({ [OK]: res('', { status: 302 }) }))
    expect(await guardedFetch(OK, OPTS))
      .toEqual({ error: 'redirect without a location header (HTTP 302)' })
  })

  it('refuses an oversized body on the content-length precheck, unread', async () => {
    const big = res('x'.repeat(50), { headers: { 'content-length': '99999' } })
    vi.stubGlobal('fetch', routes({ [OK]: big }))
    expect(await guardedFetch(OK, { maxBytes: 10, timeoutMs: 5000 }))
      .toEqual({ error: 'exceeds 10 bytes' })
    expect(big.cancelled).toBe(true)
  })

  // A chunked response declares no length. Buffering it first and measuring
  // afterwards is an OOM waiting for a hostile catalog.
  it('aborts a chunked body mid-stream at the cap', async () => {
    const chunked = res('', { chunks: Array.from({ length: 100 }, () => 'x'.repeat(64)) })
    vi.stubGlobal('fetch', routes({ [OK]: chunked }))
    expect(await guardedFetch(OK, { maxBytes: 100, timeoutMs: 5000 }))
      .toEqual({ error: 'exceeds 100 bytes' })
    expect(chunked.cancelled).toBe(true)
  })

  it('accepts a chunked body that fits', async () => {
    vi.stubGlobal('fetch', routes({ [OK]: res('', { chunks: ['abc', 'def', 'ghi'] }) }))
    expect(await guardedFetch(OK, OPTS)).toEqual({ bytes: Buffer.from('abcdefghi'), contentType: '' })
  })

  it('reports a non-2xx status and an invalid URL without throwing', async () => {
    vi.stubGlobal('fetch', routes({}))
    expect(await guardedFetch(OK, OPTS)).toEqual({ error: 'HTTP 404 Error' })
    expect(await guardedFetch('not a url', OPTS)).toEqual({ error: 'invalid URL: not a url' })
  })

  it('returns a network error rather than throwing it at the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await guardedFetch(OK, OPTS)).toEqual({ error: 'ECONNREFUSED' })
  })
})
