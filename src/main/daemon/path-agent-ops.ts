/**
 * Path-addressed agent operations (W1-E, the PATH_FILE gap of channel-map.ts):
 * Studio channels that take a file path and work on an agent file that is
 * neither open nor running — the clone dialog's table list, "set model" on a
 * fleet card, and the credential, attach and detach actions of the MCP,
 * adapter and provider settings pages. Embedded Studio opens a temporary
 * workspace for these (e.g. ipc/index.ts MCP_CREDENTIAL_SET); so does this.
 *
 * When the file is loaded in this daemon, every operation goes to the
 * RuntimeService method the /agents/:id route uses, so a running agent sees
 * the change exactly as through that route (config fan-out, provider
 * rebuild). When it is not, the file is opened for the call, the envelopes
 * are unlocked with this runtime's keys (the daemon's unlock cascade), the
 * change is written, and the file is closed. Responses have the shape of the
 * /agents/:id routes plus `filePath` and `loaded`.
 *
 * Credential values never leave the process: reads return metadata
 * (RuntimeIdentityMeta), as the /agents/:id credential routes do.
 */

import { basename } from 'node:path'
import { AdfWorkspace } from '../adf/adf-workspace'
import { AdapterInstanceConfigSchema } from '../adf/adf-schema'
import { envelopeFromAlgo } from '../crypto/envelope-crypto'
import { unlockWorkspaceEnvelopes } from '../runtime/identity-provisioner'
import { stripLoopNameMarker } from '../runtime/loop-pool'
import { CREDENTIALS_UNLOCK_HINT } from '../runtime/agent-runtime-builder'
import {
  CREDENTIALS_LOCKED_CODE,
  RuntimeLoopError,
  type RuntimeIdentityMeta,
  type RuntimeService,
} from '../runtime/runtime-service'
import type { AdfProviderConfig, AgentConfig, McpServerConfig } from '../../shared/types/adf-v02.types'
import type { AdapterInstanceConfig } from '../../shared/types/channel-adapter.types'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import { FileOpError, requireAdfPath, type AgentFileOps } from './file-ops'
import type { TrackedDirsSettings } from './tracked-dirs'

export type PathAgentRuntime = Pick<RuntimeService,
  | 'setAgentProviderCredential' | 'getAgentProviderCredentials' | 'attachAgentProvider' | 'detachAgentProvider'
  | 'setAgentMcpCredential' | 'getAgentMcpCredentials' | 'attachAgentMcpServer' | 'detachAgentMcpServer'
  | 'setAgentAdapterCredential' | 'getAgentAdapterCredentials' | 'attachAgentAdapter' | 'detachAgentAdapter'>

interface Target {
  filePath: string
  /** The loaded agent's id, when the file runs here. */
  loadedId: string | null
}

/** A table of an agent file and its row count (FILE_LIST_TABLES). */
export interface FileTable {
  name: string
  row_count: number
}

/**
 * Open a closed agent file for one call: envelopes unlocked with this
 * runtime's keys, closed afterwards whatever happens.
 */
export function withClosedAgentFile<T>(filePath: string, fn: (ws: AdfWorkspace) => T): T {
  const ws = AdfWorkspace.open(filePath)
  try {
    unlockWorkspaceEnvelopes(ws)
    return fn(ws)
  } finally {
    try { ws.close() } catch (err) { console.warn(`[PathAgentOps] Closing ${basename(filePath)} failed:`, err) }
  }
}

/**
 * Every table of an agent file with its row count, without the shadow tables
 * of virtual (FTS) tables: the clone dialog's list (Studio's FILE_LIST_TABLES).
 */
