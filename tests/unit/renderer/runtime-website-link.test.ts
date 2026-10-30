import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'
import { openRuntimeWebsiteLink, resolveRuntimeWebsiteLink } from '../../../src/renderer/utils/runtime-website-link'

const local: RuntimeView = { id: 'local', kind: 'local', name: 'Local', url: null, state: 'connected' }
const remote: RuntimeView = { id: 'remote:one', kind: 'remote', name: 'One', url: 'https://one.example:7386', state: 'connected' }
let view: ConnectionsView
let servers: Record<string, { running: boolean; host: string; port: number }>
let api: { platform: string; runtimeId: string; runtime: ReturnType<typeof vi.fn>; listConnections: ReturnType<typeof vi.fn>; getMeshServerStatus: ReturnType<typeof vi.fn> }
const href = '/agents/my-agent/dashboard/?a=1&b=2#totals'

beforeEach(() => {
  view = { current: { ...local }, next: null, rows: [], discovery: null, runtimes: [{ ...local }, { ...remote }] }
  servers = {
    local: { running: true, host: '0.0.0.0', port: 7295 },
    'remote:one': { running: true, host: '127.0.0.1', port: 7297 },
  }
  api = {
    platform: 'darwin', runtimeId: 'local',
    runtime: vi.fn((id: string) => ({ getMeshServerStatus: async () => servers[id] })),
    listConnections: vi.fn(async () => view),
    getMeshServerStatus: vi.fn(async () => servers[api.runtimeId]),
  }
  vi.stubGlobal('window', { adfApi: api, location: { href: 'https://browser-host.example:7386/studio/', search: '' }, open: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('runtime-relative website navigation', () => {
  it('uses the view’s runtime and its mesh port for both local and remote links', async () => {
    expect(await resolveRuntimeWebsiteLink(href, 'local')).toBe(`http://127.0.0.1:7295${href}`)
    expect(await resolveRuntimeWebsiteLink(href, remote.id)).toBe(`http://one.example:7297${href}`)
    expect(api.runtime).toHaveBeenCalledWith(remote.id)
  })

  it('uses an agent window’s own bound surface', async () => {
    api.runtimeId = remote.id
    expect(await resolveRuntimeWebsiteLink(href, remote.id)).toBe(`http://one.example:7297${href}`)
    expect(api.runtime).not.toHaveBeenCalled()
  })

  it('reads the current connection and server port again on the next activation', async () => {
    await resolveRuntimeWebsiteLink(href, remote.id)
    view.runtimes![1].url = 'http://100.100.10.20:7385'
    servers[remote.id].host = '192.168.1.20'
    servers[remote.id].port = 7299
    expect(await resolveRuntimeWebsiteLink(href, remote.id)).toBe(`http://100.100.10.20:7299${href}`)
    expect(api.listConnections).toHaveBeenCalledTimes(2)
  })

  it('rejects a malformed remote connection instead of opening the client’s localhost', async () => {
    view.runtimes![1].url = 'not a URL'
    await expect(resolveRuntimeWebsiteLink(href, remote.id)).rejects.toThrow()
    view.runtimes![1].url = 'file:///tmp/runtime'
    await expect(resolveRuntimeWebsiteLink(href, remote.id)).rejects.toThrow('unavailable')
  })

  it('uses the browser’s server address for Browser Studio’s local runtime', async () => {
    api.platform = 'web'
    delete view.runtimes
    expect(await resolveRuntimeWebsiteLink(href, 'local')).toBe(`http://browser-host.example:7295${href}`)
  })

  it.each(['http://localhost:7295/agents/a/', 'https://custom.example/path?q=1#x', '//other.example/agents/a/', 'adf-file://README.md', '#heading', '/other/path'])('leaves %s untouched without looking up a runtime', async (url) => {
    expect(await resolveRuntimeWebsiteLink(url, 'missing')).toBe(url)
    expect(api.listConnections).not.toHaveBeenCalled()
    expect(api.runtime).not.toHaveBeenCalled()
  })

  it('fails without falling back to the local runtime for an unknown, disconnected or stopped server', async () => {
    await expect(resolveRuntimeWebsiteLink(href, 'missing')).rejects.toThrow('Connect')
    view.runtimes![1].state = 'retrying'
    await expect(resolveRuntimeWebsiteLink(href, remote.id)).rejects.toThrow('Connect')
    view.runtimes![1].state = 'connected'
    servers[remote.id].running = false
    await expect(resolveRuntimeWebsiteLink(href, remote.id)).rejects.toThrow('server is off')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('does not open a result after the document view changes', async () => {
    await openRuntimeWebsiteLink(href, remote.id, () => false)
    expect(window.open).not.toHaveBeenCalled()
    await openRuntimeWebsiteLink(href, remote.id, () => true)
    expect(window.open).toHaveBeenCalledWith(`http://one.example:7297${href}`, '_blank', 'noopener,noreferrer')
  })

  it('reserves a browser tab during the gesture and closes it on failures or stale views', async () => {
    api.platform = 'web'
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    vi.mocked(window.open).mockReturnValue(tab as unknown as Window)
    const opening = openRuntimeWebsiteLink(href, remote.id, () => true)
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab.opener).toBeNull()
    await opening
    expect(tab.location.replace).toHaveBeenCalledWith(`http://one.example:7297${href}`)
    await openRuntimeWebsiteLink(href, remote.id, () => false)
    expect(tab.close).toHaveBeenCalledTimes(1)
    servers[remote.id].running = false
    await expect(openRuntimeWebsiteLink(href, remote.id, () => true)).rejects.toThrow('server is off')
    expect(tab.close).toHaveBeenCalledTimes(2)
  })
})
