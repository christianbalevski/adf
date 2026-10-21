import { dialog } from 'electron'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError } from '../../../../shared/daemon-client'
import type { AgentActivity, AgentVitals } from '../../../../shared/types/agent-vitals.types'
import type { FleetMessageResult, FleetPendingInteraction, FleetStateResult, FleetStatusResult } from '../../../../shared/types/ipc.types'
import type { AgentState } from '../../../../shared/types/ipc.types'
import { countActiveLoops } from '../../../runtime/background-event-mapping'
import type { DaemonHandlerTable, DaemonModeContext } from '../context'
import { pathKey, samePath } from '../session'
import { fleetState, hydrateBurn } from './poll'

/**
 * Daemon-mode handlers for the mesh, the fleet map, the overview card,
 * the mesh HTTP server, peers, the LAN firewall and the emergency stop
 * (tracker W3-D). Results have the embedded handlers' shapes
 * (src/main/ipc/index.ts), error answers included; the daemon routes are
 * W1-D's fleet routes, the network routes and W3-D's path-addressed fleet
 * routes (daemon/routes/fleet-client-routes.ts).
 *
 * The polled reads go through the coalescer (poll.ts), then get Studio's
 * client state (clientOverlay): which agent is in the foreground is D3
 * client state the daemon does not have. The firewall is the
 * Studio host's own: it is checked and changed here, with the mesh port and
 * LAN binding of the daemon's server; in remote mode that server is on
 * another machine, so both channels answer with the sentence below.
 */

/** Studio's defaults when there is no mesh server (MESH_SERVER_STATUS, the firewall). */
const DEFAULT_MESH_PORT = 7295
const DEFAULT_MESH_HOST = '127.0.0.1'

export const REMOTE_FIREWALL_SENTENCE =
  'The firewall check applies to this computer, but the mesh server runs on the remote daemon\'s machine. Check that machine\'s firewall there: allow inbound TCP on the mesh port and UDP 5353.'

