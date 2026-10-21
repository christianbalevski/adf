/**
 * The fleet map's peer traffic events (docs/design/multi-runtime.md §6.4): a
 * message leaving for another runtime names the recipient (toPeerAgent), a
 * message arriving from one names the sender (fromPeerAgent), so a map that
 * manages both runtimes draws the trace tile to tile.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-peer-traffic-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-peer-traffic-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { MeshManager } from '../../../src/main/runtime/mesh-manager'
import type { AlfMessage } from '../../../src/shared/types/adf-v02.types'

const RT_PEER = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d'
const DID_PEER_AGENT = 'did:key:z6Mk-agent-2-peer'

function mesh() {
  const m = new MeshManager([mkdtempSync(join(tmpdir(), 'adf-peer-traffic-'))])
  m.setMdnsService({ getDiscoveredRuntimes: () => [{ runtime_id: RT_PEER, url: 'http://192.168.1.30:7295' }] } as never)
  const events: unknown[] = []
  m.on('mesh_event', (e) => events.push(e))
  return { m: m as unknown as Record<string, (...a: unknown[]) => void>, events }
}

describe('peer traffic events', () => {
  it('a message arriving from a peer names its sender', () => {
    const { m, events } = mesh()
    m.emitPeerStationIngress('/home/u/agents/agent-1.adf', 'http://192.168.1.30:7295/agents/agent-2/inbox', DID_PEER_AGENT)
    expect(events).toEqual([{
      type: 'message_routed',
      payload: { filePath: `station:peer:${RT_PEER}`, toFilePaths: ['/home/u/agents/agent-1.adf'], fromPeerAgent: { runtimeId: RT_PEER, id: DID_PEER_AGENT } },
      timestamp: expect.any(Number),
    }])
  })

  it('without a sender DID the event is as before', () => {
    const { m, events } = mesh()
    m.emitPeerStationIngress('/home/u/agents/agent-1.adf', 'http://192.168.1.30:7295/agents/agent-2/inbox')
    expect((events[0] as { payload: unknown }).payload).toEqual({ filePath: `station:peer:${RT_PEER}`, toFilePaths: ['/home/u/agents/agent-1.adf'] })
  })

  it('a message leaving for a peer names its recipient', () => {
    const { m, events } = mesh()
    m.emitPeerStationTraffic('/home/u/agents/agent-1.adf', 'http://192.168.1.30:7295/agents/agent-2/inbox', DID_PEER_AGENT)
    expect((events[0] as { payload: unknown }).payload).toEqual({ filePath: '/home/u/agents/agent-1.adf', toFilePaths: [`station:peer:${RT_PEER}`], toPeerAgent: { runtimeId: RT_PEER, id: DID_PEER_AGENT } })
  })
})

describe('B4: an arrival names its sender only when the sender was verified', () => {
  const RECIPIENT = 'agent-1'

  async function arrival(sign: boolean, transport?: (did: string) => { identityVerified?: boolean; remoteDid?: string }) {
    const { createHeadlessAgent, MockLLMProvider } = await import('../../../src/main/runtime/headless')
    const { signMessageMiddleware } = await import('../../../src/main/services/alf-pipeline')
    const { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } = await import('../../../src/main/crypto/identity-crypto')
    const base = mkdtempSync(join(tmpdir(), 'adf-peer-ingress-'))
    const file = join(base, `${RECIPIENT}.adf`)
    const recipient = createHeadlessAgent({ filePath: file, name: RECIPIENT, provider: new MockLLMProvider(), createOptions: { handle: RECIPIENT, messaging: { mode: 'respond_only', receive: true } as never } })
    const m = new MeshManager([base])
    m.enableMesh()
    m.registerServableAgent(file, recipient.workspace.getAgentConfig(), recipient.registry, recipient.workspace, recipient.session, recipient.executor, null, null, null)
    m.setMdnsService({ getDiscoveredRuntimes: () => [{ runtime_id: RT_PEER, url: 'http://192.168.1.30:7295' }] } as never)
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    m.on('mesh_event', (e) => events.push(e as never))
    // The sender: agent-2 of the peer runtime, with its own key.
    const keys = generateEd25519KeyPair()
    const did = publicKeyToDid(extractRawPublicKey(keys.publicKey))
    let message: AlfMessage = {
      version: '0.1', network: 'devnet', id: `m-${sign}`, timestamp: '2026-10-21T00:00:00Z',
      from: did, to: recipient.workspace.getDid()!, reply_to: 'http://192.168.1.30:7295/agents/agent-2/inbox',
      payload: { content: 'hello', content_type: 'text/plain', sent_at: '2026-10-21T00:00:00Z' },
    }
    if (sign) {
      const ctx = { direction: 'egress', workspace: { getSigningKeys: () => keys }, localDid: did, remoteDid: message.to, isLocal: false, security: { level: 1 }, derivedKey: null }
      message = (await signMessageMiddleware(message, ctx as never)).data
    }
    try {
      expect((await m.processIngressMessage(file, message, undefined, 'mesh', transport?.(did))).success).toBe(true)
      return { did, routed: events.filter((e) => e.type === 'message_routed').map((e) => e.payload) }
    } finally {
      m.unregisterAgent(file)
      recipient.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  }

  it('unsigned (allowed by default): drawn from the peer station, no sender named', async () => {
    const { routed } = await arrival(false)
    expect(routed).toEqual([{ filePath: `station:peer:${RT_PEER}`, toFilePaths: [expect.stringContaining(RECIPIENT)] }])
  })

  it('signed by the DID it is from: the sender is named, so a managed sender is drawn from its tile', async () => {
    const { did, routed } = await arrival(true)
    expect(routed).toEqual([{ filePath: `station:peer:${RT_PEER}`, toFilePaths: [expect.stringContaining(RECIPIENT)], fromPeerAgent: { runtimeId: RT_PEER, id: did } }])
  })

  it('a transport that verified the sender\'s DID itself names it; one that verified another DID does not', async () => {
    const same = await arrival(false, (did) => ({ identityVerified: true, remoteDid: did }))
    expect(same.routed[0]).toEqual(expect.objectContaining({ fromPeerAgent: { runtimeId: RT_PEER, id: same.did } }))
    const other = await arrival(false, () => ({ identityVerified: true, remoteDid: 'did:key:z6Mk-other' }))
    expect(other.routed[0]).not.toHaveProperty('fromPeerAgent')
    const unverified = await arrival(false, (did) => ({ identityVerified: false, remoteDid: did }))
    expect(unverified.routed[0]).not.toHaveProperty('fromPeerAgent')
  })
})
