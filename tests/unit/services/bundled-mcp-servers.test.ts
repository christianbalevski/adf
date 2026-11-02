import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUNDLED_MCP_SERVERS,
  availableBundledMcpServers,
  bundledMcpInstall,
  bundledMcpServerEnv,
  isBundledMcpServerSpawn,
  matchBundledMcpServer,
  resolveBundledMcpSpawn,
  type BundledMcpRuntime,
} from '../../../src/main/services/bundled-mcp-servers'
import { resolveMcpSpawnConfig } from '../../../src/main/services/mcp-spawn-utils'
import { resolveContainerCommand } from '../../../src/main/services/container-command-resolver'
import { PackageResolver } from '../../../src/main/services/mcp-package-resolver'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import { McpRegistryFetchService } from '../../../src/main/services/mcp-registry-fetch.service'
import { buildMcpServerConfigFromRegistration } from '../../../src/shared/utils/mcp-config'
import { MCP_REGISTRY, registrationFromRegistryEntry } from '../../../src/shared/constants/mcp-registry'
import type { McpInstalledPackage, McpServerConfig } from '../../../src/shared/types/adf-v02.types'

const GMAIL = '@gongrzhe/server-gmail-autoauth-mcp'
const STUDIO_EXE = join(tmpdir(), 'ADF Studio', 'ADF Studio.exe')

let resources: string
let entry: string
beforeAll(() => {
  resources = mkdtempSync(join(tmpdir(), 'adf-bundled-mcp-'))
  entry = join(resources, 'mcp-servers', 'gmail', 'index.mjs')
  mkdirSync(join(resources, 'mcp-servers', 'gmail'), { recursive: true })
  writeFileSync(entry, '')
})
afterAll(() => rmSync(resources, { recursive: true, force: true }))

const studio = (): BundledMcpRuntime => ({ resourcesPath: resources, execPath: STUDIO_EXE, electron: true })
const gmailCfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'gmail', transport: 'stdio', npm_package: GMAIL, source: `npm:${GMAIL}`, ...over,
})
const noInstalls = { getInstalled: (): McpInstalledPackage | undefined => undefined }

describe('bundled Gmail server: version pin', () => {
  it('the bundled version is the exact package.json devDependency pin', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8'))
    const gmail = BUNDLED_MCP_SERVERS.find((s) => s.npmPackage === GMAIL)!
    expect(pkg.devDependencies[GMAIL]).toBe(gmail.version)
    expect(pkg.dependencies?.[GMAIL]).toBeUndefined()
  })

  it('matches the catalog entry (which pins no version today; if it ever does, it must be this one)', () => {
    const doc = JSON.parse(readFileSync(join(__dirname, '../../../mcp-registry.json'), 'utf-8'))
    const entry = doc.servers?.find?.((e: { npmPackage?: string }) => e.npmPackage === GMAIL)
      ?? MCP_REGISTRY.find((e) => e.npmPackage === GMAIL)
    expect(entry).toBeDefined()
    const version = (entry as { version?: string }).version
    if (version !== undefined) expect(version).toBe(BUNDLED_MCP_SERVERS[0].version)
    expect(entry!.runLocation).toBe('host')
  })
})

describe('resolveBundledMcpSpawn / matchBundledMcpServer', () => {
  it('the catalog Gmail config runs on Studio\'s executable with the bundled entry', () => {
    expect(resolveBundledMcpSpawn(gmailCfg(), studio())).toMatchObject({ command: STUDIO_EXE, args: [entry] })
  })

  it('a config built from the catalog registration matches', () => {
    const reg = registrationFromRegistryEntry(MCP_REGISTRY.find((e) => e.npmPackage === GMAIL)!, 'r1')
    expect(resolveBundledMcpSpawn(buildMcpServerConfigFromRegistration(reg), studio())?.args).toEqual([entry])
  })

  it('accepts the npx "-y <pkg>" prefix, no source, and a source pinned to the bundled version', () => {
    expect(matchBundledMcpServer(gmailCfg({ args: ['-y', GMAIL] }))).not.toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ source: undefined }))).not.toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ source: `npm:${GMAIL}@${BUNDLED_MCP_SERVERS[0].version}` }))).not.toBeNull()
  })

  it('an edited executable identity is not the bundled server', () => {
    expect(matchBundledMcpServer(gmailCfg({ command: 'node' }))).toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ command: 'npx', args: ['-y', GMAIL] }))).toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ args: ['--extra'] }))).toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ args: ['-y', GMAIL, 'auth'] }))).toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ source: `npm:${GMAIL}@1.2.0` }))).toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ source: 'custom' }))).toBeNull()
    expect(matchBundledMcpServer(gmailCfg({ npm_package: `${GMAIL}-fork`, source: `npm:${GMAIL}-fork` }))).toBeNull()
    expect(matchBundledMcpServer({ npm_package: '@modelcontextprotocol/server-github' })).toBeNull()
  })

  it('no bundled file, no resources dir, or plain Node: null', () => {
    expect(resolveBundledMcpSpawn(gmailCfg(), { ...studio(), resourcesPath: join(resources, 'nope') })).toBeNull()
    expect(resolveBundledMcpSpawn(gmailCfg(), { ...studio(), resourcesPath: undefined })).toBeNull()
    expect(resolveBundledMcpSpawn(gmailCfg(), { ...studio(), electron: false })).toBeNull()
    // The live test process is plain Node with no resourcesPath.
    expect(resolveBundledMcpSpawn(gmailCfg())).toBeNull()
  })
})

