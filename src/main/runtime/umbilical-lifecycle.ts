/**
 * Shared umbilical lifecycle resources.
 *
 * The three agent hosts — the daemon (via AgentRuntimeBuilder), the Studio
 * background manager, and the Studio foreground IPC path — used to each carry
 * their own copy of the umbilical wiring: create the per-agent bus, register
 * taps, emit `agent.loaded` / `agent.unloaded`, and bridge adapter/MCP manager
 * events onto the umbilical. Three copies meant three subtly different event
 * streams (the foreground emitted no lifecycle events at all).
 *
 * These factories are the single implementation. Hosts consume them as
 * `LifecycleResource` entries, so `assembleAgent` owns the start/stop ordering
 * and every host produces an identical umbilical stream.
 *
 * Ordering contract (asserted by tests/unit/runtime/umbilical-host-parity.test.ts):
 *   - The lifecycle resource is listed FIRST, so its `start` runs before any
 *     other resource can emit and its `stop` runs LAST (resources stop in
 *     reverse), keeping the bus alive for the whole teardown.
 *   - Within `start`: bus → replay buffer → taps → `agent.loaded`, so both a tap
 *     and the replay window see every event from the load announcement onward.
 *   - Within `stop`: tap dispose → `agent.unloaded` → replay detach → bus
 *     destroy, so the unload announcement still reaches external subscribers and
 *     lands in the replay window as its final entry.
 */

import type { AdfWorkspace } from '../adf/adf-workspace'
import type {
  AgentConfig,
  McpServerLogEntry,
  McpServerStatus,
  McpToolInfo,
} from '../../shared/types/adf-v02.types'
import type { AdapterLogEntry, AdapterStatus } from '../../shared/types/channel-adapter.types'
import type { ChannelAdapterManager } from '../services/channel-adapter-manager'
import type { McpClientManager } from '../services/mcp-client-manager'
import type { AdfCallHandler } from './adf-call-handler'
import type { CodeSandboxService } from './code-sandbox'
import type { LifecycleResource } from './assemble-agent'
import { TapManager } from './tap-manager'
import { emitUmbilicalEvent } from './emit-umbilical'
import { withSource } from './execution-context'
import { destroyUmbilicalBus, ensureWorkspaceUmbilicalBus } from './umbilical-bus'
import {
  createUmbilicalReplayBuffer,
  registerUmbilicalReplayBuffer,
  unregisterUmbilicalReplayBuffer,
  type UmbilicalReplayBuffer,
} from './umbilical-replay-buffer'

export interface UmbilicalLifecycleOptions {
  /** Stable agent id — the umbilical bus key. Always `config.id` in production. */
  agentId: string
  workspace: AdfWorkspace
  /** `.adf` path, or null for in-memory/created agents. Echoed in payloads. */
  filePath: string | null
  config: AgentConfig
  codeSandboxService?: CodeSandboxService | null
  adfCallHandler?: AdfCallHandler | null
  /** Override the default console + adf_logs reporting of a tap registration failure. */
  onTapRegisterError?: (error: unknown) => void
}

