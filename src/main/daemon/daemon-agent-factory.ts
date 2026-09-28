/**
 * Daemon-side agent creation — Studio's "new agent" flow without Studio:
 * template instantiate → full owner identity (sealed keys, owner/runtime
 * stamps, attestations) → reviewed mark → directory tracked → loaded (and
 * optionally started) in the daemon runtime.
 */

import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, resolve } from 'path'
import { AdfWorkspace } from '../adf/adf-workspace'
import { AgentTemplatesService } from '../adf/agent-templates'
import { markConfigReviewed } from '../services/agent-review'
import { canonicalizePath, isSameOrSubPath } from '../utils/tracked-paths'
import { generateAgentName } from '../../shared/utils/agent-names'
import type { AgentTemplateListResult, ProviderConfig } from '../../shared/types/ipc.types'
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

export class DaemonAgentFactory {
  private templates: AgentTemplatesService | null = null

  constructor(private readonly deps: {
    settings: FactorySettings
    identity: DaemonIdentity
    runtime: RuntimeService
  }) {}

  private templatesService(): AgentTemplatesService {
    if (!this.templates) {
      this.templates = new AgentTemplatesService({
        settings: this.deps.settings,
        getOwnerDid: () => this.deps.identity.service.getOwnerDid(),
        notifyChanged: () => {},
      })
    }
    return this.templates
  }

  private requireIdentity(): void {
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
    const ref = await this.deps.runtime.loadAgent(filePath, { enforceReviewGate: false })
    let started = false
    if (input.start === true) {
      await this.deps.runtime.startAgent(ref.id)
      started = true
    }
    return { agentId: ref.id, name: basename(filePath, '.adf'), filePath, did, started }
  }
}
