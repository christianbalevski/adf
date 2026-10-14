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
 * rebuild); detach deletes credentials by exact prefix here (the workspace's
 * prefix delete is a LIKE). When it is not loaded, reads go through one
 * readonly connection (no migration, nothing written), and writes are
 * refused while another runtime holds the agent's lease (409 agent_leased);
 * otherwise the file is opened for the call, its envelopes unlocked with
 * this runtime's keys, written and closed. Responses have the shape of the
 * /agents/:id routes plus `filePath` and `loaded`.
 *
 * Credential values never leave the process: reads return metadata
 * (RuntimeIdentityMeta), as the /agents/:id credential routes do.
 */

import { basename } from 'node:path'
import { AdfDatabase } from '../adf/adf-database'
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
import { FileOpError, type AgentFileOps } from './file-ops'
import type { TrackedDirsSettings } from './tracked-dirs'

export type PathAgentRuntime = Pick<RuntimeService,
  | 'setAgentProviderCredential' | 'getAgentProviderCredentials' | 'attachAgentProvider' | 'detachAgentProvider'
  | 'setAgentMcpCredential' | 'getAgentMcpCredentials' | 'attachAgentMcpServer' | 'detachAgentMcpServer'
  | 'setAgentAdapterCredential' | 'getAgentAdapterCredentials' | 'attachAgentAdapter' | 'getAgentConfig' | 'setAgentConfig'>

interface Target {
  filePath: string
  /** The agent's id when the file is open here: running, or an open document (D4). */
  loadedId: string | null
  /** A runtime runs on it (false for an open document that is not running). */
  running: boolean
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
export function listTablesOf(query: (sql: string) => unknown[]): FileTable[] {
  const virtualTables = query("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'") as Array<{ name: string }>
  const shadowPrefixes = virtualTables.map(v => `${v.name}_`)
  const rows = query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name: string }>
  return rows
    .filter(r => !shadowPrefixes.some(prefix => r.name.startsWith(prefix)))
    .map(r => {
      const count = query(`SELECT COUNT(*) as count FROM "${r.name.replace(/"/g, '""')}"`) as Array<{ count: number }>
      return { name: r.name, row_count: count[0]?.count ?? 0 }
    })
}

// --- Read-only peeks of a closed file ------------------------------------------------
// The GET routes never open a closed file for writing: one readonly SQLite
// connection, no migration, no skills-registry rewrite (AdfDatabase.peek).
// No envelope is unlocked, so a sealed value reads as stored-but-locked, as
// Studio's temp-open read reports it.

interface IdentityRowPeek { purpose: string; value: Buffer | string; encryption_algo: string | null; code_access: number }

function describeRow(row: IdentityRowPeek): RuntimeIdentityMeta {
  const algo = row.encryption_algo ?? 'plain'
  const envelope = envelopeFromAlgo(algo)
  const storage = envelope ? 'sealed' : algo === 'plain' ? 'plain' : 'password'
  const locked = storage !== 'plain'
  let length: number | null = null
  if (!locked && !row.purpose.startsWith('crypto:')) {
    length = (Buffer.isBuffer(row.value) ? row.value.toString('utf-8') : String(row.value)).length
  }
  return { purpose: row.purpose, present: true, storage, sealed: envelope !== null, locked, length, code_access: !!row.code_access }
}

/** Config and credential metadata of a closed file under one exact purpose prefix (no LIKE wildcards). */
function peekCredentials(filePath: string, prefix: string): { config: AgentConfig; credentials: Record<string, RuntimeIdentityMeta> } {
  return AdfDatabase.peek(filePath, db => {
    const configRow = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
    if (!configRow) throw new FileOpError('Not a readable .adf: missing adf_config row', 400, 'not_an_adf')
    const credentials: Record<string, RuntimeIdentityMeta> = {}
    let rows: IdentityRowPeek[] = []
    try {
      rows = db.prepare('SELECT purpose, value, encryption_algo, code_access FROM adf_identity WHERE substr(purpose, 1, ?) = ? ORDER BY purpose')
        .all(prefix.length, prefix) as IdentityRowPeek[]
    } catch { /* no identity table in an old file */ }
    for (const row of rows) credentials[row.purpose.slice(prefix.length)] = describeRow(row)
    return { config: JSON.parse(configRow.config_json) as AgentConfig, credentials }
  })
}

