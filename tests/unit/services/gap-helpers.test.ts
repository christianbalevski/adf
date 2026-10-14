// Characterization of the smaller Studio handler bodies that moved into
// shared modules for the daemon's gap routes (rule E1), written against
// ipc/index.ts before the move:
//   ADAPTER_GET_STATUS (getAdapterStatus)     -> services/adapter-status.ts
//   MESH_PEER_AGENT_HEALTH, MESH_PEER_SHARED_FILE -> services/peer-fetch.ts (peer-fetch.test.ts)
//   SKILLS_CATALOG_GET, SKILLS_PACKAGE_GET    -> services/skills-catalog-fetch.ts
//   MCP_ENSURE_PYTHON_RUNTIME, MCP_OAUTH_STATUS, MCP_OAUTH_SIGNOUT
//                                             -> services/mcp-connect-tests.ts
//   COMPUTE_BROWSER_INFO                      -> services/compute-browser-info.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const guarded = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../../src/main/utils/guarded-fetch', async (orig) => ({ ...(await orig<object>()), guardedFetch: guarded.fn }))

import { mergeAdapterStates } from '../../../src/main/services/adapter-status'
import { fetchSkillPackage, fetchSkillsCatalog } from '../../../src/main/services/skills-catalog-fetch'
import { ensurePythonRuntime, mcpOAuthSignOut, mcpOAuthStatus } from '../../../src/main/services/mcp-connect-tests'
import { getComputeBrowserInfo } from '../../../src/main/services/compute-browser-info'
import { isolatedContainerName } from '../../../src/main/services/podman.service'
import { MAX_CATALOG_BYTES, MAX_SKILL_PACKAGE_BYTES } from '../../../src/shared/schemas/skills-catalog.schema'

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); guarded.fn.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('mergeAdapterStates', () => {
  it('dedupes by type (healthiest wins) and lists per agent without logs', () => {
    const a = [{ type: 'telegram', status: 'error', error: 'x', logs: ['l1'] }, { type: 'email', status: 'stopped', logs: [] }]
    const b = [{ type: 'telegram', status: 'connected', connectedAt: 5, logs: ['l2'] }]
    const result = mergeAdapterStates([
      { filePath: '/a/agent-1.adf', states: a as never },
      { filePath: null, states: [] },
      { filePath: '/a/agent-2.adf', states: b as never },
    ])
    expect(result.adapters).toEqual([b[0], a[1]])
    expect(result.perAgent).toEqual([
      { filePath: '/a/agent-1.adf', adapters: [{ type: 'telegram', status: 'error', error: 'x', connectedAt: undefined }, { type: 'email', status: 'stopped', error: undefined, connectedAt: undefined }] },
      { filePath: '/a/agent-2.adf', adapters: [{ type: 'telegram', status: 'connected', error: undefined, connectedAt: 5 }] },
    ])
  })
})

describe('skills catalog fetches', () => {
  it('catalog: https only, guarded fetch with caps, JSON + schema checks', async () => {
    expect(await fetchSkillsCatalog('http://x.test/c.json')).toEqual({ ok: false, error: 'Catalog URL must be https' })
    guarded.fn.mockResolvedValueOnce({ error: 'request timed out after 10000ms' })
    expect(await fetchSkillsCatalog('https://x.test/c.json')).toEqual({ ok: false, error: 'request timed out after 10000ms' })
    expect(guarded.fn).toHaveBeenLastCalledWith('https://x.test/c.json', { maxBytes: MAX_CATALOG_BYTES, timeoutMs: 10_000 })
    guarded.fn.mockResolvedValueOnce({ bytes: Buffer.from('{nope') })
    expect(await fetchSkillsCatalog('https://x.test/c.json')).toEqual({ ok: false, error: 'Catalog is not valid JSON' })
    guarded.fn.mockResolvedValueOnce({ bytes: Buffer.from('{"what":1}') })
    expect(await fetchSkillsCatalog('https://x.test/c.json')).toEqual({ ok: false, error: 'Unrecognized catalog schema' })
  })

  it('package: https only, binary refused, text returned', async () => {
    expect(await fetchSkillPackage('ftp://x')).toEqual({ ok: false, error: 'Package URL must be https' })
    guarded.fn.mockResolvedValueOnce({ bytes: Buffer.from([0, 1]) })
    expect(await fetchSkillPackage('https://x.test/SKILL.md')).toEqual({ ok: false, error: 'SKILL.md is not text' })
    expect(guarded.fn).toHaveBeenLastCalledWith('https://x.test/SKILL.md', { maxBytes: MAX_SKILL_PACKAGE_BYTES, timeoutMs: 10_000 })
    guarded.fn.mockResolvedValueOnce({ bytes: Buffer.from('# Skill') })
    expect(await fetchSkillPackage('https://x.test/SKILL.md')).toEqual({ ok: true, content: '# Skill' })
  })
})

