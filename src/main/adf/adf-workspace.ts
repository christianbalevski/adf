/**
 * ADF Workspace
 *
 * Provides read/write methods for tools and the runtime.
 * Backed by AdfDatabase (SQLite) - no temp directory extraction needed.
 */

import { brotliCompress, brotliCompressSync, brotliDecompressSync } from 'zlib'
import { promisify } from 'util'
import type { ContentBlock } from '@shared/types/provider.types'
import type {
  AgentConfig,
  AlfAgentCard,
  AuditConfig,
  CreateAgentOptions,
  FileProtectionLevel,
  MetaProtectionLevel,
  LoggingConfig,
  LoopTokenUsage,
  InboxMessage,
  OutboxMessage,
  Timer,
  TimerSchedule,
  InboxStatus,
  OutboxStatus,
  TaskEntry,
  TaskStatus
} from '@shared/types/adf-v02.types'
import { LOG_LEVELS } from '@shared/types/adf-v02.types'
import { AdfDatabase, type LoopEntryRow } from './adf-database'
import { SkillIndexer, type SkillIndexResult, type SkillIndexRunResult } from './skill-indexer'
import {
  deriveKey,
  generateSalt,
  encrypt,
  decrypt,
  getDefaultKdfParams,
  generateEd25519KeyPair,
  extractRawPublicKey,
  publicKeyToDid,
  type KdfParams
} from '../crypto/identity-crypto'
import {
  generateDek,
  createKeySlot,
  openKeySlot,
  createPasswordSlot,
  openPasswordSlot,
  sealWithDek,
  openWithDek,
  envelopeForPurpose,
  envelopeAlgo,
  envelopeFromAlgo,
  type EnvelopeName,
  type EnvelopeSlot,
  type KeySlotRecord,
  type PasswordSlotRecord
} from '../crypto/envelope-crypto'
import { currentSourceOrUnknown } from '../runtime/execution-context'
// Static import is cycle-free: emit-umbilical only pulls in the umbilical bus,
// the async-local execution context, and a type-only daemon bus reference —
// none of which reach back into the workspace.
import { emitUmbilicalEvent } from '../runtime/emit-umbilical'

/** Off-event-loop brotli — see AdfWorkspace.runLoopMutation. */
const brotliCompressAsync = promisify(brotliCompress)

/** Compressed archive of the loop rows a destructive op is about to remove. */
type LoopArchive = { json: string; data: Buffer } | null

/**
 * Thrown (and caught) inside runLoopMutation's transaction when the loop table
 * changed while the archive was being compressed. A symbol, not an Error, so it
 * can never be confused with a genuine failure from the commit body.
 */
const LOOP_REVISION_CHANGED = Symbol('adf:loop-revision-changed')

/**
 * Envelope lifecycle state (ADF_IDENTITY_SPEC D10):
 *  - absent:   no descriptor row — pre-envelope file
 *  - unlocked: DEK cached in memory for this workspace instance
 *  - locked:   a password slot exists; prompt to unlock
 *  - foreign:  slots exist but none opened — file from another owner/runtime
 */
export type EnvelopeState = 'absent' | 'unlocked' | 'locked' | 'foreign'

/**
 * Emitted after a VFS mutation succeeds. This is intentionally owned by the
 * workspace rather than individual tools so Studio, agents, lambdas, imports,
 * transfers, and runtime APIs all have one reliable file-change path.
 */
export interface WorkspaceFileChange {
  path: string
  operation: 'created' | 'modified' | 'deleted'
  /** Text content is included only when the file is text-like, for diffing. */
  content?: string
  previousContent?: string
  source: string
  metadata: {
    mime_type: string | null
    size: number
    protection: FileProtectionLevel
    authorized: boolean
    created_at: string
    updated_at: string
  } | null
}

/**
 * Coarse-grained "this data changed" signal, emitted after inbox/outbox rows
 * or SQL tables mutate. Owned by the workspace (like WorkspaceFileChange) so
 * every write path — tools, lambdas, mesh delivery, adapters, Studio IPC —
 * funnels through one reliable notification point. Consumers refetch; no
 * payload is carried.
 */
export type WorkspaceDataScope = 'inbox' | 'outbox' | 'tables'

export interface EnvelopeRecipients {
  ownerDid: string
  ownerEncPublicKey: Buffer
  runtimeDid: string
  runtimeEncPublicKey: Buffer
}

const ENVELOPE_NAMES: EnvelopeName[] = ['identity', 'credentials']
const ENVELOPE_PURPOSE_PREFIX = 'crypto:envelope:'

/** Sealed OAuth token store purpose — `mcp:<name>:oauth`. */
const MCP_OAUTH_PURPOSE_RE = /^mcp:[^:]+:oauth$/
/** Credential-file purposes — `mcp:<name>:file:<declared path>`. */
const MCP_CREDENTIAL_FILE_PURPOSE_RE = /^mcp:[^:]+:file:/

/**
 * MCP runtime-managed identity purposes: sealed OAuth token stores
 * (`mcp:<name>:oauth`) and materialized credential files
 * (`mcp:<name>:file:<path>`). These are written and read ONLY by the
 * main-process MCP connect/refresh machinery. Agent access is LOCKED BY OWNER
 * POLICY by default — no agent writes (set_identity poisoning) and no code
 * reads (get_identity exfiltration), regardless of the row's code_access flag
 * — but this is a policy lock, not a capability wall: see
 * mcpRuntimeIdentityAccess for the sovereignty-track unlock semantics. Plain
 * env-credential rows (`mcp:<name>:<KEY>`) are deliberately NOT matched — those
 * stay legitimately code-readable for the agent's own sys_code.
 */
export function isReservedMcpRuntimePurpose(purpose: string): boolean {
  return MCP_OAUTH_PURPOSE_RE.test(purpose) || MCP_CREDENTIAL_FILE_PURPOSE_RE.test(purpose)
}

/**
 * Owner-policy lock over agent access to a reserved MCP runtime identity
 * purpose. This is a LOCK the owner holds, NOT a hardcoded capability wall:
 * an agent *may not* read/write these today because the owner's policy is
 * locked, not because the agent is permanently incapable. Denial belongs in
 * policy so that when owner-granted identity sovereignty lands, granting an
 * agent authority over its own credentials is a policy flip, not a code change.
 *
 * Default: LOCKED (read+write) for reserved purposes — the 99% case. The
 * grant source is sovereignty-track and MUST be owner-controlled and never
 * agent-writable (an agent cannot unlock itself); no such grant exists yet, so
 * both stay locked. Non-reserved purposes are not governed here.
 *
 * NOTE: this is distinct from crypto key material (CODE_FORBIDDEN_PURPOSES),
 * which is a true absolute — signing/envelope/kdf rows are never code-readable
 * for the crypto system to hold, and that is integrity, not policy.
 */
export function mcpRuntimeIdentityAccess(purpose: string): { readUnlocked: boolean; writeUnlocked: boolean } {
  if (!isReservedMcpRuntimePurpose(purpose)) return { readUnlocked: true, writeUnlocked: true }
  return { readUnlocked: false, writeUnlocked: false }
}

export class AdfWorkspace {
  private db: AdfDatabase
  private filePath: string
  private autoCheckpointTimer: NodeJS.Timeout | null = null
  /** Randomized start delay for the checkpoint interval — see startAutoCheckpoint. */
  private autoCheckpointStartTimer: NodeJS.Timeout | null = null
  private static readonly AUTO_CHECKPOINT_MS = 10_000
  /** Unwrapped envelope DEKs, per open workspace instance. Never persisted. */
  private envelopeDeks = new Map<EnvelopeName, Buffer>()
  private onFileChangeCallback: ((change: WorkspaceFileChange) => void) | null = null
  private onDataChangeCallback: ((scope: WorkspaceDataScope) => void) | null = null
  /** Reindexes skills/*\/SKILL.md → skills-registry.json off the write choke point. */
  private skillIndexer: SkillIndexer
  private onSkillRegistryChangedCallback: ((json: string, result: SkillIndexResult) => void) | null = null

  /** Card builder function, registered by mesh-manager when the agent is served. */
  _cardBuilder?: () => AlfAgentCard | null

  /** Provider metadata from the last LLM response (e.g. rate limits). Set by the executor. */
  _providerMeta?: Record<string, unknown>

  constructor(db: AdfDatabase, filePath: string) {
    this.db = db
    this.filePath = filePath
    this.skillIndexer = new SkillIndexer(this, {
      // Read live, not captured: sys_update_config can flip skills.enabled
      // mid-session and the very next write must respect the new value.
      isEnabled: () => {
        try { return this.getAgentConfig().skills?.enabled === true } catch { return false }
      },
      onRegistryChanged: (json, result) => this.onSkillRegistryChangedCallback?.(json, result),
      onError: (message) => {
        try { this.insertLog('warn', 'runtime', 'skill_index', null, message) } catch { /* diagnostic only */ }
      },
    })
    this.startAutoCheckpoint()
  }

  static open(filePath: string): AdfWorkspace {
    const db = AdfDatabase.open(filePath)
    return new AdfWorkspace(db, filePath)
  }

  static create(
    filePath: string,
    options: CreateAgentOptions
  ): AdfWorkspace {
    const db = AdfDatabase.create(filePath, options)
    return new AdfWorkspace(db, filePath)
  }

  getFilePath(): string {
    return this.filePath
  }

  // ===========================================================================
  // Document Access
  // ===========================================================================

  readDocument(): string {
    const doc = this.db.getDocument()
    return doc?.content ?? ''
  }

  writeDocument(content: string): void {
    const doc = this.db.getDocument()
    const path = doc?.path ?? 'README.md'
    this.writeFile(path, content, 'no_delete')
  }

  getDocumentPath(): string {
    const doc = this.db.getDocument()
    return doc?.path ?? 'README.md'
  }

  readMind(): string {
    return this.db.getMind()
  }

  writeMind(content: string): void {
    this.writeFile('mind.md', content, 'no_delete')
  }

  // ===========================================================================
  // Identity / Keystore
  // ===========================================================================

