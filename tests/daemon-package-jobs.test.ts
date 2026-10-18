// W3-C daemon routes: package installs as jobs (package-job-routes.ts) and an
// agent file's config by path (agent-file-config-routes.ts). The package
// services are fakes: nothing runs npm, uv or the network.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-package-jobs-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-package-jobs-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi, type DaemonHttpApiOptions } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function setup(opts: Partial<DaemonHttpApiOptions> = {}) {
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), opts)
  cleanups.push(() => server.close())
  return server
}
type Server = ReturnType<typeof setup>

async function awaitJob(server: Server, jobId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 500; i++) {
    const job = (await server.inject({ method: 'GET', url: `/jobs/${jobId}` })).json()
    if (job.state !== 'running') return job
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`job ${jobId} still running`)
}

/** A package service whose install reports two lines, then answers or throws (assertNpmSpec's words). */
function fakeResolver() {
  return {
    install: vi.fn(async (name: string, onProgress?: (m: string) => void) => {
      if (name.includes(' ')) throw new Error(`Invalid npm package name: ${name}`)
      onProgress?.(`Installing ${name}...`)
      onProgress?.(`Installed ${name}@1.0.0`)
      return { package: name, version: '1.0.0', command: '/x/bin.js', installPath: '/x', installedAt: 1 }
    }),
    uninstall: vi.fn(async () => {}),
    listInstalled: vi.fn(() => []),
  }
}

describe('POST /admin/*/packages/*/jobs', () => {
  it('npm: 202, progress on the job, the result as Studio answers it', async () => {
    const npm = fakeResolver()
    const server = setup({ mcpPackageService: npm })
    const res = await server.inject({ method: 'POST', url: '/admin/mcp/packages/npm/jobs', payload: { package: '@acme/server' } })
    expect(res.statusCode).toBe(202)
    expect(res.json().job).toMatchObject({ kind: 'mcp.install.npm', state: 'running' })
    const job = await awaitJob(server, res.json().jobId)
    expect(job.result).toEqual({ success: true, installed: { package: '@acme/server', version: '1.0.0', command: '/x/bin.js', installPath: '/x', installedAt: 1 } })
    expect(job.progressLog).toEqual([
      { seq: 1, text: 'Installing @acme/server...', detail: { package: '@acme/server' } },
      { seq: 2, text: 'Installed @acme/server@1.0.0', detail: { package: '@acme/server' } },
    ])
  })

  it('a failed install is a finished job whose result carries String(error)', async () => {
    const server = setup({ adapterPackageService: fakeResolver() })
    const res = await server.inject({ method: 'POST', url: '/admin/adapters/packages/jobs', payload: { package: 'not a package' } })
    const job = await awaitJob(server, res.json().jobId)
    expect(job).toMatchObject({ state: 'succeeded', result: { success: false, error: 'Error: Invalid npm package name: not a package' } })
  })

  it('python passes the version; a second request for the same package joins the running job', async () => {
    let release!: () => void
    const python = {
      install: vi.fn((_name: string, _version?: string) => new Promise<unknown>((r) => { release = () => r({ package: 'mcp-x', version: '2.0.0' }) })),
      uninstall: vi.fn(async () => {}),
      listInstalled: vi.fn(() => []),
    }
    const server = setup({ mcpPythonPackageService: python })
    const first = (await server.inject({ method: 'POST', url: '/admin/mcp/packages/python/jobs', payload: { package: 'mcp-x', version: '2.0.0' } })).json()
    const second = (await server.inject({ method: 'POST', url: '/admin/mcp/packages/python/jobs', payload: { package: 'mcp-x', version: '2.0.0' } })).json()
    expect(second).toMatchObject({ jobId: first.jobId, job: { joined: true } })
    await vi.waitFor(() => expect(python.install).toHaveBeenCalledTimes(1))
    expect(python.install.mock.calls[0].slice(0, 2)).toEqual(['mcp-x', '2.0.0'])
    release()
    expect((await awaitJob(server, first.jobId)).result).toEqual({ success: true, installed: { package: 'mcp-x', version: '2.0.0' } })
  })

  it('sandbox: one job installs each package in turn; a failure does not stop the rest', async () => {
    const sandbox = {
      install: vi.fn(async (name: string, version?: string, onProgress?: (m: string) => void) => {
        if (name === 'bad') throw new Error('Invalid npm package name: bad!')
        onProgress?.(`Installing ${name}@${version}...`)
        return { name, version: version ?? '1.0.0', size_mb: 1, already_installed: false }
      }),
      uninstall: vi.fn(() => true),
      checkMissing: vi.fn(() => []),
      getInstalledModules: vi.fn(() => []),
      getInstalledPackages: vi.fn(() => []),
      getBasePath: vi.fn(() => '/sandbox'),
    }
    const server = setup({ sandboxPackageService: sandbox })
    const res = await server.inject({ method: 'POST', url: '/admin/sandbox/packages/jobs', payload: { packages: [{ name: 'bad', version: '1.0.0' }, { name: 'lodash', version: '4.17.21' }] } })
    const job = await awaitJob(server, res.json().jobId)
    expect(job.result).toEqual({
      success: true,
      results: { bad: { success: false, error: 'Error: Invalid npm package name: bad!' }, lodash: { success: true, version: '4.17.21' } },
    })
    expect(sandbox.install.mock.calls.map((c) => c[0])).toEqual(['bad', 'lodash'])
    expect(job.progressLog).toEqual([{ seq: 1, text: 'Installing lodash@4.17.21...', detail: { package: 'lodash' } }])
  })

  it('400 without a package, 503 without the service', async () => {
    const server = setup({ mcpPackageService: fakeResolver() })
    expect((await server.inject({ method: 'POST', url: '/admin/mcp/packages/npm/jobs', payload: {} })).statusCode).toBe(400)
    expect((await server.inject({ method: 'POST', url: '/admin/sandbox/packages/jobs', payload: { packages: [] } })).statusCode).toBe(503)
    expect((await server.inject({ method: 'POST', url: '/admin/mcp/packages/python/jobs', payload: { package: 'x' } })).json()).toEqual({ error: 'MCP Python package service is not configured.', code: 'unavailable' })
  })
})

describe('GET /files/agent/config', () => {
  it("a closed file's config, read without writing; refusals as the other /files routes", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-file-config-')))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const filePath = join(dir, 'agent-1.adf')
    const ws = AdfWorkspace.create(filePath, { name: 'agent-1', handle: 'agent-1' })
    const config = ws.getAgentConfig()
    config.adapters = { telegram: { enabled: false, policy: { dm: 'allowlist', allow_from: ['42'] } } } as never
    ws.setAgentConfig(config)
    const id = config.id
    ws.close()
    const server = setup()
    const res = await server.inject({ method: 'GET', url: `/files/agent/config?path=${encodeURIComponent(filePath)}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ agentId: id, loaded: false, config: { id, adapters: { telegram: { enabled: false, policy: { dm: 'allowlist', allow_from: ['42'] } } } } })
    expect((await server.inject({ method: 'GET', url: '/files/agent/config' })).statusCode).toBe(400)
    expect((await server.inject({ method: 'GET', url: `/files/agent/config?path=${encodeURIComponent(join(dir, 'missing.adf'))}` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: `/files/agent/config?path=${encodeURIComponent(join(dir, 'notes.txt'))}` })).statusCode).toBe(400)
  })
})