describe('python runtime and MCP OAuth status', () => {
  it('ensures uv, then Python when missing', async () => {
    const uv = { ensureUv: vi.fn(async () => '/bin/uv'), getUvVersion: vi.fn(async () => '0.5.0'), isPythonAvailable: vi.fn(async () => false), ensurePython: vi.fn(async () => {}) }
    expect(await ensurePythonRuntime(uv)).toEqual({ success: true, uvAvailable: true, uvVersion: '0.5.0', pythonAvailable: true, uvPath: '/bin/uv' })
    expect(uv.ensurePython).toHaveBeenCalled()
    uv.ensureUv.mockRejectedValueOnce(new Error('offline'))
    expect(await ensurePythonRuntime(uv)).toEqual({ success: false, error: 'Error: offline', uvAvailable: false, pythonAvailable: false })
  })

  it('status is a signed-in flag only; sign-out clears the whole record', async () => {
    const SECRET = 'at-SECRET-1'
    const store = { get: vi.fn(async () => ({ tokens: { access_token: SECRET, token_type: 'bearer' }, updatedAt: 1 })), save: vi.fn(), invalidate: vi.fn(async () => {}) }
    const status = await mcpOAuthStatus(store, { url: 'https://mcp.example.test/mcp' })
    expect(status).toEqual({ signedIn: true })
    expect(JSON.stringify(status)).not.toContain(SECRET)
    expect(await mcpOAuthStatus(store, {})).toEqual({ signedIn: false })
    store.get.mockRejectedValueOnce(new Error('locked'))
    expect(await mcpOAuthStatus(store, { url: 'https://mcp.example.test/mcp' })).toEqual({ signedIn: false })
    expect(await mcpOAuthSignOut(store, { url: 'https://mcp.example.test/mcp' })).toEqual({ success: true })
    expect(store.invalidate).toHaveBeenCalledWith('https://mcp.example.test/mcp', 'all')
    expect(await mcpOAuthSignOut(store, { url: '' })).toEqual({ success: false, error: 'A server url is required to sign out.' })
    store.invalidate.mockRejectedValueOnce(new Error('cannot write'))
    expect(await mcpOAuthSignOut(store, { url: 'https://mcp.example.test/mcp' })).toEqual({ success: false, error: 'cannot write' })
  })
})

describe('getComputeBrowserInfo', () => {
  it('only a ready container gets the browser bring-up and the noVNC port', async () => {
    const podman = {
      containerPhase: vi.fn(async () => ({ phase: 'starting', detail: 'pulling' })),
      browserReady: vi.fn(async () => {}),
      getNovncHostPort: vi.fn(async () => 6080),
    }
    const name = isolatedContainerName('agent-1', 'abc')
    expect(await getComputeBrowserInfo(podman, { agentName: 'agent-1', agentId: 'abc' })).toEqual({ containerName: name, hostPort: null, phase: 'starting', detail: 'pulling' })
    expect(podman.browserReady).not.toHaveBeenCalled()
    podman.containerPhase.mockResolvedValueOnce({ phase: 'ready', detail: undefined } as never)
    podman.browserReady.mockRejectedValueOnce(new Error('no display'))
    expect(await getComputeBrowserInfo(podman, { agentName: 'agent-1', agentId: 'abc' })).toEqual({ containerName: name, hostPort: 6080, phase: 'ready', detail: 'no display' })
  })
})
