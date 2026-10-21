/**
 * The fleet map's peer traffic events (docs/design/multi-runtime.md §6.4): a
 * message leaving for another runtime names the recipient (toPeerAgent), a
 * message arriving from one names the sender (fromPeerAgent), so a map that
 * manages both runtimes draws the trace tile to tile.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
