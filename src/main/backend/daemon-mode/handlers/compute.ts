import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError } from '../../../../shared/daemon-client'
import type { BrowserSessionInfo, ContainerSummary } from '../../../../shared/types/compute.types'
import { enc, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { fleetState } from './poll'
import { remoteName } from './providers'
import { DesktopRelays } from '../remote/desktop-relay'

/**
 * Daemon-mode handlers for compute (Settings → Compute, the dashboard's
 * container tile, the Computer tab) and the daemon's container service
 * (tracker W3-D). Results have the embedded handlers' shapes
 * (src/main/ipc/index.ts); a handler that catches there turns a daemon
 * error into the same `{ success: false, error }`.
 *
 * W1-G: a runtime stops only the containers it started. `leftRunning` (in
 * COMPUTE_STATUS, from the daemon's last stop) names a container left to
 * another runtime, and each container row carries `users`, the other live
 * runtimes using it (GET /compute/users), for the Stop, Remove and Rebuild
 * confirmations. Embedded rows carry them too (listContainersWithUsers).
 */

/** Podman install, machine init/start and image pulls take minutes. */
const LONG_MS = 15 * 60_000

/** The browser viewer of a remote runtime whose daemon cannot relay the desktop (an older version). */
export function remoteBrowserSentence(name: string): string {
  return `Open on ${name}, or update ADF there to see this desktop here.`
}

/** One set of desktop relays per runtime connection; requests use the latest window's client. */
const relaysByConnection = new WeakMap<object, { relays: DesktopRelays; ctx: DaemonModeContext }>()

function desktopRelays(ctx: DaemonModeContext): DesktopRelays {
  let entry = relaysByConnection.get(ctx.connection)
  if (!entry) {
    const created: { relays: DesktopRelays; ctx: DaemonModeContext } = { ctx, relays: new DesktopRelays(() => created.ctx.ready()) }
    entry = created
    relaysByConnection.set(ctx.connection, entry)
  }
  entry.ctx = ctx
  return entry.relays
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A compute action whose embedded handler answers `{ success: false, error }` when it throws. */
async function action<T extends object>(ctx: DaemonModeContext, run: () => Promise<T>): Promise<T | { success: false; error: string }> {
  try {
    return await run()
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  } finally {
    fleetState(ctx).polls.invalidate()
  }
}

/** Other runtimes using each listed container (W1-G); {} from a daemon without the route. */
async function containerUsers(ctx: DaemonModeContext, names: string[]): Promise<Record<string, string[]>> {
  const client = await ctx.ready()
  try {
    return (await client.request<{ users: Record<string, string[]> }>('GET', '/compute/users', { query: { names: names.join(',') } })).users ?? {}
  } catch (err) {
    if (!(err instanceof DaemonError) || err.unreachable) throw err
    return {}
  }
}

export const COMPUTE_HANDLERS: DaemonHandlerTable = {
  [IPC.COMPUTE_STATUS]: async (ctx) => {
    const client = await ctx.ready()
    return client.request('GET', '/compute/status')
  },

  [IPC.COMPUTE_INIT]: (ctx) => action(ctx, async () => {
    const client = await ctx.ready()
    await client.request('POST', '/compute/start', { timeoutMs: LONG_MS })
    return { success: true }
  }),

  // The shared container only, as embedded (POST /compute/stop stops every container this runtime started).
  [IPC.COMPUTE_STOP]: (ctx) => action(ctx, async () => {
    const client = await ctx.ready()
    return client.request<{ success: boolean; error?: string }>('POST', '/compute/shared/stop', { timeoutMs: LONG_MS })
  }),

  [IPC.COMPUTE_DESTROY]: (ctx) => action(ctx, async () => {
    const client = await ctx.ready()
    await client.request('POST', '/compute/destroy', { timeoutMs: LONG_MS })
    return { success: true }
  }),

  [IPC.COMPUTE_LIST_CONTAINERS]: async (ctx) => {
    const client = await ctx.ready()
    const { containers } = await client.request<{ containers: ContainerSummary[] }>('GET', '/compute/containers', { timeoutMs: 60_000 })
    if (containers.length === 0) return { containers }
    const users = await containerUsers(ctx, containers.map((c) => c.name))
    return { containers: containers.map((c) => (users[c.name]?.length ? { ...c, users: users[c.name] } : c)) }
  },

  [IPC.COMPUTE_STOP_CONTAINER]: (ctx, _event, args: { name: string }) => action(ctx, async () => {
    const client = await ctx.ready()
    return client.request<{ success: boolean }>('POST', `/compute/containers/${enc(args.name)}/stop`, { timeoutMs: LONG_MS })
  }),

  [IPC.COMPUTE_START_CONTAINER]: (ctx, _event, args: { name: string }) => action(ctx, async () => {
    const client = await ctx.ready()
    return client.request<{ success: boolean }>('POST', `/compute/containers/${enc(args.name)}/start`, { timeoutMs: LONG_MS })
  }),

  [IPC.COMPUTE_DESTROY_CONTAINER]: (ctx, _event, args: { name: string }) => action(ctx, async () => {
    const client = await ctx.ready()
    return client.request<{ success: boolean }>('POST', `/compute/containers/${enc(args.name)}/destroy`, { timeoutMs: LONG_MS })
  }),

  // The route answers { success, recreated } or { success: false, error } itself.
  [IPC.COMPUTE_REBUILD_CONTAINER]: (ctx, _event, args: { name: string }) => action(ctx, async () => {
    const client = await ctx.ready()
    return client.request<{ success: boolean; recreated?: boolean; error?: string }>('POST', `/compute/containers/${enc(args.name)}/rebuild`, { timeoutMs: LONG_MS })
  }),

  [IPC.COMPUTE_SETUP]: (ctx, _event, args: { step: 'install' | 'machine_init' | 'machine_start' | 'check'; installCommand?: string }) => action(ctx, async () => {
    const client = await ctx.ready()
    return client.request<Record<string, unknown>>('POST', '/compute/setup', {
      body: { step: args?.step, ...(args?.installCommand !== undefined ? { installCommand: args.installCommand } : {}) },
      timeoutMs: LONG_MS,
    })
  }),

  [IPC.COMPUTE_CONTAINER_DETAIL]: async (ctx, _event, args: { name: string }) => {
    const client = await ctx.ready()
    try {
      return await client.request<Record<string, unknown>>('GET', `/compute/containers/${enc(args.name)}`, { timeoutMs: 60_000 })
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
  },

  [IPC.COMPUTE_EXEC_LOG]: async (ctx, _event, args: { name?: string }) => {
    const client = await ctx.ready()
    return client.request<{ entries: unknown[] }>('GET', '/compute/exec-log', { query: { name: args?.name } })
  },

  [IPC.COMPUTE_TEST_EXECUTION_TARGET]: async (ctx, _event, target: unknown) => {
    const client = await ctx.ready()
    return client.request('POST', '/compute/execution-targets/test', { body: target ?? {}, timeoutMs: 120_000 })
  },

  // Remote: the server's noVNC port is on its loopback (§9.3), so the viewer gets a loopback
  // relay on this computer that forwards to GET /compute/desktop/:container/* (desktop-relay.ts).
  // A server without those routes keeps the old answer: no port, and the reason as the detail.
  [IPC.COMPUTE_BROWSER_INFO]: async (ctx, _event, args: { agentName: string; agentId: string }) => {
    const client = await ctx.ready()
    const info = await client.request<BrowserSessionInfo>('GET', '/compute/browser-info', {
      query: { agentName: args?.agentName, agentId: args?.agentId },
      timeoutMs: 120_000,
    })
    if (ctx.mode !== 'remote' || info.hostPort == null) return info
    const unreachable = { ...info, hostPort: null, detail: remoteBrowserSentence(remoteName(ctx)) }
    const page = await ctx.raw(`/compute/desktop/${enc(info.containerName)}/vnc.html`).catch(() => null)
    if (!page?.ok) return unreachable
    return { ...info, hostPort: await desktopRelays(ctx).portFor(info.containerName) }
  },

  // The dashboard tile (polled): the same counts and `unavailable` rule as embedded.
  [IPC.DASHBOARD_CONTAINERS]: async (ctx) => {
    const client = await ctx.ready()
    return fleetState(ctx).polls.get('dashboard-containers', async () => {
      try {
        const [{ containers }, status] = await Promise.all([
          client.request<{ containers: Array<{ running: boolean }> }>('GET', '/compute/containers', { timeoutMs: 60_000 }),
          client.request<{ status: string }>('GET', '/compute/status'),
        ])
        return {
          total: containers.length,
          running: containers.filter((c) => c.running).length,
          unavailable: status.status === 'not_installed' || undefined,
        }
      } catch (err) {
        if (err instanceof DaemonError && err.unreachable) throw err
        return { total: 0, running: 0, unavailable: true }
      }
    })
  },
}
