/**
 * The Mesh view with more than one runtime (docs/design/multi-runtime.md
 * §6.4): a message between two runtimes of the set is drawn tile to tile,
 * both ways and once; a handle on two runtimes is two agents; a runtime of
 * the set is not also drawn as a peer station when its peer record carries
 * what its connection checked (the pinned fingerprint, the runtime DID read
 * over it), and only then; a peer paired since takes its station's ground;
 * managed regions are solid, peer stations dashed ("Peer").
 *
 * No jsdom: the hook's one effect runs inline in a static render, frames are
 * flushed by hand. Every runtime surface is a stub (no keychain, no settings
 * file, no port).
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'
import type { FleetAgentStatus, MeshDebugInfo, MeshEvent } from '../../../src/shared/types/ipc.types'

;(globalThis as { React?: typeof React }).React = React

// A static render reads a zustand store's server snapshot, its initial state; here, the state the test set.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>()
  const create = ((init: Parameters<typeof z.createStore>[0]) => {
    const api = z.createStore(init)
    api.getInitialState = api.getState
    const hook = (selector?: (s: unknown) => unknown) => z.useStore(api, selector as never)
    return Object.assign(hook, api)
  }) as unknown as typeof z.create
  return { ...z, create }
})

// Effects do not run in a static render; the mesh hook's subscription effect runs inline.
vi.mock('react', async (importOriginal) => {
  const r = await importOriginal<typeof import('react')>()
  const useEffect = ((fn: () => unknown, deps?: unknown[]) => {
    if (String(fn).includes('onMeshEvent')) fn()
    return r.useEffect(fn as never, deps as never)
  }) as typeof r.useEffect
  return { ...r, default: { ...r, useEffect }, useEffect }
})

const HOST_1 = 'remote:host-1'
const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://192.168.1.20:7386', state: 'connected' }
const FP_1 = 'ABCD-EFGH'
/** Where each runtime is proven (S2): host-1 at its connection's host, This computer at its own address. */
const AT_HOST_1 = 'http://192.168.1.20:7295'
const AT_LOCAL = 'http://192.168.1.10:7295'
const LAN_IPS = { getMeshServerLanIps: async () => ({ hostname: 'host-0', addresses: [{ iface: 'eth0', address: '192.168.1.10', family: 'IPv4', mac: '' }] }) }

const LOCAL_ROOT = '/home/u/agents'
const HOST_ROOT = '/srv/agents'
const A1 = `${LOCAL_ROOT}/agent-1.adf`
const A2 = `${LOCAL_ROOT}/agent-2.adf`
const B1 = `${HOST_ROOT}/agent-1.adf`
const B2 = `${HOST_ROOT}/agent-2.adf`
const KEY_B1 = `${HOST_1}\n${B1}`
const KEY_B2 = `${HOST_1}\n${B2}`
const DID_A1 = 'did:key:z6Mk-agent-1-local'
const DID_B1 = 'did:key:z6Mk-agent-1-host-1'
const DID_B2 = 'did:key:z6Mk-agent-2-host-1'
const RT_LOCAL = '7c1e0a4b-2f3d-4e5a-9b6c-1d2e3f4a5b6c'
const RT_HOST_1 = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f'
const RT_PEER = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d'

function agent(filePath: string, did: string | undefined, root: string): FleetAgentStatus {
  return { filePath, handle: filePath.split('/').pop()!.replace('.adf', ''), did, state: 'idle', participating: true, online: true, trackedDirRoot: root } as FleetAgentStatus
}

