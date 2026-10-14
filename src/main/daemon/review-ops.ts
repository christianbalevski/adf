/**
 * Agent review in the daemon, at Studio's parity (tracker W2-A):
 *
 * - The summary is Studio's buildReviewSummaryFor: identity scenario
 *   (deriveReviewIdentity), provider usability through the automatic
 *   provider check (honours providerChecksEnabled), and willRelocate /
 *   relocateTo for a file outside every tracked folder. GET /agents/review,
 *   GET /templates/:id/review.
 * - Accept is Studio's FILE_REVIEW_ACCEPT: an optional model override
 *   (provider checked first), claim (a legacy whole-file password is removed
 *   first, which needs the unlocked key) or the full identity provisioning
 *   deferred at open, the auto-locked security fields, then the reviewed
 *   mark. POST /agents/review/accept. The move of an untracked file into the
 *   agents folder is POST /files/relocate (W1-E), which the client calls after.
 *
 * Files open here (running or an open document, D4) are read and written
 * through their own workspace; a closed file is opened for the call.
 */

import { homedir } from 'node:os'
import { dirname, sep } from 'node:path'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { readAdfAttestations, verifyAttestation } from '../services/attestation.service'
import { autoLockFields, buildConfigSummary, deriveReviewIdentity, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { ProviderChecks } from '../services/provider-checks'
import type { RuntimeService } from '../runtime/runtime-service'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentConfigSummary, ProviderConfig } from '../../shared/types/ipc.types'
import { canonicalizePath, isSameOrSubPath } from '../utils/tracked-paths'
import type { DaemonIdentity } from './daemon-identity'
import { resolveAgentsFolderSync } from './file-ops'

export interface ReviewSettings {
  get(key: string): unknown
  set?(key: string, value: unknown): void
}

export interface ReviewDeps {
  settings?: ReviewSettings
  identity?: Pick<DaemonIdentity, 'isReady' | 'service'>
}

/** 4xx refusals of the review routes, `{ error, code }` with this status. */
export class ReviewError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409, readonly code: string) {
    super(message)
    this.name = 'ReviewError'
  }
}

const checksBySettings = new WeakMap<object, ProviderChecks>()
const NO_SETTINGS = {}

/**
 * The daemon's provider checks for review summaries: one per settings store,
 * so its session cache is shared by every review (Studio keeps one instance).
 */
export function reviewProviderChecks(settings: ReviewSettings | undefined): ProviderChecks {
  const key = settings ?? NO_SETTINGS
  let checks = checksBySettings.get(key)
  if (!checks) {
    checks = new ProviderChecks({ isEnabled: () => settings?.get('providerChecksEnabled') !== false })
    checksBySettings.set(key, checks)
  }
  return checks
}

/** Everything of the summary that reads the workspace; the provider status comes after (it may do network I/O). */
interface SummaryParts {
  base: Omit<AgentConfigSummary, 'provider'>
  provider: Omit<NonNullable<AgentConfigSummary['provider']>, 'status'>
  localProvider: ProviderConfig | undefined
  willRelocate: boolean
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read() } catch { return fallback }
}

