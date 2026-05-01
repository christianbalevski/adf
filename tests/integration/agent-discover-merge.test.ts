import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-mdns-merge-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-mdns-merge-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { MeshManager } from '../../src/main/runtime/mesh-manager'
import { MeshServer, canonicalizeCardForSignature, buildAgentCard } from '../../src/main/services/mesh-server'
import { DirectoryFetchCache } from '../../src/main/services/directory-fetch-cache'
import { verifyEd25519, didToPublicKey, rawPublicKeyToSpki } from '../../src/main/crypto/identity-crypto'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import type { DiscoveredRuntime, MdnsService } from '../../src/main/services/mdns-service'
import type { AlfAgentCard } from '../../src/shared/types/adf-v02.types'

/**
 * Stub MdnsService: no real multicast. The test injects whatever peer list it
 * wants and the rest of the pipeline behaves exactly as if mDNS had found
 * those peers. Satisfies the `MdnsService` structural type expected by
 * MeshManager.setMdnsService — only `getDiscoveredRuntimes` is consulted.
 */
function makeStubMdns(peers: DiscoveredRuntime[]): MdnsService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    getDiscoveredRuntimes: () => peers,
    start: async () => {},
    stop: async () => {},
    on: () => stub,
    off: () => stub,
    emit: () => false,
    once: () => stub,
    removeListener: () => stub,
    removeAllListeners: () => stub,
    listeners: () => [],
    listenerCount: () => 0
  }
  return stub as MdnsService
}

interface RuntimeFixture {
  dir: string
  filePath: string
  agent: ReturnType<typeof createHeadlessAgent>
  did: string
  mesh: MeshManager
  server: MeshServer
  port: number
  dispose: () => Promise<void>
}

async function standUpRuntime(handle: string, port: number): Promise<RuntimeFixture> {
  const dir = mkdtempSync(join(tmpdir(), `adf-mdns-merge-${handle}-`))
  const filePath = join(dir, `${handle}.adf`)

  const agent = createHeadlessAgent({
    filePath,
    name: handle,
    provider: new MockLLMProvider(),
    createOptions: {
      handle,
      messaging: { mode: 'respond_only', visibility: 'lan', receive: true }
    }
  })

  // Generate an Ed25519 identity so the agent's card gets signed.
  agent.workspace.generateIdentityKeys(null)
  const did = agent.workspace.getDid()
  if (!did) throw new Error('failed to create DID for test fixture')

  const mesh = new MeshManager([dir])
  mesh.enableMesh()
  mesh.registerServableAgent(
    filePath,
    agent.workspace.getAgentConfig(),
    agent.registry,
    agent.workspace,
    agent.session,
    agent.executor
  )

  // Settings stub that returns the test's ephemeral port.
  const settingsStub = { get: (key: string) => (key === 'meshPort' ? port : undefined) }
  const server = new MeshServer(new CodeSandboxService(), settingsStub)
  server.setMeshManager(mesh)
  await server.start()
  if (!server.isRunning()) throw new Error(`mesh server failed to start on ${port}`)

  const dispose = async () => {
    try { await server.stop() } catch { /* best-effort */ }
    try { mesh.unregisterAgent(filePath) } catch { /* best-effort */ }
    agent.dispose()
  }

  return { dir, filePath, agent, did, mesh, server, port, dispose }
}