describe('resolveMcpSpawnConfig with a bundled server', () => {
  it('bundled present: Studio executable + entry, ahead of a managed install', () => {
    const installed = { getInstalled: () => ({ package: GMAIL, version: '1.1.0', command: '/m/index.js', installPath: '/m', installedAt: 1 }) }
    expect(resolveMcpSpawnConfig(gmailCfg(), { npmResolver: installed, bundledRuntime: studio() })).toEqual({ command: STUDIO_EXE, args: [entry] })
  })

  it('bundled absent: exactly today\'s npx / managed paths', () => {
    const absent = { ...studio(), resourcesPath: undefined }
    const npx = resolveMcpSpawnConfig(gmailCfg(), { npmResolver: noInstalls, bundledRuntime: absent })
    expect(npx.args).toEqual(['-y', GMAIL])
    expect(npx.command).toMatch(/(^|[\\/])npx(\.cmd)?$/i)
    const installed = { getInstalled: () => ({ package: GMAIL, version: '1.1.11', command: '/m/index.js', installPath: '/m', installedAt: 1 }) }
    expect(resolveMcpSpawnConfig(gmailCfg(), { npmResolver: installed, bundledRuntime: absent })).toEqual({ command: 'node', args: ['/m/index.js'] })
  })

  it('other npm packages, uvx and custom commands are unchanged', () => {
    const rt = studio()
    expect(resolveMcpSpawnConfig({ name: 'gh', transport: 'stdio', npm_package: '@acme/gh' }, { npmResolver: noInstalls, bundledRuntime: rt }).args).toEqual(['-y', '@acme/gh'])
    expect(resolveMcpSpawnConfig({ name: 'py', transport: 'stdio', pypi_package: 'mcp-x' }, { npmResolver: noInstalls, uvBinPath: '/bin/uv', bundledRuntime: rt })).toEqual({ command: '/bin/uv', args: ['tool', 'run', 'mcp-x'] })
    expect(resolveMcpSpawnConfig({ name: 'c', transport: 'stdio', command: '/usr/bin/my-mcp', args: ['a'] }, { npmResolver: noInstalls, bundledRuntime: rt })).toEqual({ command: '/usr/bin/my-mcp', args: ['a'] })
  })

  it('an edited Gmail config keeps the npm path even with the bundle present', () => {
    expect(resolveMcpSpawnConfig(gmailCfg({ args: ['--x'] }), { npmResolver: noInstalls, bundledRuntime: studio() }).args).toEqual(['-y', GMAIL, '--x'])
    expect(resolveMcpSpawnConfig(gmailCfg({ command: 'npx', args: ['-y', GMAIL] }), { npmResolver: noInstalls, bundledRuntime: studio() }).args).toEqual(['-y', GMAIL])
  })

  it('a container run is unchanged: npx inside the container', () => {
    expect(resolveContainerCommand(gmailCfg())).toEqual({ command: 'npx', args: ['-y', GMAIL] })
  })
})