function summaryParts(workspace: AdfWorkspace, filePath: string, deps: ReviewDeps, relocatable: boolean): SummaryParts {
  const config = workspace.getAgentConfig()
  const svc = deps.identity?.service
  const agentDid = workspace.getDid()
  // Owner shown in review: verified attestation first (proof), meta fallback (fact).
  const ownerAtt = readAdfAttestations(workspace)
    .filter((a) => a.role === 'owner')
    .find((a) => verifyAttestation(a, agentDid ? { expectedSubject: agentDid } : undefined))
  const credentialSlots = workspace.readEnvelopeSlots('credentials') ?? []
  const settingsString = (key: string) => (typeof deps.settings?.get(key) === 'string' ? deps.settings!.get(key) as string : '')
  const identity = deriveReviewIdentity({
    agentDid,
    fileOwnerDid: ownerAtt?.issuer ?? workspace.getMeta('adf_owner_did') ?? null,
    fileRuntimeDid: workspace.getMeta('adf_runtime_did') ?? null,
    localOwnerDid: svc ? safe(() => svc.getOwnerDid(), settingsString('ownerDid')) : settingsString('ownerDid'),
    localRuntimeDid: svc ? safe(() => svc.getRuntimeDid(), settingsString('runtimeDid')) : settingsString('runtimeDid'),
    identityEnvelope: workspace.getEnvelopeState('identity'),
    credentialsEnvelope: workspace.getEnvelopeState('credentials'),
    sharePasswordSet: credentialSlots.some((s) => s.type === 'password'),
    filePasswordProtected: workspace.isPasswordProtected(),
    ownerKeyAvailable: svc ? safe(() => svc.getOwnerEncPrivateKey() !== null, false) : false,
  })
  // Can this install run the agent's model? The configured provider id, else
  // a local provider of the embedded entry's type.
  const appProviders = (deps.settings?.get('providers') as ProviderConfig[] | undefined) ?? []
  const embedded = config.providers?.find((p) => p.id === config.model.provider)
  const localProvider =
    appProviders.find((p) => p.id === config.model.provider) ??
    (embedded ? appProviders.find((p) => p.type === embedded.type) : undefined)
  return {
    base: buildConfigSummary(config, identity),
    provider: {
      configuredId: config.model.provider,
      configuredType: embedded?.type,
      modelId: config.model.model_id,
      ...(localProvider ? { resolvedLocalId: localProvider.id } : {}),
    },
    localProvider,
    willRelocate: relocatable && willRelocateOnAccept(filePath, deps.settings),
  }
}

/** Studio's willRelocateOnAccept: accept moves a file whose folder no tracked folder covers. */
function willRelocateOnAccept(filePath: string, settings: ReviewSettings | undefined): boolean {
  const dir = dirname(safe(() => canonicalizePath(filePath), filePath))
  const tracked = (settings?.get('trackedDirectories') as string[] | undefined) ?? []
  return !tracked.some((d) => safe(() => isSameOrSubPath(d, dir), false))
}

/** Studio's displayPath: the home folder shortened to `~`. */
function displayPath(p: string): string {
  const home = homedir()
  return p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p
}

async function finishSummary(parts: SummaryParts, deps: ReviewDeps): Promise<AgentConfigSummary> {
  const status = parts.localProvider ? await reviewProviderChecks(deps.settings).autoCheck(parts.localProvider) : 'missing'
  return {
    ...parts.base,
    provider: { ...parts.provider, status },
    willRelocate: parts.willRelocate,
    ...(parts.willRelocate ? { relocateTo: displayPath(resolveAgentsFolderSync(deps.settings).path) } : {}),
  }
}

/** Studio's buildReviewSummaryFor for a workspace the caller holds open (a template: relocatable false). */
export async function reviewSummaryFor(workspace: AdfWorkspace, filePath: string, deps: ReviewDeps, opts: { relocatable: boolean }): Promise<AgentConfigSummary> {
  return finishSummary(summaryParts(workspace, filePath, deps, opts.relocatable), deps)
}

export interface AgentReviewCheck {
  agentId: string
  filePath: string
  reviewed: boolean
  /** Studio's FILE_CHECK_REVIEW `needsReview`. */
  needsReview: boolean
  summary: AgentConfigSummary
}

/** GET /agents/review: Studio's FILE_CHECK_REVIEW payload for an agent file. */
export async function checkAgentReview(runtime: RuntimeService, filePath: string, deps: ReviewDeps): Promise<AgentReviewCheck> {
  const read = runtime.withAgentFile(filePath, (workspace, canonicalPath) => {
    const config = workspace.getAgentConfig()
    return {
      agentId: config.id,
      filePath: canonicalPath,
      reviewed: isConfigReviewed(deps.settings?.get('reviewedAgents'), config),
      parts: summaryParts(workspace, canonicalPath, deps, true),
    }
  })
  return { agentId: read.agentId, filePath: read.filePath, reviewed: read.reviewed, needsReview: !read.reviewed, summary: await finishSummary(read.parts, deps) }
}