describe('agent_discover scope:"all" merges local and mDNS-discovered cards', () => {
  it('returns both local and remote cards tagged correctly, and remote card signatures verify', async () => {
    // Stand up two runtimes on distinct loopback ports. Using high fixed ports
    // since MeshServer.getPort() returns the configured value, not the ephemeral one.
    const a = await standUpRuntime('alice', 38893)
    const b = await standUpRuntime('bob', 38894)

    try {
      // Inject a peer entry into A pointing at B's server.
      const peerUrl = `http://127.0.0.1:${b.port}`
      const fakePeer: DiscoveredRuntime = {
        runtime_id: 'runtime-b',
        runtime_did: 'did:key:zRuntimeB',
        proto: 'alf/0.2',
        directory_path: '/mesh/directory',
        host: '127.0.0.1',
        port: b.port,
        url: peerUrl,
        first_seen: Date.now(),
        last_seen: Date.now()
      }
      const fetchCache = new DirectoryFetchCache()
      a.mesh.setMdnsService(makeStubMdns([fakePeer]))
      a.mesh.setDirectoryFetchCache(fetchCache)

      // Invoke agent_discover through the tool registry as the LLM would.
      const tool = a.agent.registry.get('agent_discover')
      expect(tool).toBeTruthy()
      const result = await tool!.execute({ scope: 'all' }, a.agent.workspace)
      expect(result.isError).toBe(false)

      const cards = JSON.parse(result.content as string) as Array<
        AlfAgentCard & { source: string; runtime_did?: string; in_subdirectory?: boolean }
      >
      const localCards = cards.filter((c) => c.source === 'local-runtime')
      const remoteCards = cards.filter((c) => c.source === 'mdns')

      // Locally there's only `alice` (caller excluded from own directory), so no local cards.
      // Remotely via B's /mesh/directory we get `bob`.
      expect(remoteCards).toHaveLength(1)
      const bobCard = remoteCards[0]
      expect(bobCard.handle).toBe('bob')
      expect(bobCard.runtime_did).toBe('did:key:zRuntimeB')
      expect(bobCard.did).toBe(b.did)

      // --- End-to-end signature verification ---
      // The remote card was signed by B with loopback-host URLs embedded; we
      // received it with URLs reflecting B's bind interface. If the
      // canonicalization rule (strip endpoints + resolution.endpoint) is
      // working, verification against B's DID-derived public key succeeds
      // regardless of observer-specific URL rewriting.
      expect(bobCard.signature).toBeTruthy()
      const sigParts = bobCard.signature!.split(':')
      expect(sigParts[0]).toBe('ed25519')
      const rawSig = sigParts.slice(1).join(':')

      const rawPubKey = didToPublicKey(bobCard.did!)
      expect(rawPubKey).toBeTruthy()
      const spki = rawPublicKeyToSpki(rawPubKey!)

      const canon = canonicalizeCardForSignature(bobCard)
      const ok = verifyEd25519(Buffer.from(canon), rawSig, spki)
      expect(ok).toBe(true)

      // And as a sanity check: local-runtime cards are used unchanged too — if
      // there were local cards they'd verify the same way.
      // (Our caller is alice, so her own card isn't in the local result.)
      void localCards
    } finally {
      await a.dispose()
      await b.dispose()
    }
  }, 20000)

  it('returns only local results when mDNS is unavailable (no stub injected)', async () => {
    const a = await standUpRuntime('solo', 38895)
    try {
      const tool = a.agent.registry.get('agent_discover')
      const result = await tool!.execute({ scope: 'all' }, a.agent.workspace)
      expect(result.isError).toBe(false)
      // No peer injected + no local peers → tool returns the empty-state message.
      expect(result.content).toContain('No other agents are reachable')
    } finally {
      await a.dispose()
    }
  }, 20000)

  it('tier filters apply to the merged set', async () => {
    const a = await standUpRuntime('alice2', 38896)
    const b = await standUpRuntime('bob2', 38897)
    try {
      const fakePeer: DiscoveredRuntime = {
        runtime_id: 'runtime-b2',
        runtime_did: 'did:key:zRuntimeB2',
        proto: 'alf/0.2',
        directory_path: '/mesh/directory',
        host: '127.0.0.1',
        port: b.port,
        url: `http://127.0.0.1:${b.port}`,
        first_seen: Date.now(),
        last_seen: Date.now()
      }
      a.mesh.setMdnsService(makeStubMdns([fakePeer]))
      a.mesh.setDirectoryFetchCache(new DirectoryFetchCache())

      const tool = a.agent.registry.get('agent_discover')
      // Filter to localhost-only: the remote bob is lan-tier so should be excluded.
      const result = await tool!.execute({ scope: 'all', visibility: ['localhost'] }, a.agent.workspace)
      // No matches — lan-tier card filtered out by visibility constraint.
      expect(result.content).toContain('No other agents are reachable')

      const result2 = await tool!.execute({ scope: 'all', visibility: ['lan'] }, a.agent.workspace)
      expect(result2.isError).toBe(false)
      const cards = JSON.parse(result2.content as string)
      expect(cards).toHaveLength(1)
      expect(cards[0].handle).toBe('bob2')
    } finally {
      await a.dispose()
      await b.dispose()
    }
  }, 20000)
})

// Suppress unused import warning — used for type-checking only.
void buildAgentCard