function view(runtimes: RuntimeView[], fingerprint: string | null = FP_1): ConnectionsView {
  return {
    current: { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' },
    next: null,
    rows: runtimes.filter((r) => r.kind === 'remote').map((r) => ({ id: r.id, kind: 'saved', name: r.name, state: r.state, action: null, url: r.url, address: null, fingerprint, encrypted: true, pairingOpen: false, removable: true })),
    discovery: null,
    ...(runtimes.length > 1 ? { runtimes } : {}),
  }
}

/** A runtime's surface: `impl` answers, a subscription records its callback, anything else never answers. */
function surface(runtimeId: string | undefined, impl: Record<string, unknown>, subs: Record<string, (...a: unknown[]) => void>) {
  return new Proxy(impl, {
    get: (target, p) => {
      if (typeof p !== 'string' || p === 'then') return undefined
      if (p === 'runtimeId') return runtimeId
      if (p in target) return target[p]
      if (p.startsWith('on')) return (cb: (...a: unknown[]) => void) => { subs[`${runtimeId ?? 'local'}:${p}`] = cb; return () => {} }
      return () => new Promise(() => {})
    },
  })
}

let frames: Array<() => void> = []
const flushFrames = () => { const f = frames; frames = []; for (const cb of f) cb() }

/** A fresh page with the runtime set, the agents of each runtime, and a stub surface per runtime. */
async function page(runtimes: RuntimeView[], opts: { local?: Record<string, unknown>; remote?: Record<string, unknown>; fingerprint?: string | null } = {}) {
  vi.resetModules()
  frames = []
  const subs: Record<string, (...a: unknown[]) => void> = {}
  const bind = (id: string) => (id === HOST_1 ? remote : local)
  // A runtime DID read fails unless the test answers it.
  const unread = { getOwnerIdentityStatus: async () => { throw new Error('unreachable') } }
  const remote = surface(HOST_1, { platform: 'linux', runtime: bind, ...unread, ...opts.remote }, subs)
  const local = surface(undefined, { platform: 'linux', runtime: bind, ...unread, ...LAN_IPS, ...opts.local }, subs)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { location: { search: '' }, adfApi: local, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('setInterval', () => 0)
  vi.stubGlobal('clearInterval', () => {})
  const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
  await import('../../../src/renderer/stores/runtimes.store')
  useConnectionStore.getState().setView(view(runtimes, opts.fingerprint === undefined ? FP_1 : opts.fingerprint))
  const { useMeshStore } = await import('../../../src/renderer/stores/mesh.store')
  useMeshStore.getState().setAgents([agent(A1, DID_A1, LOCAL_ROOT), agent(A2, undefined, LOCAL_ROOT)])
  if (runtimes.length > 1) useMeshStore.getState().setAgents([agent(B1, DID_B1, HOST_ROOT), agent(B2, DID_B2, HOST_ROOT)], HOST_1)
  return { subs }
}

/** The mesh hook mounted: every runtime's mesh events reach the map. */
async function mountMeshHook(subs: Record<string, (...a: unknown[]) => void>) {
  const { useMeshGraph } = await import('../../../src/renderer/hooks/useMeshGraph')
  const Probe = () => { useMeshGraph(); return null }
  renderToStaticMarkup(<Probe />)
  return {
    local: (e: MeshEvent) => { subs['local:onMeshEvent'](e); flushFrames() },
    host1: (e: MeshEvent) => { subs[`${HOST_1}:onMeshEvent`](e); flushFrames() },
  }
}

const routed = (payload: Record<string, unknown>): MeshEvent => ({ type: 'message_routed', payload, timestamp: 1 } as MeshEvent)

/** The polls' peers of a set with both runtimes: each lists the other (DIDs known). */
async function learnBothWays(state = { seq: {}, errors: {}, dids: { local: 'did:key:rt-local', [HOST_1]: 'did:key:rt-host-1' } as Record<string, string | null> }) {
  const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
  const own = [{ runtime_id: RT_HOST_1, runtime_did: 'did:key:rt-host-1', url: AT_HOST_1 }]
  const remote = [{ peers: [{ runtime_id: RT_LOCAL, runtime_did: 'did:key:rt-local', url: AT_LOCAL }] }]
  return fleetPeers(own, remote, state)
}

/** The map's message edges now, as the Mesh view builds them. */
async function edges(debug: MeshDebugInfo | null = null) {
  const { buildEdges } = await import('../../../src/renderer/components/mesh/MeshGraphView')
  const { selectMapAgents } = await import('../../../src/renderer/components/mesh/runtime-fleet')
  const { useMeshStore } = await import('../../../src/renderer/stores/mesh.store')
  const { useMeshGraphStore } = await import('../../../src/renderer/stores/mesh-graph.store')
  return buildEdges(selectMapAgents(useMeshStore.getState()), debug, useMeshGraphStore.getState().liveRoutes, { map: new Map(), last: [] })
    .filter((e) => (e.data as { edgeType?: string }).edgeType === 'message')
    .map((e) => [e.source, e.target].sort())
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('a message between two runtimes of the set', () => {
  it('draws a tile-to-tile edge, both directions, each message once', async () => {
    const { subs } = await page([LOCAL, REMOTE])
    const send = await mountMeshHook(subs)
    expect(await learnBothWays()).toEqual([])
    const { useMeshGraphStore } = await import('../../../src/renderer/stores/mesh-graph.store')

    // agent-1 (This computer) → agent-2 (host-1): This computer reports it leaving, host-1 arriving.
    send.local(routed({ filePath: A1, toFilePaths: [`station:peer:${RT_HOST_1}`], toPeerAgent: { runtimeId: RT_HOST_1, id: DID_B2 } }))
    send.host1(routed({ filePath: `station:peer:${RT_LOCAL}`, toFilePaths: [B2], fromPeerAgent: { runtimeId: RT_LOCAL, id: DID_A1 } }))
    expect(await edges()).toEqual([[A1, KEY_B2].sort()])
    expect(useMeshGraphStore.getState().edgeHeat[`${A1}|${KEY_B2}`]?.count).toBe(1)
    expect(Object.keys(useMeshGraphStore.getState().liveRoutes).some((k) => k.includes('station:'))).toBe(false)

    // agent-2 (host-1) → agent-1 (This computer): the arrival is reported first this time.
    send.local(routed({ filePath: `station:peer:${RT_HOST_1}`, toFilePaths: [A1], fromPeerAgent: { runtimeId: RT_HOST_1, id: DID_B2 } }))
    send.host1(routed({ filePath: B2, toFilePaths: [`station:peer:${RT_LOCAL}`], toPeerAgent: { runtimeId: RT_LOCAL, id: DID_A1 } }))
    expect(useMeshGraphStore.getState().edgeHeat[`${KEY_B2}|${A1}`]?.count).toBe(1)
    expect(await edges()).toEqual([[A1, KEY_B2].sort()])
    // The tile lit is the tile, not a stub of a station the map does not draw.
    expect(useMeshGraphStore.getState().peerAgentPings).toEqual({})
  })

  it('an arrival only (the sender\'s runtime saw no peer) is still drawn from the sender\'s tile', async () => {
    const { subs } = await page([LOCAL, REMOTE])
    const send = await mountMeshHook(subs)
    await learnBothWays()
    send.local(routed({ filePath: `station:peer:${RT_HOST_1}`, toFilePaths: [A1], fromPeerAgent: { runtimeId: RT_HOST_1, id: DID_B1 } }))
    expect(await edges()).toEqual([[A1, KEY_B1].sort()])
  })

  it('a handle names the agent of the peer\'s runtime only', async () => {
    const { subs } = await page([LOCAL, REMOTE])
    const send = await mountMeshHook(subs)
    await learnBothWays()
    // A recipient known by handle only: agent-1 of host-1, not agent-1 of This computer.
    send.local(routed({ filePath: A2, toFilePaths: [`station:peer:${RT_HOST_1}`], toPeerAgent: { runtimeId: RT_HOST_1, id: 'agent-1' } }))
    expect(await edges()).toEqual([[A2, KEY_B1].sort()])
  })

  it('S2: egress to an unproven peer that claims a managed runtime\'s DID is drawn to its station, never onto the managed tile', async () => {
    const { subs } = await page([LOCAL, REMOTE])
    const send = await mountMeshHook(subs)
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const state = { seq: {}, errors: {}, dids: { local: 'did:key:rt-local', [HOST_1]: 'did:key:rt-host-1' } as Record<string, string | null> }
    await fleetPeers([{ runtime_id: RT_PEER, runtime_did: 'did:key:rt-host-1', fingerprint: FP_1, url: 'http://192.168.1.66:7295' }], [], state)
    send.local(routed({ filePath: A1, toFilePaths: [`station:peer:${RT_PEER}`], toPeerAgent: { runtimeId: RT_PEER, id: DID_B2 } }))
    const { useMeshGraphStore } = await import('../../../src/renderer/stores/mesh-graph.store')
    expect(Object.keys(useMeshGraphStore.getState().liveRoutes)).toEqual([`${A1}|station:peer:${RT_PEER}`])
    expect(Object.keys(useMeshGraphStore.getState().edgeHeat).some((k) => k.includes(KEY_B2))).toBe(false)
  })

  it('a peer the map does not manage keeps its station and its stub ping', async () => {
    const { subs } = await page([LOCAL, REMOTE])
    const send = await mountMeshHook(subs)
    await learnBothWays()
    send.local(routed({ filePath: A1, toFilePaths: [`station:peer:${RT_PEER}`], toPeerAgent: { runtimeId: RT_PEER, id: 'did:key:peer-agent' } }))
    const { useMeshGraphStore } = await import('../../../src/renderer/stores/mesh-graph.store')
    expect(Object.keys(useMeshGraphStore.getState().liveRoutes)).toEqual([`${A1}|station:peer:${RT_PEER}`])
    expect(Object.keys(useMeshGraphStore.getState().peerAgentPings)).toEqual([`${RT_PEER}|did:key:peer-agent`])
  })

  it('This computer only: a peer message is drawn to the peer station as before', async () => {
    const { subs } = await page([LOCAL])
    const send = await mountMeshHook(subs)
    send.local(routed({ filePath: A1, toFilePaths: [`station:peer:${RT_HOST_1}`], toPeerAgent: { runtimeId: RT_HOST_1, id: 'agent-1' } }))
    const { useMeshGraphStore } = await import('../../../src/renderer/stores/mesh-graph.store')
    expect(Object.keys(useMeshGraphStore.getState().liveRoutes)).toEqual([`${A1}|station:peer:${RT_HOST_1}`])
  })
})

describe('the same handle on two runtimes', () => {
  it('This computer\'s message log draws no edge to the other runtime\'s agent-1', async () => {
    await page([LOCAL, REMOTE])
    const debug = { messageLog: [{ from: 'agent-2', deliveredTo: ['agent-1'], delivered: true, channel: '*' }] } as unknown as MeshDebugInfo
    expect(await edges(debug)).toEqual([[A1, A2].sort()])
  })
})

describe('a runtime of the set is not also a peer station', () => {
  const match = () => ({ seq: {}, errors: {}, dids: {} as Record<string, string | null> })

  it('a peer record without runtime_did, after a failed DID read, by fingerprint', async () => {
    const getOwnerIdentityStatus = vi.fn(async () => { throw new Error('unreachable') })
    await page([LOCAL, REMOTE], { local: { getOwnerIdentityStatus }, remote: { getOwnerIdentityStatus } })
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const own = [{ runtime_id: RT_HOST_1, url: 'http://192.168.1.20:7295', fingerprint: FP_1, daemon_port: 7386 }, { runtime_id: RT_PEER }]
    expect((await fleetPeers(own, [], match())).map((p) => p.runtime_id)).toEqual([RT_PEER])
  })

  it('by the runtime DID read over its connection', async () => {
    await page([LOCAL, REMOTE], { fingerprint: null, remote: { getOwnerIdentityStatus: async () => ({ runtimeDid: 'did:key:rt-host-1' }) } })
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const own = [{ runtime_id: RT_HOST_1, runtime_did: 'did:key:rt-host-1', url: AT_HOST_1 }, { runtime_id: RT_PEER, runtime_did: 'did:key:rt-peer' }]
    expect((await fleetPeers(own, [], match())).map((p) => p.runtime_id)).toEqual([RT_PEER])
  })

  it('B4: an address alone (host and daemon port, copyable on the LAN) is not a match: the record stays a station', async () => {
    await page([LOCAL, REMOTE], { fingerprint: null })
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const own = [{ runtime_id: RT_HOST_1, url: 'http://192.168.1.20:7295', daemon_port: 7386 }, { runtime_id: RT_PEER, url: 'http://192.168.1.30:7295' }]
    expect((await fleetPeers(own, [], match())).map((p) => p.runtime_id)).toEqual([RT_HOST_1, RT_PEER])
  })

  it('B4: a directory listing the map\'s agent DIDs is not a match; a stub that is a tile is still not drawn', async () => {
    await page([LOCAL, REMOTE], { fingerprint: null })
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const own = [
      { runtime_id: RT_HOST_1, agents: [{ handle: 'agent-1', did: DID_B1 }, { handle: 'agent-2', did: DID_B2 }] },
      { runtime_id: RT_PEER, agents: [{ handle: 'agent-9', did: 'did:key:peer-agent' }, { handle: 'agent-1', did: DID_A1 }] },
    ]
    const shown = await fleetPeers(own, [], match())
    expect(shown).toEqual([{ runtime_id: RT_HOST_1, agents: [] }, { runtime_id: RT_PEER, agents: [{ handle: 'agent-9', did: 'did:key:peer-agent' }] }])
  })

  it('B4: the matches are rebuilt every poll: a record that copied the fingerprint once does not hide its station for the session', async () => {
    await page([LOCAL, REMOTE])
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const state = match() as ReturnType<typeof match> & { learned?: Record<string, string> }
    expect(await fleetPeers([{ runtime_id: RT_PEER, fingerprint: FP_1, url: AT_HOST_1 }], [], state)).toEqual([])
    expect(state.learned).toEqual({ [RT_PEER]: HOST_1 })
    expect(await fleetPeers([{ runtime_id: RT_PEER }], [], state)).toEqual([{ runtime_id: RT_PEER }])
    expect(state.learned).toEqual({})
    // Within one poll a record of a matched runtime_id is that runtime, whichever list reports it.
    expect(await fleetPeers([{ runtime_id: RT_HOST_1, fingerprint: FP_1, url: AT_HOST_1 }], [{ peers: [{ runtime_id: RT_HOST_1 }] }], state)).toEqual([])
  })

  it('S2: a LAN spoofer that copies the runtime DID and the fingerprint from mDNS TXT is a station, not the managed region', async () => {
    await page([LOCAL, REMOTE], { remote: { getOwnerIdentityStatus: async () => ({ runtimeDid: 'did:key:rt-host-1' }) }, local: { getOwnerIdentityStatus: async () => ({ runtimeDid: 'did:key:rt-local' }) } })
    const { fleetPeers } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const state = match() as ReturnType<typeof match> & { learned?: Record<string, string> }
    const spoof = [
      { runtime_id: RT_PEER, runtime_did: 'did:key:rt-host-1', fingerprint: FP_1, url: 'http://192.168.1.66:7295' },
      { runtime_id: 'rt-spoof-local', runtime_did: 'did:key:rt-local', url: 'http://192.168.1.67:7295' },
    ]
    expect((await fleetPeers(spoof, [], state)).map((p) => p.runtime_id)).toEqual([RT_PEER, 'rt-spoof-local'])
    expect(state.learned).toEqual({})
    // At the proven addresses the same claims match.
    expect(await fleetPeers([{ ...spoof[0], url: AT_HOST_1 }, { ...spoof[1], url: AT_LOCAL }], [], state)).toEqual([])
  })

  it('a DID read that fails, or answers none, is read again with backoff, not once', async () => {
    let answer: () => Promise<{ runtimeDid: string }> = async () => { throw new Error('unreachable') }
    const getOwnerIdentityStatus = vi.fn(() => answer())
    await page([LOCAL, REMOTE], { remote: { getOwnerIdentityStatus }, local: { getOwnerIdentityStatus: async () => ({ runtimeDid: 'did:key:rt-local' }) } })
    const { setRuntimeDids, DID_RETRY_FIRST_MS } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const state = match()
    await setRuntimeDids(state, 0)
    expect(getOwnerIdentityStatus).toHaveBeenCalledTimes(1)
    await setRuntimeDids(state, DID_RETRY_FIRST_MS - 1)
    expect(getOwnerIdentityStatus).toHaveBeenCalledTimes(1)
    answer = async () => ({ runtimeDid: '' })
    await setRuntimeDids(state, DID_RETRY_FIRST_MS)
    expect(getOwnerIdentityStatus).toHaveBeenCalledTimes(2)
    await setRuntimeDids(state, DID_RETRY_FIRST_MS * 2)
    expect(getOwnerIdentityStatus).toHaveBeenCalledTimes(2)
    answer = async () => ({ runtimeDid: 'did:key:rt-host-1' })
    await setRuntimeDids(state, DID_RETRY_FIRST_MS * 3)
    expect(getOwnerIdentityStatus).toHaveBeenCalledTimes(3)
    expect(state.dids).toEqual({ local: 'did:key:rt-local', [HOST_1]: 'did:key:rt-host-1' })
    await setRuntimeDids(state, DID_RETRY_FIRST_MS * 100)
    expect(getOwnerIdentityStatus).toHaveBeenCalledTimes(3)
  })
})

describe('a peer that becomes a runtime of the set', () => {
  it('its station goes in the render its tiles land in, and its region takes the station\'s ground', async () => {
    await page([LOCAL])
    const { useMeshStore } = await import('../../../src/renderer/stores/mesh.store')
    const { useFleetStore } = await import('../../../src/renderer/stores/fleet.store')
    const { useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
    const { useRuntimesStore } = await import('../../../src/renderer/stores/runtimes.store')
    const { fleetPeers, peerMatchOf, regionFromStation } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const { mergePeers, selectMapAgents, runtimeRegionRoot } = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { computeFleetLayout } = await import('../../../src/renderer/components/mesh/fleet-layout')
    // host-1 is a peer, not paired yet: a station; its record carries its remote-access fingerprint.
    const peer = { runtime_id: RT_HOST_1, fingerprint: FP_1, url: AT_HOST_1, agents: [{ handle: 'agent-1', did: DID_B1 }, { handle: 'agent-2', did: DID_B2 }] }
    const state = { seq: {}, errors: {}, dids: {} as Record<string, string | null> }
    const lanPeers = await fleetPeers([peer], [], state)
    expect(lanPeers).toEqual([peer])
    const shown = () => mergePeers([lanPeers], peerMatchOf(state, useRuntimesStore.getState().runtimes, selectMapAgents(useMeshStore.getState())))
    expect(shown()).toEqual([peer])

    // Its station was frozen on the ring; host-1 is paired (that fingerprint pinned) and its agents land.
    useFleetStore.getState().setPlacement({ regionOrigins: {}, cellPins: {}, stationPins: { [`station:peer:${RT_HOST_1}`]: { q: 40, r: -6, auto: true } } })
    useConnectionStore.getState().setView(view([LOCAL, REMOTE]))
    useMeshStore.getState().setAgents([agent(B1, DID_B1, HOST_ROOT), agent(B2, DID_B2, HOST_ROOT)], HOST_1)
    // The station ring of the same render, before the next poll: no station.
    expect(shown()).toEqual([])

    // The next poll learns it; a region with no place of its own is founded on the station's cell.
    expect(await fleetPeers([peer], [], state)).toEqual([])
    regionFromStation(HOST_1, state.learned ?? {})
    const root = runtimeRegionRoot(HOST_1)
    expect(useFleetStore.getState().placement!.regionOrigins[root]).toEqual({ q: 40, r: -6 })
    const layout = computeFleetLayout(selectMapAgents(useMeshStore.getState()), useFleetStore.getState().placement!)
    expect(layout.regionOrigins[root]).toEqual({ q: 40, r: -6 })
  })
})

describe('B5: a runtime id that is another computer now, or moved, loses its matches', () => {
  const state = () => ({
    seq: { [HOST_1]: 9 } as Record<string, number>, errors: { [HOST_1]: 'unreachable' } as Record<string, string>,
    dids: { local: 'did:key:rt-local', [HOST_1]: 'did:key:rt-host-1' } as Record<string, string | null>,
    didRetry: { [HOST_1]: { at: 1, wait: 5_000 } } as Record<string, { at: number; wait: number }>,
    learned: { [RT_LOCAL]: 'local', [RT_HOST_1]: HOST_1 } as Record<string, string>,
  })
  const kept = { seq: {}, errors: {}, dids: { local: 'did:key:rt-local' }, didRetry: {}, learned: { [RT_LOCAL]: 'local' } }

  it('replaced (RUNTIMES_MOVED): its runtime DID, retry, cursor and matches go, the traffic match too', async () => {
    await page([LOCAL, REMOTE])
    const { trackPeerMatchState, setPeerRuntimes, peerAgentTile } = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { noteRuntimeMoves } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const { useMeshStore, selectMeshSlice } = await import('../../../src/renderer/stores/mesh.store')
    const agentsOf = (rt: string) => selectMeshSlice(useMeshStore.getState(), rt).agents
    const s = state()
    const untrack = trackPeerMatchState(s)
    setPeerRuntimes({ [RT_HOST_1]: HOST_1 })
    expect(peerAgentTile(RT_HOST_1, DID_B1, agentsOf)).toBe(KEY_B1)
    noteRuntimeMoves({ moves: {}, replaced: [HOST_1] })
    expect(s).toEqual(kept)
    expect(peerAgentTile(RT_HOST_1, DID_B1, agentsOf)).toBeNull()
    untrack()
  })

  it('moved: the old id\'s matches go; a state no longer tracked is left alone', async () => {
    await page([LOCAL, REMOTE])
    const { trackPeerMatchState } = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { noteRuntimeMoves } = await import('../../../src/renderer/hooks/useRuntimeFeeds')
    const s = state()
    const gone = state()
    trackPeerMatchState(gone)()
    const untrack = trackPeerMatchState(s)
    noteRuntimeMoves({ moves: { [HOST_1]: 'remote:host-1b' }, replaced: [] })
    expect(s).toEqual(kept)
    expect(gone).toEqual(state())
    untrack()
  })

  it('the Mesh view tracks its poll state', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/mesh/MeshGraphView.tsx'), 'utf-8')
    expect(src).toContain('trackPeerMatchState(remotePolls.current)')
  })
})

describe('the management cue', () => {
  it('managed regions are solid in --ink-faint; peer stations dashed, tooltip "Peer"; This computer only: as before', async () => {
    await page([LOCAL, REMOTE])
    vi.stubGlobal('document', { documentElement: { classList: { contains: () => false } } })
    const { regionDecor } = await import('../../../src/renderer/components/mesh/MeshGraphView')
    const { computeFleetLayout } = await import('../../../src/renderer/components/mesh/fleet-layout')
    const { selectMapAgents } = await import('../../../src/renderer/components/mesh/runtime-fleet')
    const { useMeshStore } = await import('../../../src/renderer/stores/mesh.store')
    const { FleetTerrainNode } = await import('../../../src/renderer/components/mesh/FleetTerrainNode')
    const { FleetStationNode } = await import('../../../src/renderer/components/mesh/FleetStationNode')
    const { ReactFlowProvider } = await import('@xyflow/react')

    expect(regionDecor([LOCAL])).toBeUndefined()
    const terrains = (decor: ReturnType<typeof regionDecor>) =>
      computeFleetLayout(selectMapAgents(useMeshStore.getState()), undefined, decor).nodes.filter((n) => n.type === 'terrainNode')
    const multi = terrains(regionDecor([LOCAL, REMOTE]))
    expect(multi.map((n) => (n.data as { managed?: boolean }).managed)).toEqual([true, true])
    expect(terrains(undefined).some((n) => 'managed' in (n.data as object))).toBe(false)

    const node = (data: unknown) => ({ id: 'terrain:x', data, type: 'terrainNode' }) as never
    const region = (managed: boolean) => renderToStaticMarkup(<FleetTerrainNode {...node({ ...multi[1].data, managed })} />)
    expect(region(true)).toContain('stroke:var(--ink-faint)')
    expect(region(false)).not.toContain('var(--ink-faint)')

    const station = (peer: boolean) => renderToStaticMarkup(
      <ReactFlowProvider>
        <FleetStationNode {...({ id: `station:peer:${RT_PEER}`, data: { kind: 'peer', label: 'host-9', status: '1 agents', peerAgents: [{ handle: 'agent-9', did: 'did:key:peer-agent' }], ...(peer ? { peer: true } : {}) } } as never)} />
      </ReactFlowProvider>,
    )
    expect(station(true)).toContain('title="Peer"')
    expect(station(true)).toMatch(/stroke-dasharray="18 12" style="stroke:var\(--ink-faint\)"/)
    expect(station(false)).toContain('title="host-9 — 1 agents"')
    expect(station(false)).not.toContain('var(--ink-faint)')
  })
})
