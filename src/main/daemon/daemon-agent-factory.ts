/**
 * Daemon-side agent creation — Studio's "new agent" flow without Studio:
 * template instantiate → full owner identity (sealed keys, owner/runtime
 * stamps, attestations) → reviewed mark → directory tracked → loaded (and
 * optionally started) in the daemon runtime.
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, resolve } from 'path'
import { AdfWorkspace } from '../adf/adf-workspace'
import { AgentTemplatesService, templateFilePath, templatesDir } from '../adf/agent-templates'
import { autoLockFields, buildConfigSummary, deriveReviewIdentity, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { readAdfAttestations, verifyAttestation } from '../services/attestation.service'
import { canonicalizePath, isSameOrSubPath } from '../utils/tracked-paths'
import { generateAgentName } from '../../shared/utils/agent-names'
import type { AgentConfigSummary, AgentTemplateListResult, ProviderConfig } from '../../shared/types/ipc.types'
import type { RuntimeService } from '../runtime/runtime-service'
import type { DaemonIdentity, DaemonIdentityStatus } from './daemon-identity'

export interface CreateAgentInput {
  name?: string
  directory?: string
  template?: string
  provider?: string
  model?: string
  start?: boolean
}

export interface CreateAgentResult {
  agentId: string
  name: string
  filePath: string
  did: string
  started: boolean
}

export type AgentCreateErrorCode =
  | 'bad_request'
  | 'identity_not_ready'
  | 'name_taken'
  | 'template_missing'
  | 'template_unreviewed'
  | 'template_invalid'
  | 'password_required'
  | 'wrong_password'
  | 'load_failed'

export class AgentCreateError extends Error {
  constructor(
    readonly code: AgentCreateErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly identity?: DaemonIdentityStatus,
  ) {
    super(message)
    this.name = 'AgentCreateError'
  }
}

interface FactorySettings {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** Same rule Studio's quick-create and rename use (ipc/index.ts isValidAgentFileName). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
function isValidAgentFileName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !INVALID_FILENAME_CHARS.test(name) &&
    !name.endsWith('.') && !name.endsWith(' ') && name !== '.' && name !== '..'
}

function isTempLocation(p: string): boolean {
  const candidate = canonicalizePath(p)
  return [tmpdir(), '/tmp'].some((root) => {
    try { return isSameOrSubPath(root, candidate) } catch { return false }
  })
}

/** `<userData>/templates-trash`: where the daemon puts deleted templates (Studio uses the OS trash). */
export function templatesTrashDir(): string {
  return join(templatesDir(), '..', 'templates-trash')
}

/** Move a template file (and any WAL sidecars) into the trash folder under a unique name. */
export function moveToTemplatesTrash(filePath: string): string {
  const dir = resolve(templatesTrashDir())
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const stem = basename(filePath, '.adf')
  let dest = join(dir, `${stem}-${stamp}.adf`)
  for (let n = 2; existsSync(dest); n++) dest = join(dir, `${stem}-${stamp}-${n}.adf`)
  renameSync(filePath, dest)
  for (const side of ['-wal', '-shm']) {
    try { if (existsSync(`${filePath}${side}`)) renameSync(`${filePath}${side}`, `${dest}${side}`) } catch { /* best effort */ }
  }
  return dest
}

export class DaemonAgentFactory {
  private templates: AgentTemplatesService | null = null

  constructor(private readonly deps: {
    settings: FactorySettings
    identity: DaemonIdentity
    runtime: RuntimeService
  }) {}

  /** Studio's templates service, over the same `<userData>/templates` folder. */
  templatesService(): AgentTemplatesService {
    if (!this.templates) {
      this.templates = new AgentTemplatesService({
        settings: this.deps.settings,
        getOwnerDid: () => this.deps.identity.service.getOwnerDid(),
        notifyChanged: () => {},
        // No OS trash without Electron: deleted templates go to a folder of
        // their own next to the templates folder. Never a hard delete.
        trashItem: async (filePath) => { moveToTemplatesTrash(filePath) },
      })
    }
    return this.templates
  }

  /**
   * Studio's TEMPLATE_CHECK_REVIEW: the same review summary the agent review
   * dialog shows, built for a template opened as a temporary workspace.
   */
  templateReview(id: string): { needsReview: boolean; reviewed: boolean; summary: AgentConfigSummary } {
    this.requireIdentity()
    const file = this.existingTemplateFile(id)
    const workspace = AdfWorkspace.open(file)
    try {
      const config = workspace.getAgentConfig()
      const reviewed = isConfigReviewed(this.deps.settings.get('reviewedAgents'), config)
      return { needsReview: !reviewed, reviewed, summary: this.reviewSummary(workspace) }
    } finally {
      try { workspace.close() } catch { /* ignore */ }
    }
  }

