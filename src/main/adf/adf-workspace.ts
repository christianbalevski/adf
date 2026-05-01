/**
 * ADF Workspace
 *
 * Provides read/write methods for tools and the runtime.
 * Backed by AdfDatabase (SQLite) - no temp directory extraction needed.
 */

import { brotliCompressSync, brotliDecompressSync } from 'zlib'
import type { ContentBlock } from '@shared/types/provider.types'
import type {
  AgentConfig,
  AlfAgentCard,
  AuditConfig,
  CreateAgentOptions,
  FileProtectionLevel,
  MetaProtectionLevel,
  LoggingConfig,
  LoopEntry,
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
import { AdfDatabase } from './adf-database'
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

export class AdfWorkspace {
  private db: AdfDatabase
  private filePath: string
  private autoCheckpointTimer: NodeJS.Timeout | null = null
  private static readonly AUTO_CHECKPOINT_MS = 10_000

  /** Card builder function, registered by mesh-manager when the agent is served. */
  _cardBuilder?: () => AlfAgentCard | null

  /** Provider metadata from the last LLM response (e.g. rate limits). Set by the executor. */
  _providerMeta?: Record<string, unknown>

  constructor(db: AdfDatabase, filePath: string) {
    this.db = db
    this.filePath = filePath
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
    const path = doc?.path ?? 'document.md'
    this.db.setDocument(content, path)
  }

  getDocumentPath(): string {
    const doc = this.db.getDocument()
    return doc?.path ?? 'document.md'
  }

  readMind(): string {
    return this.db.getMind()
  }

  writeMind(content: string): void {
    this.db.setMind(content)
  }

  // ===========================================================================
  // Identity / Keystore
  // ===========================================================================

  getIdentity(purpose: string): string | null {
    return this.db.getIdentity(purpose)
  }

  setIdentity(purpose: string, value: string): void {
    this.db.setIdentity(purpose, value)
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
   * Set a password on the identity keystore: encrypt ALL identity rows.
   */
  setPassword(password: string): Buffer {
    const salt = generateSalt()
    const kdfParams = getDefaultKdfParams()
    const derivedKey = deriveKey(password, salt, kdfParams)

    // Encrypt all identity rows
    const rows = this.db.getAllIdentityRaw()
    for (const row of rows) {
      if (row.encryption_algo !== 'plain') continue
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
    return this.db.getIdentityDecrypted(purpose, derivedKey)
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

  getDid(): string | null {
    return this.db.getMeta('adf_did')
  }

  /**
   * Generate Ed25519 key pair + DID for an ADF that doesn't have one.
   * If a password is active, the new keys are encrypted with the given derivedKey.
   */
  generateIdentityKeys(derivedKey: Buffer | null): { did: string } {
    const keyPair = generateEd25519KeyPair()
    const rawPubKey = extractRawPublicKey(keyPair.publicKey)
    const did = publicKeyToDid(rawPubKey)

    if (derivedKey) {
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

    this.db.setMeta('adf_did', did)
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
    this.db.deleteAllIdentity()
    this.db.setMeta('adf_did', '')
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
    this.db.setConfig(config)
    this._loggingConfigCache = null
  }

  // ===========================================================================
  // Loop
  // ===========================================================================

  getLoop(): LoopEntry[] {
    return this.db.getLoopEntries()
  }

  getLoopPaginated(limit: number, offset?: number): LoopEntry[] {
    return this.db.getLoopEntries(limit, offset)
  }

  appendToLoop(role: 'user' | 'assistant', content: ContentBlock[], model?: string, tokens?: LoopTokenUsage, createdAt?: number): number {
    return this.db.appendLoopEntry(role, content, model, tokens, createdAt)
  }

  clearLoop(): void {
    try { this.db.backupBeforeDestructive() } catch { /* best-effort */ }
    try {
      const audit = this.getAuditConfig()
      if (audit.loop) {
        this.db.transaction(() => {
          const entries = this.db.getLoopEntries()
          if (entries.length > 0) {
            const json = JSON.stringify(entries)
            const compressed = brotliCompressSync(Buffer.from(json, 'utf-8'))
            this.db.insertAudit(
              'loop',
              entries[0].created_at,
              entries[entries.length - 1].created_at,
              entries.length,
              json.length,
              compressed
            )
          }
          this.db.clearLoop()
        })
      } else {
        this.db.clearLoop()
      }
      AdfDatabase.removeBackup(this.filePath)
    } catch (error) {
      console.error(`[AdfWorkspace] clearLoop failed. Backup preserved at: ${this.filePath}.bak`)
      throw error
    }
  }

  getLoopCount(): number {
    return this.db.getLoopCount()
  }

  getLastAssistantTokens(): LoopTokenUsage | undefined {
    return this.db.getLastAssistantTokens()
  }

  clearLoopSlice(start?: number, end?: number): { deleted: number; audited: boolean } {
    const seqs = this.db.getLoopSeqs()
    if (seqs.length === 0) return { deleted: 0, audited: false }

    // Resolve Python-style indices
    const len = seqs.length
    let resolvedStart = start ?? 0
    let resolvedEnd = end ?? len

    if (resolvedStart < 0) resolvedStart = Math.max(0, len + resolvedStart)
    if (resolvedEnd < 0) resolvedEnd = Math.max(0, len + resolvedEnd)
    resolvedStart = Math.min(resolvedStart, len)
    resolvedEnd = Math.min(resolvedEnd, len)

    if (resolvedStart >= resolvedEnd) return { deleted: 0, audited: false }

    const minSeq = seqs[resolvedStart]
    const maxSeq = seqs[resolvedEnd - 1]

    try { this.db.backupBeforeDestructive() } catch { /* best-effort */ }
    try {
      const audit = this.getAuditConfig()
      let audited = false

      this.db.transaction(() => {
        if (audit.loop) {
          const entries = this.db.getLoopEntriesBySeqRange(minSeq, maxSeq)
          if (entries.length > 0) {
            const json = JSON.stringify(entries)
            const compressed = brotliCompressSync(Buffer.from(json, 'utf-8'))
            this.db.insertAudit(
              'loop',
              entries[0].created_at,
              entries[entries.length - 1].created_at,
              entries.length,
              json.length,
              compressed
            )
            audited = true
          }
        }
        this.db.deleteLoopBySeqRange(minSeq, maxSeq)
      })

      const deleted = resolvedEnd - resolvedStart
      AdfDatabase.removeBackup(this.filePath)
      return { deleted, audited }
    } catch (error) {
      console.error(`[AdfWorkspace] clearLoopSlice failed. Backup preserved at: ${this.filePath}.bak`)
      throw error
    }
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
    id: number; source: string; start_at: number; end_at: number
    entry_count: number; size_bytes: number; created_at: number
  }> {
    return this.db.listAudits()
  }

  deleteInboxByFilter(filter: { status?: string; from?: string; source?: string; before?: number; thread_id?: string }): { deleted: number; audited: boolean } {
    const audit = this.getAuditConfig()
    let audited = false
    let deleted = 0

    this.db.transaction(() => {
      if (audit.inbox) {
        const rows = this.db.getInboxByFilter(filter)
        if (rows.length > 0) {
          const json = JSON.stringify(rows)
          const compressed = brotliCompressSync(Buffer.from(json, 'utf-8'))
          this.db.insertAudit(
            'inbox',
            Math.min(...rows.map(r => r.received_at)),
            Math.max(...rows.map(r => r.received_at)),
            rows.length,
            json.length,
            compressed
          )
          audited = true
        }
      }
      deleted = this.db.deleteInboxByFilter(filter)
    })

    return { deleted, audited }
  }

  deleteOutboxByFilter(filter: { status?: string; to?: string; before?: number; thread_id?: string }): { deleted: number; audited: boolean } {
    const audit = this.getAuditConfig()
    let audited = false
    let deleted = 0

    this.db.transaction(() => {
      if (audit.outbox) {
        const rows = this.db.getOutboxByFilter(filter)
        if (rows.length > 0) {
          const json = JSON.stringify(rows)
          const compressed = brotliCompressSync(Buffer.from(json, 'utf-8'))
          this.db.insertAudit(
            'outbox',
            Math.min(...rows.map(r => r.created_at)),
            Math.max(...rows.map(r => r.created_at)),
            rows.length,
            json.length,
            compressed
          )
          audited = true
        }
      }
      deleted = this.db.deleteOutboxByFilter(filter)
    })

    return { deleted, audited }
  }

  /**
   * Audit a single message at ingestion/send time.
   * Stores the full message JSON (with inline attachment data) as a brotli-compressed blob.
   */
  auditMessage(source: 'inbox' | 'outbox', messageJson: string, timestamp: number): void {
    const audit = this.getAuditConfig()
    if (source === 'inbox' && !audit.inbox) return
    if (source === 'outbox' && !audit.outbox) return

    const compressed = brotliCompressSync(Buffer.from(messageJson, 'utf-8'))
    this.db.insertAudit(
      `${source}_message`,
      timestamp,
      timestamp,
      1,
      messageJson.length,
      compressed
    )
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

  addToInbox(msg: Omit<InboxMessage, 'id'>): string {
    const id = this.db.addInboxMessage(msg)
    try {
      // Lazy import to avoid circular dep (runtime depends on workspace).
      const { emitUmbilicalEvent } = require('../runtime/emit-umbilical') as typeof import('../runtime/emit-umbilical')
      emitUmbilicalEvent({
        event_type: 'message.received',
        payload: {
          message_id: id,
          from: msg.from,
          content_type: msg.content_type ?? null,
          size: msg.content ? Buffer.byteLength(msg.content, 'utf-8') : 0,
        }
      })
    } catch { /* emit is best-effort */ }
    return id
  }

  updateInboxStatus(id: string, status: InboxStatus): void {
    this.db.updateInboxStatus(id, status)
  }

  archiveAllInbox(): number {
    return this.db.archiveAllInbox()
  }

  getUnreadCount(): number {
    return this.db.getUnreadInboxCount()
  }

  deleteInboxMessage(id: string): boolean {
    return this.db.deleteInboxMessage(id)
  }

  // ===========================================================================
  // Outbox
  // ===========================================================================

  getOutbox(status?: OutboxStatus): OutboxMessage[] {
    return this.db.getOutboxMessages(status)
  }

  addToOutbox(msg: Omit<OutboxMessage, 'id'>): string {
    return this.db.addOutboxMessage(msg)
  }

  updateOutboxStatus(id: string, status: OutboxStatus, deliveredAt?: number): void {
    this.db.updateOutboxStatus(id, status, deliveredAt)
    this.emitOutboxTerminalStatus(id, status)
  }

  updateOutboxDeliveryFull(id: string, status: OutboxStatus, statusCode: number | null, deliveredAt: number | null): void {
    this.db.updateOutboxDeliveryFull(id, status, statusCode, deliveredAt)
    this.emitOutboxTerminalStatus(id, status, statusCode)
  }

  private emitOutboxTerminalStatus(id: string, status: OutboxStatus, statusCode?: number | null): void {
    if (status !== 'delivered' && status !== 'failed') return
    try {
      const { emitUmbilicalEvent } = require('../runtime/emit-umbilical') as typeof import('../runtime/emit-umbilical')
      emitUmbilicalEvent({
        event_type: status === 'delivered' ? 'message.sent' : 'message.delivery_failed',
        payload: { message_id: id, status_code: statusCode ?? null }
      })
    } catch { /* emit is best-effort */ }
  }

  updateOutboxMeta(id: string, meta: Record<string, unknown>): void {
    this.db.updateOutboxMeta(id, meta)
  }

  findOutboxByMetaValue(jsonKey: string, value: unknown): string | null {
    return this.db.findOutboxByMetaValue(jsonKey, value)
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
      llmMessages: loopEntries.map(e => ({ role: e.role, content: e.content_json }))
    }
  }

  writeChat(_data: { version: number; uiLog: any[]; llmMessages: any[] }): void {
    console.warn('[AdfWorkspace] writeChat is deprecated, loop is managed by AgentSession')
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

  renewTimer(
    schedule: TimerSchedule, nextWakeAt: number,
    payload: string | undefined, scope: string[],
    lambda: string | undefined, warm: boolean | undefined,
    runCount: number, createdAt: number, lastFiredAt: number,
    locked?: boolean
  ): number {
    return this.db.renewTimer(schedule, nextWakeAt, payload, scope, lambda, warm, runCount, createdAt, lastFiredAt, locked)
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

  getExpiredTimers(): Timer[] {
    return this.db.getExpiredTimers()
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

    const level: FileProtectionLevel = protection ??
      (relativePath === 'mind.md' || relativePath.startsWith('document.') ? 'no_delete' : 'none')
    this.db.writeFile(
      relativePath,
      Buffer.from(content, 'utf-8'),
      this.getMimeType(relativePath),
      level
    )
  }

  writeFileBuffer(relativePath: string, content: Buffer, mimeType?: string): void {

    const protection: FileProtectionLevel =
      relativePath === 'mind.md' || relativePath.startsWith('document.') ? 'no_delete' : 'none'
    this.db.writeFile(relativePath, content, mimeType, protection)
  }

  deleteFile(relativePath: string): boolean {

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
          const now = Date.now()
          this.db.insertAudit('file', now, now, 1, json.length, compressed)
        }
        deleted = this.db.deleteFile(relativePath)
      })
      return deleted
    }
    return this.db.deleteFile(relativePath)
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
    return this.db.renameFile(oldPath, newPath)
  }

  renameFolder(oldPrefix: string, newPrefix: string): number {
    return this.db.renameFolder(oldPrefix, newPrefix)
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

  insertTask(id: string, tool: string, args: string, origin?: string, requiresAuthorization?: boolean, executorManaged?: boolean): void {
    this.db.insertTask(id, tool, args, origin, requiresAuthorization, executorManaged)
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
    return this.db.dropLocalTable(name)
  }

  querySQL(sql: string, params?: unknown[]): unknown[] {
    return this.db.querySQL(sql, params)
  }

  executeSQL(sql: string, params?: unknown[]): { changes: number } {
    return this.db.executeSQL(sql, params)
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  private startAutoCheckpoint(): void {
    this.autoCheckpointTimer = setInterval(() => {
      try {
        this.db.checkpointPassive()
      } catch {
        // DB may be closed during shutdown — ignore
      }
    }, AdfWorkspace.AUTO_CHECKPOINT_MS)
    this.autoCheckpointTimer.unref()
  }

  checkpoint(): void {
    this.db.checkpoint()
  }

  close(): void {
    if (this.autoCheckpointTimer) {
      clearInterval(this.autoCheckpointTimer)
      this.autoCheckpointTimer = null
    }
    this.db.checkpoint()
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