describe('ELECTRON_RUN_AS_NODE exception', () => {
  it('only for Studio\'s executable running a bundled entry', () => {
    const rt = studio()
    expect(isBundledMcpServerSpawn(STUDIO_EXE, [entry], rt)).toBe(true)
    expect(bundledMcpServerEnv(STUDIO_EXE, [entry, 'auth'], rt)).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(bundledMcpServerEnv(STUDIO_EXE, ['/tmp/other.mjs'], rt)).toEqual({})
    expect(bundledMcpServerEnv(STUDIO_EXE, [], rt)).toEqual({})
    expect(bundledMcpServerEnv('node', [entry], rt)).toEqual({})
    expect(bundledMcpServerEnv('npx', ['-y', GMAIL], rt)).toEqual({})
    expect(bundledMcpServerEnv(STUDIO_EXE, [entry], { ...rt, resourcesPath: undefined })).toEqual({})
  })

  describe('McpClientManager child env (real spawn)', () => {
    // A tiny stdio MCP server that names its one tool after the
    // ELECTRON_RUN_AS_NODE it was started with.
    const SERVER = `
      const rl = require('readline').createInterface({ input: process.stdin })
      const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'env', version: '1' } } })
        else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'run_as_node_' + (process.env.ELECTRON_RUN_AS_NODE ?? 'unset'), inputSchema: { type: 'object' } }] } })
        else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
      })`
    let liveResources: string
    let liveEntry: string
    let other: string
    const savedResources = (process as { resourcesPath?: string }).resourcesPath
    beforeAll(() => {
      liveResources = mkdtempSync(join(tmpdir(), 'adf-bundled-live-'))
      mkdirSync(join(liveResources, 'mcp-servers', 'gmail'), { recursive: true })
      liveEntry = join(liveResources, 'mcp-servers', 'gmail', 'index.mjs')
      // ESM entry (as the real bundle): require() via createRequire.
      writeFileSync(liveEntry, `import { createRequire } from 'module'; const require = createRequire(import.meta.url);\n${SERVER}`)
      other = join(liveResources, 'other.cjs')
      writeFileSync(other, SERVER)
      ;(process as { resourcesPath?: string }).resourcesPath = liveResources
      Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true, enumerable: true })
    })
    afterAll(() => {
      ;(process as { resourcesPath?: string }).resourcesPath = savedResources
      delete (process.versions as { electron?: string }).electron
      rmSync(liveResources, { recursive: true, force: true })
    })
    let manager: McpClientManager | null = null
    afterEach(async () => { await manager?.disconnectAll(); manager = null })

    it('the bundled spawn gets ELECTRON_RUN_AS_NODE=1', async () => {
      manager = new McpClientManager()
      const tools = await manager.connect({ name: 'gmail', transport: 'stdio', command: process.execPath, args: [liveEntry] })
      expect(tools?.map((t) => t.name)).toEqual(['run_as_node_1'])
    }, 30_000)

    it('any other server cannot get it, not even through its config env', async () => {
      manager = new McpClientManager()
      const tools = await manager.connect({ name: 'other', transport: 'stdio', command: process.execPath, args: [other], env: { ELECTRON_RUN_AS_NODE: '1' } })
      expect(tools?.map((t) => t.name)).toEqual(['run_as_node_unset'])
    }, 30_000)
  })
})

describe('managed install of a bundled server', () => {
  it('reports the bundled copy for the bare package or its pinned spec; nothing else', () => {
    const v = BUNDLED_MCP_SERVERS[0].version
    expect(bundledMcpInstall(GMAIL, studio())).toMatchObject({ package: GMAIL, version: v, command: entry })
    expect(bundledMcpInstall(`${GMAIL}@${v}`, studio())).toMatchObject({ version: v })
    expect(bundledMcpInstall(`${GMAIL}@1.2.0`, studio())).toBeNull()
    expect(bundledMcpInstall('@acme/gh', studio())).toBeNull()
    expect(bundledMcpInstall(GMAIL, { ...studio(), resourcesPath: undefined })).toBeNull()
  })

  it('PackageResolver("mcp-servers").install runs no npm and writes no manifest entry', async () => {
    const savedResources = (process as { resourcesPath?: string }).resourcesPath
    const savedUserData = process.env.ADF_USER_DATA_DIR
    const userData = mkdtempSync(join(tmpdir(), 'adf-bundled-userdata-'))
    ;(process as { resourcesPath?: string }).resourcesPath = resources
    Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true, enumerable: true })
    process.env.ADF_USER_DATA_DIR = userData
    try {
      const resolver = new PackageResolver('mcp-servers')
      const progress: string[] = []
      const installed = await resolver.install(GMAIL, (m) => progress.push(m))
      expect(installed).toMatchObject({ package: GMAIL, version: BUNDLED_MCP_SERVERS[0].version, command: entry })
      expect(progress.join('\n')).toMatch(/built into ADF Studio/)
      expect(resolver.getInstalled(GMAIL)).toBeUndefined()
    } finally {
      ;(process as { resourcesPath?: string }).resourcesPath = savedResources
      delete (process.versions as { electron?: string }).electron
      if (savedUserData === undefined) delete process.env.ADF_USER_DATA_DIR
      else process.env.ADF_USER_DATA_DIR = savedUserData
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

describe('MCP_REGISTRY_GET bundledServers', () => {
  it('reports what this process ships; absent when nothing is bundled', async () => {
    expect(availableBundledMcpServers(studio())).toEqual([{ npmPackage: GMAIL, version: BUNDLED_MCP_SERVERS[0].version }])
    expect(availableBundledMcpServers({ ...studio(), resourcesPath: undefined })).toEqual([])
    const cacheDir = mkdtempSync(join(tmpdir(), 'adf-bundled-registry-'))
    try {
      const opts = { userDataDir: cacheDir, isRemoteEnabled: () => false, bundledFiles: () => [] }
      const withServers = await new McpRegistryFetchService({ ...opts, bundledServers: () => availableBundledMcpServers(studio()) }).getRegistry()
      expect(withServers.bundledServers).toEqual([{ npmPackage: GMAIL, version: BUNDLED_MCP_SERVERS[0].version }])
      const without = await new McpRegistryFetchService({ ...opts, bundledServers: () => [] }).getRegistry()
      expect(without).not.toHaveProperty('bundledServers')
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })
})