  getIdentity(purpose: string): string | null {
    // Envelope-encrypted rows decrypt transparently while their envelope is
    // unlocked, so existing consumers are agnostic to at-rest encryption.
    const row = this.db.getIdentityRaw(purpose)
    if (!row) return null
    const envelope = envelopeFromAlgo(row.encryption_algo)
    if (envelope) {
      const dek = this.envelopeDeks.get(envelope)
      if (!dek) return null
      return openWithDek(row.value, dek)?.toString('utf-8') ?? null
    }
    return this.db.getIdentity(purpose)
  }

  /**
   * Store an identity value. `codeAccess` only applies when the key is
   * created — an existing key keeps its current code_access flag.
   * When the covering envelope is unlocked the value is sealed under its DEK;
   * otherwise it is stored plain (pre-envelope files keep working unchanged).
   */
  setIdentity(purpose: string, value: string, codeAccess = false): void {
    const envelope = envelopeForPurpose(purpose)
    const dek = envelope ? this.envelopeDeks.get(envelope) : undefined
    if (envelope && dek) {
      const existed = this.db.getIdentityRow(purpose) !== null
      this.db.setIdentityRaw(purpose, sealWithDek(Buffer.from(value, 'utf-8'), dek), envelopeAlgo(envelope), null, null)
      if (!existed && codeAccess) this.db.setIdentityCodeAccess(purpose, true)
      return
    }
    this.db.setIdentity(purpose, value, codeAccess)
  }

  /**
   * Store an identity value ONLY if it can be sealed under its covering
   * envelope's DEK — never falls back to plaintext. For high-value rows
   * (credential files, token stores) where an unsealed write is worse than
   * a failed one. Throws a plain error when the envelope is locked/absent.
   */
  setIdentitySealed(purpose: string, value: string, codeAccess = false): void {
    const envelope = envelopeForPurpose(purpose)
    if (!envelope) {
      throw new Error(`Cannot seal identity value for "${purpose}" — the purpose is not covered by an envelope.`)
    }
    const dek = this.envelopeDeks.get(envelope)
    if (!dek) {
      throw new Error(
        `Cannot store "${purpose}" — the ${envelope} envelope is locked in this runtime, and this value must never be written unsealed. ` +
        'Open the agent in ADF Studio once (which unlocks envelopes), or provision a daemon runtime key.',
      )
    }
    const existed = this.db.getIdentityRow(purpose) !== null
    this.db.setIdentityRaw(purpose, sealWithDek(Buffer.from(value, 'utf-8'), dek), envelopeAlgo(envelope), null, null)
    if (!existed && codeAccess) this.db.setIdentityCodeAccess(purpose, true)
  }

  deleteIdentity(purpose: string): boolean {
    return this.db.deleteIdentity(purpose)
  }

  deleteIdentityByPrefix(prefix: string): number {
    return this.db.deleteIdentityByPrefix(prefix)
  }

  listIdentityPurposes(prefix?: string): string[] {
    return this.db.listIdentityPurposes(prefix)
  }

  // ===========================================================================
  // Password-Protected Identity
  // ===========================================================================

  isPasswordProtected(): boolean {
    return this.db.isPasswordProtected()
  }

  /**
   * Unlock a password-protected ADF by deriving the key and test-decrypting.
   * Throws if the password is wrong.
   */
  unlockWithPassword(password: string): Buffer {
    const saltHex = this.db.getIdentity('crypto:kdf:salt')
    const kdfJson = this.db.getIdentity('crypto:kdf:params')
    if (!saltHex || !kdfJson) {
      throw new Error('No password salt/params found')
    }
    const salt = Buffer.from(saltHex, 'hex')
    const kdfParams: KdfParams = JSON.parse(kdfJson)
    const derivedKey = deriveKey(password, salt, kdfParams)

    // Test-decrypt any encrypted row to verify the password
    const allRows = this.db.getAllIdentityRaw()
    const encryptedRow = allRows.find((r) => r.encryption_algo !== 'plain' && r.salt)
    if (!encryptedRow) {
      throw new Error('No encrypted identity rows found')
    }
    // This will throw if auth tag doesn't match (wrong password)
    decrypt(encryptedRow.value, derivedKey, encryptedRow.salt!)
    return derivedKey
  }

  /**
   * True when the derived key decrypts this file's password-encrypted rows —
   * the same test unlockWithPassword performs. A file with no
   * password-encrypted rows verifies trivially: there is nothing to disprove
   * the key against, and legacy password-protected files often lack specific
   * rows (e.g. crypto:signing:private_key — key minting skips
   * password-protected files), so probing one fixed purpose misreads
   * row-missing as key-stale.
   */
  verifyDerivedKey(derivedKey: Buffer): boolean {
    const encryptedRow = this.db.getAllIdentityRaw().find((r) => r.encryption_algo !== 'plain' && r.salt)
    if (!encryptedRow) return true
    try {
      decrypt(encryptedRow.value, derivedKey, encryptedRow.salt!)
      return true
    } catch {
      return false
    }
  }

  /**
   * Set a password on the identity keystore: encrypt ALL identity rows.
   */
  setPassword(password: string): Buffer {
    const salt = generateSalt()
    const kdfParams = getDefaultKdfParams()
    const derivedKey = deriveKey(password, salt, kdfParams)

    // Encrypt all identity rows. Envelope descriptors stay plain — they hold
    // only wrapped material and must stay readable for slot inspection;
    // env:* rows are already sealed and are skipped by the 'plain' guard.
    const rows = this.db.getAllIdentityRaw()
    for (const row of rows) {
      if (row.encryption_algo !== 'plain') continue
      if (row.purpose.startsWith(ENVELOPE_PURPOSE_PREFIX)) continue
      const plaintext = row.value
      const { ciphertext, iv } = encrypt(plaintext, derivedKey)
      this.db.setIdentityRaw(
        row.purpose, ciphertext, 'aes-256-gcm', iv,
        JSON.stringify(kdfParams)
      )
    }

    // Store salt and kdf params in identity
    this.db.setIdentity('crypto:kdf:salt', salt.toString('hex'))
    this.db.setIdentity('crypto:kdf:params', JSON.stringify(kdfParams))

    return derivedKey
  }

  /**
   * Remove the password: decrypt ALL rows back to plain and clear KDF params.
   */
  removePassword(derivedKey: Buffer): void {
    const rows = this.db.getAllIdentityRaw()
    for (const row of rows) {
      if (row.encryption_algo === 'plain') continue
      if (!row.salt) continue
      const plaintext = decrypt(row.value, derivedKey, row.salt)
      this.db.setIdentityRaw(
        row.purpose, plaintext, 'plain', null, null
      )
    }
    // Clear KDF params from identity
    this.db.deleteIdentity('crypto:kdf:salt')
    this.db.deleteIdentity('crypto:kdf:params')
  }

  /**
   * Change the password: decrypt with old key, re-encrypt with new.
   */
  changePassword(oldDerivedKey: Buffer, newPassword: string): Buffer {
    const newSalt = generateSalt()
    const kdfParams = getDefaultKdfParams()
    const newDerivedKey = deriveKey(newPassword, newSalt, kdfParams)

    const rows = this.db.getAllIdentityRaw()
    for (const row of rows) {
      // env:* rows (salt-less) and envelope descriptors are not password-keyed
      if (row.purpose.startsWith(ENVELOPE_PURPOSE_PREFIX)) continue
      let plaintext: Buffer
      if (row.encryption_algo === 'plain') {
        plaintext = row.value
      } else {
        if (!row.salt) continue
        plaintext = decrypt(row.value, oldDerivedKey, row.salt)
      }
      const { ciphertext, iv } = encrypt(plaintext, newDerivedKey)
      this.db.setIdentityRaw(
        row.purpose, ciphertext, 'aes-256-gcm', iv,
        JSON.stringify(kdfParams)
      )
    }

    this.db.setIdentity('crypto:kdf:salt', newSalt.toString('hex'))
    this.db.setIdentity('crypto:kdf:params', JSON.stringify(kdfParams))

    return newDerivedKey
  }

  getIdentityDecrypted(purpose: string, derivedKey: Buffer | null): string | null {
    const row = this.db.getIdentityRaw(purpose)
    if (row && envelopeFromAlgo(row.encryption_algo)) return this.getIdentity(purpose)
    return this.db.getIdentityDecrypted(purpose, derivedKey)
  }

  /** Purposes never readable from agent code, regardless of code_access (spec D13). */
  private static readonly CODE_FORBIDDEN_PURPOSES = /^crypto:(signing|envelope|kdf):/

  /**
   * Identity read for agent code execution (get_identity): enforces the
   * code_access flag AND hard-blocks key material — signing keys, envelope
   * descriptors, and KDF rows are runtime-only even if someone flips
   * code_access on them.
   */
  getIdentityForCode(purpose: string, derivedKey: Buffer | null): string | null {
    if (AdfWorkspace.CODE_FORBIDDEN_PURPOSES.test(purpose)) return null
    // Reserved MCP runtime identity (sealed OAuth tokens, credential files):
    // governed by owner policy, LOCKED by default (see mcpRuntimeIdentityAccess).
    // Locked ⇒ code cannot read it, regardless of the row's code_access flag —
    // so a pre-seeded/poisoned flag can't leak the token. When an owner grants
    // read, this opens; today it is always locked. Not a permanent wall.
    if (isReservedMcpRuntimePurpose(purpose) && !mcpRuntimeIdentityAccess(purpose).readUnlocked) return null
    const row = this.db.getIdentityRow(purpose)
    if (!row?.code_access) return null
    return this.getIdentityDecrypted(purpose, derivedKey)
  }

  listIdentityEntries(): Array<{ purpose: string; encrypted: boolean; code_access: boolean }> {
    return this.db.listIdentityEntries()
  }

  getIdentityRow(purpose: string): { purpose: string; code_access: boolean; encryption_algo: string } | null {
    return this.db.getIdentityRow(purpose)
  }

  setIdentityCodeAccess(purpose: string, codeAccess: boolean): boolean {
    return this.db.setIdentityCodeAccess(purpose, codeAccess)
  }

  // ===========================================================================
  // Envelopes (ADF_IDENTITY_SPEC D5/D6/D9/D10)
  // ===========================================================================

