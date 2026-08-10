/**
 * Phase 1b: one umbilical lifecycle implementation, three hosts.
 *
 * The daemon (via AgentRuntimeBuilder), the Studio background manager, and the
 * Studio foreground IPC path each used to carry their own copy of the umbilical
 * wiring. They now all spread `createUmbilicalResources(...)` at the front of
 * their `LifecycleResource[]`, so a start → adapter status → mcp log → stop
 * sequence must produce a byte-identical ordered event stream regardless of
 * which host's extra resources surround it.
 *
 * Two fences here:
 *   1. Behavioural — the three host shapes emit the same ordered event types.
 *   2. Source-level — no production file other than umbilical-lifecycle.ts may
 *      emit the lifecycle/adapter/MCP event literals again.
 */

import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonEventBus } from '../../../src/main/daemon/event-bus'
import { registerDaemonEventBus } from '../../../src/main/runtime/emit-umbilical'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { UmbilicalEvent } from '../../../src/main/runtime/umbilical-bus'
import type { LifecycleResource } from '../../../src/main/runtime/assemble-agent'
import { createUmbilicalResources } from '../../../src/main/runtime/umbilical-lifecycle'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { ChannelAdapterManager } from '../../../src/main/services/channel-adapter-manager'
import type { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

const AGENT_ID = 'agent-1'
const FILE_PATH = '/tmp/agent-1.adf'
const REPO_ROOT = join(__dirname, '..', '..', '..')

afterEach(() => {
  clearAllUmbilicalBuses()
  registerDaemonEventBus(new DaemonEventBus(100))
  vi.restoreAllMocks()
})

function captureEvents(): { events: UmbilicalEvent[]; types: () => string[] } {
  const bus = new DaemonEventBus(500)
  registerDaemonEventBus(bus)
  const events: UmbilicalEvent[] = []
  bus.subscribe(frame => events.push(frame.event))
  return { events, types: () => events.map(e => e.event_type) }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: AGENT_ID,
    name: 'agent-1',
    handle: 'agent_1',
    autostart: false,
    tools: [],
    ...overrides,
  } as unknown as AgentConfig
}

function makeWorkspace(tapSource?: string) {
  const meta = new Map<string, string>()
  return {
    getMeta: (key: string) => meta.get(key) ?? null,
    setMeta: (key: string, value: string) => { meta.set(key, value) },
    insertLog: vi.fn(),
    readFile: vi.fn((path: string) => (path === 'lib/tap.ts' ? tapSource ?? null : null)),
    getAgentConfig: vi.fn(() => ({ limits: {} })),
    isFileAuthorized: vi.fn(() => false),
  } as unknown as AdfWorkspace
}

/** Mirrors assembleAgent: resources start in order, stop in reverse. */
async function startAll(resources: LifecycleResource[]): Promise<void> {
  for (const resource of resources) await resource.start?.()
}
async function stopAll(resources: LifecycleResource[]): Promise<void> {
  for (const resource of [...resources].reverse()) await resource.stop?.()
}

interface HostShape {
  name: string
  /** Host-owned resources appended AFTER the shared umbilical set. */
  extraResources: (adapter: EventEmitter, mcp: EventEmitter) => LifecycleResource[]
}

/**
 * The three production host shapes. Only their non-umbilical resources differ;
 * every one of them spreads the shared umbilical set at the front.
 */
const HOSTS: HostShape[] = [
  {
    // AgentRuntimeBuilder: one combined cleanup resource.
    name: 'daemon',
    extraResources: (adapter, mcp) => [
      { name: 'daemon-runtime-resources', stop: async () => { adapter.removeAllListeners(); mcp.removeAllListeners() } },
    ],
  },
  {
    // BackgroundAgentManager: several fine-grained resources.
    name: 'studio-background',
    extraResources: (adapter, mcp) => [
      { name: 'code-sandbox', stop: () => {} },
      { name: 'compute-registration', stop: async () => {} },
      { name: 'stream-bindings', stop: () => {} },
      { name: 'scratch-directory', stop: () => {} },
      { name: 'channel-adapters', stop: async () => { adapter.removeAllListeners() } },
      { name: 'mcp-clients', stop: async () => { mcp.removeAllListeners() } },
    ],
  },
  {
    // Studio foreground IPC: one combined stop closure.
    name: 'studio-foreground',
    extraResources: (adapter, mcp) => [
      { name: 'studio-foreground-resources', stop: async () => { mcp.removeAllListeners(); adapter.removeAllListeners() } },
    ],
  },
]

async function runHost(host: HostShape): Promise<string[]> {
  const { types } = captureEvents()
  const adapter = new EventEmitter()
  const mcp = new EventEmitter()

  const umbilical = createUmbilicalResources({
    agentId: AGENT_ID,
    workspace: makeWorkspace(),
    filePath: FILE_PATH,
    config: makeConfig(),
    adapterManager: adapter as unknown as ChannelAdapterManager,
    mcpManager: mcp as unknown as McpClientManager,
  })
  const resources: LifecycleResource[] = [
    ...umbilical.resources,
    ...host.extraResources(adapter, mcp),
  ]

  await startAll(resources)
  adapter.emit('status-changed', 'telegram', 'connected', undefined)
  mcp.emit('log', 'filesystem', { timestamp: 1234, stream: 'stderr', message: 'hello' })
  await stopAll(resources)

  clearAllUmbilicalBuses()
  return types()
}