/** Embedded answers `String(error)` in a few result objects; the same text for a daemon error. */
function errorString(err: unknown): string {
  return String(err instanceof Error ? new Error(err.message) : err)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 503/405 from the network routes: the daemon has no mesh server wired (embedded: `meshServer` null). */
function noServer(err: unknown): boolean {
  return err instanceof DaemonError && (err.status === 503 || err.status === 405)
}

interface ServerStatus { running: boolean; port: number; host: string; lanAddresses?: string[]; warning?: string }

async function serverStatus(ctx: DaemonModeContext): Promise<ServerStatus | null> {
  const client = await ctx.ready()
  try {
    const s = await client.request<ServerStatus>('GET', '/network/server')
    return { running: s.running, port: s.port, host: s.host, ...(Array.isArray(s.lanAddresses) ? { lanAddresses: s.lanAddresses } : {}), ...(typeof s.warning === 'string' && s.warning ? { warning: s.warning } : {}) }
  } catch (err) {
    if (noServer(err)) return null
    throw err
  }
}

/** The polled reads: shared while in flight (poll.ts). */
async function polled<T>(ctx: DaemonModeContext, key: string, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const client = await ctx.ready()
  return fleetState(ctx).polls.get(key, () => client.request<T>('GET', path, { query, timeoutMs: 60_000 }))
}

type Row = Record<string, unknown>

/**
 * The foreground/background split embedded mode reports, from Studio's
 * client state (D3, D6). Embedded builds the live rows from the background
 * manager's statuses (display state from the event mapping, inner-loop
 * count) and the foreground executor's raw state (no inner-loop count), and
 * the mesh lists the foreground registration apart. The daemon has no
 * foreground: it answers every agent from its executor. So the session's
 * open, running agent keeps the daemon's row, and every other running agent
 * gets the state and inner-loop count of the bridge's background mapping
 * (the same mapping embedded's background manager keeps,
 * background-event-mapping.ts).
 */
interface ClientOverlay {
  remote: boolean
  focusedPath: string | null
  background: Map<string, { state: AgentState; activeLoops: number }>
}

function clientOverlay(ctx: DaemonModeContext): ClientOverlay {
  const background = new Map<string, { state: AgentState; activeLoops: number }>()
  for (const agent of ctx.bridge.runningAgents()) {
    if (ctx.session.isFocused(agent.agentId, agent.filePath)) continue
    background.set(pathKey(agent.filePath, ctx.mode === 'remote'), { state: agent.mapping.state, activeLoops: countActiveLoops(agent.mapping.loopStates) })
  }
  return { remote: ctx.mode === 'remote', focusedPath: ctx.session.filePath, background }
}

/** Live rows (mesh statuses) and ghost rows (tracked files) of a fleet or mesh answer. */
function overlayRows(rows: unknown, overlay: ClientOverlay): void {
  if (!Array.isArray(rows)) return
  for (const row of rows as Row[]) {
    if (!row || typeof row.filePath !== 'string') continue
    const live = overlay.background.get(pathKey(row.filePath, overlay.remote))
    if (!live) continue
    row.state = live.state
    // A mesh row (getAgentStatuses) carries `canReceive`; embedded overlays the inner-loop count onto it.
    if (typeof row.canReceive === 'boolean') row.activeLoops = live.activeLoops
    else if ('online' in row) row.online = live.state !== 'off'
  }
}

/** The mesh debug view: the foreground registration is listed apart, without state and tool count. */
function overlayDebug(debug: Row, overlay: ClientOverlay): void {
  const background = debug.backgroundAgents
  if (!Array.isArray(background) || !overlay.focusedPath) return
  const at = (background as Row[]).findIndex((a) => typeof a?.filePath === 'string' && samePath(a.filePath, overlay.focusedPath, overlay.remote))
  if (at < 0) return
  const [entry] = (background as Row[]).splice(at, 1)
  const foreground = Array.isArray(debug.foregroundAgents) ? debug.foregroundAgents as Row[] : []
  foreground.push({ filePath: entry.filePath, name: entry.name, onMessageReceived: entry.onMessageReceived, hasMessaging: entry.hasMessaging })
  debug.foregroundAgents = foreground
}

/** A mesh status answer (buildMeshStatus) with Studio's client state; the cached answer is not touched. */
function meshStatusView(answer: Row | null, overlay: ClientOverlay): Row | null {
  if (!answer) return answer
  const view = structuredClone(answer)
  overlayRows(view.agents, overlay)
  overlayDebug(view, overlay)
  return view
}

function fleetStatusView(answer: FleetStatusResult, overlay: ClientOverlay): FleetStatusResult {
  const view = structuredClone(answer)
  overlayRows(view.agents, overlay)
  return view
}

interface EmergencyStopResult { success: boolean; error?: string; skipped?: string[]; failed?: string[]; stoppedAgents?: number }

/**
 * After a partial stop the open agent was detached, so the window saw none
 * of its teardown. Show where it ended: still running (the daemon named it in
 * `failed`, or it has a status) is attached again with its current state;
 * gone (404) gets the foreground `state_changed: stopped`, as embedded's
 * AGENT_STOP would show, since the status bar no longer resets the window
 * after a partial stop. Its bridge entry is not recreated (no file path).
 */
async function resyncAfterPartialStop(ctx: DaemonModeContext, agentId: string, _result: EmergencyStopResult): Promise<void> {
  const client = await ctx.ready()
  let status: { runtimeState?: string; filePath?: string | null } | null = null
  let gone = false
  try {
    status = await client.request('GET', `/agents/${encodeURIComponent(agentId)}/status`)
  } catch (err) {
    if (err instanceof DaemonError && err.status === 404) gone = true
    else ctx.log.warn(`[EmergencyStop] Could not read the open agent's state after a partial stop: ${errorMessage(err)}`)
  }
  ctx.bridge.attach(agentId)
  const state = status?.runtimeState ?? (gone ? 'stopped' : null)
  if (!state) return
  ctx.log.log(gone
    ? `[EmergencyStop] ${ctx.session.filePath} stopped in the partial stop`
    : `[EmergencyStop] ${ctx.session.filePath} is still running after the partial stop (${state}); showing it again`)
  ctx.bridge.handleFrame({
    kind: 'executor',
    agentId,
    filePath: null,
    event: { type: 'state_changed', payload: { state }, timestamp: Date.now() },
  } as never)
}

/** Studio's own writes make the next poll fresh (a read in flight may predate them). */
function invalidate(ctx: DaemonModeContext): void {
  fleetState(ctx).polls.invalidate()
}

export const MESH_HANDLERS: DaemonHandlerTable = {
  // --- mesh on/off ---------------------------------------------------------------
  // The daemon persists meshEnabled, as Studio does; embedded answers no more than success.
  [IPC.MESH_ENABLE]: async (ctx) => {
    const client = await ctx.ready()
    try {
      await client.request('POST', '/network/mesh/enable', { query: { persist: 0 } })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorString(error) }
    } finally {
      invalidate(ctx)
    }
  },

  [IPC.MESH_DISABLE]: async (ctx) => {
    const client = await ctx.ready()
    try {
      await client.request('POST', '/network/mesh/disable', { query: { persist: 0 } })
      return { success: true }
    } catch (error) {
      return { success: false, error: errorString(error) }
    } finally {
      invalidate(ctx)
    }
  },

  // --- fleet map reads (polled) --------------------------------------------------
  [IPC.MESH_STATUS]: async (ctx, _event, args?: { debug?: boolean; sinceSeq?: number }) => {
    const debug = args?.debug ? 1 : undefined
    const sinceSeq = typeof args?.sinceSeq === 'number' ? args.sinceSeq : undefined
    const answer = await polled<Row>(ctx, `mesh:${debug ?? 0}:${sinceSeq ?? ''}`, '/fleet/mesh', { debug, sinceSeq })
    return meshStatusView(answer, clientOverlay(ctx))
  },

  [IPC.MESH_FLEET_STATUS]: async (ctx) => fleetStatusView(await polled<FleetStatusResult>(ctx, 'fleet', '/fleet/status'), clientOverlay(ctx)),

  [IPC.MESH_TOKEN_BURN]: async (ctx) => {
    await hydrateBurn(ctx, await ctx.ready())
    return polled<unknown>(ctx, 'burn', '/fleet/burn')
  },

  // The fleet map's 5 s poll: one batched route ({ debug, fleet, burn, adapters, peers }).
  [IPC.MESH_MAP_POLL]: async (ctx, _event, args?: { sinceSeq?: number }) => {
    await hydrateBurn(ctx, await ctx.ready())
    const sinceSeq = typeof args?.sinceSeq === 'number' ? args.sinceSeq : undefined
    const answer = await polled<{ debug: Row | null; fleet: FleetStatusResult } & Row>(ctx, `map:${sinceSeq ?? ''}`, '/fleet/map', { sinceSeq })
    const overlay = clientOverlay(ctx)
    return { ...answer, debug: meshStatusView(answer.debug, overlay), fleet: fleetStatusView(answer.fleet, overlay) }
  },

  [IPC.MESH_GET_RECENT_TOOLS]: (ctx) => polled<Record<string, unknown>>(ctx, 'recent-tools', '/fleet/recent-tools'),

  [IPC.MESH_PENDING_INTERACTIONS]: async (ctx) => {
    const client = await ctx.ready()
    return client.request<FleetPendingInteraction[]>('GET', '/approvals/interactions')
  },

  // --- overview card (path-addressed, any .adf) ------------------------------------
  [IPC.AGENT_VITALS]: async (ctx, _event, args: { filePath: string; force?: boolean }) => {
    const client = await ctx.ready()
    return client.request<AgentVitals>('GET', '/fleet/vitals', { query: { path: args.filePath, force: args.force ? 1 : undefined }, timeoutMs: 60_000 })
  },

  [IPC.AGENT_ACTIVITY]: async (ctx, _event, args: { filePath: string; force?: boolean }) => {
    const client = await ctx.ready()
    return client.request<AgentActivity>('GET', '/fleet/activity', { query: { path: args.filePath, force: args.force ? 1 : undefined }, timeoutMs: 60_000 })
  },

  // --- fleet map commands ------------------------------------------------------------
  [IPC.MESH_MESSAGE_AGENTS]: async (ctx, _event, args: { filePaths: string[]; content: string }) => {
    const client = await ctx.ready()
    try {
      // A message to an agent that is not running starts it: allow for a cold start.
      return await client.request<FleetMessageResult>('POST', '/fleet/message', {
        body: { filePaths: Array.isArray(args?.filePaths) ? args.filePaths : [], content: typeof args?.content === 'string' ? args.content : '' },
        timeoutMs: 180_000,
      })
    } finally {
      invalidate(ctx)
    }
  },

  [IPC.MESH_SET_AGENT_STATE]: async (ctx, _event, args: { filePaths: string[]; state: string }) => {
    const client = await ctx.ready()
    try {
      return await client.request<FleetStateResult>('POST', '/fleet/state', {
        body: { filePaths: Array.isArray(args?.filePaths) ? args.filePaths : [], state: args?.state },
      })
    } finally {
      invalidate(ctx)
    }
  },

  [IPC.MESH_FOUND_AGENT]: async (ctx, _event, args: { dir: string; name: string; newRoot?: boolean }) => {
    const client = await ctx.ready()
    try {
      return await client.request<{ success: boolean; filePath?: string; error?: string }>('POST', '/fleet/found', {
        body: { dir: args?.dir ?? '', name: args?.name ?? '', ...(args?.newRoot === true ? { newRoot: true } : {}) },
        timeoutMs: 60_000,
      })
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    } finally {
      invalidate(ctx)
    }
  },

  // --- mesh HTTP server ----------------------------------------------------------------
  // Start/stop change the running server only (persist=0): embedded Studio
  // does not write meshServerEnabled, so the next daemon start brings the
  // server back as before. The CLI's start/stop persist (the route default).
  [IPC.MESH_SERVER_STATUS]: async (ctx) =>
    (await serverStatus(ctx)) ?? { running: false, port: DEFAULT_MESH_PORT, host: DEFAULT_MESH_HOST },

  [IPC.MESH_SERVER_RESTART]: async (ctx) => {
    const client = await ctx.ready()
    try {
      const s = await client.request<ServerStatus>('POST', '/network/server/restart', { timeoutMs: 60_000 })
      return { success: true, running: s.running, port: s.port, host: s.host }
    } catch (err) {
      if (noServer(err)) return { success: false, error: 'No mesh server' }
      throw err
    } finally {
      invalidate(ctx)
    }
  },

  [IPC.MESH_SERVER_START]: async (ctx) => {
    const current = await serverStatus(ctx)
    if (!current) return { success: false, error: 'No mesh server' }
    if (current.running) return { success: true, running: true, port: current.port, host: current.host }
    const client = await ctx.ready()
    try {
      const s = await client.request<ServerStatus>('POST', '/network/server/start', { query: { persist: 0 }, timeoutMs: 60_000 })
      return {
        success: s.running,
        running: s.running,
        port: s.port,
        host: s.host,
        ...(!s.running && { error: 'Failed to start server' }),
      }
    } catch (err) {
      if (noServer(err)) return { success: false, error: 'No mesh server' }
      throw err
    } finally {
      invalidate(ctx)
    }
  },

  [IPC.MESH_SERVER_STOP]: async (ctx) => {
    const client = await ctx.ready()
    try {
      const s = await client.request<ServerStatus>('POST', '/network/server/stop', { query: { persist: 0 }, timeoutMs: 60_000 })
      return { success: true, running: false, port: s.port, host: s.host }
    } catch (err) {
      if (noServer(err)) return { success: false, error: 'No mesh server' }
      throw err
    } finally {
      invalidate(ctx)
    }
  },

  [IPC.MESH_SERVER_LAN_IPS]: async (ctx) => {
    const client = await ctx.ready()
    // The route wraps getLanAddresses() ({ hostname, addresses }) in { addresses }.
    const answer = await client.request<{ addresses: unknown }>('GET', '/network/mesh/lan-addresses')
    return answer.addresses
  },

  // --- peers ---------------------------------------------------------------------------
  [IPC.MESH_DISCOVERED_RUNTIMES]: async (ctx, _event, args?: { force?: boolean }) => {
    const client = await ctx.ready()
    const answer = await client.request<{ runtimes: unknown[] }>('GET', '/network/mesh/discovered-runtimes', {
      query: { force: args?.force ? 1 : undefined },
      timeoutMs: 60_000,
    })
    return answer.runtimes
  },

  [IPC.MESH_PEER_AGENT_HEALTH]: async (ctx, _event, healthUrl: string) => {
    const client = await ctx.ready()
    return client.request('GET', '/network/peers/health', { query: { url: healthUrl } })
  },

  [IPC.MESH_PEER_SHARED_FILE]: async (ctx, _event, baseUrl: string, filePath: string) => {
    const client = await ctx.ready()
    return client.request('GET', '/network/peers/shared-file', { query: { baseUrl, path: filePath }, timeoutMs: 60_000 })
  },

  // --- LAN firewall: the Studio host's own, with the daemon's mesh port --------------------
  [IPC.MESH_FIREWALL_CHECK]: async (ctx) => {
    const server = await serverStatus(ctx)
    const port = server?.port ?? DEFAULT_MESH_PORT
    const serverLanBound = server?.host === '0.0.0.0'
    if (ctx.mode === 'remote') {
      return { platform: process.platform, supported: false, ruleConfigured: null, reachable: null, lanIp: null, detail: REMOTE_FIREWALL_SENTENCE, commands: [], port, serverLanBound, verified: false }
    }
    const { checkLanFirewall } = await import('../../../services/firewall-service')
    const fw = await checkLanFirewall(port)
    const verified = serverLanBound && (fw.supported ? fw.ruleConfigured === true : fw.reachable === true)
    return { ...fw, port, serverLanBound, verified }
  },

  // --- emergency stop -------------------------------------------------------------------
  /**
   * The daemon's teardown (W1-D route): runtime gate closed, mesh off, every
   * agent unloaded, WS connections, mesh server, child processes, host
   * execs, sandbox workers and compute stopped. A part the daemon could not
   * stop answers `success: false` with `skipped` / `failed`; that is shown
   * (log and a warning dialog), never read as a full stop.
   */
  [IPC.EMERGENCY_STOP]: async (ctx) => {
    const client = await ctx.ready()
    ctx.log.log('[EmergencyStop] Asking the ADF daemon to stop everything...')
    // Embedded detaches the foreground host first: the renderer sees none of
    // its teardown events and resets its own state after the call. The
    // bridge drops the detach when the agent's stop arrives.
    const focused = ctx.session.agentId
    if (focused) ctx.bridge.detach(focused)
    let result: EmergencyStopResult
    try {
      result = await client.request<EmergencyStopResult>('POST', '/runtime/emergency-stop', { timeoutMs: 120_000 })
    } catch (err) {
      // The stop may not have reached the daemon: keep showing the open agent,
      // say so, and let the renderer keep its state (StatusBar resets only after a stop).
      if (focused) ctx.bridge.attach(focused)
      const why = errorMessage(err)
      ctx.log.error(`[EmergencyStop] The stop did not reach the ADF daemon: ${why}`)
      void dialog.showMessageBox({
        type: 'error',
        message: 'Emergency stop did not reach the ADF daemon.',
        detail: `${why}\n\nAgents may still be running.`,
        buttons: ['OK'],
      }).catch(() => {})
      throw err
    } finally {
      invalidate(ctx)
    }
    if (result.success) {
      ctx.log.log('[EmergencyStop] The daemon stopped all agents; mesh disabled.')
      return result
    }
    const parts = [
      result.skipped?.length ? `Left running (not wired on this daemon): ${result.skipped.join(', ')}.` : '',
      result.failed?.length ? `Failed to stop: ${result.failed.join(', ')}.` : '',
    ].filter(Boolean)
    ctx.log.error(`[EmergencyStop] ${result.error ?? 'Partial stop.'}`)
    void dialog.showMessageBox({
      type: 'warning',
      message: 'Emergency stop was partial.',
      detail: `${parts.length ? parts.join('\n') : result.error ?? 'The ADF daemon could not stop everything.'}\n\nAgents may still be running.`,
      buttons: ['OK'],
    }).catch(() => {})
    if (focused) await resyncAfterPartialStop(ctx, focused, result)
    return result
  },
}
