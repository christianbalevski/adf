import { dialog } from 'electron'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError } from '../../../../shared/daemon-client'
import type { AgentActivity, AgentVitals } from '../../../../shared/types/agent-vitals.types'
import type { FleetMessageResult, FleetPendingInteraction, FleetStateResult, FleetStatusResult } from '../../../../shared/types/ipc.types'
import type { DaemonHandlerTable, DaemonModeContext } from '../context'
import { fleetState, hydrateBurn } from './poll'

/**
 * Daemon-mode handlers for the mesh, the fleet map, the overview card,
 * the mesh HTTP server, peers, the LAN firewall and the emergency stop
 * (tracker W3-D). Results have the embedded handlers' shapes
 * (src/main/ipc/index.ts), error answers included; the daemon routes are
 * W1-D's fleet routes, the network routes and W3-D's path-addressed fleet
 * routes (daemon/routes/fleet-client-routes.ts).
 *
 * The polled reads go through the coalescer (poll.ts). The firewall is the
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

interface ServerStatus { running: boolean; port: number; host: string }

async function serverStatus(ctx: DaemonModeContext): Promise<ServerStatus | null> {
  const client = await ctx.ready()
  try {
    const s = await client.request<ServerStatus>('GET', '/network/server')
    return { running: s.running, port: s.port, host: s.host }
  } catch (err) {
    if (noServer(err)) return null
    throw err
  }
}

/** The polled reads: shared while in flight, then served for a second (poll.ts). */
async function polled<T>(ctx: DaemonModeContext, key: string, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const client = await ctx.ready()
  return fleetState(ctx).polls.get(key, () => client.request<T>('GET', path, { query, timeoutMs: 60_000 }))
}

/** Studio's own writes make the next poll fresh. */
function invalidate(ctx: DaemonModeContext): void {
  fleetState(ctx).polls.invalidate()
}

export const MESH_HANDLERS: DaemonHandlerTable = {
  // --- mesh on/off ---------------------------------------------------------------
  // The daemon persists meshEnabled, as Studio does; embedded answers no more than success.
  [IPC.MESH_ENABLE]: async (ctx) => {
    const client = await ctx.ready()
    try {
      await client.request('POST', '/network/mesh/enable')
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
      await client.request('POST', '/network/mesh/disable')
      return { success: true }
    } catch (error) {
      return { success: false, error: errorString(error) }
    } finally {
      invalidate(ctx)
    }
  },

  // --- fleet map reads (polled) --------------------------------------------------
  [IPC.MESH_STATUS]: (ctx, _event, args?: { debug?: boolean; sinceSeq?: number }) => {
    const debug = args?.debug ? 1 : undefined
    const sinceSeq = typeof args?.sinceSeq === 'number' ? args.sinceSeq : undefined
    return polled<Record<string, unknown>>(ctx, `mesh:${debug ?? 0}:${sinceSeq ?? ''}`, '/fleet/mesh', { debug, sinceSeq })
  },

  [IPC.MESH_FLEET_STATUS]: (ctx) => polled<FleetStatusResult>(ctx, 'fleet', '/fleet/status'),

  [IPC.MESH_TOKEN_BURN]: async (ctx) => {
    await hydrateBurn(ctx, await ctx.ready())
    return polled<unknown>(ctx, 'burn', '/fleet/burn')
  },

  // The fleet map's 5 s poll: one batched route ({ debug, fleet, burn, adapters, peers }).
  [IPC.MESH_MAP_POLL]: async (ctx, _event, args?: { sinceSeq?: number }) => {
    await hydrateBurn(ctx, await ctx.ready())
    const sinceSeq = typeof args?.sinceSeq === 'number' ? args.sinceSeq : undefined
    return polled<unknown>(ctx, `map:${sinceSeq ?? ''}`, '/fleet/map', { sinceSeq })
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
      const s = await client.request<ServerStatus>('POST', '/network/server/start', { timeoutMs: 60_000 })
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
      const s = await client.request<ServerStatus>('POST', '/network/server/stop', { timeoutMs: 60_000 })
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
      return { platform: process.platform, supported: false, ruleConfigured: null, reachable: null, lanIp: null, detail: REMOTE_FIREWALL_SENTENCE, port, serverLanBound, verified: false }
    }
    const { checkLanFirewall } = await import('../../../services/firewall-service')
    const fw = await checkLanFirewall(port)
    const verified = serverLanBound && (fw.supported ? fw.ruleConfigured === true : fw.reachable === true)
    return { ...fw, port, serverLanBound, verified }
  },

  [IPC.MESH_FIREWALL_APPLY]: async (ctx) => {
    if (ctx.mode === 'remote') return { success: false, error: REMOTE_FIREWALL_SENTENCE }
    const server = await serverStatus(ctx)
    const { applyLanFirewall } = await import('../../../services/firewall-service')
    return applyLanFirewall(server?.port ?? DEFAULT_MESH_PORT)
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
    try {
      const result = await client.request<{ success: boolean; error?: string; skipped?: string[]; failed?: string[] }>(
        'POST', '/runtime/emergency-stop', { timeoutMs: 120_000 })
      if (result.success) {
        ctx.log.log('[EmergencyStop] The daemon stopped all agents; mesh disabled.')
      } else {
        const parts = [
          result.skipped?.length ? `Left running (not wired on this daemon): ${result.skipped.join(', ')}.` : '',
          result.failed?.length ? `Failed to stop: ${result.failed.join(', ')}.` : '',
        ].filter(Boolean).join('\n')
        ctx.log.error(`[EmergencyStop] ${result.error ?? 'Partial stop'} ${parts}`)
        void dialog.showMessageBox({
          type: 'warning',
          message: 'Emergency stop was partial.',
          detail: `${result.error ?? 'The ADF daemon could not stop everything.'}${parts ? `\n\n${parts}` : ''}`,
          buttons: ['OK'],
        }).catch(() => {})
      }
      return result
    } finally {
      invalidate(ctx)
    }
  },
}
