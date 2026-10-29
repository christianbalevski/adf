import { describe, expect, it, vi } from 'vitest'
import { openStudioInBrowser } from '../../src/main/backend/open-studio-browser'
import type { DaemonClient } from '../../src/shared/daemon-client'

const ticket = 't'.repeat(43)
function setup(url = `http://127.0.0.1:7385/studio/#ticket=${ticket}`, baseUrl = 'http://127.0.0.1:7385') {
  const request = vi.fn(async () => ({ url }))
  const runtime = { kind: 'local' as const, connection: { baseUrl }, client: vi.fn(async () => ({ request }) as unknown as DaemonClient) }
  const open = vi.fn(async () => {})
  return { runtime, request, open }
}

describe('desktop Open in browser', () => {
  it('mints through the trusted local client, opens its one-use link and returns no ticket', async () => {
    const h = setup()
    const result = await openStudioInBrowser(h.runtime, h.open)
    expect(h.request).toHaveBeenCalledExactlyOnceWith('POST', '/web/launch')
    expect(h.open).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:7385/studio/#ticket=${ticket}`)
    expect(result).toEqual({ success: true })
    expect(JSON.stringify(result)).not.toContain(ticket)
  })

  it.each([
    `https://example.org/studio/#ticket=${ticket}`,
    `http://127.0.0.1:9999/studio/#ticket=${ticket}`,
    `http://127.0.0.1:7385/another/#ticket=${ticket}`,
    `http://127.0.0.1:7385/studio/?token=secret#ticket=${ticket}`,
    `http://user:secret@127.0.0.1:7385/studio/#ticket=${ticket}`,
    `http://127.0.0.1:7385/studio/#ticket=${ticket}&ticket=${ticket}`,
    'http://127.0.0.1:7385/studio/#ticket=short',
    'javascript:alert(1)',
  ])('never opens an invalid launch target: %s', async (url) => {
    const h = setup(url)
    expect(await openStudioInBrowser(h.runtime, h.open)).toMatchObject({ success: false })
    expect(h.open).not.toHaveBeenCalled()
  })

  it('refuses embedded and remote-only modes without requesting a ticket', async () => {
    const h = setup()
    expect(await openStudioInBrowser(null, h.open)).toMatchObject({ success: false, error: expect.stringContaining('Local server') })
    expect(await openStudioInBrowser({ ...h.runtime, kind: 'remote' }, h.open)).toMatchObject({ success: false })
    expect(h.request).not.toHaveBeenCalled()
  })

  it('never sends the launch request to a non-loopback endpoint', async () => {
    const h = setup(undefined, 'http://127.attacker.test:7385')
    expect(await openStudioInBrowser(h.runtime, h.open)).toMatchObject({ success: false })
    expect(h.request).not.toHaveBeenCalled()
  })

  it('reports older daemons and does not expose shell errors containing the ticket', async () => {
    const h = setup()
    h.request.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    expect(await openStudioInBrowser(h.runtime, h.open)).toMatchObject({ success: false, error: expect.stringContaining('Update the local daemon') })
    h.open.mockRejectedValueOnce(new Error(`Could not launch ${ticket}`))
    const result = await openStudioInBrowser(h.runtime, h.open)
    expect(result).toMatchObject({ success: false })
    expect(JSON.stringify(result)).not.toContain(ticket)
  })
})
