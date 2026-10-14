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
// over the daemon's loaded agents and tracked directories.

import { existsSync } from 'fs'
import type { FastifyInstance } from 'fastify'
import { AdfWorkspace } from '../../adf/adf-workspace'
import { agentProviderKeySource, type ProviderSettingsStore } from '../../providers/provider-factory'
import {
  listAdapterCredentialFiles,
  listMcpCredentialFiles,
  listProviderCredentialFiles,
  type CredentialFileSources,
} from '../../services/credential-list-files'
import { canonicalizePath } from '../../utils/tracked-paths'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import type { DaemonSettingsStore } from '../http-api'
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

function canon(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
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
    return listMcpCredentialFiles({ mcpServerName, npmPackage }, sources())
  })

  server.get<{ Querystring: { adapterType?: string } }>('/credentials/adapters/files', async (request, reply) => {
    const adapterType = stringParam(request.query.adapterType)
    if (!adapterType) return badRequest(reply, 'adapterType is required')
    return listAdapterCredentialFiles(adapterType, sources())
  })

  server.get<{ Querystring: { providerId?: string } }>('/credentials/providers/files', async (request, reply) => {
    const providerId = stringParam(request.query.providerId)
    if (!providerId) return badRequest(reply, 'providerId is required')
    return listProviderCredentialFiles(providerId, sources())
  })

  // Where each of an agent's provider copies gets its key. The entries come
  // from the caller (the renderer's config save is debounced, so the file can
  // lag a copy just added); only the keys are read from the file. A loaded
  // agent is read from its open workspace, any other file with a short open.
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
    const key = canon(filePath)
    const live = runtime.listLiveAgents().find((a) => canon(a.filePath) === key)
    let workspace: AdfWorkspace | null = live?.workspace ?? null
    let temp = false
    try {
      if (!workspace) {
        if (!filePath.toLowerCase().endsWith('.adf') || !existsSync(filePath)) return { sources: {}, error: 'Cannot open file' }
        workspace = AdfWorkspace.open(filePath)
        temp = true
      }
      const out: Record<string, string> = {}
      // The derived key of a password-protected file is not reachable here;
      // its sealed keys then read as 'locked', as on a fresh open in Studio.
      for (const entry of entries) out[entry.id] = agentProviderKeySource(entry, workspace, null, providerSettings(settings))
      return { sources: out }
    } catch (error) {
      return { sources: {}, error: String(error) }
    } finally {
      if (temp) workspace?.close()
    }
  })
}