export interface UmbilicalLifecycleResource extends LifecycleResource {
  /** The TapManager created by `start`, or null when no taps are configured. */
  getTapManager(): TapManager | null
  /** The in-memory replay ring created by `start`, or null when `umbilical.log` is off. */
  getReplayBuffer(): UmbilicalReplayBuffer | null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bus + taps + `agent.loaded` on start; tap dispose + `agent.unloaded` + bus
 * destroy on stop. This is the ONLY place any host announces agent lifecycle
 * on the umbilical.
 */
export function createUmbilicalLifecycleResource(
  options: UmbilicalLifecycleOptions,
): UmbilicalLifecycleResource {
  const { agentId, workspace, filePath, config } = options
  let tapManager: TapManager | null = null
  let replayBuffer: UmbilicalReplayBuffer | null = null

  return {
    name: 'umbilical-lifecycle',
    getTapManager: () => tapManager,
    getReplayBuffer: () => replayBuffer,
    start: async () => {
      const bus = ensureWorkspaceUmbilicalBus(agentId, workspace)

      // Subscribed before anything can emit, so the window opens with `agent.loaded`.
      // Registered under the agent id so the catch-up endpoint can find it
      // without host-specific plumbing (see umbilical-replay-buffer.ts).
      replayBuffer = createUmbilicalReplayBuffer({ agentId, config: config.umbilical })
      if (replayBuffer) {
        replayBuffer.attach(bus)
        registerUmbilicalReplayBuffer(agentId, replayBuffer)
      }

      const taps = config.umbilical_taps ?? []
      if (taps.length > 0 && options.codeSandboxService && options.adfCallHandler) {
        // Keep the manager even if registration throws: `register` is
        // per-tap best-effort, so some subscriptions may already be live and
        // must still be disposed at stop.
        tapManager = new TapManager(
          agentId,
          workspace,
          bus,
          options.codeSandboxService,
          options.adfCallHandler,
        )
        try {
          await tapManager.register(taps)
        } catch (error) {
          if (options.onTapRegisterError) options.onTapRegisterError(error)
          else {
            console.error(`[Umbilical] Tap registration failed for ${agentId}:`, error)
            try {
              workspace.insertLog('error', 'runtime', 'tap_register_failed', null, describeError(error).slice(0, 200))
            } catch { /* non-fatal */ }
          }
        }
      }

      // AFTER tap registration so a tap observes its own agent's load event.
      withSource('system:lifecycle', agentId, () => {
        emitUmbilicalEvent({
          event_type: 'agent.loaded',
          agentId,
          payload: {
            filePath,
            name: config.name,
            handle: config.handle,
            autostart: config.autostart ?? false,
          },
        })
      })
    },
    stop: () => {
      tapManager?.dispose()
      tapManager = null
      // Emitted BEFORE the bus is destroyed so in-process taps and external
      // /events subscribers both see the unload.
      withSource('system:lifecycle', agentId, () => {
        emitUmbilicalEvent({ event_type: 'agent.unloaded', agentId, payload: { filePath } })
      })
      // After the unload emit, so `agent.unloaded` is the window's last entry.
      // The ring is in-memory and dies with the agent, so it is dropped from the
      // registry here rather than kept readable past the agent's life.
      replayBuffer?.detach()
      replayBuffer = null
      unregisterUmbilicalReplayBuffer(agentId)
      destroyUmbilicalBus(agentId)
    },
  }
}

export interface AdapterBridgeOptions {
  agentId: string
  filePath: string | null
  adapterManager: ChannelAdapterManager | null
}

/** `adapter.status.changed` / `adapter.log` for the agent's channel adapters. */
export function createAdapterBridgeResource(options: AdapterBridgeOptions): LifecycleResource {
  const { agentId, filePath, adapterManager } = options

  const onStatusChanged = (type: string, status: AdapterStatus, error?: string): void => {
    withSource('system:adapter', agentId, () => {
      emitUmbilicalEvent({
        event_type: 'adapter.status.changed',
        agentId,
        payload: { filePath, type, status, error },
      })
    })
  }
  const onLog = (type: string, entry: AdapterLogEntry): void => {
    withSource('system:adapter', agentId, () => {
      emitUmbilicalEvent({
        event_type: 'adapter.log',
        agentId,
        timestamp: entry.timestamp,
        payload: { filePath, type, entry },
      })
    })
  }

  return {
    name: 'umbilical-adapter-bridge',
    start: () => {
      if (!adapterManager) return
      adapterManager.on('status-changed', onStatusChanged)
      adapterManager.on('log', onLog)
    },
    stop: () => {
      if (!adapterManager) return
      adapterManager.off('status-changed', onStatusChanged)
      adapterManager.off('log', onLog)
    },
  }
}

export interface McpBridgeOptions {
  agentId: string
  filePath: string | null
  mcpManager: McpClientManager | null
}

/** `mcp.status.changed` / `mcp.tools.discovered` / `mcp.log` for the agent's MCP servers. */
export function createMcpBridgeResource(options: McpBridgeOptions): LifecycleResource {
  const { agentId, filePath, mcpManager } = options

  const onStatusChanged = (name: string, status: McpServerStatus, error?: string): void => {
    withSource('system:mcp', agentId, () => {
      emitUmbilicalEvent({
        event_type: 'mcp.status.changed',
        agentId,
        payload: { filePath, name, status, error },
      })
    })
  }
  const onToolsDiscovered = (name: string, tools: McpToolInfo[]): void => {
    withSource('system:mcp', agentId, () => {
      emitUmbilicalEvent({
        event_type: 'mcp.tools.discovered',
        agentId,
        payload: { filePath, name, toolCount: tools.length },
      })
    })
  }
  const onLog = (name: string, entry: McpServerLogEntry): void => {
    withSource('system:mcp', agentId, () => {
      emitUmbilicalEvent({
        event_type: 'mcp.log',
        agentId,
        timestamp: entry.timestamp,
        payload: { filePath, name, entry },
      })
    })
  }

  return {
    name: 'umbilical-mcp-bridge',
    start: () => {
      if (!mcpManager) return
      mcpManager.on('status-changed', onStatusChanged)
      mcpManager.on('tools-discovered', onToolsDiscovered)
      mcpManager.on('log', onLog)
    },
    stop: () => {
      if (!mcpManager) return
      mcpManager.off('status-changed', onStatusChanged)
      mcpManager.off('tools-discovered', onToolsDiscovered)
      mcpManager.off('log', onLog)
    },
  }
}

/**
 * The complete umbilical resource set, in host-independent order. Every host
 * spreads this at the FRONT of its `resources` array.
 */
export function createUmbilicalResources(
  options: UmbilicalLifecycleOptions & {
    adapterManager?: ChannelAdapterManager | null
    mcpManager?: McpClientManager | null
  },
): { resources: LifecycleResource[]; lifecycle: UmbilicalLifecycleResource } {
  const lifecycle = createUmbilicalLifecycleResource(options)
  return {
    lifecycle,
    resources: [
      lifecycle,
      createAdapterBridgeResource({
        agentId: options.agentId,
        filePath: options.filePath,
        adapterManager: options.adapterManager ?? null,
      }),
      createMcpBridgeResource({
        agentId: options.agentId,
        filePath: options.filePath,
        mcpManager: options.mcpManager ?? null,
      }),
    ],
  }
}