  /**
   * Studio's TEMPLATE_REVIEW_ACCEPT: claim the FILE with a fresh identity
   * under this owner, auto-lock the security fields, mark it reviewed.
   */
  acceptTemplateReview(id: string, password?: string): { reviewed: true } {
    this.requireIdentity()
    const file = this.existingTemplateFile(id)
    const service = this.deps.identity.service
    const workspace = AdfWorkspace.open(file)
    try {
      if (!service.getEnvelopeRecipients()) {
        throw new AgentCreateError('identity_not_ready', 'Owner and runtime encryption keys are unavailable (keystore locked?), so the template cannot be claimed securely.', 409, this.deps.identity.status())
      }
      if (workspace.isPasswordProtected()) {
        if (!password) throw new AgentCreateError('password_required', 'This template is password-protected. Enter its password to accept it.', 400)
        let derivedKey: Buffer
        try {
          derivedKey = workspace.unlockWithPassword(password)
        } catch {
          throw new AgentCreateError('wrong_password', 'Wrong password', 403)
        }
        workspace.removePassword(derivedKey)
      }
      service.claimWorkspace(workspace)
      const config = workspace.getAgentConfig()
      const locked = new Set(config.locked_fields ?? [])
      for (const field of autoLockFields(config)) locked.add(field)
      config.locked_fields = [...locked]
      workspace.setAgentConfig(config)
      this.deps.settings.set('reviewedAgents', markConfigReviewed(this.deps.settings.get('reviewedAgents'), config))
      return { reviewed: true }
    } finally {
      try { workspace.close() } catch { /* ignore */ }
    }
  }

