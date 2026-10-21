/**
 * The fleet map across runtimes (docs/design/multi-runtime.md §6.4, §7.4):
 * with This computer only the map is exactly today's; with more, each other
 * runtime is one region named after it, equal paths and agent ids on two
 * runtimes stay two tiles, a peer that is a runtime of the set is not a
 * station, and another runtime's groups and world are saved under
 * runtimeFleet with its own paths.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { computeFleetLayout, type TerrainNodeData } from '../../../src/renderer/components/mesh/fleet-layout'
import {
  byRuntime,
  fleetSettingsPatch,
  mapAgentsOf,
  mergeGroups,
  mergePeers,
  runtimeOfRegion,
  runtimeRegionRoot,
  selectMapAgents,
  setStoredRuntimeFleet,
  storedRuntimeFleetOf,
  splitGroups,
  splitRecord,
} from '../../../src/renderer/components/mesh/runtime-fleet'
import { useMeshStore } from '../../../src/renderer/stores/mesh.store'
import { agentKey } from '../../../src/shared/types/agent-ref'
import type { FleetAgentStatus } from '../../../src/shared/types/ipc.types'
import type { RuntimeView } from '../../../src/shared/types/connection.types'

const HOST_1 = 'remote:host-1'
const AGENT_1_ID = '0b8f5c2e-6a51-4c4e-9a43-2f1d7e9c1a01'
const AGENT_2_ID = '5d1e9a7c-3b24-4f0a-8c6e-9e2b4d7a3f02'

function agent(filePath: string, agentId: string, root: string): FleetAgentStatus {
  return { filePath, handle: filePath.split('/').pop()!.replace('.adf', ''), state: 'idle', participating: true, online: true, agentId, trackedDirRoot: root } as FleetAgentStatus
}

const LOCAL_ROOT = '/home/u/agents'
const AGENT_1 = agent(`${LOCAL_ROOT}/agent-1.adf`, AGENT_1_ID, LOCAL_ROOT)
const AGENT_2 = agent(`${LOCAL_ROOT}/agent-2.adf`, AGENT_2_ID, LOCAL_ROOT)

const ONE: RuntimeView[] = [{ id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }]
const TWO: RuntimeView[] = [...ONE, { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7385', state: 'connected' }]

const meshNodes = (nodes: { type?: string; id: string }[]) => nodes.filter((n) => n.type === 'meshNode').map((n) => n.id).sort()
const terrains = (nodes: { type?: string; data: unknown }[]) => nodes.filter((n) => n.type === 'terrainNode').map((n) => n.data as TerrainNodeData)

describe('one runtime: the map is today\'s', () => {
  beforeEach(() => useMeshStore.setState({ agents: [AGENT_1, AGENT_2], byRuntime: {} }))

  it('the map\'s agents are the store\'s own list', () => {
    expect(selectMapAgents(useMeshStore.getState())).toBe(useMeshStore.getState().agents)
    expect(mapAgentsOf([AGENT_1], [])).toEqual([AGENT_1])
  })

  it('the layout without region decor equals the layout of before', () => {
    const before = computeFleetLayout([AGENT_1, AGENT_2])
    expect(computeFleetLayout([AGENT_1, AGENT_2], undefined, undefined)).toEqual(before)
    expect(terrains(before.nodes).map((t) => t.label)).toEqual(['agents'])
  })

  it('a save names no runtimeFleet', () => {
    const local = { fleetGroups: { team: [AGENT_1.filePath] } }
    expect(fleetSettingsPatch(local, {}, ONE)).toBe(local)
  })
})

describe('two runtimes: one region per runtime', () => {
  // The same file path and agent id on both runtimes (an identity collision).
  const HOST_AGENT_1 = agent(AGENT_1.filePath, AGENT_1_ID, LOCAL_ROOT)
  beforeEach(() => {
    useMeshStore.setState({ agents: [AGENT_1], byRuntime: { [HOST_1]: { enabled: true, enabledRev: 0, agents: [HOST_AGENT_1] } } })
  })

  it('equal paths and agent ids on two runtimes are two tiles', () => {
    const agents = selectMapAgents(useMeshStore.getState())
    expect(agents.map((a) => a.filePath)).toEqual([AGENT_1.filePath, agentKey({ runtimeId: HOST_1, filePath: AGENT_1.filePath })])
    const layout = computeFleetLayout(agents)
    expect(meshNodes(layout.nodes)).toHaveLength(2)
    // Memoized: a second read is the same list.
    expect(selectMapAgents(useMeshStore.getState())).toBe(agents)
  })

  it('the other runtime is one region, named after it, its folder a district', () => {
    const agents = selectMapAgents(useMeshStore.getState())
    const decor = { label: (dir: string) => (runtimeOfRegion(dir) ? 'host-1' : undefined), muted: (dir: string) => runtimeOfRegion(dir) === HOST_1 }
    const regions = terrains(computeFleetLayout(agents, undefined, decor).nodes)
    expect(regions.map((r) => r.dirPath).sort()).toEqual([LOCAL_ROOT, runtimeRegionRoot(HOST_1)].sort())
    const host = regions.find((r) => r.dirPath === runtimeRegionRoot(HOST_1))!
    expect(host.label).toBe('host-1')
    expect(host.muted).toBe(true)
    expect(host.districts).toEqual(['agents'])
    expect(regions.find((r) => r.dirPath === LOCAL_ROOT)!.muted).toBeUndefined()
  })

  it('a selection is sent one call per runtime, with each runtime\'s own paths', () => {
    const groups = byRuntime([AGENT_1.filePath, agentKey({ runtimeId: HOST_1, filePath: AGENT_1.filePath }), AGENT_2.filePath])
    expect([...groups]).toEqual([['local', [AGENT_1.filePath, AGENT_2.filePath]], [HOST_1, [AGENT_1.filePath]]])
  })
})

describe('peer stations', () => {
  it('a peer that is a runtime of the set is not a station; others are one per runtime id', () => {
    const local = [{ runtime_id: 'rt-host-1', runtime_did: 'did:key:host-1' }, { runtime_id: 'rt-peer', runtime_did: 'did:key:peer' }]
    const host = [{ runtime_id: 'rt-peer', runtime_did: 'did:key:peer' }, { runtime_id: 'rt-this', runtime_did: 'did:key:this' }, { runtime_id: 'rt-other' }]
    const merged = mergePeers([local, host], new Set(['did:key:host-1', 'did:key:this']))
    expect(merged.map((p) => p.runtime_id)).toEqual(['rt-peer', 'rt-other'])
  })
})

describe('per-runtime client keys', () => {
  beforeEach(() => setStoredRuntimeFleet({ 'remote:host-2': { fleetGroups: { kept: ['/srv/agent-1.adf'] } } }))

  it('This computer\'s records keep their bytes; another runtime\'s lose the runtime prefix', () => {
    const local = { [AGENT_1.filePath]: 10 }
    expect(splitRecord(local).local).toBe(local)
    const mixed = { ...local, [agentKey({ runtimeId: HOST_1, filePath: '/srv/agent-2.adf' })]: 20 }
    expect(splitRecord(mixed)).toEqual({ local, remote: { [HOST_1]: { '/srv/agent-2.adf': 20 } } })
  })

  it('a group spanning two runtimes is saved per runtime and merged back on load', () => {
    const groups = { team: [AGENT_1.filePath, agentKey({ runtimeId: HOST_1, filePath: '/srv/agent-2.adf' })] }
    const { local, remote } = splitGroups(groups)
    expect(local).toEqual({ team: [AGENT_1.filePath] })
    expect(remote).toEqual({ [HOST_1]: { team: ['/srv/agent-2.adf'] } })
    expect(mergeGroups(local, { [HOST_1]: { fleetGroups: remote[HOST_1] } })).toEqual(groups)
  })

  it('with two runtimes a save writes runtimeFleet for the runtimes of the set only; main keeps the others (mergeRuntimeFleet)', () => {
    const patch = fleetSettingsPatch({ fleetGroups: {} }, { [HOST_1]: { fleetGroups: { team: ['/srv/agent-2.adf'] } } }, TWO)
    expect(patch).toEqual({
      fleetGroups: {},
      runtimeFleet: {
        [HOST_1]: { fleetGroups: { team: ['/srv/agent-2.adf'] } },
      },
    })
    // The copy here keeps the runtime not in the set, as main does.
    expect(storedRuntimeFleetOf()['remote:host-2']).toEqual({ fleetGroups: { kept: ['/srv/agent-1.adf'] } })
  })
})