  hasEnvelopes(): boolean {
    return this.db.getIdentityRow(ENVELOPE_PURPOSE_PREFIX + 'identity') !== null
  }

  readEnvelopeSlots(name: EnvelopeName): EnvelopeSlot[] | null {
    const raw = this.db.getIdentity(ENVELOPE_PURPOSE_PREFIX + name)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed?.slots) ? (parsed.slots as EnvelopeSlot[]) : null
    } catch {
      return null
    }
  }

  private writeEnvelopeSlots(name: EnvelopeName, slots: EnvelopeSlot[]): void {
    // Descriptors stay plain: they hold only wrapped material and must be
    // readable without unlocking anything (slot inspection, claim detection).
    this.db.setIdentity(ENVELOPE_PURPOSE_PREFIX + name, JSON.stringify({ v: 1, slots }))
  }

  /**
   * Create both envelopes with owner + runtime key slots (D5/D6). Idempotent —
   * an existing descriptor is left untouched. DEKs are cached, so subsequent
   * setIdentity calls seal automatically.
   */
  provisionEnvelopes(recipients: EnvelopeRecipients): void {
    for (const name of ENVELOPE_NAMES) {
      if (this.db.getIdentityRow(ENVELOPE_PURPOSE_PREFIX + name) !== null) continue
      const dek = generateDek()
      this.writeEnvelopeSlots(name, [
        createKeySlot(dek, name, 'owner', recipients.ownerDid, recipients.ownerEncPublicKey),
        createKeySlot(dek, name, 'runtime', recipients.runtimeDid, recipients.runtimeEncPublicKey)
      ])
      this.envelopeDeks.set(name, dek)
    }
  }

  getEnvelopeState(name: EnvelopeName): EnvelopeState {
    if (this.envelopeDeks.has(name)) return 'unlocked'
    const slots = this.readEnvelopeSlots(name)
    if (!slots) return 'absent'
    return slots.some((s) => s.type === 'password') ? 'locked' : 'foreign'
  }

  /**
   * D10 unwrap cascade: runtime slot → owner slot. On an owner-slot unlock a
   * runtime slot for this install is added (re-wrap), so the seed-derived key
   * is needed at most once per file per machine. Password slots are not tried
   * here — they prompt on demand via unlockEnvelopeWithPassword.
   */
  unlockEnvelopes(keys: {
    runtimeEncPrivateKey?: Buffer | null
    ownerEncPrivateKey?: Buffer | null
    reWrapRuntime?: { did: string; encPublicKey: Buffer }
  }): Record<EnvelopeName, EnvelopeState> {
    for (const name of ENVELOPE_NAMES) {
      if (this.envelopeDeks.has(name)) continue
      const slots = this.readEnvelopeSlots(name)
      if (!slots) continue

      let dek: Buffer | null = null
      let viaOwner = false
      for (const slot of slots) {
        if (slot.type === 'password') continue
        const record = slot as KeySlotRecord
        const key = record.type === 'runtime' ? keys.runtimeEncPrivateKey : keys.ownerEncPrivateKey
        if (!key) continue
        dek = openKeySlot(record, name, key)
        if (dek) {
          viaOwner = record.type === 'owner'
          break
        }
      }
      if (!dek) continue

      this.envelopeDeks.set(name, dek)
      if (viaOwner && keys.reWrapRuntime) {
        const kept = slots.filter(
          (s) => s.type === 'password' || s.type === 'owner' || (s as KeySlotRecord).recipient_did !== keys.reWrapRuntime!.did
        )
        kept.push(createKeySlot(dek, name, 'runtime', keys.reWrapRuntime.did, keys.reWrapRuntime.encPublicKey))
        this.writeEnvelopeSlots(name, kept)
      }
    }
    return {
      identity: this.getEnvelopeState('identity'),
      credentials: this.getEnvelopeState('credentials')
    }
  }

  /** Try a password slot (D12 recipient flow). Returns true when the envelope unlocks. */
  unlockEnvelopeWithPassword(name: EnvelopeName, password: string): boolean {
    if (this.envelopeDeks.has(name)) return true
    const slots = this.readEnvelopeSlots(name)
    if (!slots) return false
    for (const slot of slots) {
      if (slot.type !== 'password') continue
      const dek = openPasswordSlot(slot as PasswordSlotRecord, password)
      if (dek) {
        this.envelopeDeks.set(name, dek)
        return true
      }
    }
    return false
  }

  /**
   * Add a password slot (D12 share flow). Identity envelopes never get one —
   * identity is non-transferable; only credentials may travel by password.
   * Requires the envelope to be unlocked (the DEK is being re-wrapped).
   */
  addEnvelopePasswordSlot(name: EnvelopeName, password: string): void {
    if (name === 'identity') throw new Error('The identity envelope cannot carry a password slot')
    const dek = this.envelopeDeks.get(name)
    if (!dek) throw new Error(`Envelope "${name}" is not unlocked`)
    const slots = this.readEnvelopeSlots(name) ?? []
    slots.push(createPasswordSlot(dek, password))
    this.writeEnvelopeSlots(name, slots)
  }

  /**
   * Add (or replace, by recipient_did) a key slot on an unlocked envelope —
   * the mcp-credential-identity Phase C flow uses this to wrap the
   * credentials DEK to a trusted daemon's X25519 key. Like the password-slot
   * path, the identity envelope never gets extra slots: identity is bound to
   * this owner/runtime pair; only credentials may gain recipients.
   */
  addEnvelopeKeySlot(
    name: EnvelopeName,
    type: 'owner' | 'runtime',
    recipientDid: string,
    recipientPublicRaw: Buffer
  ): void {
    if (name === 'identity') throw new Error('The identity envelope cannot gain additional key slots')
    const dek = this.envelopeDeks.get(name)
    if (!dek) throw new Error(`Envelope "${name}" is not unlocked`)
    const slots = (this.readEnvelopeSlots(name) ?? []).filter(
      (s) => s.type === 'password' || (s as KeySlotRecord).recipient_did !== recipientDid
    )
    slots.push(createKeySlot(dek, name, type, recipientDid, recipientPublicRaw))
    this.writeEnvelopeSlots(name, slots)
  }

  /**
   * Remove a key slot by recipient_did (Phase C daemon-key revocation).
   * Removing a slot only narrows access, so no unlock is required. Returns
   * true when a slot was removed.
   */
  removeEnvelopeKeySlot(name: EnvelopeName, recipientDid: string): boolean {
    const slots = this.readEnvelopeSlots(name)
    if (!slots) return false
    const kept = slots.filter(
      (s) => s.type === 'password' || (s as KeySlotRecord).recipient_did !== recipientDid
    )
    if (kept.length === slots.length) return false
    this.writeEnvelopeSlots(name, kept)
    return true
  }

  /**
   * Drop password slots. Only the explicit owner controls call this
   * (share-password remove, and set/legacy-convert replacing a slot) —
   * adoption and claim never do: password slots persist through both.
   */
  removeEnvelopePasswordSlots(name: EnvelopeName): void {
    const slots = this.readEnvelopeSlots(name)
    if (!slots) return
    const kept = slots.filter((s) => s.type !== 'password')
    if (kept.length !== slots.length) this.writeEnvelopeSlots(name, kept)
  }

  /**
   * D12 recipient adoption: re-wrap an unlocked envelope's DEK to a new
   * owner/runtime pair, replacing all previous key slots (they belonged to
   * the sender). Password slots are PRESERVED — envelopes are multi-route by
   * design: the DEK is unchanged, so after adoption the file opens silently
   * via local keys AND the same share password keeps working (including for
   * re-sharing). A password slot only disappears via the explicit
   * share-password remove/change controls.
   */
  adoptEnvelope(name: EnvelopeName, recipients: EnvelopeRecipients): void {
    const dek = this.envelopeDeks.get(name)
    if (!dek) throw new Error(`Envelope "${name}" is not unlocked`)
    const passwordSlots = (this.readEnvelopeSlots(name) ?? []).filter((s) => s.type === 'password')
    this.writeEnvelopeSlots(name, [
      ...passwordSlots,
      createKeySlot(dek, name, 'owner', recipients.ownerDid, recipients.ownerEncPublicKey),
      createKeySlot(dek, name, 'runtime', recipients.runtimeDid, recipients.runtimeEncPublicKey)
    ])
  }

  /**
   * Forget a cached DEK whose descriptor row was deleted out-of-band (claim
   * wipes crypto:envelope:identity directly). A dangling DEK would let
   * generateIdentityKeys seal fresh keys under a descriptor that no longer
   * exists — unrecoverable.
   */
  clearCachedEnvelopeDek(name: EnvelopeName): void {
    this.envelopeDeks.delete(name)
  }

  /**
   * D11 claim hygiene: a credentials envelope that cannot be opened on this
   * machine is kept while any route to its DEK survives — a password slot
   * always counts (it opens the envelope regardless of sealed-row count, and
   * password slots only ever disappear via the explicit share-password
   * remove/change controls). Only a password-less envelope whose key slots
   * are all foreign is cryptographically dead here: leaving its descriptor
   * would make every credential written after a claim stay plaintext forever
   * (no DEK → setIdentity falls back to plain). Drop it and its unreadable
   * rows so a fresh envelope can be provisioned. Returns true when dropped.
   */
  dropDeadCredentialsEnvelope(): boolean {
    if (this.envelopeDeks.has('credentials')) return false // unlocked/adopted — keep
    const slots = this.readEnvelopeSlots('credentials')
    if (!slots) return false // absent
    if (slots.some((s) => s.type === 'password')) return false // recoverable via password
    const algo = envelopeAlgo('credentials')
    const rows = this.db.getAllIdentityRaw().filter((r) => r.encryption_algo === algo)
    for (const row of rows) this.db.deleteIdentity(row.purpose)
    this.db.deleteIdentity(ENVELOPE_PURPOSE_PREFIX + 'credentials')
    return true
  }

  /**
   * Migration (spec §8): seal existing plain rows under their covering
   * envelope's DEK. Only touches plain rows whose envelope is unlocked;
   * password-encrypted (aes-256-gcm) rows are left for conversion on unlock.
   * Returns the number of rows sealed.
   */
  sealPlainRowsIntoEnvelopes(): number {
    let sealed = 0
    for (const row of this.db.getAllIdentityRaw()) {
      if (row.encryption_algo !== 'plain') continue
      const envelope = envelopeForPurpose(row.purpose)
      if (!envelope) continue
      const dek = this.envelopeDeks.get(envelope)
      if (!dek) continue
      this.db.setIdentityRaw(row.purpose, sealWithDek(row.value, dek), envelopeAlgo(envelope), null, null)
      sealed++
    }
    return sealed
  }

  /** True if any plain row is covered by an envelope — i.e. migration has work to do. */
  hasUnsealedSecrets(): boolean {
    return this.db
      .getAllIdentityRaw()
      .some((row) => row.encryption_algo === 'plain' && envelopeForPurpose(row.purpose) !== null)
  }

  getDid(): string | null {
    return this.db.getMeta('adf_did')
  }

  /** Prior agent DIDs, oldest first. Appended on rotation/claim/reset; never rewritten. */
  getDidHistory(): string[] {
    const raw = this.db.getMeta('adf_did_history')
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string' && d) : []
    } catch {
      return []
    }
  }

  /**
   * Record a DID that is about to be replaced or cleared, so lineage references
   * to it stay resolvable (read-time cascade; child files are never rewritten).
   */
  private appendDidHistory(oldDid: string): void {
    if (!oldDid) return
    const history = this.getDidHistory()
    if (history.includes(oldDid)) return
    history.push(oldDid)
    this.db.setMeta('adf_did_history', JSON.stringify(history), 'readonly')
  }

  /**
   * Generate Ed25519 key pair + DID for an ADF that doesn't have one.
   * If a password is active, the new keys are encrypted with the given derivedKey.
   */
  generateIdentityKeys(derivedKey: Buffer | null): { did: string } {
    const keyPair = generateEd25519KeyPair()
    const rawPubKey = extractRawPublicKey(keyPair.publicKey)
    const did = publicKeyToDid(rawPubKey)

    const identityDek = this.envelopeDeks.get('identity')
    if (identityDek) {
      // Envelope-provisioned file: private key sealed, public key plain (D6).
      this.db.setIdentityRaw('crypto:signing:private_key', sealWithDek(keyPair.privateKey, identityDek), envelopeAlgo('identity'), null, null)
      this.db.setIdentityRaw('crypto:signing:public_key', keyPair.publicKey, 'plain', null, null)
    } else if (derivedKey) {
      const kdfParamsJson = this.db.getIdentity('crypto:kdf:params')
      const { ciphertext: privCt, iv: privIv } = encrypt(keyPair.privateKey, derivedKey)
      this.db.setIdentityRaw(
        'crypto:signing:private_key', privCt, 'aes-256-gcm', privIv, kdfParamsJson
      )
      const { ciphertext: pubCt, iv: pubIv } = encrypt(keyPair.publicKey, derivedKey)
      this.db.setIdentityRaw(
        'crypto:signing:public_key', pubCt, 'aes-256-gcm', pubIv, kdfParamsJson
      )
    } else {
      this.db.setIdentityRaw('crypto:signing:private_key', keyPair.privateKey, 'plain', null, null)
      this.db.setIdentityRaw('crypto:signing:public_key', keyPair.publicKey, 'plain', null, null)
    }

    const previousDid = this.db.getMeta('adf_did')
    if (previousDid && previousDid !== did) this.appendDidHistory(previousDid)
    // readonly: identity keys must not be agent-writable via sys_set_meta.
    // Runtime writes bypass tool-layer protection, so reset/re-provision still work.
    this.db.setMeta('adf_did', did, 'readonly')
    return { did }
  }

  /**
   * Get the raw Ed25519 signing key buffers (private PKCS8 DER + public SPKI DER).
   * Handles decryption if the keystore is password-protected.
   * Returns null if keys don't exist or can't be decrypted.
   */
  getSigningKeys(derivedKey: Buffer | null): { privateKey: Buffer; publicKey: Buffer } | null {
    const privRow = this.db.getIdentityRaw('crypto:signing:private_key')
    const pubRow = this.db.getIdentityRaw('crypto:signing:public_key')
    if (!privRow || !pubRow) return null

    try {
      let privateKey: Buffer
      let publicKey: Buffer

      if (privRow.encryption_algo === 'plain') {
        privateKey = privRow.value
      } else if (envelopeFromAlgo(privRow.encryption_algo)) {
        const dek = this.envelopeDeks.get('identity')
        if (!dek) return null
        const opened = openWithDek(privRow.value, dek)
        if (!opened) return null
        privateKey = opened
      } else {
        if (!derivedKey || !privRow.salt) return null
        privateKey = decrypt(privRow.value, derivedKey, privRow.salt)
      }

      if (pubRow.encryption_algo === 'plain') {
        publicKey = pubRow.value
      } else {
        if (!derivedKey || !pubRow.salt) return null
        publicKey = decrypt(pubRow.value, derivedKey, pubRow.salt)
      }

      return { privateKey, publicKey }
    } catch {
      return null
    }
  }

  wipeAllIdentity(): void {
    const previousDid = this.db.getMeta('adf_did')
    if (previousDid) this.appendDidHistory(previousDid)
    this.db.deleteAllIdentity()
    this.envelopeDeks.clear() // descriptors are gone; cached DEKs are dangling
    this.db.setMeta('adf_did', '', 'readonly')
  }

  // ===========================================================================
  // Agent Config
  // ===========================================================================
  // Meta
  // ===========================================================================

  getMeta(key: string): string | null {
    return this.db.getMeta(key)
  }

  setMeta(key: string, value: string, protection?: MetaProtectionLevel): void {
    this.db.setMeta(key, value, protection)
  }

  /** Atomically add `delta` to a numeric meta value (creates the key at `delta`).
   *  Returns the new value, or null when the stored value isn't numeric. */
  incrementMeta(key: string, delta: number, protection?: MetaProtectionLevel): string | null {
    return this.db.incrementMeta(key, delta, protection)
  }

  deleteMeta(key: string): boolean {
    return this.db.deleteMeta(key)
  }

  getAllMeta(): Array<{ key: string; value: string; protection: MetaProtectionLevel }> {
    return this.db.getAllMeta()
  }

  getMetaProtection(key: string): MetaProtectionLevel | null {
    return this.db.getMetaProtection(key)
  }

  setMetaProtection(key: string, protection: MetaProtectionLevel): boolean {
    return this.db.setMetaProtection(key, protection)
  }

  // ===========================================================================
  // Agent Config
  // ===========================================================================

  getAgentConfig(): AgentConfig {
    return this.db.getConfig()
  }

  setAgentConfig(config: AgentConfig): void {
    let previous: AgentConfig | null = null
    try { previous = this.db.getConfig() } catch { previous = null }
    this.db.setConfig(config)
    this._loggingConfigCache = null
    this._agentIdCache = config.id || null
    // Only the NAMES of the changed top-level keys go on the wire — config
    // values can hold secrets (provider keys, adapter tokens) and must never
    // leak to taps or external /events subscribers.
    this.emitUmbilical('config.changed', {
      updated_at: Date.now(),
      changed_keys: AdfWorkspace.changedConfigKeys(previous, config),
    })
  }

  /** Shallow per-top-level-key JSON diff. Cheap and good enough for observability. */
  private static changedConfigKeys(previous: AgentConfig | null, next: AgentConfig): string[] {
    if (!previous) return Object.keys(next)
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
    const changed: string[] = []
    for (const key of keys) {
      const a = (previous as unknown as Record<string, unknown>)[key]
      const b = (next as unknown as Record<string, unknown>)[key]
      if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(key)
    }
    return changed
  }

  /**
   * The agent id this workspace belongs to, for stamping umbilical provenance.
   * Many workspace emits fire from IPC/HTTP/mesh callbacks that have no
   * `withSource` async scope, so the async-local agent id is null there and the
   * event would be dropped by the per-agent bus. Reading config.id here stamps
   * it explicitly. Cached because the id is stable for a workspace instance;
   * invalidated on setAgentConfig. Never throws (teardown-safe).
   */
  private _agentIdCache: string | null = null
  private ownAgentId(): string | undefined {
    if (this._agentIdCache) return this._agentIdCache
    try {
      const id = this.db.getConfig().id
      if (id) this._agentIdCache = id
      return id || undefined
    } catch {
      return undefined
    }
  }

  /** Emit an umbilical event from a workspace choke point. Never throws. */
  private emitUmbilical(eventType: string, payload: Record<string, unknown>): void {
    try {
      emitUmbilicalEvent({ event_type: eventType, agentId: this.ownAgentId(), payload })
    } catch { /* emit is best-effort */ }
  }

  // ===========================================================================
  // Loop
  // ===========================================================================

  getLoop(): LoopEntryRow[] {
    return this.db.getLoopEntries()
  }

  getLoopPaginated(limit: number, offset?: number): LoopEntryRow[] {
    return this.db.getLoopEntries(limit, offset)
  }

  /** Keyset pagination: entries immediately preceding `beforeSeq`, ascending. */
  getLoopBefore(beforeSeq: number, limit: number): LoopEntryRow[] {
    return this.db.getLoopEntriesBefore(beforeSeq, limit)
  }

  getLoopCountBefore(beforeSeq: number): number {
    return this.db.getLoopCountBefore(beforeSeq)
  }

  appendToLoop(role: 'user' | 'assistant', content: ContentBlock[], model?: string, tokens?: LoopTokenUsage, createdAt?: number): number {
    return this.db.appendLoopEntry(role, content, model, tokens, createdAt)
  }

  /** Min/max seq over loop entries WITHOUT assuming array order: once an
   *  ord'd compaction summary exists, getLoopEntries() is in display order
   *  (COALESCE(ord, seq)) — the summary sorts first but carries the highest
   *  seq, so first/last-element ranges would invert. No spread — loops can
   *  hold tens of thousands of rows. */
  private static seqRange(entries: Array<{ seq: number }>): { min: number; max: number } {
    let min = entries[0].seq
    let max = entries[0].seq
    for (const e of entries) {
      if (e.seq < min) min = e.seq
      if (e.seq > max) max = e.seq
    }
    return { min, max }
  }

  /**
   * Per-.adf-file mutex for destructive loop ops (clear/replace/compact/slice).
   * Keyed by canonical path, not by instance, so the foreground workspace and a
   * background agent holding the same file share one chain.
   *
   * Without it two ops interleave across their awaits (backup, compression) and
   * the loser silently corrupts the winner's result — e.g. a clear landing
   * between compactLoop's read and its delete leaves deleteLoopBySeqs matching
   * nothing, so compaction reports success while the preserved tail is gone.
   * Serializing END TO END (backup → archive → commit → .bak removal) also
   * gives each op exclusive use of the shared `<file>.bak` path.
   */
  private static destructiveLoopChains = new Map<string, Promise<unknown>>()

  private runExclusiveLoopOp<T>(fn: () => Promise<T>): Promise<T> {
    const key = AdfDatabase.canonicalPathKey(this.filePath)
    const previous = AdfWorkspace.destructiveLoopChains.get(key) ?? Promise.resolve()
    // `.then(fn, fn)`: a failed predecessor must not cancel the queue.
    const run = previous.then(fn, fn)
    const chain = run.then(() => undefined, () => undefined)
    AdfWorkspace.destructiveLoopChains.set(key, chain)
    void chain.then(() => {
      // Drop the entry once this op is the tail — keeps the map from growing
      // one permanent promise per file ever cleared.
      if (AdfWorkspace.destructiveLoopChains.get(key) === chain) {
        AdfWorkspace.destructiveLoopChains.delete(key)
      }
    })
    return run
  }

  /** Recompress attempts before giving up on the off-transaction fast path. */
  private static readonly MAX_ARCHIVE_ATTEMPTS = 3

  /** Run a caller-supplied post-commit hook synchronously; never let it turn a
   *  committed op into a failed one. */
  private runAfterCommit(afterCommit?: () => void): void {
    if (!afterCommit) return
    try { afterCommit() } catch (error) {
      console.error('[AdfWorkspace] loop onCommitted hook threw:', error)
    }
  }

  /**
   * Read the rows a destructive loop op archives, brotli-compress them OUTSIDE
   * any transaction, then commit. Compressing a full transcript is multi-second
   * CPU; doing it inside db.transaction() holds the write lock for that whole
   * time.
   *
   * The await yields the event loop, so the loop table can change between the
   * read and the commit. The consistency check is therefore the FIRST statement
   * INSIDE the transaction — comparing AdfDatabase's monotonic loop revision
   * against the value captured before the read — so there is no microtask gap
   * between "verified unchanged" and "committed" for anything to slip into. A
   * revision (rather than a rowCount:maxSeq fingerprint) is what makes
   * replaceLoop's delete + reinsert of identical seqs with different content
   * visible.
   *
   * A mismatch re-reads and recompresses, capped at MAX_ARCHIVE_ATTEMPTS: an
   * agent appending every 1–3s could otherwise starve the loop forever and hang
   * the renderer's Clear button. After the cap the op falls back to compressing
   * synchronously inside the transaction — slower, blocking, but correct by
   * construction because nothing can run between the read and the commit.
   *
   * With `compress: false` (audit disabled) there is no await at all and the
   * read happens on the same tick as the commit.
   *
   * `afterCommit` runs synchronously in the same tick as the successful commit
   * — no await between COMMIT and the hook — so callers can reset in-memory
   * session state without a dispatched turn landing in between.
   */
  private async runLoopMutation<C, R>(
    read: () => { entries: LoopEntryRow[]; ctx: C },
    compress: boolean,
    commit: (payload: { entries: LoopEntryRow[]; ctx: C; archive: LoopArchive }) => R,
    afterCommit?: () => void
  ): Promise<R> {
    if (!compress) {
      const result = this.db.transaction(() => commit({ ...read(), archive: null }))
      this.runAfterCommit(afterCommit)
      return result
    }

    for (let attempt = 1; attempt <= AdfWorkspace.MAX_ARCHIVE_ATTEMPTS; attempt++) {
      const revision = this.db.getLoopRevision()
      const { entries, ctx } = read()
      if (entries.length === 0) {
        // Nothing to compress ⇒ no await happened ⇒ still the read's tick.
        const result = this.db.transaction(() => commit({ entries, ctx, archive: null }))
        this.runAfterCommit(afterCommit)
        return result
      }
      const json = JSON.stringify(entries)
      const data = await brotliCompressAsync(Buffer.from(json, 'utf-8'))
      try {
        const result = this.db.transaction(() => {
          if (this.db.getLoopRevision() !== revision) throw LOOP_REVISION_CHANGED
          return commit({ entries, ctx, archive: { json, data } })
        })
        this.runAfterCommit(afterCommit)
        return result
      } catch (error) {
        if (error !== LOOP_REVISION_CHANGED) throw error
      }
    }

    console.warn(
      `[AdfWorkspace] loop changed under ${AdfWorkspace.MAX_ARCHIVE_ATTEMPTS} archive attempts; ` +
      `compressing inside the transaction (blocking fallback)`
    )
    const result = this.db.transaction(() => {
      const { entries, ctx } = read()
      let archive: LoopArchive = null
      if (entries.length > 0) {
        const json = JSON.stringify(entries)
        archive = { json, data: brotliCompressSync(Buffer.from(json, 'utf-8')) }
      }
      return commit({ entries, ctx, archive })
    })
    this.runAfterCommit(afterCommit)
    return result
  }

  /** Insert the audit row for a set of archived loop entries. */
  private insertLoopAudit(entries: LoopEntryRow[], archive: { json: string; data: Buffer }): void {
    const range = AdfWorkspace.seqRange(entries)
    this.db.insertAudit('loop', {
      startSeq: range.min,
      endSeq: range.max,
      entryCount: entries.length,
      sizeBytes: archive.json.length,
      data: archive.data
    })
  }

  /**
   * Wipe the loop table (audited when loop audit is on).
   *
   * `onCommitted` runs synchronously in the commit's tick — callers that must
   * also reset in-memory session state (Studio clear, runtime API, mesh) pass
   * it there instead of awaiting this call, so a dispatched turn cannot land
   * between the table wipe and the session reset.
   */
  async clearLoop(opts?: { onCommitted?: () => void }): Promise<void> {
    await this.runExclusiveLoopOp(async () => {
      try { await this.db.backupBeforeDestructive() } catch { /* best-effort */ }
      try {
        const auditLoop = this.getAuditConfig().loop
        await this.runLoopMutation<null, void>(
          () => ({ entries: auditLoop ? this.db.getLoopEntries() : [], ctx: null }),
          auditLoop,
          ({ entries, archive }) => {
            if (archive) this.insertLoopAudit(entries, archive)
            this.db.clearLoop()
          },
          opts?.onCommitted
        )
        await AdfDatabase.removeBackup(this.filePath)
      } catch (error) {
        console.error(`[AdfWorkspace] clearLoop failed. Backup preserved at: ${this.filePath}.bak`)
        throw error
      }
    })
    this.emitUmbilical('loop.cleared', { method: 'clear' })
  }

  /**
   * Atomically replace the loop table contents (e.g. after stripping
   * provider-incompatible blocks from history). Backs up first and audits the
   * prior state when loop audit is enabled — same policy as clearLoop.
   * Entries carrying an explicit `seq` keep it (seq stability across rebuilds);
   * dropped entries leave gaps — their content lives in the audit blob.
   */
  async replaceLoop(entries: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; model?: string; tokens?: LoopTokenUsage; created_at?: number; seq?: number; ord?: number }>): Promise<void> {
    await this.runExclusiveLoopOp(async () => {
      try { await this.db.backupBeforeDestructive() } catch { /* best-effort */ }
      try {
        const auditLoop = this.getAuditConfig().loop
        await this.runLoopMutation<null, void>(
          () => ({ entries: auditLoop ? this.db.getLoopEntries() : [], ctx: null }),
          auditLoop,
          ({ entries: prior, archive }) => {
            if (archive) this.insertLoopAudit(prior, archive)
            this.db.clearLoop()
            for (const e of entries) {
              this.db.appendLoopEntry(e.role, e.content, e.model, e.tokens, e.created_at, { seq: e.seq, ord: e.ord })
            }
          }
        )
        await AdfDatabase.removeBackup(this.filePath)
      } catch (error) {
        console.error(`[AdfWorkspace] replaceLoop failed. Backup preserved at: ${this.filePath}.bak`)
        throw error
      }
    })
    this.emitUmbilical('loop.cleared', { method: 'replace' })
  }

  /**
   * Compact the loop while keeping the preserved tail rows physically in
   * place: archive+delete only the rows NOT in `preservedSeqs`, then insert
   * the summary with `ord = min(preserved ordering keys) - 1` so it sorts
   * before the tail. Deriving the slot from the preserved rows' actual keys
   * (COALESCE(ord, seq)) keeps it collision-free even if the tail contains a
   * prior ord'd summary. With no tail, ord stays NULL.
   *
   * Throws when any preserved seq no longer exists in the loop (e.g. an
   * external clear raced this call) — the caller must fall back to a path
   * that can re-create the tail from memory, otherwise those rows would be
   * silently dropped.
   * One transaction; same backup/audit policy and umbilical event as clearLoop.
   */
  async compactLoop(
    preservedSeqs: number[],
    summary: { content: ContentBlock[]; model?: string; tokens?: LoopTokenUsage; createdAt?: number }
  ): Promise<void> {
    await this.runExclusiveLoopOp(async () => {
      try { await this.db.backupBeforeDestructive() } catch { /* best-effort */ }
      try {
        const auditLoop = this.getAuditConfig().loop
        const preserved = new Set(preservedSeqs)
        await this.runLoopMutation<LoopEntryRow[], void>(
          () => {
            const entries = this.db.getLoopEntries()
            const rows = entries.filter(e => preserved.has(e.seq))
            if (rows.length !== preserved.size) {
              throw new Error(
                `compactLoop: ${preserved.size - rows.length} preserved seq(s) missing from the loop`
              )
            }
            return { entries: entries.filter(e => !preserved.has(e.seq)), ctx: rows }
          },
          auditLoop,
          ({ entries: archived, ctx: preservedRows, archive }) => {
            if (archive) this.insertLoopAudit(archived, archive)
            this.db.deleteLoopBySeqs(archived.map(e => e.seq))
            let ord: number | undefined
            if (preservedRows.length > 0) {
              ord = preservedRows.reduce((min, e) => Math.min(min, e.ord ?? e.seq), Number.POSITIVE_INFINITY) - 1
            }
            this.db.appendLoopEntry('user', summary.content, summary.model, summary.tokens, summary.createdAt, { ord })
          }
        )
        await AdfDatabase.removeBackup(this.filePath)
      } catch (error) {
        console.error(`[AdfWorkspace] compactLoop failed. Backup preserved at: ${this.filePath}.bak`)
        throw error
      }
    })
    this.emitUmbilical('loop.cleared', { method: 'compact' })
  }

  getLoopCount(): number {
    return this.db.getLoopCount()
  }

  getLastAssistantTokens(): LoopTokenUsage | undefined {
    return this.db.getLastAssistantTokens()
  }

  /**
   * Resolve Python-style slice indices against the loop's CURRENT display
   * order. Boundaries are ordering-key values (COALESCE(ord, seq)) so a
   * positional slice resolves an ord'd summary at its display position, not
   * its seq. Returns null when the slice selects nothing.
   *
   * Called from inside runLoopMutation's `read` so the range is derived from
   * the same table state the transaction commits against — resolving it before
   * the backup/compression awaits would delete a window that has since shifted.
   */
  private resolveLoopSliceRange(start?: number, end?: number): { minKey: number; maxKey: number } | null {
    const rows = this.db.getLoopSeqs()
    const len = rows.length
    if (len === 0) return null

    let resolvedStart = start ?? 0
    let resolvedEnd = end ?? len

    if (resolvedStart < 0) resolvedStart = Math.max(0, len + resolvedStart)
    if (resolvedEnd < 0) resolvedEnd = Math.max(0, len + resolvedEnd)
    resolvedStart = Math.min(resolvedStart, len)
    resolvedEnd = Math.min(resolvedEnd, len)

    if (resolvedStart >= resolvedEnd) return null
    return { minKey: rows[resolvedStart].ordKey, maxKey: rows[resolvedEnd - 1].ordKey }
  }

  async clearLoopSlice(start?: number, end?: number): Promise<{ deleted: number; audited: boolean }> {
    return this.runExclusiveLoopOp(async () => {
      if (this.db.getLoopCount() === 0) return { deleted: 0, audited: false }

      try { await this.db.backupBeforeDestructive() } catch { /* best-effort */ }
      try {
        const auditLoop = this.getAuditConfig().loop
        const result = await this.runLoopMutation<{ minKey: number; maxKey: number } | null, { deleted: number; audited: boolean }>(
          () => {
            const range = this.resolveLoopSliceRange(start, end)
            if (!range) return { entries: [], ctx: null }
            return {
              entries: auditLoop ? this.db.getLoopEntriesBySeqRange(range.minKey, range.maxKey) : [],
              ctx: range
            }
          },
          auditLoop,
          ({ entries, ctx: range, archive }) => {
            if (archive) this.insertLoopAudit(entries, archive)
            // Count the rows actually removed rather than the resolved slice
            // width — the two agree now that the range is resolved inside the
            // commit, but the DELETE's own count stays the source of truth.
            const deleted = range ? this.db.deleteLoopBySeqRange(range.minKey, range.maxKey) : 0
            return { deleted, audited: archive !== null }
          }
        )
        await AdfDatabase.removeBackup(this.filePath)
        return result
      } catch (error) {
        console.error(`[AdfWorkspace] clearLoopSlice failed. Backup preserved at: ${this.filePath}.bak`)
        throw error
      }
    })
  }

  // ===========================================================================
  // Audit
  // ===========================================================================

  readAudit(id: number): unknown[] | null {
    const row = this.db.getAuditById(id)
    if (!row) return null
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data)
    const decompressed = brotliDecompressSync(buf)
    return JSON.parse(decompressed.toString('utf-8'))
  }

  listAudits(): Array<{
    id: number; source: string; start_seq: number | null; end_seq: number | null; ref: string | null
    entry_count: number; size_bytes: number; created_at: number
  }> {
    return this.db.listAudits()
  }

  /**
   * Guard against a filter that looks selective but produces no WHERE clause.
   * The DELETE builders ignore fields they do not know and skip falsy values,
   * so `{ source: 'telegram' }` against the outbox would wipe the whole table.
   * An explicitly empty filter ({}) is still allowed — that is the documented
   * "clear the whole inbox" call used by the UI and runtime service.
   */
  private assertFilterSelective(
    filter: Record<string, unknown>,
    supported: readonly string[],
    table: string
  ): void {
    const provided = Object.keys(filter).filter(k => filter[k] !== undefined && filter[k] !== null)
    if (provided.length === 0) return
    const effective = provided.filter(k => supported.includes(k) && Boolean(filter[k]))
    if (effective.length === 0) {
      throw new Error(
        `Refusing to delete every ${table} row: filter [${provided.join(', ')}] matches no supported field ` +
        `(supported: ${supported.join(', ')}) and would produce an unfiltered DELETE.`
      )
    }
  }

  /**
   * Message audit is per-message only (auditMessage at arrival/send): batch
   * deletes no longer write `inbox`/`outbox` audit rows — those sources are
   * legacy-read-only. `audited` is always false, kept for caller shape.
   */
  deleteInboxByFilter(filter: { status?: string; from?: string; source?: string; before?: number; thread_id?: string }): { deleted: number; audited: boolean } {
    this.assertFilterSelective(filter as Record<string, unknown>, ['status', 'from', 'source', 'before', 'thread_id'], 'inbox')
    const deleted = this.db.deleteInboxByFilter(filter)
    if (deleted > 0) this.emitDataChange('inbox')
    return { deleted, audited: false }
  }

  /** Per-message-only audit policy — see deleteInboxByFilter. */
  deleteOutboxByFilter(filter: { status?: string; to?: string; before?: number; thread_id?: string }): { deleted: number; audited: boolean } {
    this.assertFilterSelective(filter as Record<string, unknown>, ['status', 'to', 'before', 'thread_id'], 'outbox')
    const deleted = this.db.deleteOutboxByFilter(filter)
    if (deleted > 0) this.emitDataChange('outbox')
    return { deleted, audited: false }
  }

  /**
   * Audit a single message at ingestion/send time.
   * Stores the full message JSON (with inline attachment data) as a brotli-compressed blob.
   * @param ref The message id, stored in adf_audit.ref for direct lookup.
   */
  auditMessage(source: 'inbox' | 'outbox', messageJson: string, ref?: string): void {
    const audit = this.getAuditConfig()
    if (source === 'inbox' && !audit.inbox) return
    if (source === 'outbox' && !audit.outbox) return

    const compressed = brotliCompressSync(Buffer.from(messageJson, 'utf-8'))
    this.db.insertAudit(`${source}_message`, {
      ref: ref ?? null,
      entryCount: 1,
      sizeBytes: messageJson.length,
      data: compressed
    })
  }

  private getAuditConfig(): AuditConfig {
    try {
      const config = this.db.getConfig()
      return config.context?.audit ?? config.audit ?? { loop: false, inbox: false, outbox: false, files: false }
    } catch {
      return { loop: false, inbox: false, outbox: false, files: false }
    }
  }

  // ===========================================================================
  // Inbox
  // ===========================================================================

  getInbox(status?: InboxStatus): InboxMessage[] {
    return this.db.getInboxMessages(status)
  }

  getInboxMessageById(id: string): InboxMessage | null {
    return this.db.getInboxMessageById(id)
  }

  hasInboxMessage(source: string, messageId: string): boolean {
    return this.db.hasInboxMessage(source, messageId)
  }

  addToInbox(msg: Omit<InboxMessage, 'id'>): string {
    const id = this.db.addInboxMessage(msg)
    this.emitUmbilical('message.received', {
      message_id: id,
      from: msg.from,
      content_type: msg.content_type ?? null,
      size: msg.content ? Buffer.byteLength(msg.content, 'utf-8') : 0,
    })
    this.emitDataChange('inbox')
    return id
  }

  updateInboxStatus(id: string, status: InboxStatus): void {
    this.db.updateInboxStatus(id, status)
    this.emitDataChange('inbox')
  }

  archiveAllInbox(): number {
    const archived = this.db.archiveAllInbox()
    if (archived > 0) this.emitDataChange('inbox')
    return archived
  }

  getUnreadCount(): number {
    return this.db.getUnreadInboxCount()
  }

  deleteInboxMessage(id: string): boolean {
    const deleted = this.db.deleteInboxMessage(id)
    if (deleted) this.emitDataChange('inbox')
    return deleted
  }

  // ===========================================================================
  // Outbox
  // ===========================================================================

  getOutbox(status?: OutboxStatus): OutboxMessage[] {
    return this.db.getOutboxMessages(status)
  }

  addToOutbox(msg: Omit<OutboxMessage, 'id'>): string {
    const id = this.db.addOutboxMessage(msg)
    this.emitUmbilical('message.queued', { message_id: id, to: msg.to ?? null })
    this.emitDataChange('outbox')
    return id
  }

  updateOutboxStatus(id: string, status: OutboxStatus, deliveredAt?: number): void {
    this.db.updateOutboxStatus(id, status, deliveredAt)
    this.emitOutboxTerminalStatus(id, status)
    this.emitDataChange('outbox')
  }

  updateOutboxDeliveryFull(id: string, status: OutboxStatus, statusCode: number | null, deliveredAt: number | null): void {
    this.db.updateOutboxDeliveryFull(id, status, statusCode, deliveredAt)
    this.emitOutboxTerminalStatus(id, status, statusCode)
    this.emitDataChange('outbox')
  }

  private emitOutboxTerminalStatus(id: string, status: OutboxStatus, statusCode?: number | null): void {
    if (status !== 'delivered' && status !== 'failed') return
    // Route through emitUmbilical so the workspace agent id is stamped — these
    // fire from delivery callbacks (adapter/mesh) that have no withSource scope.
    this.emitUmbilical(
      status === 'delivered' ? 'message.sent' : 'message.delivery_failed',
      { message_id: id, status_code: statusCode ?? null },
    )
  }

  updateOutboxMeta(id: string, meta: Record<string, unknown>): void {
    this.db.updateOutboxMeta(id, meta)
    this.emitDataChange('outbox')
  }

  findOutboxByMetaValue(jsonKey: string, value: unknown): string | null {
    return this.db.findOutboxByMetaValue(jsonKey, value)
  }

  findOutboxByMetaArrayValue(jsonKey: string, value: unknown): string | null {
    return this.db.findOutboxByMetaArrayValue(jsonKey, value)
  }

  getPendingOutbox(): OutboxMessage[] {
    return this.getOutbox('pending')
  }

  // ===========================================================================
  // Legacy Compatibility
  // ===========================================================================

  readChat(): { version: number; uiLog: any[]; llmMessages: any[] } | null {
    const loopEntries = this.getLoop()
    if (loopEntries.length === 0) return null
    return {
      version: 1,
      uiLog: [],
      llmMessages: loopEntries.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at }))
    }
  }

  // ===========================================================================
  // Timers
  // ===========================================================================

  getTimers(): Timer[] {
    return this.db.getTimers()
  }

  addTimer(schedule: TimerSchedule, nextWakeAt: number, payload?: string, scope?: string[], lambda?: string, warm?: boolean, locked?: boolean): number {
    return this.db.addTimer(schedule, nextWakeAt, payload, scope, lambda, warm, locked)
  }

  advanceTimer(id: number, nextWakeAt: number, runCount: number, lastFiredAt: number): boolean {
    return this.db.advanceTimer(id, nextWakeAt, runCount, lastFiredAt)
  }

  updateTimer(id: number, schedule: TimerSchedule, nextWakeAt: number, payload?: string, scope?: string[], lambda?: string, warm?: boolean, locked?: boolean): boolean {
    return this.db.updateTimer(id, schedule, nextWakeAt, payload, scope, lambda, warm, locked)
  }

  deleteTimer(id: number): boolean {
    return this.db.deleteTimer(id)
  }

  deleteTimers(ids: number[]): number {
    return this.db.deleteTimers(ids)
  }

  /** Active timers whose wake time has passed — the set the evaluator fires. */
  getDueTimers(): Timer[] {
    return this.db.getDueTimers()
  }

  /** Flag completed timers as expired history instead of deleting them. */
  expireTimers(ids: number[], firedAt?: number): number {
    return this.db.expireTimers(ids, firedAt)
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  readFile(relativePath: string): string | null {

    const entry = this.db.readFile(relativePath)
    if (!entry) return null
    return entry.content.toString('utf-8')
  }

  readFileBuffer(relativePath: string): Buffer | null {

    const entry = this.db.readFile(relativePath)
    return entry?.content ?? null
  }

  writeFile(relativePath: string, content: string, protection?: FileProtectionLevel): void {
    const previous = this.db.readFile(relativePath)
    const level: FileProtectionLevel = protection ??
      (relativePath === 'mind.md' || relativePath === 'README.md' || relativePath === 'document.md' ? 'no_delete' : 'none')
    this.db.writeFile(
      relativePath,
      Buffer.from(content, 'utf-8'),
      this.getMimeType(relativePath),
      level
    )
    this.emitUmbilical('file.written', { path: relativePath, bytes: Buffer.byteLength(content, 'utf-8') })
    this.emitFileChange(relativePath, previous ? 'modified' : 'created', Buffer.from(content, 'utf-8'), previous?.content, this.getFileMeta(relativePath))
  }

  writeFileBuffer(relativePath: string, content: Buffer, mimeType?: string): void {
    const previous = this.db.readFile(relativePath)
    const protection: FileProtectionLevel =
      relativePath === 'mind.md' || relativePath === 'README.md' || relativePath === 'document.md' ? 'no_delete' : 'none'
    this.db.writeFile(relativePath, content, mimeType, protection)
    this.emitUmbilical('file.written', { path: relativePath, bytes: content.length })
    this.emitFileChange(relativePath, previous ? 'modified' : 'created', content, previous?.content, this.getFileMeta(relativePath))
  }

  /**
   * Delete a file. The DB's DELETE only removes rows with protection = 'none'
   * (a belt-and-braces guard so no code path drops a protected row by
   * accident). Callers that hold an explicit authorization — a HIL-approved
   * `_protection_override` or an authorized script (same privilege as the UI)
   * — pass `force: true`, which clears the row's protection first so the
   * guarded DELETE can see it. Without force, deleting a protected file is a
   * silent no-op (returns false), which upstream must NOT report as
   * "not found" — check getFileProtection first and fail plainly.
   */
  deleteFile(relativePath: string, opts?: { force?: boolean }): boolean {
    const previous = this.db.readFile(relativePath)
    const metadata = this.getFileMeta(relativePath)
    const audit = this.getAuditConfig()
    if (audit.files) {
      let deleted = false
      this.db.transaction(() => {
        const entry = this.db.readFile(relativePath)
        if (entry) {
          const snapshot = {
            path: relativePath,
            content_base64: entry.content.toString('base64'),
            mime_type: entry.mime_type,
            size: entry.size
          }
          const json = JSON.stringify(snapshot)
          const compressed = brotliCompressSync(Buffer.from(json, 'utf-8'))
          this.db.insertAudit('file', { ref: relativePath, entryCount: 1, sizeBytes: json.length, data: compressed })
        }
        if (opts?.force && entry) this.db.setFileProtection(relativePath, 'none')
        deleted = this.db.deleteFile(relativePath)
      })
      if (deleted) {
        this.emitUmbilical('file.deleted', { path: relativePath })
        this.emitFileChange(relativePath, 'deleted', undefined, previous?.content, metadata)
      }
      return deleted
    }
    if (opts?.force && previous) this.db.setFileProtection(relativePath, 'none')
    const deleted = this.db.deleteFile(relativePath)
    if (deleted) {
      this.emitUmbilical('file.deleted', { path: relativePath })
      this.emitFileChange(relativePath, 'deleted', undefined, previous?.content, metadata)
    }
    return deleted
  }

  getFileMeta(path: string): { path: string; mime_type: string | null; size: number; protection: FileProtectionLevel; authorized: boolean; created_at: string; updated_at: string } | null {
    return this.db.getFileMeta(path)
  }

  listFiles(): Array<{
    path: string
    size: number
    mime_type?: string
    protection: FileProtectionLevel
    authorized: boolean
    created_at: string
    updated_at: string
  }> {
    return this.db.listFiles().map((f) => ({
      path: f.path,
      size: f.size,
      mime_type: f.mime_type,
      protection: f.protection,
      authorized: f.authorized,
      created_at: f.created_at,
      updated_at: f.updated_at
    }))
  }

  fileExists(relativePath: string): boolean {

    return this.db.readFile(relativePath) !== null
  }

  renameInternalFile(oldPath: string, newPath: string): boolean {
    const previous = this.db.readFile(oldPath)
    const metadata = this.getFileMeta(oldPath)
    const renamed = this.db.renameFile(oldPath, newPath)
    if (renamed) {
      // Model a rename as delete + create so existing file-change consumers do
      // not need a fourth operation and watches on either path are reliable.
      this.emitFileChange(oldPath, 'deleted', undefined, previous?.content, metadata)
      this.emitFileChange(newPath, 'created', previous?.content, undefined, this.getFileMeta(newPath))
    }
    return renamed
  }

  renameFolder(oldPrefix: string, newPrefix: string): number {
    const prefix = oldPrefix.endsWith('/') ? oldPrefix : `${oldPrefix}/`
    const moved = this.listFiles()
      .filter(file => file.path.startsWith(prefix))
      .map(file => ({ path: file.path, content: this.db.readFile(file.path)?.content, metadata: this.getFileMeta(file.path) }))
    const count = this.db.renameFolder(oldPrefix, newPrefix)
    if (count > 0) {
      const replacementPrefix = newPrefix.endsWith('/') ? newPrefix : `${newPrefix}/`
      for (const file of moved) {
        const newPath = replacementPrefix + file.path.slice(prefix.length)
        this.emitFileChange(file.path, 'deleted', undefined, file.content, file.metadata)
        this.emitFileChange(newPath, 'created', file.content, undefined, this.getFileMeta(newPath))
      }
    }
    return count
  }

  /** Register the assembled runtime's single file-change sink. */
  setOnFileChangeCallback(callback: ((change: WorkspaceFileChange) => void) | null): void {
    this.onFileChangeCallback = callback
  }

  /** Register the single data-change sink (Studio IPC forwarder). */
  setOnDataChangeCallback(callback: ((scope: WorkspaceDataScope) => void) | null): void {
    this.onDataChangeCallback = callback
  }

  /**
   * Register the sink for mid-session catalog changes. The runtime turns this
   * into a keyed `loop_inject`; the `{{skills-registry.json}}` prompt snapshot
   * is deliberately NOT rebuilt (that would break prompt caching mid-session).
   */
  setOnSkillRegistryChangedCallback(
    callback: ((json: string, result: SkillIndexResult) => void) | null,
  ): void {
    this.onSkillRegistryChangedCallback = callback
  }

  /**
   * Index skills now, skipping the debounce. Called at workspace open / session
   * start; a no-op (returns null) when `skills.enabled` is false.
   */
  refreshSkillIndex(): SkillIndexRunResult | null {
    return this.skillIndexer.refresh()
  }

  /**
   * Release the runtime's `read_only` hold on `skills-registry.json`. Called
   * when `skills.enabled` is turned OFF: the runtime stops maintaining the
   * derived catalog, so it must stop owning the file too — otherwise the agent
   * is left with a stale generated artifact it can neither refresh nor delete.
   * Returns true when a protection level actually changed.
   */
  releaseSkillRegistry(): boolean {
    return this.skillIndexer.releaseRegistry()
  }

  private emitDataChange(scope: WorkspaceDataScope): void {
    try {
      this.onDataChangeCallback?.(scope)
    } catch { /* notification is best-effort — never fail the write */ }
  }

  private emitFileChange(
    path: string,
    operation: WorkspaceFileChange['operation'],
    content: Buffer | undefined,
    previousContent: Buffer | undefined,
    metadata: WorkspaceFileChange['metadata'],
  ): void {
    // Ahead of the callback guard: skill indexing must happen for every writer
    // whether or not a runtime is attached to this workspace. The indexer's own
    // write targets skills-registry.json, which is not a watched path, so this
    // cannot recurse.
    this.skillIndexer.notifyPath(path)
    if (!this.onFileChangeCallback) return
    const mimeType = metadata?.mime_type ?? this.getMimeType(path)
    this.onFileChangeCallback({
      path,
      operation,
      content: this.toDiffText(content, mimeType),
      previousContent: this.toDiffText(previousContent, mimeType),
      source: currentSourceOrUnknown(),
      metadata,
    })
  }

  private toDiffText(content: Buffer | undefined, mimeType: string | null | undefined): string | undefined {
    if (!content || !this.isTextLikeMimeType(mimeType)) return undefined
    return content.toString('utf-8')
  }

  private isTextLikeMimeType(mimeType: string | null | undefined): boolean {
    return !!mimeType && (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/javascript'
    )
  }

  setFileProtection(path: string, protection: FileProtectionLevel): boolean {
    return this.db.setFileProtection(path, protection)
  }

  getFileProtection(path: string): FileProtectionLevel | null {
    return this.db.getFileProtection(path)
  }

  isFileAuthorized(path: string): boolean {
    return this.db.getFileAuthorized(path)
  }

  setFileAuthorized(path: string, authorized: boolean): boolean {
    return this.db.setFileAuthorized(path, authorized)
  }


  getMimeType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase()
    const mimeTypes: Record<string, string> = {
      // Text / code
      md: 'text/markdown', txt: 'text/plain', json: 'application/json',
      js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python',
      html: 'text/html', css: 'text/css', csv: 'text/csv',
      xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
      sh: 'text/x-shellscript', sql: 'text/x-sql', toml: 'text/toml',
      ini: 'text/plain', env: 'text/plain', log: 'text/plain',
      // Line/record textual formats — must be text so cat/head/coreutils see
      // bytes, not a binary placeholder.
      ndjson: 'application/x-ndjson', jsonl: 'application/x-ndjson',
      tsv: 'text/tab-separated-values', tab: 'text/tab-separated-values',
      text: 'text/plain', conf: 'text/plain', cfg: 'text/plain',
      // Images
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      ico: 'image/x-icon', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
      // Audio
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
      flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', weba: 'audio/webm',
      // Video
      mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
      avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska',
      // Documents
      pdf: 'application/pdf', doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      // Archives
      zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
      '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
      // Fonts
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
      // Data
      wasm: 'application/wasm', parquet: 'application/vnd.apache.parquet',
      arrow: 'application/vnd.apache.arrow.file',
    }
    return mimeTypes[ext ?? ''] ?? 'application/octet-stream'
  }

  // ===========================================================================
  // Tasks
  // ===========================================================================

  insertTask(id: string, tool: string, args: string, origin?: string, requiresAuthorization?: boolean, executorManaged?: boolean, approvalMeta?: string): void {
    this.db.insertTask(id, tool, args, origin, requiresAuthorization, executorManaged, approvalMeta)
  }

  getTask(id: string): TaskEntry | null {
    return this.db.getTask(id)
  }

  updateTaskStatus(id: string, status: TaskStatus, result?: string, error?: string): void {
    this.db.updateTaskStatus(id, status, result, error)
  }

  setTaskRequiresAuthorization(id: string, value: true): void {
    this.db.setTaskRequiresAuthorization(id, value)
  }

  setTaskExecutorManaged(id: string, value: true): void {
    this.db.setTaskExecutorManaged(id, value)
  }

  updateTaskArgs(id: string, args: string): void {
    this.db.updateTaskArgs(id, args)
  }

  getTasksByStatus(status: TaskStatus): TaskEntry[] {
    return this.db.getTasksByStatus(status)
  }

  getAllTasks(limit?: number): TaskEntry[] {
    return this.db.getAllTasks(limit)
  }

  // ===========================================================================
  // Logs
  // ===========================================================================

  private _onLogCallback?: (level: string, origin: string | null, event: string | null, target: string | null, message: string) => void
  private _firingLogTrigger = false
  private _loggingConfigCache: { config: LoggingConfig | undefined; timestamp: number } | null = null
  private _logInsertCount = 0

  private static readonly LOG_SEVERITY: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }
  private static readonly LOGGING_CONFIG_CACHE_MS = 5000

  private getLoggingConfig(): LoggingConfig | undefined {
    const now = Date.now()
    if (this._loggingConfigCache && (now - this._loggingConfigCache.timestamp) < AdfWorkspace.LOGGING_CONFIG_CACHE_MS) {
      return this._loggingConfigCache.config
    }
    try {
      const cfg = this.db.getConfig()
      this._loggingConfigCache = { config: cfg.logging, timestamp: now }
      return cfg.logging
    } catch {
      return undefined
    }
  }

  private shouldLog(level: string, origin: string | null): boolean {
    const config = this.getLoggingConfig()
    if (!config) return true

    const severity = AdfWorkspace.LOG_SEVERITY[level] ?? 1

    if (config.rules && origin) {
      for (const rule of config.rules) {
        if (this.logGlobMatch(rule.origin, origin)) {
          return severity >= (AdfWorkspace.LOG_SEVERITY[rule.min_level] ?? 1)
        }
      }
    }

    return severity >= (AdfWorkspace.LOG_SEVERITY[config.default_level] ?? 1)
  }

  private logGlobMatch(pattern: string, value: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
    return regex.test(value)
  }

  setOnLogCallback(cb: (level: string, origin: string | null, event: string | null, target: string | null, message: string) => void): void {
    this._onLogCallback = cb
  }

  private static readonly DEFAULT_MAX_LOG_ROWS = 10_000
  private static readonly TRIM_INTERVAL = 100

  insertLog(level: string, origin: string | null, event: string | null, target: string | null, message: string, data?: unknown): void {
    if (!this.shouldLog(level, origin)) return

    this.db.insertLog(level, origin, event, target, message, data)

    // Amortized ring-buffer trim: check every TRIM_INTERVAL inserts
    this._logInsertCount++
    if (this._logInsertCount >= AdfWorkspace.TRIM_INTERVAL) {
      this._logInsertCount = 0
      const config = this.getLoggingConfig()
      const maxRows = config?.max_rows
      // undefined → use default; null → unlimited
      if (maxRows !== null) {
        try { this.db.trimLogs(maxRows ?? AdfWorkspace.DEFAULT_MAX_LOG_ROWS) } catch { /* non-fatal */ }
      }
    }

    // Fire on_logs trigger — with anti-recursion guard
    if (this._onLogCallback && !this._firingLogTrigger) {
      this._firingLogTrigger = true
      try { this._onLogCallback(level, origin, event, target, message) } catch { /* never block logging */ }
      finally { this._firingLogTrigger = false }
    }
  }

  getLogs(limit?: number): Array<{ id: number; level: string; origin: string | null; event: string | null; target: string | null; message: string; data: string | null; created_at: number }> {
    return this.db.getLogs(limit)
  }

  getLogsAfterId(afterId: number): Array<{ id: number; level: string; origin: string | null; event: string | null; target: string | null; message: string; data: string | null; created_at: number }> {
    return this.db.getLogsAfterId(afterId)
  }

  clearLogs(): void {
    this.db.clearLogs()
  }

  // ===========================================================================
  // Direct SQL (for db_query / db_execute tools)
  // ===========================================================================

  listLocalTables(): Array<{ name: string; row_count: number }> {
    return this.db.listLocalTables()
  }

  dropLocalTable(name: string): boolean {
    const dropped = this.db.dropLocalTable(name)
    if (dropped) this.emitDataChange('tables')
    return dropped
  }

  querySQL(sql: string, params?: unknown[]): unknown[] {
    return this.db.querySQL(sql, params)
  }

  executeSQL(sql: string, params?: unknown[]): { changes: number } {
    const result = this.db.executeSQL(sql, params)
    // DDL (CREATE/DROP/ALTER) reports 0 changes but still mutates — emit unconditionally.
    this.emitDataChange('tables')
    return result
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  private startAutoCheckpoint(): void {
    // Random phase offset: every workspace uses the same fixed period, so
    // agents opened together would otherwise checkpoint on the same tick —
    // N synchronous checkpoints back-to-back on the shared main thread.
    const delay = Math.floor(Math.random() * AdfWorkspace.AUTO_CHECKPOINT_MS)
    this.autoCheckpointStartTimer = setTimeout(() => {
      this.autoCheckpointStartTimer = null
      this.autoCheckpointTimer = setInterval(() => {
        try {
          this.db.checkpointPassive()
        } catch {
          // DB may be closed during shutdown — ignore
        }
      }, AdfWorkspace.AUTO_CHECKPOINT_MS)
      this.autoCheckpointTimer.unref()
    }, delay)
    this.autoCheckpointStartTimer.unref()
  }

  checkpoint(): void {
    this.db.checkpoint()
  }

  close(): void {
    this.skillIndexer.dispose()
    if (this.autoCheckpointStartTimer) {
      clearTimeout(this.autoCheckpointStartTimer)
      this.autoCheckpointStartTimer = null
    }
    if (this.autoCheckpointTimer) {
      clearInterval(this.autoCheckpointTimer)
      this.autoCheckpointTimer = null
    }
    // Ordering invariant: checkpoint (flush WAL into the main .adf) happens
    // BEFORE AdfDatabase.close(), which writes the clean-close marker as its
    // final write (last in-process connection only) and then lets SQLite
    // itself remove -wal/-shm when the genuinely-last connection closes.
    // The checkpoint is best-effort — a BUSY checkpoint must not prevent the
    // close (sqlite auto-checkpoints on the last connection close anyway).
    // NOTE: there is no cross-process lock here; another process holding the
    // same .adf is handled by the refcount in AdfDatabase.close() (in-process)
    // and by reapSidecars' exclusive-lock probe returning 'busy' (cross-process).
    try {
      this.db.checkpoint()
    } catch { /* e.g. already-closed db during shutdown races */ }
    this.db.close()
  }

  dispose(): void {
    this.close()
  }

  getDatabase(): AdfDatabase {
    return this.db
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }
}
