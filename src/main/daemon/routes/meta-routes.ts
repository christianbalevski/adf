// What this daemon run is, for clients deciding whether to attach to it
// (design daemon-backend.md §8.2):
//
//   GET /version
//
// Studio in `local` mode attaches only to a daemon on its own settings file
// that speaks its client API version; `startedBy` decides whether Studio may
// stop the daemon when it quits (it never stops one the CLI or a service
// manager started).

import { dirname } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { DaemonRouteContext } from './index'

/**
 * Version of the internal client API (`/client/*` routes, client frames).
 * Bump it on any change a client of the previous number cannot handle;
 * Studio refuses to attach to a daemon with another number (§8.2).
 */
export const CLIENT_API_VERSION = 1

export type DaemonStartedBy = 'studio' | 'cli' | 'service'

/** Set by whoever launches the daemon. Unset or unknown = `cli` (`adf daemon`, `adf daemon start`). */
export const DAEMON_STARTED_BY_ENV = 'ADF_DAEMON_STARTED_BY'

export function parseStartedBy(raw: string | undefined): DaemonStartedBy {
  return raw === 'studio' || raw === 'service' ? raw : 'cli'
}

export interface DaemonVersionInfo {
  version: string
  clientApiVersion: number
  /** The settings file this daemon reads and writes; null for an in-memory store. */
  settingsPath: string | null
  /** The directory next to the settings file: token, pid file, logs, runtime keys. */
  dataDir: string | null
  /** The mesh runtime id from settings (`runtimeId`); null until a runtime minted one. */
  runtimeId: string | null
  pid: number
  startedBy: DaemonStartedBy
}

export function registerMetaRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { options } = ctx
  server.get('/version', async (): Promise<DaemonVersionInfo> => {
    const settingsPath = options.settingsStore?.filePath ?? null
    const runtimeId = options.settingsStore?.get('runtimeId')
    return {
      version: options.version ?? process.env.ADF_VERSION ?? process.env.npm_package_version ?? 'dev',
      clientApiVersion: CLIENT_API_VERSION,
      settingsPath,
      dataDir: settingsPath ? dirname(settingsPath) : null,
      runtimeId: typeof runtimeId === 'string' && runtimeId.length > 0 ? runtimeId : null,
      pid: process.pid,
      startedBy: options.routes?.startedBy ?? 'cli',
    }
  })
}