describe('umbilical host parity', () => {
  it('produces an identical ordered event stream for all three host shapes', async () => {
    const streams: Record<string, string[]> = {}
    for (const host of HOSTS) streams[host.name] = await runHost(host)

    const expected = [
      'agent.loaded',
      'adapter.status.changed',
      'mcp.log',
      'agent.unloaded',
    ]
    expect(streams.daemon).toEqual(expected)
    expect(streams['studio-background']).toEqual(streams.daemon)
    expect(streams['studio-foreground']).toEqual(streams.daemon)
  })

  it('carries identical sources and payloads regardless of host', async () => {
    const { events } = captureEvents()
    const adapter = new EventEmitter()
    const mcp = new EventEmitter()
    const { resources } = createUmbilicalResources({
      agentId: AGENT_ID,
      workspace: makeWorkspace(),
      filePath: FILE_PATH,
      config: makeConfig({ autostart: true } as Partial<AgentConfig>),
      adapterManager: adapter as unknown as ChannelAdapterManager,
      mcpManager: mcp as unknown as McpClientManager,
    })

    await startAll(resources)
    adapter.emit('status-changed', 'telegram', 'error', 'boom')
    mcp.emit('tools-discovered', 'filesystem', [{ name: 'read' }, { name: 'write' }])
    await stopAll(resources)

    expect(events.map(e => `${e.event_type}:${e.source}`)).toEqual([
      'agent.loaded:system:lifecycle',
      'adapter.status.changed:system:adapter',
      'mcp.tools.discovered:system:mcp',
      'agent.unloaded:system:lifecycle',
    ])
    expect(events.every(e => e.agent_id === AGENT_ID)).toBe(true)
    expect(events[0].payload).toEqual({
      filePath: FILE_PATH, name: 'agent-1', handle: 'agent_1', autostart: true,
    })
    expect(events[1].payload).toEqual({
      filePath: FILE_PATH, type: 'telegram', status: 'error', error: 'boom',
    })
    expect(events[2].payload).toEqual({ filePath: FILE_PATH, name: 'filesystem', toolCount: 2 })
    expect(events[3].payload).toEqual({ filePath: FILE_PATH })
  })

  it('registers taps BEFORE agent.loaded so a tap observes its own load event', async () => {
    captureEvents()
    const execute = vi.fn(async () => ({ stdout: '' }))
    const workspace = makeWorkspace('export async function onEvent(event) { return event.seq }')
    const { resources, lifecycle } = createUmbilicalResources({
      agentId: AGENT_ID,
      workspace,
      filePath: FILE_PATH,
      config: makeConfig({
        umbilical_taps: [{
          name: 'lifecycle-watch',
          lambda: 'lib/tap.ts:onEvent',
          filter: { event_types: ['agent.loaded'], allow_wildcard: false },
          exclude_own_origin: true,
          max_rate_per_sec: 100,
        }],
      } as Partial<AgentConfig>),
      codeSandboxService: { execute } as never,
      adfCallHandler: {
        handleCall: vi.fn(),
        getEnabledToolNames: () => [],
        getHilToolNames: () => [],
      } as never,
    })

    await startAll(resources)
    expect(lifecycle.getTapManager()).not.toBeNull()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(execute).toHaveBeenCalledTimes(1)
    const dispatched = JSON.parse(
      /\(({[\s\S]*})\);/.exec(execute.mock.calls[0][1] as unknown as string)?.[1] ?? '{}',
    )
    expect(dispatched.event_type).toBe('agent.loaded')

    await stopAll(resources)
    expect(lifecycle.getTapManager()).toBeNull()
  })

  it('emits agent.unloaded before the per-agent bus is destroyed', async () => {
    captureEvents()
    const seen: string[] = []
    const { resources, lifecycle } = createUmbilicalResources({
      agentId: AGENT_ID,
      workspace: makeWorkspace(),
      filePath: FILE_PATH,
      config: makeConfig(),
    })

    await startAll(resources)
    // Subscribe directly to the per-agent bus the lifecycle resource created.
    const { getUmbilicalBus } = await import('../../../src/main/runtime/umbilical-bus')
    getUmbilicalBus(AGENT_ID)!.subscribe(event => seen.push(event.event_type))

    await stopAll(resources)
    expect(seen).toEqual(['agent.unloaded'])
    expect(getUmbilicalBus(AGENT_ID)).toBeUndefined()
    expect(lifecycle.getTapManager()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Source fence: hosts must not re-grow their own copies.
// ---------------------------------------------------------------------------

const SHARED_MODULE = 'src/main/runtime/umbilical-lifecycle.ts'
const HOST_OWNED_EVENT_TYPES = [
  'agent.loaded',
  'agent.unloaded',
  'adapter.status.changed',
  'adapter.log',
  'mcp.status.changed',
  'mcp.tools.discovered',
  'mcp.log',
] as const

function walkTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      walkTypeScriptFiles(abs, out)
    } else if (st.isFile() && abs.endsWith('.ts')) {
      out.push(abs)
    }
  }
  return out
}

describe('umbilical lifecycle emission is single-sourced', () => {
  const sources = walkTypeScriptFiles(join(REPO_ROOT, 'src', 'main')).map(abs => ({
    path: relative(REPO_ROOT, abs).split(sep).join('/'),
    content: readFileSync(abs, 'utf8'),
  }))

  for (const eventType of HOST_OWNED_EVENT_TYPES) {
    it(`only ${SHARED_MODULE} emits "${eventType}"`, () => {
      const emitters = sources
        .filter(source => source.content.includes(`event_type: '${eventType}'`))
        .map(source => source.path)
      expect(emitters).toEqual([SHARED_MODULE])
    })
  }

  it('the retired agent.event type is gone from production code', () => {
    const offenders = sources
      .filter(source => source.content.includes(`'agent.event'`))
      .map(source => source.path)
    expect(offenders).toEqual([])
  })
})
