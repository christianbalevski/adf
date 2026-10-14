import { IPC } from '../../../../shared/constants/ipc-channels'
import { isKeyMaterialPurpose, REVEAL_REFUSED_REASON } from '../../../../shared/constants/identity-reveal'
import { DaemonError, type DaemonClient } from '../../../../shared/daemon-client'
import type { AlfAttestation } from '../../../../shared/types/adf-v02.types'
import { deriveOwnerIdentity, validateMnemonic } from '../../../crypto/mnemonic-identity'
import { verifyAttestation } from '../../../services/attestation.service'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { DaemonModeUnavailableError } from '../errors'
import { REMOTE_VALUES_UNSUPPORTED, writeWithLockedChoice } from './providers'

/**
 * The daemon-mode handlers of identity (tracker W3-B, design §5): the open
 * agent's keystore, password, envelope and attestations, and the owner
 * identity. Results have the embedded handlers' shapes (src/main/ipc/index.ts).
 *
 * The per-agent channels act on the open file, as embedded acts on
 * `currentWorkspace`: with no file open they answer what embedded answers
 * without a workspace. The open file's agent must be reachable in the daemon
 * (running there, or held open by the client session, W2-B); otherwise the
 * call fails visibly naming W2-B, as the core reads do.
 *
 * Secrets: stored values reach the renderer as embedded shows them (Reveal),
 * through the daemon's local-only reveal route; key material (`crypto:*`)
 * never leaves the daemon. The owner phrase is read from the OS keychain
 * entry Studio and the daemon share, never over HTTP (§5.4).
 */

const NO_ADF = 'No ADF open'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | undefined => {
  const body = err instanceof DaemonError ? (err.body as { code?: unknown } | null) : null
  return body && typeof body.code === 'string' ? body.code : undefined
}

/**
 * Run `fn` on the open file's agent. `none` is embedded's answer with no
 * file open. A file whose agent the daemon does not have open fails visibly
 * (W2-B), as a stopped one does.
 */
async function onOpenAgent<T, N>(ctx: DaemonModeContext, what: string, none: () => N, fn: (client: DaemonClient, agentId: string, filePath: string) => Promise<T>): Promise<T | N> {
  const filePath = ctx.session.filePath
  if (!filePath) return none()
  const agentId = ctx.session.agentId
  if (!agentId) throw new DaemonModeUnavailableError(what, 'W2-B', `${filePath} is not running in the daemon, and holding it open needs a client session`)
  const client = await ctx.ready()
  try {
    return await fn(client, agentId, filePath)
  } catch (err) {
    if (isNotFound(err)) throw new DaemonModeUnavailableError(what, 'W2-B', `${filePath} is no longer running in the daemon, and holding it open needs a client session`)
    throw err
  }
}

/** Readable values of the open agent (local-only reveal route); key material is never among them. */
async function reveal(client: DaemonClient, agentId: string, purpose: string): Promise<string | null> {
  const { values } = await client.request<{ values: Record<string, string> }>('POST', `/agents/${enc(agentId)}/identity/reveal`, { body: { purposes: [purpose] } })
  return values[purpose] ?? null
}

interface DaemonIdentityStatus {
  status: 'none' | 'locked' | 'restore-needed' | 'ready'
  ownerDid: string | null
  runtimeDid: string | null
  runtime: { state: 'adopted' | 'absent' | 'rejected' | 'unavailable'; source: 'studio' | 'daemon'; reason: string | null; message: string }
  storage: 'keychain' | 'file'
  backupConfirmed: boolean
}

/** Last runtime-adoption message logged, so a refresh loop does not repeat it. */
const loggedRuntime = new WeakMap<DaemonModeContext, string>()