export function listTablesOf(ws: AdfWorkspace): FileTable[] {
  const virtualTables = ws.querySQL("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'") as Array<{ name: string }>
  const shadowPrefixes = virtualTables.map(v => `${v.name}_`)
  const rows = ws.querySQL("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name: string }>
  return rows
    .filter(r => !shadowPrefixes.some(prefix => r.name.startsWith(prefix)))
    .map(r => {
      const count = ws.querySQL(`SELECT COUNT(*) as count FROM "${r.name.replace(/"/g, '""')}"`) as Array<{ count: number }>
      return { name: r.name, row_count: count[0]?.count ?? 0 }
    })
}

/** RuntimeService.describeIdentity for a file opened without a password key. */
export function describeIdentityIn(ws: AdfWorkspace, purpose: string): RuntimeIdentityMeta {
  const row = ws.getIdentityRow(purpose)
  if (!row) return { purpose, present: false, storage: null, sealed: false, locked: false, length: null, code_access: false }
  const envelope = envelopeFromAlgo(row.encryption_algo)
  const storage = envelope ? 'sealed' : row.encryption_algo === 'plain' ? 'plain' : 'password'
  const locked = envelope ? ws.getEnvelopeState(envelope) !== 'unlocked' : storage === 'password'
  let length: number | null = null
  if (!locked && !purpose.startsWith('crypto:')) {
    try { length = ws.getIdentityDecrypted(purpose, null)?.length ?? null } catch { length = null }
  }
  return { purpose, present: true, storage, sealed: envelope !== null, locked, length, code_access: row.code_access }
}

function describeCredentialsIn(ws: AdfWorkspace, prefix: string): Record<string, RuntimeIdentityMeta> {
  const out: Record<string, RuntimeIdentityMeta> = {}
  for (const purpose of ws.listIdentityPurposes(prefix)) out[purpose.slice(prefix.length)] = describeIdentityIn(ws, purpose)
  return out
}

/**
 * RuntimeService.setIdentityValue for a closed file (no password key): a
 * locked envelope refuses a plain write (409 credentials_locked) unless the
 * owner asks to `replace`, which is logged to the agent's adf_logs. Returns
 * true when a locked sealed value was discarded.
 */
export function setCredentialIn(ws: AdfWorkspace, purpose: string, value: string, opts: { replace?: boolean } = {}): boolean {
  if (ws.isPasswordProtected()) {
    throw new RuntimeLoopError(
      'This agent’s identity keystore is locked with its file password. Load the agent and unlock it first (POST /agents/{id}/identity/password/unlock), then save the credential.',
      409,
      CREDENTIALS_LOCKED_CODE,
    )
  }
  const state = ws.getEnvelopeState('credentials')
  const envelopeLocked = state === 'locked' || state === 'foreign'
  const row = ws.getIdentityRow(purpose)
  const rowEnvelope = row ? envelopeFromAlgo(row.encryption_algo) : null
  const rowLocked = rowEnvelope !== null && ws.getEnvelopeState(rowEnvelope) !== 'unlocked'
  if (!envelopeLocked && !rowLocked) {
    ws.setIdentity(purpose, value)
    return false
  }
  if (!opts.replace) {
    throw new RuntimeLoopError(
      rowLocked
        ? `This agent's saved "${purpose}" is sealed and its credentials envelope is ${state} on this daemon, so it can't be read or overwritten. ${CREDENTIALS_UNLOCK_HINT} Or replace it (replace: true): the old value is discarded.`
        : `The credentials envelope of this agent is ${state} on this daemon — refusing to store "${purpose}" unsealed. ${CREDENTIALS_UNLOCK_HINT} Or store it anyway (replace: true): it is sealed once the envelope unlocks.`,
      409,
      CREDENTIALS_LOCKED_CODE,
    )
  }
  const codeAccess = row?.code_access ?? false
  if (rowLocked) ws.deleteIdentity(purpose)
  ws.setIdentity(purpose, value, codeAccess)
  const message = rowLocked
    ? `Owner replaced locked sealed credential "${purpose}" (the old value was discarded unread); the new value is stored unsealed until the credentials envelope unlocks.`
    : `Owner stored credential "${purpose}" while the credentials envelope is ${state}; it is stored unsealed until the envelope unlocks.`
  console.warn(`[PathAgentOps] ${ws.getFilePath()}: ${message}`)
  try { ws.getDatabase().insertLog('warn', 'runtime', 'credential_replaced', purpose, message) } catch { /* non-fatal */ }
  return rowLocked
}

function writeConfig(ws: AdfWorkspace, config: AgentConfig): void {
  // Derived-config-only marker: never persisted (RuntimeService.setAgentConfig does the same).
  stripLoopNameMarker(config)
  ws.setAgentConfig(config)
}

/**
 * An agent file's own provider entry with its API key, for in-process use
 * (model listing for a closed file, MODELS_LIST). Never returned over HTTP.
 * Undefined when the file has no such provider.
 */
export function readFileProviderConfig(filePath: string, providerId: string): ProviderConfig | undefined {
  return withClosedAgentFile(filePath, ws => {
    const entry = ws.getAgentConfig().providers?.find(p => p.id === providerId)
    if (!entry) return undefined
    const apiKey = ws.getIdentityDecrypted(`provider:${entry.id}:apiKey`, null) ?? ''
    return { ...entry, apiKey } as unknown as ProviderConfig
  })
}

export class PathAgentOps {
  constructor(
    private readonly runtime: PathAgentRuntime,
    private readonly files: AgentFileOps,
    private readonly settings?: TrackedDirsSettings,
  ) {}

  private async target(input: unknown): Promise<Target> {
    const filePath = await requireAdfPath(input)
    return { filePath, loadedId: this.files.loadedAt(filePath)?.id ?? null }
  }

  private closedAgentId(ws: AdfWorkspace): string {
    return ws.getAgentConfig().id
  }

  /** FILE_LIST_TABLES. */
  async tables(input: unknown): Promise<{ filePath: string; loaded: boolean; tables: FileTable[] }> {
    const t = await this.target(input)
    const live = t.loadedId ? this.files.liveAgent(t.filePath) : undefined
    if (live) return { filePath: t.filePath, loaded: true, tables: listTablesOf(live.workspace) }
    return { filePath: t.filePath, loaded: false, tables: withClosedAgentFile(t.filePath, listTablesOf) }
  }

  /**
   * AGENT_MODEL_SET_FOR_FILE: the model of a stopped agent. A running agent
   * is refused, as in Studio (its config is saved through PUT /agents/:id/config).
   */
  async setModel(input: unknown, body: unknown): Promise<{ success: true; filePath: string; model: AgentConfig['model'] }> {
    const t = await this.target(input)
    const model = isRecord(body) ? (isRecord(body.model) ? body.model : body) : null
    if (!model || typeof model.provider !== 'string' || typeof model.model_id !== 'string') {
      throw new FileOpError('provider and model_id are required', 400, 'bad_request')
    }
    if (t.loadedId) throw new FileOpError('Stop the agent before changing its model', 409, 'agent_running')
    const providers = (this.settings?.get('providers') as ProviderConfig[] | undefined) ?? []
    if (!providers.some(p => p.id === model.provider)) {
      throw new FileOpError(`Provider "${model.provider}" is not configured in Settings`, 400, 'provider_unknown')
    }
    const next = withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      config.model = { ...config.model, provider: model.provider as string, model_id: model.model_id as string }
      writeConfig(ws, config)
      return config.model
    })
    return { success: true, filePath: t.filePath, model: next }
  }

  // --- providers ---

  async setProviderCredential(input: unknown, providerId: string, body: unknown) {
    const t = await this.target(input)
    const value = isRecord(body) ? body.value : undefined
    if (typeof value !== 'string') throw new FileOpError('value is required', 400, 'bad_request')
    const replace = isRecord(body) && body.replace === true
    if (t.loadedId) return { ...this.runtime.setAgentProviderCredential(t.loadedId, providerId, value, { replace }), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const replaced = setCredentialIn(ws, `provider:${providerId}:apiKey`, value, { replace })
      return { agentId: this.closedAgentId(ws), providerId, success: true as const, ...(replaced ? { replaced } : {}), filePath: t.filePath, loaded: false }
    })
  }

  async getProviderCredentials(input: unknown, providerId: string) {
    const t = await this.target(input)
    if (t.loadedId) return { ...this.runtime.getAgentProviderCredentials(t.loadedId, providerId), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const entry = config.providers?.find(p => p.id === providerId)
      return {
        agentId: config.id,
        providerId,
        credentials: describeCredentialsIn(ws, `provider:${providerId}:`),
        ...(entry ? { providerConfig: { defaultModel: entry.defaultModel, params: entry.params, requestDelayMs: entry.requestDelayMs } } : {}),
        filePath: t.filePath,
        loaded: false,
      }
    })
  }

  async attachProvider(input: unknown, body: unknown) {
    const t = await this.target(input)
    const provider = isRecord(body) ? body.provider : undefined
    if (!isRecord(provider) || typeof provider.id !== 'string') throw new FileOpError('provider with id is required', 400, 'bad_request')
    const entry = provider as unknown as AdfProviderConfig
    if (t.loadedId) return { ...(await this.runtime.attachAgentProvider(t.loadedId, entry)), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const providers = [...(config.providers ?? [])]
      const idx = providers.findIndex(p => p.id === entry.id)
      const alreadyAttached = idx >= 0
      if (alreadyAttached) providers[idx] = { ...providers[idx], ...entry }
      else providers.push(entry)
      const next = { ...config, providers }
      writeConfig(ws, next)
      return { agentId: config.id, providerId: entry.id, success: true as const, alreadyAttached, config: next, filePath: t.filePath, loaded: false }
    })
  }

  async detachProvider(input: unknown, providerId: string) {
    const t = await this.target(input)
    if (t.loadedId) return { ...(await this.runtime.detachAgentProvider(t.loadedId, providerId)), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const providers = (config.providers ?? []).filter(p => p.id !== providerId)
      const next: AgentConfig = { ...config, providers }
      if (providers.length === 0) delete next.providers
      writeConfig(ws, next)
      const deletedCredentials = ws.deleteIdentityByPrefix(`provider:${providerId}:`)
      return { agentId: config.id, providerId, success: true as const, deletedCredentials, config: next, filePath: t.filePath, loaded: false }
    })
  }

  // --- MCP ---

  async setMcpCredential(input: unknown, body: unknown) {
    const t = await this.target(input)
    const { npmPackage, envKey, value } = isRecord(body) ? body : {} as Record<string, unknown>
    if (typeof npmPackage !== 'string') throw new FileOpError('npmPackage is required', 400, 'bad_request')
    if (typeof envKey !== 'string') throw new FileOpError('envKey is required', 400, 'bad_request')
    if (typeof value !== 'string') throw new FileOpError('value is required', 400, 'bad_request')
    const replace = isRecord(body) && body.replace === true
    if (t.loadedId) return { ...this.runtime.setAgentMcpCredential(t.loadedId, npmPackage, envKey, value, { replace }), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const replaced = setCredentialIn(ws, `mcp:${npmPackage}:${envKey}`, value, { replace })
      return { agentId: this.closedAgentId(ws), npmPackage, envKey, success: true as const, ...(replaced ? { replaced } : {}), filePath: t.filePath, loaded: false }
    })
  }

  async getMcpCredentials(input: unknown, npmPackage: unknown) {
    const t = await this.target(input)
    if (typeof npmPackage !== 'string' || !npmPackage) throw new FileOpError('npmPackage is required', 400, 'bad_request')
    if (t.loadedId) return { ...this.runtime.getAgentMcpCredentials(t.loadedId, npmPackage), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => ({
      agentId: this.closedAgentId(ws),
      npmPackage,
      credentials: describeCredentialsIn(ws, `mcp:${npmPackage}:`),
      filePath: t.filePath,
      loaded: false,
    }))
  }

  async attachMcpServer(input: unknown, body: unknown) {
    const t = await this.target(input)
    const server = isRecord(body) ? (body.server ?? body.serverConfig) : undefined
    if (!isRecord(server) || typeof server.name !== 'string' || (server.transport !== 'stdio' && server.transport !== 'http')) {
      throw new FileOpError('server with name and transport is required', 400, 'bad_request')
    }
    const entry = server as unknown as McpServerConfig
    if (t.loadedId) return { ...(await this.runtime.attachAgentMcpServer(t.loadedId, entry)), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const servers = [...(config.mcp?.servers ?? [])]
      const alreadyAttached = servers.some(s => s.name === entry.name)
      if (!alreadyAttached) servers.push(entry)
      const next = { ...config, mcp: { ...(config.mcp ?? {}), servers } }
      writeConfig(ws, next)
      return { agentId: config.id, serverName: entry.name, success: true as const, alreadyAttached, config: next, filePath: t.filePath, loaded: false }
    })
  }

  async detachMcpServer(input: unknown, serverName: string, credentialNamespace?: string) {
    const t = await this.target(input)
    const namespace = credentialNamespace || serverName
    if (t.loadedId) return { ...(await this.runtime.detachAgentMcpServer(t.loadedId, serverName, namespace)), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const servers = (config.mcp?.servers ?? []).filter(s => s.name !== serverName)
      const next = { ...config, mcp: { ...(config.mcp ?? {}), servers } }
      writeConfig(ws, next)
      const deletedCredentials = ws.deleteIdentityByPrefix(`mcp:${namespace}:`)
      return { agentId: config.id, serverName, success: true as const, deletedCredentials, config: next, filePath: t.filePath, loaded: false }
    })
  }

  // --- adapters ---

  async setAdapterCredential(input: unknown, body: unknown) {
    const t = await this.target(input)
    const { adapterType, envKey, value } = isRecord(body) ? body : {} as Record<string, unknown>
    if (typeof adapterType !== 'string') throw new FileOpError('adapterType is required', 400, 'bad_request')
    if (typeof envKey !== 'string') throw new FileOpError('envKey is required', 400, 'bad_request')
    if (typeof value !== 'string') throw new FileOpError('value is required', 400, 'bad_request')
    const replace = isRecord(body) && body.replace === true
    if (t.loadedId) return { ...this.runtime.setAgentAdapterCredential(t.loadedId, adapterType, envKey, value, { replace }), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const replaced = setCredentialIn(ws, `adapter:${adapterType}:${envKey}`, value, { replace })
      return { agentId: this.closedAgentId(ws), adapterType, envKey, success: true as const, ...(replaced ? { replaced } : {}), filePath: t.filePath, loaded: false }
    })
  }

  async getAdapterCredentials(input: unknown, adapterType: unknown) {
    const t = await this.target(input)
    if (typeof adapterType !== 'string' || !adapterType) throw new FileOpError('adapterType is required', 400, 'bad_request')
    if (t.loadedId) return { ...this.runtime.getAgentAdapterCredentials(t.loadedId, adapterType), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => ({
      agentId: this.closedAgentId(ws),
      adapterType,
      credentials: describeCredentialsIn(ws, `adapter:${adapterType}:`),
      filePath: t.filePath,
      loaded: false,
    }))
  }

  async attachAdapter(input: unknown, body: unknown) {
    const t = await this.target(input)
    const adapterType = isRecord(body) ? body.adapterType : undefined
    if (typeof adapterType !== 'string') throw new FileOpError('adapterType is required', 400, 'bad_request')
    const parsed = AdapterInstanceConfigSchema.safeParse(isRecord(body) ? body.config : undefined)
    if (!parsed.success) throw new FileOpError(parsed.error.issues.map(i => i.message).join(', '), 400, 'bad_request')
    const adapterConfig = parsed.data as AdapterInstanceConfig
    if (t.loadedId) return { ...(await this.runtime.attachAgentAdapter(t.loadedId, adapterType, adapterConfig)), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const adapters = { ...(config.adapters ?? {}) }
      const alreadyAttached = adapters[adapterType] !== undefined
      adapters[adapterType] = adapterConfig
      const next = { ...config, adapters }
      writeConfig(ws, next)
      return { agentId: config.id, adapterType, success: true as const, alreadyAttached, config: next, filePath: t.filePath, loaded: false }
    })
  }

  async detachAdapter(input: unknown, adapterType: string) {
    const t = await this.target(input)
    if (t.loadedId) return { ...(await this.runtime.detachAgentAdapter(t.loadedId, adapterType)), filePath: t.filePath, loaded: true }
    return withClosedAgentFile(t.filePath, ws => {
      const config = ws.getAgentConfig()
      const adapters = { ...(config.adapters ?? {}) }
      delete adapters[adapterType]
      const next: AgentConfig = { ...config, adapters }
      if (Object.keys(adapters).length === 0) delete next.adapters
      writeConfig(ws, next)
      const deletedCredentials = ws.deleteIdentityByPrefix(`adapter:${adapterType}:`)
      return { agentId: config.id, adapterType, success: true as const, deletedCredentials, config: next, filePath: t.filePath, loaded: false }
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