/**
 * Delete the identity rows whose purpose starts with exactly `prefix`. The
 * workspace's prefix delete is a LIKE (case-insensitive, `%` and `_` are
 * wildcards), which would also delete other servers' credentials.
 */
export function deleteCredentialsExact(ws: AdfWorkspace, prefix: string): number {
  let deleted = 0
  for (const purpose of ws.listIdentityPurposes(prefix)) {
    if (purpose.startsWith(prefix) && ws.deleteIdentity(purpose)) deleted++
  }
  return deleted
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

  /**
   * The file and, when it is open here, the id its /agents/:id methods take.
   * An open document (D4) goes through the same RuntimeService methods as a
   * running agent (one workspace, its unlocked key); a write to one is
   * refused while another runtime holds the file's lease, as a closed file's.
   */
  private async target(input: unknown, write = false): Promise<Target> {
    const filePath = await this.files.adfPath(input)
    const running = this.files.loadedAt(filePath)?.id
    if (running) return { filePath, loadedId: running, running: true }
    const open = this.files.openDocumentAt(filePath)
    if (open && write) await this.files.assertNotLeasedElsewhere(filePath)
    return { filePath, loadedId: open?.agentId ?? null, running: false }
  }

  /** Write to a file that is not loaded here: refused (409 agent_leased) while another runtime runs it. */
  private async writeClosed<T>(t: Target, fn: (ws: AdfWorkspace) => T): Promise<T> {
    await this.files.assertNotLeasedElsewhere(t.filePath)
    return withClosedAgentFile(t.filePath, fn)
  }

  private liveWorkspace(t: Target): AdfWorkspace {
    const live = this.files.liveAgent(t.filePath)
    if (!live) throw new FileOpError(`${basename(t.filePath)} stopped while the request ran; try again`, 409, 'conflict')
    return live.workspace
  }

  /** Detach on a loaded agent: the config through the runtime (its fan-out), credentials deleted by exact prefix. */
  private async detachLoaded(t: Target, next: (config: AgentConfig) => AgentConfig, prefix: string) {
    const id = t.loadedId!
    const { config } = this.runtime.getAgentConfig(id)
    const result = await this.runtime.setAgentConfig(id, next(config))
    const deletedCredentials = deleteCredentialsExact(this.liveWorkspace(t), prefix)
    return { agentId: id, deletedCredentials, config: result.config }
  }

  /** FILE_LIST_TABLES. Read-only for a closed file. */
  async tables(input: unknown): Promise<{ filePath: string; loaded: boolean; tables: FileTable[] }> {
    const t = await this.target(input)
    const live = t.loadedId ? this.files.liveAgent(t.filePath) : undefined
    if (live) return { filePath: t.filePath, loaded: true, tables: listTablesOf(sql => live.workspace.querySQL(sql)) }
    return { filePath: t.filePath, loaded: false, tables: AdfDatabase.peek(t.filePath, db => listTablesOf(sql => db.prepare(sql).all())) }
  }

  /**
   * AGENT_MODEL_SET_FOR_FILE: the model of a stopped agent. A running agent
   * is refused, as in Studio (its config is saved through PUT /agents/:id/config).
   */
  async setModel(input: unknown, body: unknown): Promise<{ success: true; filePath: string; model: AgentConfig['model'] }> {
    const t = await this.target(input, true)
    const model = isRecord(body) ? (isRecord(body.model) ? body.model : body) : null
    if (!model || typeof model.provider !== 'string' || typeof model.model_id !== 'string') {
      throw new FileOpError('provider and model_id are required', 400, 'bad_request')
    }
    if (t.running) throw new FileOpError('Stop the agent before changing its model', 409, 'agent_running')
    const providers = (this.settings?.get('providers') as ProviderConfig[] | undefined) ?? []
    if (!providers.some(p => p.id === model.provider)) {
      throw new FileOpError(`Provider "${model.provider}" is not configured in Settings`, 400, 'provider_unknown')
    }
    if (t.loadedId) {
      const { config } = this.runtime.getAgentConfig(t.loadedId)
      const next = { ...config, model: { ...config.model, provider: model.provider as string, model_id: model.model_id as string } }
      const saved = await this.runtime.setAgentConfig(t.loadedId, next)
      return { success: true, filePath: t.filePath, model: saved.config.model }
    }
    const next = await this.writeClosed(t, ws => {
      const config = ws.getAgentConfig()
      config.model = { ...config.model, provider: model.provider as string, model_id: model.model_id as string }
      writeConfig(ws, config)
      return config.model
    })
    return { success: true, filePath: t.filePath, model: next }
  }

  // --- providers ---

  async setProviderCredential(input: unknown, providerId: string, body: unknown) {
    const t = await this.target(input, true)
    const value = isRecord(body) ? body.value : undefined
    if (typeof value !== 'string') throw new FileOpError('value is required', 400, 'bad_request')
    const replace = isRecord(body) && body.replace === true
    if (t.loadedId) return { ...this.runtime.setAgentProviderCredential(t.loadedId, providerId, value, { replace }), filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
      const replaced = setCredentialIn(ws, `provider:${providerId}:apiKey`, value, { replace })
      return { agentId: ws.getAgentConfig().id, providerId, success: true as const, ...(replaced ? { replaced } : {}), filePath: t.filePath, loaded: false }
    })
  }

  async getProviderCredentials(input: unknown, providerId: string) {
    const t = await this.target(input)
    if (t.loadedId) return { ...this.runtime.getAgentProviderCredentials(t.loadedId, providerId), filePath: t.filePath, loaded: true }
    const { config, credentials } = peekCredentials(t.filePath, `provider:${providerId}:`)
    const entry = config.providers?.find(p => p.id === providerId)
    return {
      agentId: config.id,
      providerId,
      credentials,
      ...(entry ? { providerConfig: { defaultModel: entry.defaultModel, params: entry.params, requestDelayMs: entry.requestDelayMs } } : {}),
      filePath: t.filePath,
      loaded: false,
    }
  }

  async attachProvider(input: unknown, body: unknown) {
    const t = await this.target(input, true)
    const provider = isRecord(body) ? body.provider : undefined
    if (!isRecord(provider) || typeof provider.id !== 'string') throw new FileOpError('provider with id is required', 400, 'bad_request')
    const entry = provider as unknown as AdfProviderConfig
    if (t.loadedId) return { ...(await this.runtime.attachAgentProvider(t.loadedId, entry)), filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
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
    const t = await this.target(input, true)
    const prefix = `provider:${providerId}:`
    const without = (config: AgentConfig): AgentConfig => {
      const providers = (config.providers ?? []).filter(p => p.id !== providerId)
      const next: AgentConfig = { ...config, providers }
      if (providers.length === 0) delete next.providers
      return next
    }
    if (t.loadedId) return { ...(await this.detachLoaded(t, without, prefix)), providerId, success: true as const, filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
      const config = ws.getAgentConfig()
      const next = without(config)
      writeConfig(ws, next)
      const deletedCredentials = deleteCredentialsExact(ws, prefix)
      return { agentId: config.id, providerId, success: true as const, deletedCredentials, config: next, filePath: t.filePath, loaded: false }
    })
  }

  // --- MCP ---

  async setMcpCredential(input: unknown, body: unknown) {
    const t = await this.target(input, true)
    const { npmPackage, envKey, value } = isRecord(body) ? body : {} as Record<string, unknown>
    if (typeof npmPackage !== 'string') throw new FileOpError('npmPackage is required', 400, 'bad_request')
    if (typeof envKey !== 'string') throw new FileOpError('envKey is required', 400, 'bad_request')
    if (typeof value !== 'string') throw new FileOpError('value is required', 400, 'bad_request')
    const replace = isRecord(body) && body.replace === true
    if (t.loadedId) return { ...this.runtime.setAgentMcpCredential(t.loadedId, npmPackage, envKey, value, { replace }), filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
      const replaced = setCredentialIn(ws, `mcp:${npmPackage}:${envKey}`, value, { replace })
      return { agentId: ws.getAgentConfig().id, npmPackage, envKey, success: true as const, ...(replaced ? { replaced } : {}), filePath: t.filePath, loaded: false }
    })
  }

  async getMcpCredentials(input: unknown, npmPackage: unknown) {
    const t = await this.target(input)
    if (typeof npmPackage !== 'string' || !npmPackage) throw new FileOpError('npmPackage is required', 400, 'bad_request')
    if (t.loadedId) return { ...this.runtime.getAgentMcpCredentials(t.loadedId, npmPackage), filePath: t.filePath, loaded: true }
    const { config, credentials } = peekCredentials(t.filePath, `mcp:${npmPackage}:`)
    return { agentId: config.id, npmPackage, credentials, filePath: t.filePath, loaded: false }
  }

  async attachMcpServer(input: unknown, body: unknown) {
    const t = await this.target(input, true)
    const server = isRecord(body) ? (body.server ?? body.serverConfig) : undefined
    if (!isRecord(server) || typeof server.name !== 'string' || (server.transport !== 'stdio' && server.transport !== 'http')) {
      throw new FileOpError('server with name and transport is required', 400, 'bad_request')
    }
    const entry = server as unknown as McpServerConfig
    if (t.loadedId) return { ...(await this.runtime.attachAgentMcpServer(t.loadedId, entry)), filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
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
    const t = await this.target(input, true)
    const prefix = `mcp:${credentialNamespace || serverName}:`
    const without = (config: AgentConfig): AgentConfig => ({
      ...config,
      mcp: { ...(config.mcp ?? {}), servers: (config.mcp?.servers ?? []).filter(s => s.name !== serverName) },
    })
    if (t.loadedId) return { ...(await this.detachLoaded(t, without, prefix)), serverName, success: true as const, filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
      const config = ws.getAgentConfig()
      const next = without(config)
      writeConfig(ws, next)
      const deletedCredentials = deleteCredentialsExact(ws, prefix)
      return { agentId: config.id, serverName, success: true as const, deletedCredentials, config: next, filePath: t.filePath, loaded: false }
    })
  }

  // --- adapters ---

  async setAdapterCredential(input: unknown, body: unknown) {
    const t = await this.target(input, true)
    const { adapterType, envKey, value } = isRecord(body) ? body : {} as Record<string, unknown>
    if (typeof adapterType !== 'string') throw new FileOpError('adapterType is required', 400, 'bad_request')
    if (typeof envKey !== 'string') throw new FileOpError('envKey is required', 400, 'bad_request')
    if (typeof value !== 'string') throw new FileOpError('value is required', 400, 'bad_request')
    const replace = isRecord(body) && body.replace === true
    if (t.loadedId) return { ...this.runtime.setAgentAdapterCredential(t.loadedId, adapterType, envKey, value, { replace }), filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
      const replaced = setCredentialIn(ws, `adapter:${adapterType}:${envKey}`, value, { replace })
      return { agentId: ws.getAgentConfig().id, adapterType, envKey, success: true as const, ...(replaced ? { replaced } : {}), filePath: t.filePath, loaded: false }
    })
  }

  async getAdapterCredentials(input: unknown, adapterType: unknown) {
    const t = await this.target(input)
    if (typeof adapterType !== 'string' || !adapterType) throw new FileOpError('adapterType is required', 400, 'bad_request')
    if (t.loadedId) return { ...this.runtime.getAgentAdapterCredentials(t.loadedId, adapterType), filePath: t.filePath, loaded: true }
    const { config, credentials } = peekCredentials(t.filePath, `adapter:${adapterType}:`)
    return { agentId: config.id, adapterType, credentials, filePath: t.filePath, loaded: false }
  }

  async attachAdapter(input: unknown, body: unknown) {
    const t = await this.target(input, true)
    const adapterType = isRecord(body) ? body.adapterType : undefined
    if (typeof adapterType !== 'string') throw new FileOpError('adapterType is required', 400, 'bad_request')
    const parsed = AdapterInstanceConfigSchema.safeParse(isRecord(body) ? body.config : undefined)
    if (!parsed.success) throw new FileOpError(parsed.error.issues.map(i => i.message).join(', '), 400, 'bad_request')
    const adapterConfig = parsed.data as AdapterInstanceConfig
    if (t.loadedId) return { ...(await this.runtime.attachAgentAdapter(t.loadedId, adapterType, adapterConfig)), filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
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
    const t = await this.target(input, true)
    const prefix = `adapter:${adapterType}:`
    const without = (config: AgentConfig): AgentConfig => {
      const adapters = { ...(config.adapters ?? {}) }
      delete adapters[adapterType]
      const next: AgentConfig = { ...config, adapters }
      if (Object.keys(adapters).length === 0) delete next.adapters
      return next
    }
    if (t.loadedId) return { ...(await this.detachLoaded(t, without, prefix)), adapterType, success: true as const, filePath: t.filePath, loaded: true }
    return this.writeClosed(t, ws => {
      const config = ws.getAgentConfig()
      const next = without(config)
      writeConfig(ws, next)
      const deletedCredentials = deleteCredentialsExact(ws, prefix)
      return { agentId: config.id, adapterType, success: true as const, deletedCredentials, config: next, filePath: t.filePath, loaded: false }
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
