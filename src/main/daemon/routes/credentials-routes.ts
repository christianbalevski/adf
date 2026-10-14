// Credential metadata across agent files: the Settings pages' "agents using
// this" lists and the agent provider key-source badges.
//
//   GET  /credentials/mcp/files?mcpServerName=&npmPackage=
//   GET  /credentials/adapters/files?adapterType=
//   GET  /credentials/providers/files?providerId=
//   POST /credentials/providers/key-sources   { filePath, providers: [{ id, type, baseUrl }] }
//
// Metadata only: key names and where a key comes from, never a value. The
// list scans are the ones Studio runs (services/credential-list-files.ts),
// over the daemon's loaded agents and tracked directories, in their async
// form: directories are read asynchronously and the scan yields after every
// file, so a large tracked tree never stalls other requests or the agents.

import { existsSync } from 'fs'
import { access } from 'fs/promises'
import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { AdfDatabase } from '../../adf/adf-database'
import { agentProviderKeySource, type ProviderIdentitySource, type ProviderSettingsStore } from '../../providers/provider-factory'
import {
  listAdapterCredentialFilesAsync,
  listMcpCredentialFilesAsync,
  listProviderCredentialFilesAsync,
  type CredentialFileSources,
} from '../../services/credential-list-files'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import type { DaemonSettingsStore } from '../http-api'
import { resolveAgentWorkspaceByPath } from './agent-resolver'
import type { DaemonRouteContext } from './index'
import { badRequest, stringParam } from './route-helpers'

/** The settings slice agentProviderKeySource reads: the app's provider by id (with its key). */
export function providerSettings(store: DaemonSettingsStore | undefined): ProviderSettingsStore {
  const withLookup = store as (DaemonSettingsStore & Partial<ProviderSettingsStore>) | undefined
  if (withLookup && typeof withLookup.getProvider === 'function') return withLookup as ProviderSettingsStore
  return {
    getProvider: (id) => ((store?.get('providers') as ProviderConfig[] | undefined) ?? []).find((p) => p.id === id),
  }
}

/**
 * The key rows of a file nobody has open, read through one readonly SQLite
 * connection (no migration, no write; sidecars it created are reaped, as
 * AdfDatabase.peek* do). No envelope is unlocked, so a sealed row reads as
 * stored-but-locked, the answer Studio gives for a file it opens without
 * unlocking.
 */
function withReadonlyKeyRows<T>(filePath: string, fn: (source: ProviderIdentitySource) => T): T {
  const hadSidecars = existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)
  const db = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT encryption_algo, value FROM adf_identity WHERE purpose = ?')
    const read = (purpose: string) => row.get(purpose) as { encryption_algo: string; value: Buffer | string } | undefined
    return fn({
      getIdentityDecrypted: (purpose) => {
        const found = read(purpose)
        if (!found || found.encryption_algo !== 'plain') return null
        return Buffer.isBuffer(found.value) ? found.value.toString('utf-8') : String(found.value)
      },
      getIdentityRow: (purpose) => read(purpose) ?? null,
    })
  } finally {
    try { db.close() } catch { /* ignore */ }
    if (!hadSidecars) { try { AdfDatabase.reapSidecars(filePath) } catch { /* best effort */ } }
  }
}

export function registerCredentialsRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime } = ctx
  const settings = ctx.options.settingsStore

  const sources = (): CredentialFileSources => ({
    knownFiles: runtime.listAgents().map((a) => a.filePath).filter((p): p is string => !!p),
    trackedDirs: (settings?.get('trackedDirectories') as string[] | undefined) ?? [],
  })

  server.get<{ Querystring: { mcpServerName?: string; npmPackage?: string } }>('/credentials/mcp/files', async (request, reply) => {
    const mcpServerName = stringParam(request.query.mcpServerName)
    const npmPackage = stringParam(request.query.npmPackage)
    if (!mcpServerName || !npmPackage) return badRequest(reply, 'mcpServerName and npmPackage are required')
    return listMcpCredentialFilesAsync({ mcpServerName, npmPackage }, sources())
  })

  server.get<{ Querystring: { adapterType?: string } }>('/credentials/adapters/files', async (request, reply) => {
    const adapterType = stringParam(request.query.adapterType)
    if (!adapterType) return badRequest(reply, 'adapterType is required')
    return listAdapterCredentialFilesAsync(adapterType, sources())
  })

  server.get<{ Querystring: { providerId?: string } }>('/credentials/providers/files', async (request, reply) => {
    const providerId = stringParam(request.query.providerId)
    if (!providerId) return badRequest(reply, 'providerId is required')
    return listProviderCredentialFilesAsync(providerId, sources())
  })

  // Where each of an agent's provider copies gets its key. The entries come
  // from the caller (the renderer's config save is debounced, so the file can
  // lag a copy just added); only the keys are read from the file. A loaded
  // agent is read from its open workspace with its derived key
  // (agent-resolver.ts); any other file read-only, so a badge never writes.
  server.post<{ Body: { filePath?: unknown; providers?: unknown } }>('/credentials/providers/key-sources', async (request, reply) => {
    const body = request.body ?? {}
    const filePath = stringParam(body.filePath)
    const providers = Array.isArray(body.providers) ? body.providers : null
    if (!filePath || !providers) return badRequest(reply, 'filePath and providers are required')
    const entries: Array<Pick<ProviderConfig, 'id' | 'type' | 'baseUrl'>> = []
    for (const p of providers) {
      if (!p || typeof p !== 'object') return badRequest(reply, 'providers[] entries need id, type and baseUrl')
      const { id, type, baseUrl } = p as Record<string, unknown>
      if (typeof id !== 'string' || typeof type !== 'string' || typeof baseUrl !== 'string') {
        return badRequest(reply, 'providers[] entries need id, type and baseUrl')
      }
      entries.push({ id, type: type as ProviderConfig['type'], baseUrl })
    }
    const app = providerSettings(settings)
    const sourcesOf = (source: ProviderIdentitySource, derivedKey: Buffer | null) => {
      const out: Record<string, string> = {}
      for (const entry of entries) out[entry.id] = agentProviderKeySource(entry, source, derivedKey, app)
      return { sources: out }
    }
    try {
      const loaded = resolveAgentWorkspaceByPath(runtime, filePath)
      if (loaded) return sourcesOf(loaded.workspace, loaded.derivedKey)
      if (!filePath.toLowerCase().endsWith('.adf')) return { sources: {}, error: 'Cannot open file' }
      try { await access(filePath) } catch { return { sources: {}, error: 'Cannot open file' } }
      return withReadonlyKeyRows(filePath, (source) => sourcesOf(source, null))
    } catch (error) {
      return { sources: {}, error: String(error) }
    }
  })
}