export interface AgentReviewAcceptInput {
  claim?: boolean
  model?: { provider: string; model_id: string }
}

export interface AgentReviewAccepted {
  agentId: string
  filePath: string
  reviewed: true
  claimed: boolean
  /** The agent DID after the accept (a claim mints a new one). */
  did: string | null
  config: AgentConfig
}

/** POST /agents/review/accept: Studio's FILE_REVIEW_ACCEPT, without the relocate (POST /files/relocate). */
export async function acceptAgentReview(runtime: RuntimeService, filePath: string, input: AgentReviewAcceptInput, deps: ReviewDeps): Promise<AgentReviewAccepted> {
  const settings = deps.settings
  if (!settings?.set) throw new ReviewError('The settings store is read-only; the review cannot be recorded.', 409, 'read_only')
  // An unknown provider fails before the claim changes the file.
  let chosenProvider: ProviderConfig | undefined
  if (input.model) {
    chosenProvider = ((settings.get('providers') as ProviderConfig[] | undefined) ?? []).find((p) => p.id === input.model!.provider)
    if (!chosenProvider) throw new ReviewError(`Provider "${input.model.provider}" is not configured in Settings`, 400, 'provider_unknown')
  }
  const open = runtime.getAgentWorkspaceByPath(filePath)
  if (input.claim && open?.running) throw new ReviewError('Stop the agent before claiming it: a claim gives it a new identity.', 409, 'agent_running')
  const identity = deps.identity

  const result = runtime.withAgentFile(filePath, (workspace, canonicalPath, keyCell) => {
    let claimed = false
    if (input.claim) {
      // Claim & Open: a fresh identity under the local owner. A legacy whole-
      // file password goes first; without its key the claim would wipe the
      // signing keys and then fail at provisioning.
      const derivedKey = keyCell?.current ?? null
      if (workspace.isPasswordProtected() && !derivedKey) {
        throw new ReviewError('File is password-protected — enter the password before claiming', 409, 'password_required')
      }
      if (!identity?.isReady() || !identity.service.getEnvelopeRecipients()) {
        throw new ReviewError('Owner and runtime encryption keys are unavailable (keystore locked?), so the agent cannot be claimed securely.', 409, 'identity_not_ready')
      }
      if (workspace.isPasswordProtected() && derivedKey) {
        workspace.removePassword(derivedKey)
        runtime.forgetFileDerivedKey(canonicalPath)
      }
      identity.service.claimWorkspace(workspace)
      claimed = true
    } else if (identity?.isReady()) {
      // The trust decision that unblocks the provisioning deferred at open.
      identity.service.ensureWorkspaceIdentity(workspace)
    } else {
      console.warn(`[ADF Daemon] Review of ${canonicalPath} accepted without identity provisioning: the owner identity is not ready`)
    }
    const config = workspace.getAgentConfig()
    if (input.model && chosenProvider) {
      config.model.provider = input.model.provider
      config.model.model_id = input.model.model_id
      config.model.params = chosenProvider.params?.length ? chosenProvider.params.map((p) => ({ ...p })) : undefined
    }
    const locked = new Set(config.locked_fields ?? [])
    for (const field of autoLockFields(config)) locked.add(field)
    config.locked_fields = [...locked]
    // A closed file is written here; an open one through the runtime below (fan-out).
    if (!open) workspace.setAgentConfig(config)
    return { canonicalPath, config, claimed, did: workspace.getDid() }
  })
  let config = result.config
  if (open) config = (await runtime.setAgentConfig(open.agentId, config)).config
  settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), config))
  console.log(`[ADF Daemon] Review accepted for ${result.canonicalPath}${result.claimed ? ' (claimed)' : ''}`)
  return { agentId: config.id, filePath: result.canonicalPath, reviewed: true, claimed: result.claimed, did: result.did, config }
}