  /** Absolute path of template `id`, or a 404. */
  existingTemplateFile(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id.includes('..')) {
      throw new AgentCreateError('template_missing', 'Unknown template.', 404)
    }
    const file = templateFilePath(id)
    // Shipped templates are code: a first call before any list creates them.
    if (!existsSync(file)) this.templatesService().ensureShipped()
    if (!existsSync(file)) throw new AgentCreateError('template_missing', `${id}.adf is not in the templates folder.`, 404)
    return file
  }

  /** Studio's buildReviewSummaryFor (relocatable: false), provider probe left out. */
  private reviewSummary(workspace: AdfWorkspace): AgentConfigSummary {
    const config = workspace.getAgentConfig()
    const svc = this.deps.identity.service
    const agentDid = workspace.getDid()
    const ownerAtt = readAdfAttestations(workspace)
      .filter((a) => a.role === 'owner')
      .find((a) => verifyAttestation(a, agentDid ? { expectedSubject: agentDid } : undefined))
    const credentialSlots = workspace.readEnvelopeSlots('credentials') ?? []
    const identity = deriveReviewIdentity({
      agentDid,
      fileOwnerDid: ownerAtt?.issuer ?? workspace.getMeta('adf_owner_did') ?? null,
      fileRuntimeDid: workspace.getMeta('adf_runtime_did') ?? null,
      localOwnerDid: svc.getOwnerDid(),
      localRuntimeDid: svc.getRuntimeDid(),
      identityEnvelope: workspace.getEnvelopeState('identity'),
      credentialsEnvelope: workspace.getEnvelopeState('credentials'),
      sharePasswordSet: credentialSlots.some((s) => s.type === 'password'),
      filePasswordProtected: workspace.isPasswordProtected(),
      ownerKeyAvailable: svc.getOwnerEncPrivateKey() !== null,
    })
    const appProviders = (this.deps.settings.get('providers') as ProviderConfig[] | undefined) ?? []
    const embedded = config.providers?.find((p) => p.id === config.model.provider)
    const localProvider =
      appProviders.find((p) => p.id === config.model.provider) ??
      (embedded ? appProviders.find((p) => p.type === embedded.type) : undefined)
    return {
      ...buildConfigSummary(config, identity),
      provider: {
        configuredId: config.model.provider,
        configuredType: embedded?.type,
        modelId: config.model.model_id,
        // Studio probes credentials here; the daemon only says whether a local provider matches.
        status: localProvider ? 'unchecked' : 'missing',
        ...(localProvider ? { resolvedLocalId: localProvider.id } : {}),
      },
    }
  }

  requireIdentity(): void {
    if (this.deps.identity.isReady()) return
    const identity = this.deps.identity.status()
    if (identity.status === 'ready') return
    throw new AgentCreateError('identity_not_ready', `Set up the owner identity first. ${identity.message}`, 409, identity)
  }

  /** Instantiable templates. Needs the owner identity: shipped templates are generated with one. */
  listTemplates(): AgentTemplateListResult {
    this.requireIdentity()
    return this.templatesService().list()
  }

  /** Where new agents go by default: settings.agentsFolder, else ~/Documents/adf-agents (Studio's default). */
  defaultDirectory(): string {
    const configured = this.deps.settings.get('agentsFolder')
    if (typeof configured === 'string' && configured.trim() !== '') {
      const candidate = resolve(configured.trim())
      if (!isTempLocation(candidate)) return candidate
    }
    return join(homedir(), 'Documents', 'adf-agents')
  }

  async create(input: CreateAgentInput): Promise<CreateAgentResult> {
    this.requireIdentity()

    // --- input ---
    const typedName = typeof input.name === 'string' ? input.name.trim() : ''
    if (typedName && !isValidAgentFileName(typedName)) {
      throw new AgentCreateError('bad_request', 'name must be a file name: at most 64 characters, none of < > : " / \\ | ? *, not ending in a dot or space.', 400)
    }
    let directory: string
    if (typeof input.directory === 'string' && input.directory.trim() !== '') {
      const raw = input.directory.trim()
      if (!isAbsolute(raw)) throw new AgentCreateError('bad_request', 'directory must be an absolute path.', 400)
      directory = resolve(raw)
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new AgentCreateError('bad_request', `directory does not exist: ${directory}`, 400)
      }
    } else {
      directory = this.defaultDirectory()
      mkdirSync(directory, { recursive: true })
    }
    const providerId = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : undefined
    const modelId = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined
    if (providerId) {
      const providers = (this.deps.settings.get('providers') as ProviderConfig[] | undefined) ?? []
      if (!providers.some((p) => p.id === providerId)) {
        const known = providers.map((p) => p.id).join(', ') || 'none configured'
        throw new AgentCreateError('bad_request', `Unknown provider "${providerId}" (known: ${known}).`, 400)
      }
    }
    const templateId = typeof input.template === 'string' && input.template.trim() ? input.template.trim() : undefined

    const name = typedName || generateAgentName({ taken: (n) => existsSync(join(directory, `${n}.adf`)) })
    const filePath = join(directory, `${name}.adf`)
    if (existsSync(filePath)) {
      throw new AgentCreateError('name_taken', `An agent named "${name}" already exists in ${directory}.`, 409)
    }

    // --- file: template instance, then identity (Studio's studioCreateDeps) ---
    const made = await this.templatesService().instantiate({ templateId, destPath: filePath, name, providerId, modelId })
    if (!made.success) {
      throw new AgentCreateError(made.code ?? 'template_missing', made.error ?? 'The template was refused.', 422)
    }

    let did: string | null = null
    let config: ReturnType<AdfWorkspace['getAgentConfig']>
    try {
      const workspace = AdfWorkspace.open(filePath)
      try {
        this.deps.identity.service.ensureWorkspaceIdentity(workspace)
        did = workspace.getDid()
        config = workspace.getAgentConfig()
      } finally {
        workspace.close()
      }
      if (!did) throw new Error('identity provisioning produced no DID')
    } catch (err) {
      // An agent without its sealed, attested identity is not what was asked for.
      for (const suffix of ['', '-wal', '-shm']) {
        try { if (existsSync(`${filePath}${suffix}`)) unlinkSync(`${filePath}${suffix}`) } catch { /* best effort */ }
      }
      throw new Error(`Could not provision the new agent's identity: ${err instanceof Error ? err.message : String(err)}`)
    }

    // --- bookkeeping: reviewed (the owner made it), directory tracked ---
    this.deps.settings.set('reviewedAgents', markConfigReviewed(this.deps.settings.get('reviewedAgents'), config!))
    const tracked = (this.deps.settings.get('trackedDirectories') as string[] | undefined) ?? []
    if (!tracked.some((d) => { try { return isSameOrSubPath(d, directory) } catch { return false } })) {
      this.deps.settings.set('trackedDirectories', [...tracked, canonicalizePath(directory)])
    }

    // --- runtime ---
    // The file is made (reviewed, tracked) even when it cannot load yet (e.g. no
    // provider configured): say so, so a retry under the same name isn't a
    // puzzling name_taken.
    let ref: Awaited<ReturnType<typeof this.deps.runtime.loadAgent>>
    try {
      ref = await this.deps.runtime.loadAgent(filePath, { enforceReviewGate: false })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new AgentCreateError('load_failed', `Created ${filePath}, but it could not load: ${why} Fix that, then load it (Fleet: o, or POST /agents/load).`, 422)
    }
    let started = false
    if (input.start === true) {
      await this.deps.runtime.startAgent(ref.id)
      started = true
    }
    return { agentId: ref.id, name: basename(filePath, '.adf'), filePath, did, started }
  }
}
