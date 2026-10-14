// Peer reads (MESH_PEER_AGENT_HEALTH, MESH_PEER_SHARED_FILE and the daemon's
// /network/peers routes) go through the shared egress guard: LAN and http
// allowed, the daemon control port and link-local / metadata refused on every
// hop, the 2 MB cap enforced while streaming. Global fetch is stubbed; IP
// literals keep the guard off DNS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPeerSharedFile, PEER_SHARED_FILE_MAX_BYTES, probePeerHealth } from '../../../src/main/services/peer-fetch'
import { daemonGuardPort } from '../../../src/main/utils/guarded-fetch'

const LAN = 'http://192.168.1.20:7295'
const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('probePeerHealth', () => {
  it('reads a LAN peer over http; error statuses as HTTP n; bad URL and fetch failures', async () => {
    expect(await probePeerHealth('ftp://x')).toEqual({ ok: false, error: 'Bad health URL' })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', state: 'idle' }), { status: 200 }))
    expect(await probePeerHealth(`${LAN}/agent-1/health`)).toEqual({ ok: true, status: 'ok', state: 'idle' })
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) })
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(await probePeerHealth(`${LAN}/agent-1/health`)).toEqual({ ok: false, error: 'HTTP 503' })
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await probePeerHealth(`${LAN}/agent-1/health`)).toEqual({ ok: false, error: 'ECONNREFUSED' })
  })

  it('refuses the daemon control port and the metadata address, also behind a redirect', async () => {
    const daemon = await probePeerHealth(`http://127.0.0.1:${daemonGuardPort()}/health`)
    expect(daemon.ok).toBe(false)
    const metadata = await probePeerHealth('http://169.254.169.254/latest/meta-data')
    expect(metadata.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }))
    const redirected = await probePeerHealth(`${LAN}/agent-1/health`)
    expect(redirected.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1) // the redirect target was never fetched
  })
})

describe('fetchPeerSharedFile', () => {
  it('path checks, encoding, text vs binary', async () => {
    expect(await fetchPeerSharedFile('nope', 'a.txt')).toEqual({ ok: false, error: 'Bad base URL' })
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, '../x')).toEqual({ ok: false, error: 'Bad file path' })
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, '/x')).toEqual({ ok: false, error: 'Bad file path' })
    fetchMock.mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await fetchPeerSharedFile(`${LAN}/agent-1/`, 'docs/a b.txt')).toEqual({ ok: true, mime: 'text/plain', size: 5, binary: false, content: 'hello' })
    expect(fetchMock.mock.calls[0][0]).toBe(`${LAN}/agent-1/docs/a%20b.txt`)
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 0, 2]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, 'b.bin')).toEqual({ ok: true, mime: 'application/octet-stream', size: 3, binary: true, content: Buffer.from([1, 0, 2]).toString('base64') })
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, 'gone.txt')).toEqual({ ok: false, error: 'HTTP 404' })
    fetchMock.mockRejectedValueOnce(new Error('x'))
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, 'a.txt')).toEqual({ ok: false, error: 'Peer unreachable' })
    expect(await fetchPeerSharedFile('http://169.254.169.254', 'a.txt')).toEqual({ ok: false, error: 'Peer unreachable' })
  })

  it('stops reading at the 2 MB cap instead of buffering the whole body', async () => {
    const CHUNK = 64 * 1024
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += CHUNK
        controller.enqueue(new Uint8Array(CHUNK))
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(endless, { status: 200 }))
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, 'big.bin')).toEqual({ ok: false, error: 'File too large to preview (>2 MB)' })
    expect(pulled).toBeLessThan(PEER_SHARED_FILE_MAX_BYTES + 4 * CHUNK)
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'content-length': String(PEER_SHARED_FILE_MAX_BYTES + 1) } }))
    expect(await fetchPeerSharedFile(`${LAN}/agent-1`, 'declared.bin')).toEqual({ ok: false, error: 'File too large to preview (>2 MB)' })
  })
})