/**
 * GET /identity (and the identity keys of GET /settings) in the shape of
 * Studio's OwnerIdentityService.getStatus(), for Settings → Identity and the
 * restore banner:
 *
 * - `status` → `hasMnemonic` (the daemon holds the phrase AND Studio can show
 *   it: the shared keychain entry, local mode), `mnemonicLocked` (file
 *   storage not unlocked), `restoreRequired` (`restore-needed`); `none` is an
 *   empty owner DID, as a Studio with no owner yet.
 * - `runtime` (W1-C): the runtime DID, its delegation and the legacy runtime
 *   DIDs are the ones the daemon presents: Studio's when it adopted them
 *   (§5.3), else its own (`daemonRuntime*`). Any state but `adopted` is
 *   logged with the daemon's own sentence.
 * - `safeStorageAvailable`: the phrase is in the keychain or the daemon's
 *   passphrase-encrypted file, never in a plain settings file, so the
 *   "stored unencrypted" warning never applies.
 */
async function ownerStatus(ctx: DaemonModeContext, client: DaemonClient) {
  const [identity, { settings }] = await Promise.all([
    client.request<DaemonIdentityStatus>('GET', '/identity'),
    client.request<{ settings: Record<string, unknown> | null }>('GET', '/settings'),
  ])
  const s = settings ?? {}
  const adopted = identity.runtime.source === 'studio'
  if (identity.runtime.state !== 'adopted' && loggedRuntime.get(ctx) !== identity.runtime.message) {
    loggedRuntime.set(ctx, identity.runtime.message)
    ctx.log.warn(`[Backend] The daemon runs as its own runtime (${identity.runtime.state}${identity.runtime.reason ? `: ${identity.runtime.reason}` : ''}): ${identity.runtime.message}`)
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const runtimeDid = identity.runtimeDid ?? ''
  const delegationValue = adopted ? s.runtimeDelegation : s.daemonRuntimeDelegation
  const runtimeDelegation = delegationValue && typeof delegationValue === 'object' ? delegationValue as AlfAttestation : null
  return {
    ownerDid: identity.ownerDid ?? '',
    runtimeDid,
    hasMnemonic: identity.status === 'ready' && ctx.mode === 'local' && identity.storage === 'keychain',
    mnemonicLocked: identity.status === 'locked',
    restoreRequired: identity.status === 'restore-needed',
    backupConfirmed: identity.backupConfirmed,
    legacyOwnerDids: strings(s.legacyOwnerDids),
    legacyRuntimeDids: strings(adopted ? s.legacyRuntimeDids : s.daemonLegacyRuntimeDids),
    safeStorageAvailable: true,
    runtimeDelegation,
    runtimeDelegationValid: !!runtimeDelegation && verifyAttestation(runtimeDelegation, { expectedSubject: runtimeDid }),
  }
}

export const IDENTITY_HANDLERS: DaemonHandlerTable = {
  // --- the open agent's keystore -------------------------------------------------------
  [IPC.IDENTITY_SET]: (ctx, _event, args: { purpose: string; value: string }) =>
    onOpenAgent(ctx, 'Storing a value in the open agent', () => ({ error: NO_ADF }), async (client, agentId) => {
      const path = `/agents/${enc(agentId)}/identity/${enc(args.purpose)}`
      await writeWithLockedChoice(ctx, args.purpose, (replace) =>
        client.request('PUT', path, { body: { value: args.value, ...(replace ? { replace } : {}) } }))
      return undefined
    }),

  // Values come only from the daemon on this machine (local-only reveal
  // routes with the local proof); a remote daemon never sends them.
  [IPC.IDENTITY_GET]: (ctx, _event, args: { purpose: string }) =>
    onOpenAgent(ctx, 'Reading a value of the open agent', () => null, async (client, agentId) => {
      if (isKeyMaterialPurpose(args.purpose)) return null
      if (ctx.mode === 'remote') throw new Error(REMOTE_VALUES_UNSUPPORTED)
      return reveal(client, agentId, args.purpose)
    }),

  [IPC.IDENTITY_REVEAL]: (ctx, _event, args: { purpose: string }) =>
    onOpenAgent(ctx, 'Revealing a value of the open agent', () => ({ value: null }), async (client, agentId) => {
      if (isKeyMaterialPurpose(args.purpose)) return { value: null, reason: REVEAL_REFUSED_REASON }
      if (ctx.mode === 'remote') return { value: null, reason: REMOTE_VALUES_UNSUPPORTED }
      return { value: await reveal(client, agentId, args.purpose) }
    }),

  [IPC.IDENTITY_DELETE]: (ctx, _event, args: { purpose: string }) =>
    onOpenAgent(ctx, 'Deleting a value of the open agent', () => undefined, async (client, agentId) => {
      await client.request('DELETE', `/agents/${enc(agentId)}/identity/${enc(args.purpose)}`)
      return undefined
    }),

  [IPC.IDENTITY_DELETE_PREFIX]: (ctx, _event, args: { prefix: string }) =>
    onOpenAgent(ctx, 'Deleting values of the open agent', () => 0, async (client, agentId) =>
      (await client.request<{ deleted: number }>('DELETE', `/agents/${enc(agentId)}/identity-prefix`, { query: { prefix: args.prefix } })).deleted),

  [IPC.IDENTITY_LIST]: (ctx, _event, args: { prefix?: string }) =>
    onOpenAgent(ctx, 'Listing the open agent\'s keystore', () => [] as string[], async (client, agentId) =>
      (await client.request<{ purposes: string[] }>('GET', `/agents/${enc(agentId)}/identity`, { query: { prefix: args?.prefix } })).purposes),

  [IPC.IDENTITY_LIST_ENTRIES]: (ctx) =>
    onOpenAgent(ctx, 'Listing the open agent\'s keystore', () => ({ entries: [] }), async (client, agentId) =>
      ({ entries: (await client.request<{ identities: unknown[] }>('GET', `/agents/${enc(agentId)}/identity/entries`)).identities })),

  [IPC.IDENTITY_SET_CODE_ACCESS]: (ctx, _event, args: { purpose: string; codeAccess: boolean }) =>
    onOpenAgent(ctx, 'Changing code access in the open agent', () => ({ success: false }), async (client, agentId) =>
      ({ success: (await client.request<{ success: boolean }>('PATCH', `/agents/${enc(agentId)}/identity/${enc(args.purpose)}/code-access`, { body: { codeAccess: args.codeAccess } })).success })),

  [IPC.IDENTITY_WIPE_ALL]: (ctx) =>
    onOpenAgent(ctx, 'Wiping the open agent\'s identity', () => ({ success: false }), async (client, agentId, filePath) => {
      await client.request('POST', `/agents/${enc(agentId)}/identity/wipe`)
      // The daemon dropped the file's key; this session stops keeping the file held for it.
      ctx.session.forgetUnlocked(filePath)
      return { success: true }
    }),

  [IPC.IDENTITY_GET_DID]: (ctx) =>
    onOpenAgent(ctx, 'Reading the open agent\'s DID', () => ({ did: null }), async (client, agentId) =>
      ({ did: (await client.request<{ did: string | null }>('GET', `/agents/${enc(agentId)}/identity/did`)).did })),

  [IPC.IDENTITY_GENERATE_KEYS]: (ctx) =>
    onOpenAgent(ctx, 'Generating keys for the open agent', () => ({ success: false, error: NO_ADF }), async (client, agentId) => {
      try {
        const { did } = await client.request<{ did: string }>('POST', `/agents/${enc(agentId)}/identity/generate-keys`)
        return { success: true, did }
      } catch (err) {
        if (isNotFound(err)) throw err
        return { success: false, error: String(new Error(message(err))) }
      }
    }),

  [IPC.IDENTITY_CLAIM]: (ctx) =>
    onOpenAgent(ctx, 'Claiming the open agent', () => ({ success: false, error: NO_ADF }), async (client, agentId, filePath) => {
      const result = await client.request<{ success: boolean; did?: string; error?: string }>('POST', `/agents/${enc(agentId)}/claim`)
      if (result.success) ctx.session.forgetUnlocked(filePath)
      return result
    }),

  // --- legacy whole-file password ------------------------------------------------------
  [IPC.IDENTITY_PASSWORD_CHECK]: (ctx) =>
    onOpenAgent(ctx, 'Checking the open agent\'s password', () => ({ needsPassword: false }), async (client, agentId) =>
      ({ needsPassword: (await client.request<{ needsPassword: boolean }>('GET', `/agents/${enc(agentId)}/identity/password`)).needsPassword })),

  /**
   * The key stays in the daemon (the file's key cell); this session keeps
   * the file held so it is not prompted again (DaemonModeSession). The
   * owner's own legacy file is converted by the daemon on unlock, as
   * embedded converts it (envelope-actions.ts convertOwnLegacyPassword):
   * then no key is needed any more.
   */
  [IPC.IDENTITY_PASSWORD_UNLOCK]: (ctx, _event, args: { password: string }) =>
    onOpenAgent(ctx, 'Unlocking the open agent', () => ({ success: false, error: NO_ADF }), async (client, agentId, filePath) => {
      let converted = false
      try {
        const answer = await client.request<{ converted?: boolean }>('POST', `/agents/${enc(agentId)}/identity/password/unlock`, { body: { password: args?.password } })
        converted = answer.converted === true
      } catch (err) {
        if (isNotFound(err)) throw err
        ctx.log.error('[IDENTITY_PASSWORD_UNLOCK] Failed:', message(err))
        return { success: false, error: codeOf(err) === 'wrong_password' ? 'Wrong password' : message(err) }
      }
      if (converted) ctx.session.forgetUnlocked(filePath)
      else ctx.session.noteUnlocked(filePath, agentId)
      return { success: true, converted }
    }),

  [IPC.IDENTITY_PASSWORD_REMOVE]: (ctx) =>
    onOpenAgent(ctx, 'Removing the open agent\'s password', () => ({ success: false, error: NO_ADF }), async (client, agentId, filePath) => {
      try {
        await client.request('DELETE', `/agents/${enc(agentId)}/identity/password`)
      } catch (err) {
        if (isNotFound(err)) throw err
        // The daemon holds no key for the file: embedded's "not unlocked".
        if (codeOf(err) === 'credentials_locked') return { success: false, error: 'Not unlocked' }
        return { success: false, error: String(new Error(message(err))) }
      }
      ctx.session.forgetUnlocked(filePath)
      return { success: true }
    }),

  // --- attestations and envelopes (W1-D routes) ------------------------------------------
  [IPC.IDENTITY_ATTESTATIONS_GET]: (ctx) =>
    onOpenAgent(ctx, 'Reading the open agent\'s attestations', () => ({ attestations: [] }), (client, agentId) =>
      client.request('GET', `/agents/${enc(agentId)}/attestations`)),

  [IPC.IDENTITY_ATTESTATIONS_REISSUE]: (ctx) =>
    onOpenAgent(ctx, 'Reissuing the open agent\'s attestations', () => ({ success: false, error: NO_ADF }), (client, agentId) =>
      client.request('POST', `/agents/${enc(agentId)}/attestations/reissue`)),

  [IPC.IDENTITY_ENVELOPE_STATUS]: (ctx) =>
    onOpenAgent(ctx, 'Reading the open agent\'s envelopes', () => ({ success: false, error: NO_ADF }), (client, agentId) =>
      client.request('GET', `/agents/${enc(agentId)}/envelope`)),

  [IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD]: (ctx, _event, password: string) =>
    onOpenAgent(ctx, 'Setting the open agent\'s share password', () => ({ success: false, error: NO_ADF }), (client, agentId) =>
      client.request('PUT', `/agents/${enc(agentId)}/envelope/share-password`, { body: { password } })),

  [IPC.IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD]: (ctx) =>
    onOpenAgent(ctx, 'Removing the open agent\'s share password', () => ({ success: false, error: NO_ADF }), (client, agentId) =>
      client.request('DELETE', `/agents/${enc(agentId)}/envelope/share-password`)),

  [IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD]: (ctx, _event, password: string, adopt?: boolean) =>
    onOpenAgent(ctx, 'Unlocking the open agent\'s credentials', () => ({ success: false, error: NO_ADF }), (client, agentId) =>
      client.request('POST', `/agents/${enc(agentId)}/envelope/unlock-password`, { body: { password, ...(adopt !== undefined ? { adopt } : {}) } })),

  // --- owner identity (§5.4) --------------------------------------------------------------
  [IPC.IDENTITY_OWNER_STATUS]: async (ctx) => ownerStatus(ctx, await ctx.ready()),

  /**
   * The phrase comes from the OS keychain entry Studio and the daemon share
   * (`ADF / owner-mnemonic`), read here, on this machine; no route carries
   * it. Null when there is none (the daemon keeps it in its passphrase file)
   * or when the entry holds another owner's phrase.
   */
  [IPC.IDENTITY_OWNER_REVEAL_MNEMONIC]: async (ctx) => {
    if (ctx.mode === 'remote') {
      throw new Error('The seed phrase stays on the daemon host: back it up there with `adf identity` (a remote daemon never sends it).')
    }
    const client = await ctx.ready()
    const { ownerDid } = await client.request<{ ownerDid: string | null }>('GET', '/identity')
    const phrase = ctx.sharedMnemonic()?.read() ?? null
    if (!phrase || !ownerDid) return { mnemonic: null }
    try {
      if (deriveOwnerIdentity(phrase).did !== ownerDid) {
        ctx.log.warn('[Backend] The keychain\'s owner phrase is not the daemon owner\'s; not shown')
        return { mnemonic: null }
      }
    } catch {
      return { mnemonic: null }
    }
    return { mnemonic: phrase }
  },

  [IPC.IDENTITY_OWNER_CONFIRM_BACKUP]: async (ctx) => {
    const client = await ctx.ready()
    await client.request('POST', '/identity/confirm-backup')
    return { success: true }
  },

  /**
   * POST /identity/import with this machine's local proof (local mode: the
   * client sends it, read from the file next to the daemon's settings). Studio's import switches
   * owners (`switchOwner`); with `expectedOwnerDid` it restores that owner
   * only. The daemon refuses a switch while the previous owner's phrase is
   * not backed up, since the switch removes it from this machine; that
   * refusal is shown as it is.
   */
  [IPC.IDENTITY_OWNER_IMPORT]: async (ctx, _event, mnemonic: string, expectedOwnerDid?: string) => {
    try {
      const normalized = String(mnemonic ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
      if (!validateMnemonic(normalized)) throw new Error('Invalid mnemonic phrase')
      const expected = typeof expectedOwnerDid === 'string' && expectedOwnerDid ? expectedOwnerDid : undefined
      const did = deriveOwnerIdentity(normalized).did
      if (expected && did !== expected) {
        throw new Error(`That phrase belongs to ${did}, not this machine's owner ${expected}. Check the words, or use Import identity to switch owners.`)
      }
      const client = await ctx.ready()
      // Local mode: the client sends this machine's local proof (index.ts).
      const body = await client.request<{ ownerDid?: string; restamp?: { restamped: number; attested: number; failures: string[] } }>(
        'POST', '/identity/import', { body: { mnemonic: normalized, ...(expected ? {} : { switchOwner: true }) }, timeoutMs: 120_000 })
      ctx.log.log(`[Backend] Owner identity imported in the daemon: ${body.ownerDid}`)
      return { success: true, ownerDid: body.ownerDid, ...(body.restamp ?? { restamped: 0, attested: 0, failures: [] }) }
    } catch (err) {
      return { success: false, error: message(err) }
    }
  },
}
