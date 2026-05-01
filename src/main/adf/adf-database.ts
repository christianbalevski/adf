/**
 * ADF Database Layer
 *
 * SQLite wrapper for .adf files implementing the v0.2 specification.
 * All persistence operations go through this class.
 */

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { nanoid as _nanoid } from 'nanoid'

/** Short 10-char IDs — sufficient for per-agent uniqueness */
const nanoid = () => _nanoid(10)
import { existsSync, unlinkSync, renameSync, copyFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import type { ContentBlock } from '../../shared/types/provider.types'
import type {
  AgentConfig,
  StoredAttachment,
  CreateAgentOptions,
  LoopEntry,
  LoopTokenUsage,
  InboxMessage,
  OutboxMessage,
  Timer,
  TimerSchedule,
  FileEntry,
  FileProtectionLevel,
  MetaProtectionLevel,
  InboxStatus,
  OutboxStatus,
  TaskEntry,
  TaskStatus,
  TriggersConfigV3,
  TriggerTypeV3
} from '../../shared/types/adf-v02.types'
import {
  AGENT_DEFAULTS as defaults,
  DEFAULT_TOOLS as defaultTools,
  getDefaultDocumentContent,
  DEFAULT_MIND_CONTENT
} from '../../shared/types/adf-v02.types'
import {
  decrypt
} from '../crypto/identity-crypto'

export interface IdentityRow {
  purpose: string
  value: Buffer
  encryption_algo: string
  salt: Buffer | null
  kdf_params: string | null
}

export interface AdfBootStatus {
  autostart: boolean
  agentId: string
  hasEncryptedIdentity: boolean
}

export interface AdfBootStatusResult {
  status: AdfBootStatus | null
  error?: string
}

/** Derive a URL-safe handle from a name: lowercase, non-alphanumeric → hyphens, collapse runs, trim. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
}

// =============================================================================
// Schema SQL (v0.2 - all tables prefixed with adf_)
// =============================================================================

const SCHEMA_SQL = `
-- 1. Format metadata & schema versioning
CREATE TABLE IF NOT EXISTS adf_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT 'none' CHECK(protection IN ('none','readonly','increment'))
);

-- 2. Agent configuration (single row)
CREATE TABLE IF NOT EXISTS adf_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Agent processing loop (LLM conversation history)
CREATE TABLE IF NOT EXISTS adf_loop (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  model TEXT,
  tokens TEXT,
  created_at INTEGER NOT NULL
);

-- 4. Received messages (ALF)
CREATE TABLE IF NOT EXISTS adf_inbox (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT,
  reply_to TEXT,
  network TEXT DEFAULT 'devnet',
  thread_id TEXT,
  parent_id TEXT,
  subject TEXT,
  content TEXT NOT NULL,
  content_type TEXT,
  attachments TEXT,
  meta TEXT,
  sender_alias TEXT,
  recipient_alias TEXT,
  owner TEXT,
  card TEXT,
  return_path TEXT,
  source TEXT DEFAULT 'mesh',
  source_context TEXT,
  sent_at INTEGER,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  original_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_status ON adf_inbox(status);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_received ON adf_inbox(received_at);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_thread ON adf_inbox(thread_id);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_from ON adf_inbox("from");
CREATE INDEX IF NOT EXISTS idx_adf_inbox_source ON adf_inbox(source);
CREATE INDEX IF NOT EXISTS idx_adf_inbox_message_id ON adf_inbox(message_id);

-- 5. Sent messages (ALF)
CREATE TABLE IF NOT EXISTS adf_outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  address TEXT DEFAULT '',
  reply_to TEXT,
  network TEXT DEFAULT 'devnet',
  thread_id TEXT,
  parent_id TEXT,
  subject TEXT,
  content TEXT NOT NULL,
  content_type TEXT,
  attachments TEXT,
  meta TEXT,
  sender_alias TEXT,
  recipient_alias TEXT,
  owner TEXT,
  card TEXT,
  return_path TEXT,
  status_code INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  original_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_adf_outbox_status ON adf_outbox(status);
CREATE INDEX IF NOT EXISTS idx_adf_outbox_thread ON adf_outbox(thread_id);
CREATE INDEX IF NOT EXISTS idx_adf_outbox_message_id ON adf_outbox(message_id);

-- 6. Scheduled wake events
CREATE TABLE IF NOT EXISTS adf_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_json TEXT NOT NULL,
  next_wake_at INTEGER NOT NULL,
  payload TEXT,
  scope TEXT NOT NULL DEFAULT '["system"]',
  lambda TEXT,
  warm INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_fired_at INTEGER,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adf_timers_wake ON adf_timers(next_wake_at);

-- 7. All files (document, mind, and supporting files)
CREATE TABLE IF NOT EXISTS adf_files (
  path TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL,
  protection TEXT NOT NULL DEFAULT 'none' CHECK(protection IN ('read_only','no_delete','none')),
  authorized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. Audit storage (compressed snapshots of cleared loop/inbox/outbox data)
CREATE TABLE IF NOT EXISTS adf_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adf_audit_source ON adf_audit(source);

-- 9. Identity / key storage (schema only, no auth logic yet)
CREATE TABLE IF NOT EXISTS adf_identity (
  purpose TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  encryption_algo TEXT DEFAULT 'plain',
  salt BLOB,
  kdf_params TEXT,
  code_access INTEGER NOT NULL DEFAULT 0
);

-- 10. Tasks (async tool interception)
CREATE TABLE IF NOT EXISTS adf_tasks (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  origin TEXT,
  requires_authorization INTEGER NOT NULL DEFAULT 0,
  executor_managed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adf_tasks_status ON adf_tasks(status);

-- 11. Structured log
CREATE TABLE IF NOT EXISTS adf_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  origin TEXT,
  event TEXT,
  target TEXT,
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adf_logs_level ON adf_logs(level);
CREATE INDEX IF NOT EXISTS idx_adf_logs_origin ON adf_logs(origin);

`

// =============================================================================
// AdfDatabase Class
// =============================================================================

export class AdfDatabase {
  private db: Database.Database
  private filePath: string
  private closed = false

  // Per-file open-connection count. Keyed by canonicalized absolute path so that
  // the foreground + any background agents that open the same .adf share a
  // single refcount. close() only unlinks -shm/-wal when the last connection
  // for a given file releases — otherwise Windows hits EBUSY on unlink.
  private static openCounts = new Map<string, number>()

  private static canonicalKey(filePath: string): string {
    const abs = resolve(filePath)
    // Windows + macOS default filesystems are case-insensitive; Linux ext4 is not.
    return process.platform === 'linux' ? abs : abs.toLowerCase()
  }

  private static incrementOpen(filePath: string): void {
    const key = AdfDatabase.canonicalKey(filePath)
    AdfDatabase.openCounts.set(key, (AdfDatabase.openCounts.get(key) ?? 0) + 1)
  }

  /** Returns the remaining open count after decrementing. */
  private static decrementOpen(filePath: string): number {
    const key = AdfDatabase.canonicalKey(filePath)
    const next = (AdfDatabase.openCounts.get(key) ?? 1) - 1
    if (next <= 0) {
      AdfDatabase.openCounts.delete(key)
      return 0
    }
    AdfDatabase.openCounts.set(key, next)
    return next
  }

  // Prepared statements (cached for performance)
  private stmts: {
    getMeta?: Database.Statement
    setMeta?: Database.Statement
    deleteMeta?: Database.Statement
    getAllMeta?: Database.Statement
    getMetaProtection?: Database.Statement
    setMetaProtection?: Database.Statement
    getConfig?: Database.Statement
    setConfig?: Database.Statement
    getLoopEntries?: Database.Statement
    getLoopEntriesLimited?: Database.Statement
    appendLoopEntry?: Database.Statement
    clearLoop?: Database.Statement
    getLoopCount?: Database.Statement
    getLastAssistantTokens?: Database.Statement
    getInboxMessages?: Database.Statement
    getInboxByStatus?: Database.Statement
    addInboxMessage?: Database.Statement
    updateInboxStatus?: Database.Statement
    getOutboxMessages?: Database.Statement
    getOutboxByStatus?: Database.Statement
    addOutboxMessage?: Database.Statement
    updateOutboxStatus?: Database.Statement
    getTimers?: Database.Statement
    addTimer?: Database.Statement
    renewTimer?: Database.Statement
    updateTimer?: Database.Statement
    deleteTimer?: Database.Statement
    getExpiredTimers?: Database.Statement
    readFile?: Database.Statement
    writeFile?: Database.Statement
    updateFile?: Database.Statement
    deleteFile?: Database.Statement
    listFiles?: Database.Statement
    fileExists?: Database.Statement
    getDocumentFile?: Database.Statement
    renameFile?: Database.Statement
    setFileProtection?: Database.Statement
    getFileProtection?: Database.Statement
    getFileAuthorized?: Database.Statement
    setFileAuthorized?: Database.Statement
    getIdentity?: Database.Statement
    setIdentity?: Database.Statement
    deleteIdentity?: Database.Statement
    listIdentityByPrefix?: Database.Statement
    getIdentityFull?: Database.Statement
    getAllIdentityFull?: Database.Statement
    hasEncryptedIdentity?: Database.Statement
    setIdentityRaw?: Database.Statement
    updateOutboxDelivery?: Database.Statement
    updateOutboxDeliveryFull?: Database.Statement
    updateOutboxMeta?: Database.Statement
    findOutboxByMetaValue?: Database.Statement
    // Audit
    insertAudit?: Database.Statement
    getAuditById?: Database.Statement
    listAudits?: Database.Statement
    // Loop slice operations
    getLoopSeqs?: Database.Statement
    getLoopEntriesBySeqRange?: Database.Statement
    deleteLoopBySeqRange?: Database.Statement
    // Tasks
    insertTask?: Database.Statement
    getTask?: Database.Statement
    updateTaskStatus?: Database.Statement
    setTaskRequiresAuthorization?: Database.Statement
    getTasksByStatus?: Database.Statement
    getAllTasks?: Database.Statement
    // Logs
    insertLog?: Database.Statement
    getLogs?: Database.Statement
    getLogsAfterId?: Database.Statement
    clearLogs?: Database.Statement
    trimLogs?: Database.Statement
    countLogs?: Database.Statement
  } = {}

  private constructor(db: Database.Database, filePath: string) {
    this.db = db
    this.filePath = filePath
    AdfDatabase.incrementOpen(filePath)
    this.applyPragmas()
    this.prepareStatements()
  }

  // ===========================================================================
  // Static Factory Methods
  // ===========================================================================

  /**
   * Attempt to repair a corrupt SQLite database using VACUUM INTO to create
   * a clean copy, then swap it in place. Returns true if repair succeeded.
   */
  private static tryRepair(filePath: string): boolean {
    const backupPath = filePath + '.corrupt'
    const repairedPath = filePath + '.repaired'

    try {
      const corruptDb = new Database(filePath)

      try {
        // VACUUM INTO creates a clean, defragmented copy of the database
        corruptDb.exec(`VACUUM INTO '${repairedPath.replace(/'/g, "''")}'`)
        corruptDb.close()
      } catch {
        corruptDb.close()
        try { unlinkSync(repairedPath) } catch { /* ignore */ }
        return false
      }

      // Swap: corrupt → backup, repaired → original
      renameSync(filePath, backupPath)
      // Move WAL/SHM files with the corrupt backup
      for (const ext of ['-wal', '-shm']) {
        if (existsSync(filePath + ext)) {
          renameSync(filePath + ext, backupPath + ext)
        }
      }
      renameSync(repairedPath, filePath)

      console.log(`[AdfDatabase] Repair succeeded. Corrupt backup at: ${backupPath}`)
      return true
    } catch (error) {
      console.error('[AdfDatabase] Repair failed:', error)
      try { unlinkSync(repairedPath) } catch { /* ignore */ }
      return false
    }
  }

  /**
   * Create a backup of the database file before a destructive operation.
   * Checkpoints WAL first so the .bak file is self-contained.
   */
  static backupBeforeDestructive(db: Database.Database, filePath: string): string {
    const backupPath = filePath + '.bak'
    try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* BUSY fallback — copy anyway */ }
    copyFileSync(filePath, backupPath)
    return backupPath
  }

  /** Remove a transient .bak file after a successful destructive operation. */
  static removeBackup(filePath: string): void {
    try { unlinkSync(filePath + '.bak') } catch { /* already gone */ }
  }

  /**
   * Clean up closed SQLite WAL sidecars in a directory.
   * Opens each .adf database, checkpoints WAL back into the main file, then closes
   * before deleting any leftover sidecars. Files in `skipPaths` are left untouched.
   */
  static cleanupOrphanedWalFiles(directory: string, skipPaths?: Set<string>): void {
    let entries: string[]
    try { entries = readdirSync(directory) } catch { return }

    const adfPaths = new Set<string>()
    for (const entry of entries) {
      if (entry.endsWith('.adf-wal') || entry.endsWith('.adf-shm')) {
        adfPaths.add(join(directory, entry.slice(0, -4))) // strip '-wal' or '-shm'
      }
    }

    for (const adfPath of adfPaths) {
      if (skipPaths?.has(adfPath)) continue

      const walPath = `${adfPath}-wal`
      const shmPath = adfPath + '-shm'

      if (!existsSync(adfPath)) {
        // .adf is gone — just delete the orphaned journal files
        try { unlinkSync(walPath) } catch { /* ignore */ }
        try { unlinkSync(shmPath) } catch { /* ignore */ }
        continue
      }

      try {
        // Open triggers WAL replay; TRUNCATE checkpoint writes it back to the main DB
        const db = new Database(adfPath)
        try { db.pragma('wal_checkpoint(TRUNCATE)') } finally { db.close() }
        // Delete files in case checkpoint didn't fully remove them
        try { if (existsSync(walPath)) unlinkSync(walPath) } catch { /* ignore */ }
        try { if (existsSync(shmPath)) unlinkSync(shmPath) } catch { /* ignore */ }
      } catch {
        // DB can't be opened (corrupt, locked, or owned by another process).
        // Leave sidecars alone rather than deleting files that SQLite may still own.
      }
    }
  }

  static open(filePath: string): AdfDatabase {
    let db = new Database(filePath)
    let needsMigration = false

    // Check database integrity and attempt auto-repair if corrupt
    try {
      const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>
      const status = result[0]?.integrity_check
      if (status !== 'ok') {
        console.warn(`[AdfDatabase] Integrity check failed: ${status}`)
        db.close()

        if (AdfDatabase.tryRepair(filePath)) {
          db = new Database(filePath)
          // Verify repair succeeded
          const recheck = db.pragma('integrity_check') as Array<{ integrity_check: string }>
          if (recheck[0]?.integrity_check !== 'ok') {
            db.close()
            throw new Error(
              `ADF file is corrupt and auto-repair failed. ` +
              `A backup was saved at: ${filePath}.corrupt`
            )
          }
          console.log('[AdfDatabase] Repaired database passed integrity check')
        } else {
          throw new Error(
            `ADF file is corrupt and could not be repaired. ` +
            `Please delete and recreate the file.`
          )
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('ADF file is corrupt')) {
        throw error
      }
      // If integrity check itself fails, the DB may be very corrupt
      console.warn('[AdfDatabase] Integrity check threw:', error)
      db.close()

      if (AdfDatabase.tryRepair(filePath)) {
        db = new Database(filePath)
      } else {
        throw new Error(
          `ADF file is corrupt and could not be repaired. ` +
          `Please delete and recreate the file.`
        )
      }
    }

    // Verify this is a v0.2 ADF file
    try {
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='adf_meta'"
      ).get() as { name: string } | undefined

      if (!tableCheck) {
        db.close()
        throw new Error(
          'This ADF file does not have the v0.2 schema. ' +
          'Please delete and recreate the file.'
        )
      }

      // Backup before migrations if schema is outdated
      const currentSv = (() => {
        const r = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
        if (r) return parseInt(r.value, 10)
        const r2 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
        return r2 ? parseInt(r2.value, 10) : 0
      })()
      needsMigration = currentSv < 16
      if (needsMigration) {
        try {
          AdfDatabase.backupBeforeDestructive(db, filePath)
          console.log(`[AdfDatabase] Backup created before migration (v${currentSv} → v16): ${filePath}.bak`)
        } catch (e) {
          console.warn('[AdfDatabase] Could not create pre-migration backup:', e)
        }
      }

      // Migrate adf_loop: add model, tokens, created_at columns if missing
      const cols = db.prepare('PRAGMA table_info(adf_loop)').all() as Array<{ name: string }>
      const colNames = new Set(cols.map(c => c.name))
      if (!colNames.has('created_at')) {
        db.exec('ALTER TABLE adf_loop ADD COLUMN model TEXT')
        db.exec('ALTER TABLE adf_loop ADD COLUMN tokens INTEGER')
        db.exec('ALTER TABLE adf_loop ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0')
      }

      // Migrate: drop old adf_archive table, add adf_audit table if missing
      db.exec('DROP TABLE IF EXISTS adf_archive')
      const auditCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='adf_audit'"
      ).get() as { name: string } | undefined
      if (!auditCheck) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            entry_count INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            data BLOB NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_adf_audit_source ON adf_audit(source);
        `)
      }

      // Migrate adf_files: protected INTEGER → protection TEXT
      const fileCols = db.prepare('PRAGMA table_info(adf_files)').all() as Array<{ name: string }>
      const fileColNames = new Set(fileCols.map(c => c.name))
      if (fileColNames.has('protected') && !fileColNames.has('protection')) {
        db.exec("ALTER TABLE adf_files ADD COLUMN protection TEXT NOT NULL DEFAULT 'none' CHECK(protection IN ('read_only','no_delete','none'))")
        db.exec("UPDATE adf_files SET protection = CASE WHEN protected = 1 THEN 'no_delete' ELSE 'none' END")
        console.log('[AdfDatabase] Migrated adf_files: protected → protection')
      }

      // Migrate config: strip allow_protected_writes from stored config JSON
      try {
        const cfgRow = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
        if (cfgRow) {
          const cfg = JSON.parse(cfgRow.config_json)
          if (cfg.security && 'allow_protected_writes' in cfg.security) {
            delete cfg.security.allow_protected_writes
            db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
            console.log('[AdfDatabase] Stripped allow_protected_writes from config')
          }
        }
      } catch { /* config migration is best-effort */ }

      // Migrate schema v3 → v4: unified inbox/outbox schema
      const sv = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv?.value === '3') {
        db.exec('DROP TABLE IF EXISTS adf_inbox')
        db.exec('DROP TABLE IF EXISTS adf_outbox')
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_inbox (
            id TEXT PRIMARY KEY,
            sender TEXT NOT NULL,
            sender_name TEXT,
            trace_id TEXT,
            parent_id TEXT,
            intent TEXT,
            payload TEXT NOT NULL,
            attachments TEXT,
            source TEXT NOT NULL DEFAULT 'mesh',
            source_meta TEXT,
            header TEXT,
            signature BLOB,
            sent_at INTEGER,
            received_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'unread'
          );
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_status ON adf_inbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_received ON adf_inbox(received_at);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_trace ON adf_inbox(trace_id);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_source ON adf_inbox(source);

          CREATE TABLE IF NOT EXISTS adf_outbox (
            id TEXT PRIMARY KEY,
            recipient TEXT NOT NULL,
            recipient_name TEXT,
            trace_id TEXT,
            parent_id TEXT,
            intent TEXT,
            payload TEXT NOT NULL,
            attachments TEXT,
            source TEXT NOT NULL DEFAULT 'mesh',
            source_meta TEXT,
            header TEXT,
            signature BLOB,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            status TEXT NOT NULL DEFAULT 'pending'
          );
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_status ON adf_outbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_trace ON adf_outbox(trace_id);
        `)
        db.prepare("UPDATE adf_meta SET value = '4' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v3 → v4 (unified inbox/outbox)')
      }

      // Migrate schema v4 → v5: trigger spec v3, adf_tasks, adf_logs
      const sv5 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv5?.value === '4') {
        // Add adf_tasks table
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_tasks (
            id TEXT PRIMARY KEY,
            tool TEXT NOT NULL,
            args TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            result TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            origin TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_adf_tasks_status ON adf_tasks(status);
        `)
        // Add adf_logs table
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            level TEXT NOT NULL DEFAULT 'info',
            origin TEXT,
            event TEXT,
            target TEXT,
            message TEXT NOT NULL,
            data TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_adf_logs_level ON adf_logs(level);
          CREATE INDEX IF NOT EXISTS idx_adf_logs_origin ON adf_logs(origin);
        `)
        // Fix timer scopes: document → system
        db.exec("UPDATE adf_timers SET scope = 'system' WHERE scope = 'document'")

        db.prepare("UPDATE adf_meta SET value = '5' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v4 → v5 (trigger v3, tasks, logs)')
      }


      // Migrate schema v5 → v6: timer lambda column, scope as JSON array
      const sv6 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv6?.value === '5') {
        // Add lambda column to adf_timers
        const timerCols = db.prepare('PRAGMA table_info(adf_timers)').all() as Array<{ name: string }>
        const timerColNames = new Set(timerCols.map(c => c.name))
        if (!timerColNames.has('lambda')) {
          db.exec('ALTER TABLE adf_timers ADD COLUMN lambda TEXT')
        }
        if (!timerColNames.has('warm')) {
          db.exec('ALTER TABLE adf_timers ADD COLUMN warm INTEGER NOT NULL DEFAULT 0')
        }
        // Migrate scope from single string to JSON array
        // e.g. 'agent' → '["agent"]', 'system' → '["system"]'
        const timers = db.prepare('SELECT id, scope FROM adf_timers').all() as Array<{ id: number; scope: string }>
        for (const t of timers) {
          try { JSON.parse(t.scope); continue } catch { /* not JSON yet, migrate */ }
          db.prepare('UPDATE adf_timers SET scope = ? WHERE id = ?').run(JSON.stringify([t.scope]), t.id)
        }
        db.prepare("UPDATE adf_meta SET value = '6' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v5 → v6 (timer lambda, scope array)')
      }

      // Migrate schema v6 → v7: unified inbox/outbox with DID+address protocol
      const sv7 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv7?.value === '6') {
        db.exec('DROP TABLE IF EXISTS adf_inbox')
        db.exec('DROP TABLE IF EXISTS adf_outbox')
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_inbox (
            id TEXT PRIMARY KEY,
            sender TEXT NOT NULL,
            reply_to TEXT,
            trace_id TEXT,
            parent_id TEXT,
            intent TEXT,
            payload TEXT NOT NULL,
            attachments TEXT,
            source TEXT NOT NULL DEFAULT 'mesh',
            source_meta TEXT,
            header TEXT,
            signature BLOB,
            sent_at INTEGER,
            received_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'unread'
          );
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_status ON adf_inbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_received ON adf_inbox(received_at);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_trace ON adf_inbox(trace_id);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_source ON adf_inbox(source);

          CREATE TABLE IF NOT EXISTS adf_outbox (
            id TEXT PRIMARY KEY,
            recipient TEXT NOT NULL,
            address TEXT NOT NULL DEFAULT '',
            trace_id TEXT,
            parent_id TEXT,
            intent TEXT,
            payload TEXT NOT NULL,
            attachments TEXT,
            source TEXT NOT NULL,
            source_meta TEXT,
            header TEXT,
            signature BLOB,
            status_code INTEGER,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            status TEXT NOT NULL DEFAULT 'pending'
          );
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_status ON adf_outbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_trace ON adf_outbox(trace_id);
        `)
        db.prepare("UPDATE adf_meta SET value = '7' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v6 → v7 (DID+address inbox/outbox)')
      }

      // Migrate schema v7 → v8: ALF envelope inbox/outbox
      const sv8 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv8?.value === '7') {
        db.exec('DROP TABLE IF EXISTS adf_inbox')
        db.exec('DROP TABLE IF EXISTS adf_outbox')
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_inbox (
            id TEXT PRIMARY KEY,
            "from" TEXT NOT NULL,
            "to" TEXT,
            reply_to TEXT,
            network TEXT DEFAULT 'devnet',
            thread_id TEXT,
            parent_id TEXT,
            subject TEXT,
            content TEXT NOT NULL,
            attachments TEXT,
            meta TEXT,
            sender_alias TEXT,
            recipient_alias TEXT,
            source TEXT DEFAULT 'mesh',
            source_context TEXT,
            sent_at INTEGER,
            received_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'unread',
            envelope TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_status ON adf_inbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_received ON adf_inbox(received_at);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_thread ON adf_inbox(thread_id);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_from ON adf_inbox("from");
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_source ON adf_inbox(source);

          CREATE TABLE IF NOT EXISTS adf_outbox (
            id TEXT PRIMARY KEY,
            "from" TEXT NOT NULL,
            "to" TEXT NOT NULL,
            address TEXT DEFAULT '',
            reply_to TEXT,
            network TEXT DEFAULT 'devnet',
            thread_id TEXT,
            parent_id TEXT,
            subject TEXT,
            content TEXT NOT NULL,
            attachments TEXT,
            meta TEXT,
            sender_alias TEXT,
            recipient_alias TEXT,
            status_code INTEGER,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            envelope TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_status ON adf_outbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_thread ON adf_outbox(thread_id);
        `)
        db.prepare("UPDATE adf_meta SET value = '8' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v7 → v8 (ALF envelope inbox/outbox)')
      }

      // Migrate schema v8 → v9: adf_peers table
      const sv9 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv9?.value === '8') {
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_peers (
            did TEXT PRIMARY KEY,
            alias TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            icon TEXT,
            address TEXT NOT NULL DEFAULT '',
            network TEXT DEFAULT 'devnet',
            public_key TEXT,
            endpoints TEXT,
            mesh_routes TEXT,
            capabilities TEXT,
            source TEXT NOT NULL DEFAULT 'mesh',
            last_seen_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            meta TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_adf_peers_alias ON adf_peers(alias);
        `)
        db.prepare("UPDATE adf_meta SET value = '9' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v8 → v9 (adf_peers)')
      }

      // Migrate schema v9 → v10: AlfMessage inbox/outbox (new columns, envelope→original_message)
      const sv10 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv10?.value === '9') {
        db.exec('DROP TABLE IF EXISTS adf_inbox')
        db.exec('DROP TABLE IF EXISTS adf_outbox')
        db.exec(`
          CREATE TABLE IF NOT EXISTS adf_inbox (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            "from" TEXT NOT NULL,
            "to" TEXT,
            reply_to TEXT,
            network TEXT DEFAULT 'devnet',
            thread_id TEXT,
            parent_id TEXT,
            subject TEXT,
            content TEXT NOT NULL,
            content_type TEXT,
            attachments TEXT,
            meta TEXT,
            sender_alias TEXT,
            recipient_alias TEXT,
            owner TEXT,
            card TEXT,
            return_path TEXT,
            source TEXT DEFAULT 'mesh',
            source_context TEXT,
            sent_at INTEGER,
            received_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'unread',
            original_message TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_status ON adf_inbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_received ON adf_inbox(received_at);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_thread ON adf_inbox(thread_id);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_from ON adf_inbox("from");
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_source ON adf_inbox(source);
          CREATE INDEX IF NOT EXISTS idx_adf_inbox_message_id ON adf_inbox(message_id);

          CREATE TABLE IF NOT EXISTS adf_outbox (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            "from" TEXT NOT NULL,
            "to" TEXT NOT NULL,
            address TEXT DEFAULT '',
            reply_to TEXT,
            network TEXT DEFAULT 'devnet',
            thread_id TEXT,
            parent_id TEXT,
            subject TEXT,
            content TEXT NOT NULL,
            content_type TEXT,
            attachments TEXT,
            meta TEXT,
            sender_alias TEXT,
            recipient_alias TEXT,
            owner TEXT,
            card TEXT,
            return_path TEXT,
            status_code INTEGER,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            original_message TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_status ON adf_outbox(status);
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_thread ON adf_outbox(thread_id);
          CREATE INDEX IF NOT EXISTS idx_adf_outbox_message_id ON adf_outbox(message_id);
        `)
        db.prepare("UPDATE adf_meta SET value = '10' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v9 → v10 (AlfMessage inbox/outbox)')
      }

      // Migrate schema v10 → v11: agent card spec update (alias→handle, drop capabilities, add policies/resolution)
      const sv11 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv11?.value === '10') {
        const peerCols = db.prepare('PRAGMA table_info(adf_peers)').all() as Array<{ name: string }>
        const colNames = peerCols.map(c => c.name)

        // Rename alias → handle
        if (colNames.includes('alias') && !colNames.includes('handle')) {
          db.exec('ALTER TABLE adf_peers RENAME COLUMN alias TO handle')
        }
        // Add resolution column
        if (!colNames.includes('resolution')) {
          db.exec('ALTER TABLE adf_peers ADD COLUMN resolution TEXT')
        }
        // Add policies column
        if (!colNames.includes('policies')) {
          db.exec('ALTER TABLE adf_peers ADD COLUMN policies TEXT')
        }
        // Drop old index on alias, create new one on handle
        db.exec('DROP INDEX IF EXISTS idx_adf_peers_alias')
        db.exec('CREATE INDEX IF NOT EXISTS idx_adf_peers_handle ON adf_peers(handle)')

        db.prepare("UPDATE adf_meta SET value = '11' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v10 → v11 (agent card: alias→handle, policies, resolution)')
      }

      // Migrate schema v11 → v12: peers table — add via, trust, capabilities columns
      const sv12 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv12?.value === '11') {
        const peerCols12 = db.prepare('PRAGMA table_info(adf_peers)').all() as Array<{ name: string }>
        const colNames12 = peerCols12.map(c => c.name)

        if (!colNames12.includes('via')) {
          db.exec('ALTER TABLE adf_peers ADD COLUMN via TEXT')
        }
        if (!colNames12.includes('trust')) {
          db.exec("ALTER TABLE adf_peers ADD COLUMN trust TEXT NOT NULL DEFAULT 'unknown'")
        }
        if (!colNames12.includes('capabilities')) {
          db.exec('ALTER TABLE adf_peers ADD COLUMN capabilities TEXT')
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_adf_peers_via ON adf_peers(via)')

        db.prepare("UPDATE adf_meta SET value = '12' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v11 → v12 (peers: via, trust, capabilities)')
      }

      // Migrate schema v12 → v13: adf_identity code_access column
      const sv13 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv13?.value === '12') {
        const idCols = db.prepare('PRAGMA table_info(adf_identity)').all() as Array<{ name: string }>
        if (!idCols.some(c => c.name === 'code_access')) {
          db.exec('ALTER TABLE adf_identity ADD COLUMN code_access INTEGER NOT NULL DEFAULT 0')
        }
        db.prepare("UPDATE adf_meta SET value = '13' WHERE key = 'schema_version'").run()
        console.log('[AdfDatabase] Migrated schema v12 → v13 (identity: code_access)')
      }

      // Migrate schema v13 → v14: adf_meta key convention + identity_salt/kdf_params move
      const sv14 = db.prepare("SELECT value FROM adf_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      if (sv14?.value === '13') {
        const getMeta = (k: string) => (db.prepare('SELECT value FROM adf_meta WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null
        const setMeta = (k: string, v: string) => db.prepare('INSERT OR REPLACE INTO adf_meta (key, value) VALUES (?, ?)').run(k, v)
        const delMeta = (k: string) => db.prepare('DELETE FROM adf_meta WHERE key = ?').run(k)
        const renameMeta = (oldKey: string, newKey: string) => {
          const val = getMeta(oldKey)
          if (val !== null) { setMeta(newKey, val); delMeta(oldKey) }
        }

        db.transaction(() => {
          // Delete redundant format key
          delMeta('format')

          // Rename schema_version → adf_schema_version (with new value)
          delMeta('schema_version')
          setMeta('adf_schema_version', '14')

          // Rename identity keys
          renameMeta('did', 'adf_did')
          renameMeta('owner_did', 'adf_owner_did')
          renameMeta('runtime_did', 'adf_runtime_did')

          // Populate denormalized keys from agent_config
          const cfgRow = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
          if (cfgRow) {
            const cfg = JSON.parse(cfgRow.config_json)
            setMeta('adf_name', cfg.name ?? 'Untitled Agent')
            setMeta('adf_handle', cfg.handle ?? slugify(cfg.name ?? 'untitled-agent'))
            setMeta('adf_parent_did', '')
            setMeta('adf_created_at', cfg.metadata?.created_at ?? new Date().toISOString())
            setMeta('adf_updated_at', cfg.metadata?.updated_at ?? new Date().toISOString())
          }

          // Move identity_salt and identity_kdf_params to adf_identity rows
          const salt = getMeta('identity_salt')
          if (salt) {
            db.prepare("INSERT OR REPLACE INTO adf_identity (purpose, value, encryption_algo, code_access) VALUES (?, ?, 'plain', 0)")
              .run('crypto:kdf:salt', Buffer.from(salt, 'utf-8'))
            delMeta('identity_salt')
          }
          const kdfParams = getMeta('identity_kdf_params')
          if (kdfParams) {
            db.prepare("INSERT OR REPLACE INTO adf_identity (purpose, value, encryption_algo, code_access) VALUES (?, ?, 'plain', 0)")
              .run('crypto:kdf:params', Buffer.from(kdfParams, 'utf-8'))
            delMeta('identity_kdf_params')
          }

          // Default agent key
          setMeta('status', '')
        })()

        console.log('[AdfDatabase] Migrated schema v13 → v14 (adf_meta key convention)')
      }

      // Migrate schema v14 → v15: adf_meta protection levels
      const sv15 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv15?.value === '14') {
        db.transaction(() => {
          db.exec("ALTER TABLE adf_meta ADD COLUMN protection TEXT NOT NULL DEFAULT 'none' CHECK(protection IN ('none','readonly','increment'))")
          db.exec("UPDATE adf_meta SET protection = 'readonly' WHERE key LIKE 'adf_%'")
          db.prepare("UPDATE adf_meta SET value = '15' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v14 → v15 (meta protection levels)')
      }

      // Migrate schema v15 → v16: timer locking
      const sv16 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv16?.value === '15') {
        db.transaction(() => {
          db.exec('ALTER TABLE adf_timers ADD COLUMN locked INTEGER NOT NULL DEFAULT 0')
          db.prepare("UPDATE adf_meta SET value = '16' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v15 → v16 (timer locking)')
      }

      // Migrate schema v16 → v17: file authorization
      const sv17 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv17?.value === '16') {
        db.transaction(() => {
          db.exec('ALTER TABLE adf_files ADD COLUMN authorized INTEGER NOT NULL DEFAULT 0')
          db.prepare("UPDATE adf_meta SET value = '17' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v16 → v17 (file authorization)')
      }

      // Migrate schema v17 → v18: task-level authorization
      const sv18 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv18?.value === '17') {
        db.transaction(() => {
          db.exec('ALTER TABLE adf_tasks ADD COLUMN requires_authorization INTEGER NOT NULL DEFAULT 0')
          db.prepare("UPDATE adf_meta SET value = '18' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v17 → v18 (task-level authorization)')
      }

      // Migrate schema v18 → v19: executor-managed tasks (HIL task-native)
      const sv19 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv19?.value === '18') {
        db.transaction(() => {
          db.exec('ALTER TABLE adf_tasks ADD COLUMN executor_managed INTEGER NOT NULL DEFAULT 0')
          db.prepare("UPDATE adf_meta SET value = '19' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v18 → v19 (executor-managed HIL tasks)')
      }

      // Migrate schema v19 → v20: consolidate require_approval + require_authorized → restricted
      const sv20 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv20?.value === '19') {
        db.transaction(() => {
          const cfgRow = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
          if (cfgRow) {
            const cfg = JSON.parse(cfgRow.config_json)
            const gatedMethods: string[] = cfg.security?.require_authorized ?? []

            // Migrate tools: require_approval → restricted, require_authorized items → restricted
            if (Array.isArray(cfg.tools)) {
              for (const tool of cfg.tools) {
                if (tool.require_approval || gatedMethods.includes(tool.name)) {
                  tool.restricted = true
                }
                delete tool.require_approval
              }
            }

            // Migrate code execution methods in require_authorized → restricted_methods
            const ceMethods = new Set(['model_invoke', 'sys_lambda', 'task_resolve', 'loop_inject', 'get_identity', 'set_identity', 'authorize_file'])
            const restrictedMethods = gatedMethods.filter(m => ceMethods.has(m))
            if (restrictedMethods.length > 0) {
              cfg.code_execution = cfg.code_execution ?? {}
              cfg.code_execution.restricted_methods = restrictedMethods
            }

            // Migrate MCP servers: require_approval → restricted
            if (cfg.mcp?.servers) {
              for (const server of cfg.mcp.servers) {
                if (server.require_approval) {
                  server.restricted = true
                }
                delete server.require_approval
              }
            }

            // Clean up old fields
            if (cfg.security) {
              delete cfg.security.require_authorized
            }

            db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
          }
          db.prepare("UPDATE adf_meta SET value = '20' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v19 → v20 (consolidated restricted access model)')
      }

      // Migrate schema v20 → v21: remove adf_peers subsystem
      const sv21 = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_schema_version'").get() as { value: string } | undefined
      if (sv21?.value === '20') {
        db.transaction(() => {
          db.exec('DROP INDEX IF EXISTS idx_adf_peers_handle')
          db.exec('DROP INDEX IF EXISTS idx_adf_peers_via')
          db.exec('DROP TABLE IF EXISTS adf_peers')
          db.prepare("UPDATE adf_meta SET value = '21' WHERE key = 'adf_schema_version'").run()
        })()
        console.log('[AdfDatabase] Migrated schema v20 → v21 (removed adf_peers subsystem)')
      }

      // Migrate container_exec → compute_exec in tool declarations
      try {
        const cfgRowCE = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
        if (cfgRowCE) {
          const cfgCE = JSON.parse(cfgRowCE.config_json)
          const ceIdx = cfgCE.tools?.findIndex((t: { name: string }) => t.name === 'container_exec')
          if (ceIdx >= 0) {
            cfgCE.tools[ceIdx].name = 'compute_exec'
            db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfgCE))
            console.log('[AdfDatabase] Migrated container_exec → compute_exec')
          }
        }
      } catch { /* best-effort */ }

      // Migrate legacy v1 trigger config shape to v3
      try {
        const cfgRow2 = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
        if (cfgRow2) {
          const cfg = JSON.parse(cfgRow2.config_json)
          if (cfg.triggers && (cfg.triggers.document || cfg.triggers.agent)) {
            cfg.triggers = {
              on_inbox: { enabled: true, targets: [{ scope: 'agent', interval_ms: 30000 }] },
              on_outbox: { enabled: false, targets: [] },
              on_file_change: { enabled: true, targets: [{ scope: 'agent', filter: { watch: 'document.*' }, debounce_ms: 2000 }] },
              on_chat: { enabled: true, targets: [{ scope: 'agent' }] },
              on_timer: { enabled: true, targets: [{ scope: 'system' }, { scope: 'agent' }] },
              on_tool_call: { enabled: false, targets: [] },
              on_task_complete: { enabled: false, targets: [] }
            }
            db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
            console.log('[AdfDatabase] Migrated trigger config v1 → v3')
          }
        }
      } catch { /* trigger migration is best-effort */ }

      // Migrations succeeded — remove transient backup
      if (needsMigration) {
        AdfDatabase.removeBackup(filePath)
      }
    } catch (error) {
      if (needsMigration) {
        console.error(`[AdfDatabase] Migration failed. Backup preserved at: ${filePath}.bak`)
      }
      db.close()
      throw error
    }

    return new AdfDatabase(db, filePath)
  }

  static create(
    filePath: string,
    options: CreateAgentOptions
  ): AdfDatabase {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      const shmPath = `${filePath}-shm`
      const walPath = `${filePath}-wal`
      if (existsSync(shmPath)) unlinkSync(shmPath)
      if (existsSync(walPath)) unlinkSync(walPath)
    }

    const db = new Database(filePath)
    db.exec(SCHEMA_SQL)

    const adfDb = new AdfDatabase(db, filePath)

    // Set meta values
    const now = new Date().toISOString()
    adfDb.setMeta('adf_version', '0.2', 'readonly')
    adfDb.setMeta('adf_schema_version', '21', 'readonly')

    const agentId = _nanoid(12)

    // Merge tools: if caller provided overrides, apply them on top of defaults
    let tools = [...defaultTools]
    if (options.tools) {
      const overrideMap = new Map(options.tools.map(t => [t.name, t]))
      tools = tools.map(t => overrideMap.has(t.name) ? { ...t, ...overrideMap.get(t.name)! } : t)
      // Add any tools not in defaults (e.g. custom tool declarations)
      for (const t of options.tools) {
        if (!tools.some(dt => dt.name === t.name)) {
          tools.push(t)
        }
      }
    }

    // Merge triggers: spread per trigger type from defaults, override with provided
    const mergedTriggers: TriggersConfigV3 = { ...defaults.triggers }
    if (options.triggers) {
      for (const key of Object.keys(options.triggers) as TriggerTypeV3[]) {
        const override = options.triggers[key]
        if (override) {
          mergedTriggers[key] = override
        }
      }
    }

    const config: AgentConfig = {
      adf_version: '0.2',
      id: agentId,
      name: options.name,
      description: options.description || '',
      icon: options.icon,
      ...(options.handle ? { handle: options.handle } : {}),
      state: options.start_in_state ?? defaults.state,
      start_in_state: options.start_in_state,
      autonomous: options.autonomous ?? defaults.autonomous,
      autostart: options.autostart ?? false,
      model: { ...defaults.model, ...options.model },
      instructions: options.instructions || '',
      context: {
        ...defaults.context,
        ...options.context,
        audit: { ...defaults.context.audit, ...options.context?.audit },
        dynamic_instructions: { ...defaults.context.dynamic_instructions, ...options.context?.dynamic_instructions }
      },
      tools,
      triggers: mergedTriggers,
      security: { ...defaults.security, ...options.security },
      limits: { ...defaults.limits, ...options.limits },
      messaging: { ...defaults.messaging, ...options.messaging },
      audit: { ...defaults.audit, ...options.audit },
      code_execution: { ...defaults.code_execution, ...options.code_execution },
      compute: { ...defaults.compute },
      logging: { ...defaults.logging, ...options.logging },
      mcp: options.mcp ?? { ...defaults.mcp },
      adapters: { ...defaults.adapters, ...options.adapters },
      serving: options.serving ?? { ...defaults.serving },
      ws_connections: options.ws_connections ?? [...defaults.ws_connections],
      providers: options.providers ?? [...defaults.providers],
      locked_fields: options.locked_fields ?? [...defaults.locked_fields],
      card: options.card ?? { ...defaults.card },
      metadata: {
        created_at: now,
        updated_at: now,
        ...options.metadata
      }
    }

    adfDb.setConfig(config)

    // Denormalized meta keys for fast lookup
    adfDb.setMeta('adf_name', options.name, 'readonly')
    adfDb.setMeta('adf_handle', options.handle || slugify(options.name), 'readonly')
    adfDb.setMeta('adf_parent_did', '', 'readonly')
    adfDb.setMeta('adf_created_at', now, 'readonly')
    adfDb.setMeta('adf_updated_at', now, 'readonly')

    // Default agent key
    adfDb.setMeta('status', '', 'none')

    const documentContent = getDefaultDocumentContent(options.name)
    adfDb.writeFile('document.md', Buffer.from(documentContent), 'text/markdown', 'no_delete')
    adfDb.writeFile('mind.md', Buffer.from(DEFAULT_MIND_CONTENT), 'text/markdown', 'no_delete')

    // Identity keys are not generated by default for local ADFs.
    // Users can manually generate keys via the Identity Panel UI or IPC calls.
    // The adf_identity table schema is still created, just left empty.

    return adfDb
  }

  /**
   * Peek at messaging config without fully opening the database.
   * Used for directory scanning to find agents by channel.
   */
  static peekMessagingConfig(
    filePath: string
  ): { id: string; name: string; receive: boolean; mode: string; autonomous: boolean } | null {
    let db: Database.Database | null = null
    try {
      db = new Database(filePath, { readonly: true })
      const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
        | { config_json: string }
        | undefined
      if (!row) return { status: null, error: 'Missing adf_config row.' }

      const config = JSON.parse(row.config_json) as AgentConfig
      return {
        id: config.id,
        name: config.name,
        receive: config.messaging?.receive ?? false,
        mode: config.messaging?.mode || 'respond_only',
        autonomous: config.autonomous ?? false
      }
    } catch {
      return null
    } finally {
      db?.close()
    }
  }

  /**
   * Peek at a file's boot-relevant status: autostart flag, agent ID, and
   * whether its identity is password-protected.
   * Used by the boot scan to decide which agents to auto-start.
   */
  static peekBootStatus(
    filePath: string
  ): AdfBootStatus | null {
    return AdfDatabase.peekBootStatusDetailed(filePath).status
  }

  static peekBootStatusDetailed(filePath: string): AdfBootStatusResult {
    let db: Database.Database | null = null
    try {
      db = new Database(filePath, { readonly: true })
      const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
        | { config_json: string }
        | undefined
      if (!row) return null

      const config = JSON.parse(row.config_json) as AgentConfig
      const hasEncrypted = !!db
        .prepare("SELECT 1 FROM adf_identity WHERE encryption_algo != 'plain' LIMIT 1")
        .get()

      return {
        status: {
          autostart: config.autostart ?? false,
          agentId: config.id,
          hasEncryptedIdentity: hasEncrypted
        }
      }
    } catch (err) {
      return {
        status: null,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      db?.close()
    }
  }

  /** @deprecated Use peekBootStatus instead */
  static peekAutostart(filePath: string): { autostart: boolean; hasEncryptedIdentity: boolean } | null {
    const result = AdfDatabase.peekBootStatus(filePath)
    if (!result) return null
    return { autostart: result.autostart, hasEncryptedIdentity: result.hasEncryptedIdentity }
  }

  /**
   * Peek at a file's agent config to check MCP server references.
   * Returns the list of MCP server names referenced in the config.
   */
  static peekMcpServerNames(filePath: string): string[] {
    let db: Database.Database | null = null
    try {
      db = new Database(filePath, { readonly: true })
      const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
        | { config_json: string }
        | undefined
      if (!row) return []

      const config = JSON.parse(row.config_json) as AgentConfig
      return (config.mcp?.servers ?? []).map((s) => s.name)
    } catch {
      return []
    } finally {
      db?.close()
    }
  }

  /**
   * Peek at a file's agent config to check adapter references.
   * Returns the list of adapter type keys referenced in the config.
   */
  static peekAdapterTypes(filePath: string): string[] {
    let db: Database.Database | null = null
    try {
      db = new Database(filePath, { readonly: true })
      const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
        | { config_json: string }
        | undefined
      if (!row) return []

      const config = JSON.parse(row.config_json) as AgentConfig
      return Object.keys(config.adapters ?? {})
    } catch {
      return []
    } finally {
      db?.close()
    }
  }

  /**
   * Peek at a file's agent config to check provider references.
   * Returns the list of provider IDs referenced in the config.
   */
  static peekProviderIds(filePath: string): string[] {
    let db: Database.Database | null = null
    try {
      db = new Database(filePath, { readonly: true })
      const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
        | { config_json: string }
        | undefined
      if (!row) return []

      const config = JSON.parse(row.config_json) as AgentConfig
      return (config.providers ?? []).map((p) => p.id)
    } catch {
      return []
    } finally {
      db?.close()
    }
  }

  /**
   * Peek at identity purposes matching a prefix without fully opening.
   * Used to check credential status for MCP servers across ADF files.
   */
  static peekIdentityPurposes(filePath: string, prefix: string): string[] {
    let db: Database.Database | null = null
    try {
      db = new Database(filePath, { readonly: true })
      const rows = db.prepare(
        "SELECT purpose FROM adf_identity WHERE purpose LIKE ? || '%'"
      ).all(prefix) as { purpose: string }[]
      return rows.map((r) => r.purpose)
    } catch {
      return []
    } finally {
      db?.close()
    }
  }

  // ===========================================================================
  // Database Setup
  // ===========================================================================

  private applyPragmas(): void {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')
    sqliteVec.load(this.db)
  }

  private prepareStatements(): void {
    // Meta
    this.stmts.getMeta = this.db.prepare('SELECT value FROM adf_meta WHERE key = ?')
    this.stmts.setMeta = this.db.prepare(
      'INSERT INTO adf_meta (key, value, protection) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    this.stmts.deleteMeta = this.db.prepare('DELETE FROM adf_meta WHERE key = ?')
    this.stmts.getAllMeta = this.db.prepare('SELECT key, value, protection FROM adf_meta ORDER BY key')
    this.stmts.getMetaProtection = this.db.prepare('SELECT protection FROM adf_meta WHERE key = ?')
    this.stmts.setMetaProtection = this.db.prepare('UPDATE adf_meta SET protection = ? WHERE key = ?')

    // Config
    this.stmts.getConfig = this.db.prepare(
      'SELECT config_json FROM adf_config WHERE id = 1'
    )
    this.stmts.setConfig = this.db.prepare(
      'INSERT OR REPLACE INTO adf_config (id, config_json, updated_at) VALUES (1, ?, ?)'
    )

    // Loop
    this.stmts.getLoopEntries = this.db.prepare(
      'SELECT seq, role, content_json, model, tokens, created_at FROM adf_loop ORDER BY seq ASC'
    )
    this.stmts.getLoopEntriesLimited = this.db.prepare(
      'SELECT seq, role, content_json, model, tokens, created_at FROM adf_loop ORDER BY seq ASC LIMIT ? OFFSET ?'
    )
    this.stmts.appendLoopEntry = this.db.prepare(
      'INSERT INTO adf_loop (role, content_json, model, tokens, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    this.stmts.clearLoop = this.db.prepare('DELETE FROM adf_loop')
    this.stmts.getLoopCount = this.db.prepare('SELECT COUNT(*) as count FROM adf_loop')
    this.stmts.getLastAssistantTokens = this.db.prepare(
      'SELECT tokens FROM adf_loop WHERE role = \'assistant\' AND tokens IS NOT NULL ORDER BY seq DESC LIMIT 1'
    )

    // Inbox
    this.stmts.getInboxMessages = this.db.prepare(
      'SELECT * FROM adf_inbox ORDER BY received_at DESC'
    )
    this.stmts.getInboxByStatus = this.db.prepare(
      'SELECT * FROM adf_inbox WHERE status = ? ORDER BY received_at DESC'
    )
    this.stmts.addInboxMessage = this.db.prepare(`
      INSERT INTO adf_inbox (id, message_id, "from", "to", reply_to, network, thread_id, parent_id, subject, content, content_type, attachments, meta, sender_alias, recipient_alias, owner, card, return_path, source, source_context, sent_at, received_at, status, original_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmts.updateInboxStatus = this.db.prepare(
      'UPDATE adf_inbox SET status = ? WHERE id = ?'
    )

    // Outbox
    this.stmts.getOutboxMessages = this.db.prepare(
      'SELECT * FROM adf_outbox ORDER BY created_at DESC'
    )
    this.stmts.getOutboxByStatus = this.db.prepare(
      'SELECT * FROM adf_outbox WHERE status = ? ORDER BY created_at DESC'
    )
    this.stmts.addOutboxMessage = this.db.prepare(`
      INSERT INTO adf_outbox (id, message_id, "from", "to", address, reply_to, network, thread_id, parent_id, subject, content, content_type, attachments, meta, sender_alias, recipient_alias, owner, card, return_path, status_code, created_at, delivered_at, status, original_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmts.updateOutboxStatus = this.db.prepare(
      'UPDATE adf_outbox SET status = ? WHERE id = ?'
    )
    this.stmts.updateOutboxDelivery = this.db.prepare(
      'UPDATE adf_outbox SET status = ?, delivered_at = ? WHERE id = ?'
    )
    this.stmts.updateOutboxDeliveryFull = this.db.prepare(
      'UPDATE adf_outbox SET status = ?, status_code = ?, delivered_at = ? WHERE id = ?'
    )
    this.stmts.updateOutboxMeta = this.db.prepare(
      'UPDATE adf_outbox SET meta = ? WHERE id = ?'
    )
    this.stmts.findOutboxByMetaValue = this.db.prepare(
      "SELECT id FROM adf_outbox WHERE json_extract(meta, ?) = ? ORDER BY created_at DESC LIMIT 1"
    )

    // Timers
    this.stmts.getTimers = this.db.prepare(
      'SELECT id, schedule_json, next_wake_at, payload, scope, lambda, warm, run_count, created_at, last_fired_at, locked FROM adf_timers ORDER BY next_wake_at ASC'
    )
    this.stmts.addTimer = this.db.prepare(
      'INSERT INTO adf_timers (schedule_json, next_wake_at, payload, scope, lambda, warm, run_count, created_at, last_fired_at, locked) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)'
    )
    this.stmts.renewTimer = this.db.prepare(
      'INSERT INTO adf_timers (schedule_json, next_wake_at, payload, scope, lambda, warm, run_count, created_at, last_fired_at, locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.stmts.updateTimer = this.db.prepare(
      'UPDATE adf_timers SET schedule_json=?, next_wake_at=?, payload=?, scope=?, lambda=?, warm=?, locked=? WHERE id=?'
    )
    this.stmts.deleteTimer = this.db.prepare('DELETE FROM adf_timers WHERE id = ?')
    this.stmts.getExpiredTimers = this.db.prepare(
      'SELECT id, schedule_json, next_wake_at, payload, scope, lambda, warm, run_count, created_at, last_fired_at, locked FROM adf_timers WHERE next_wake_at <= ? ORDER BY next_wake_at ASC'
    )

    // Files
    this.stmts.readFile = this.db.prepare(
      'SELECT content, mime_type, size, protection, authorized, created_at, updated_at FROM adf_files WHERE path = ?'
    )
    this.stmts.writeFile = this.db.prepare(`
      INSERT INTO adf_files (path, content, mime_type, size, protection, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.stmts.updateFile = this.db.prepare(`
      UPDATE adf_files SET content = ?, mime_type = ?, size = ?, authorized = 0, updated_at = ? WHERE path = ?
    `)
    this.stmts.deleteFile = this.db.prepare("DELETE FROM adf_files WHERE path = ? AND protection = 'none'")
    this.stmts.listFiles = this.db.prepare(
      'SELECT path, mime_type, size, protection, authorized, created_at, updated_at FROM adf_files'
    )
    this.stmts.fileExists = this.db.prepare('SELECT 1 FROM adf_files WHERE path = ?')
    this.stmts.getDocumentFile = this.db.prepare(
      "SELECT path, content FROM adf_files WHERE path LIKE 'document.%' LIMIT 1"
    )
    this.stmts.renameFile = this.db.prepare(
      'UPDATE adf_files SET path = ?, updated_at = ? WHERE path = ?'
    )
    this.stmts.setFileProtection = this.db.prepare(
      'UPDATE adf_files SET protection = ?, updated_at = ? WHERE path = ?'
    )
    this.stmts.getFileProtection = this.db.prepare(
      'SELECT protection FROM adf_files WHERE path = ?'
    )
    this.stmts.getFileAuthorized = this.db.prepare(
      'SELECT authorized FROM adf_files WHERE path = ?'
    )
    this.stmts.setFileAuthorized = this.db.prepare(
      'UPDATE adf_files SET authorized = ?, updated_at = ? WHERE path = ?'
    )

    // Identity
    this.stmts.getIdentity = this.db.prepare(
      'SELECT value, encryption_algo, salt FROM adf_identity WHERE purpose = ?'
    )
    this.stmts.setIdentity = this.db.prepare(
      'INSERT INTO adf_identity (purpose, value, encryption_algo) VALUES (?, ?, ?) ON CONFLICT(purpose) DO UPDATE SET value = excluded.value, encryption_algo = excluded.encryption_algo'
    )
    this.stmts.deleteIdentity = this.db.prepare(
      'DELETE FROM adf_identity WHERE purpose = ?'
    )
    this.stmts.listIdentityByPrefix = this.db.prepare(
      "SELECT purpose FROM adf_identity WHERE purpose LIKE ? || '%'"
    )
    this.stmts.getIdentityFull = this.db.prepare(
      'SELECT purpose, value, encryption_algo, salt, kdf_params, code_access FROM adf_identity WHERE purpose = ?'
    )
    this.stmts.getAllIdentityFull = this.db.prepare(
      'SELECT purpose, value, encryption_algo, salt, kdf_params, code_access FROM adf_identity'
    )
    this.stmts.hasEncryptedIdentity = this.db.prepare(
      "SELECT 1 FROM adf_identity WHERE encryption_algo != 'plain' LIMIT 1"
    )
    this.stmts.setIdentityRaw = this.db.prepare(
      'INSERT INTO adf_identity (purpose, value, encryption_algo, salt, kdf_params) VALUES (?, ?, ?, ?, ?) ON CONFLICT(purpose) DO UPDATE SET value = excluded.value, encryption_algo = excluded.encryption_algo, salt = excluded.salt, kdf_params = excluded.kdf_params'
    )

    // Audit
    this.stmts.insertAudit = this.db.prepare(
      'INSERT INTO adf_audit (source, start_at, end_at, entry_count, size_bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    this.stmts.getAuditById = this.db.prepare(
      'SELECT id, source, start_at, end_at, entry_count, size_bytes, data, created_at FROM adf_audit WHERE id = ?'
    )
    this.stmts.listAudits = this.db.prepare(
      'SELECT id, source, start_at, end_at, entry_count, size_bytes, created_at FROM adf_audit ORDER BY created_at DESC'
    )

    // Loop slice operations
    this.stmts.getLoopSeqs = this.db.prepare(
      'SELECT seq FROM adf_loop ORDER BY seq ASC'
    )
    this.stmts.getLoopEntriesBySeqRange = this.db.prepare(
      'SELECT seq, role, content_json, model, tokens, created_at FROM adf_loop WHERE seq >= ? AND seq <= ? ORDER BY seq ASC'
    )
    this.stmts.deleteLoopBySeqRange = this.db.prepare(
      'DELETE FROM adf_loop WHERE seq >= ? AND seq <= ?'
    )

    // Tasks
    this.stmts.insertTask = this.db.prepare(
      'INSERT INTO adf_tasks (id, tool, args, status, created_at, origin, requires_authorization, executor_managed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.stmts.getTask = this.db.prepare(
      'SELECT id, tool, args, status, result, error, created_at, completed_at, origin, requires_authorization, executor_managed FROM adf_tasks WHERE id = ?'
    )
    this.stmts.updateTaskStatus = this.db.prepare(
      'UPDATE adf_tasks SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?'
    )
    this.stmts.setTaskRequiresAuthorization = this.db.prepare(
      'UPDATE adf_tasks SET requires_authorization = 1 WHERE id = ?'
    )
    this.stmts.getTasksByStatus = this.db.prepare(
      'SELECT id, tool, args, status, result, error, created_at, completed_at, origin, requires_authorization, executor_managed FROM adf_tasks WHERE status = ? ORDER BY created_at ASC'
    )
    this.stmts.getAllTasks = this.db.prepare(
      'SELECT id, tool, args, status, result, error, created_at, completed_at, origin, requires_authorization, executor_managed FROM adf_tasks ORDER BY created_at DESC LIMIT ?'
    )

    // Logs
    this.stmts.insertLog = this.db.prepare(
      'INSERT INTO adf_logs (level, origin, event, target, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    this.stmts.getLogs = this.db.prepare(
      'SELECT id, level, origin, event, target, message, data, created_at FROM adf_logs ORDER BY id DESC LIMIT ?'
    )
    this.stmts.getLogsAfterId = this.db.prepare(
      'SELECT id, level, origin, event, target, message, data, created_at FROM adf_logs WHERE id > ? ORDER BY id ASC'
    )
    this.stmts.clearLogs = this.db.prepare('DELETE FROM adf_logs')
    this.stmts.trimLogs = this.db.prepare(
      'DELETE FROM adf_logs WHERE id <= (SELECT id FROM adf_logs ORDER BY id DESC LIMIT 1 OFFSET ?)'
    )
    this.stmts.countLogs = this.db.prepare('SELECT COUNT(*) as count FROM adf_logs')
  }

  // ===========================================================================
  // Meta Table
  // ===========================================================================

  getMeta(key: string): string | null {
    const row = this.stmts.getMeta!.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string, protection: MetaProtectionLevel = 'none'): void {
    this.stmts.setMeta!.run(key, value, protection)
  }

  deleteMeta(key: string): boolean {
    const result = this.stmts.deleteMeta!.run(key)
    return result.changes > 0
  }

  getAllMeta(): Array<{ key: string; value: string; protection: MetaProtectionLevel }> {
    return this.stmts.getAllMeta!.all() as Array<{ key: string; value: string; protection: MetaProtectionLevel }>
  }

  getMetaProtection(key: string): MetaProtectionLevel | null {
    const row = this.stmts.getMetaProtection!.get(key) as { protection: MetaProtectionLevel } | undefined
    return row?.protection ?? null
  }

  setMetaProtection(key: string, protection: MetaProtectionLevel): boolean {
    const result = this.stmts.setMetaProtection!.run(protection, key)
    return result.changes > 0
  }

  // ===========================================================================
  // Identity / Keystore
  // ===========================================================================

  getIdentity(purpose: string): string | null {
    const row = this.stmts.getIdentity!.get(purpose) as
      | { value: Buffer | Uint8Array; encryption_algo: string; salt: Buffer | Uint8Array | null }
      | undefined
    if (!row) return null
    // Only return plain values directly; encrypted values need decryption via getIdentityDecrypted
    if (row.encryption_algo !== 'plain') return null
    const buf = Buffer.isBuffer(row.value) ? row.value : Buffer.from(row.value)
    return buf.toString('utf-8')
  }

  setIdentity(purpose: string, value: string): void {
    this.stmts.setIdentity!.run(purpose, Buffer.from(value, 'utf-8'), 'plain')
  }

  deleteIdentity(purpose: string): boolean {
    const result = this.stmts.deleteIdentity!.run(purpose)
    return result.changes > 0
  }

  deleteIdentityByPrefix(prefix: string): number {
    const stmt = this.db.prepare("DELETE FROM adf_identity WHERE purpose LIKE ? || '%'")
    const result = stmt.run(prefix)
    return result.changes
  }

  listIdentityPurposes(prefix?: string): string[] {
    if (prefix) {
      const rows = this.stmts.listIdentityByPrefix!.all(prefix) as { purpose: string }[]
      return rows.map((r) => r.purpose)
    }
    const rows = this.db.prepare('SELECT purpose FROM adf_identity').all() as { purpose: string }[]
    return rows.map((r) => r.purpose)
  }

  // --- Encrypted identity methods ---

  /**
   * Ensure a value from better-sqlite3 BLOB (Uint8Array) is a real Buffer.
   */
  private toBuffer(val: Buffer | Uint8Array | null): Buffer | null {
    if (val === null || val === undefined) return null
    return Buffer.isBuffer(val) ? val : Buffer.from(val)
  }

  private normalizeIdentityRow(row: IdentityRow): IdentityRow {
    return {
      ...row,
      value: this.toBuffer(row.value)!,
      salt: this.toBuffer(row.salt)
    }
  }

  getIdentityRaw(purpose: string): IdentityRow | null {
    const row = this.stmts.getIdentityFull!.get(purpose) as IdentityRow | undefined
    if (!row) return null
    return this.normalizeIdentityRow(row)
  }

  setIdentityRaw(
    purpose: string,
    value: Buffer,
    encryption_algo: string,
    salt: Buffer | null,
    kdf_params: string | null
  ): void {
    this.stmts.setIdentityRaw!.run(purpose, value, encryption_algo, salt ?? null, kdf_params ?? null)
  }

  getIdentityDecrypted(purpose: string, derivedKey: Buffer | null): string | null {
    const row = this.getIdentityRaw(purpose)
    if (!row) return null
    if (row.encryption_algo === 'plain') {
      return row.value.toString('utf-8')
    }
    if (!derivedKey || !row.salt) return null
    try {
      const plaintext = decrypt(row.value, derivedKey, row.salt)
      return plaintext.toString('utf-8')
    } catch {
      return null
    }
  }

  isPasswordProtected(): boolean {
    return !!this.stmts.hasEncryptedIdentity!.get()
  }

  getAllIdentityRaw(): IdentityRow[] {
    const rows = this.stmts.getAllIdentityFull!.all() as IdentityRow[]
    return rows.map((r) => this.normalizeIdentityRow(r))
  }

  listIdentityEntries(): Array<{ purpose: string; encrypted: boolean; code_access: boolean }> {
    const rows = this.stmts.getAllIdentityFull!.all() as IdentityRow[]
    return rows.map((r) => ({
      purpose: r.purpose,
      encrypted: r.encryption_algo !== 'plain',
      code_access: !!(r as unknown as { code_access?: number }).code_access
    }))
  }

  /**
   * Get identity row metadata (without decrypting).
   * Used by get_identity to check code_access flag before returning the value.
   */
  getIdentityRow(purpose: string): { purpose: string; code_access: boolean; encryption_algo: string } | null {
    const row = this.db.prepare(
      'SELECT purpose, encryption_algo, code_access FROM adf_identity WHERE purpose = ?'
    ).get(purpose) as { purpose: string; encryption_algo: string; code_access: number } | undefined
    if (!row) return null
    return { purpose: row.purpose, code_access: !!row.code_access, encryption_algo: row.encryption_algo }
  }

  /**
   * Update the code_access flag for an identity row.
   */
  setIdentityCodeAccess(purpose: string, codeAccess: boolean): boolean {
    const result = this.db.prepare(
      'UPDATE adf_identity SET code_access = ? WHERE purpose = ?'
    ).run(codeAccess ? 1 : 0, purpose)
    return result.changes > 0
  }

  deleteAllIdentity(): void {
    this.db.prepare('DELETE FROM adf_identity').run()
  }

  // ===========================================================================
  // Agent Config
  // ===========================================================================

  getConfig(): AgentConfig {
    const row = this.stmts.getConfig!.get() as { config_json: string } | undefined
    if (!row) {
      throw new Error('Agent config not found')
    }
    const config = JSON.parse(row.config_json) as AgentConfig

    // Backfill handle from adf_meta so the stored handle is always the source of truth.
    // config.handle is optional in the JSON — without this, the mesh re-derives from
    // the file path on every registration, which is unstable across renames/moves.
    if (!config.handle) {
      const storedHandle = this.getMeta('adf_handle')
      if (storedHandle) config.handle = storedHandle
    }

    // Backfill tool visibility for pre-visible local files and any tools from
    // DEFAULT_TOOLS missing from this agent's config. New tools are added with
    // their default enabled/restricted/visible state so they
    // appear in the UI immediately for existing agents.
    const existing = new Set(config.tools.map(t => t.name))
    let added = false
    for (const tool of config.tools) {
      if (tool.visible === undefined) {
        tool.visible = tool.enabled
        added = true
      }
    }
    for (const dt of defaultTools) {
      if (!existing.has(dt.name)) {
        config.tools.push({ ...dt })
        added = true
      }
    }
    if (added) {
      this.setConfig(config)
    }

    return config
  }

  setConfig(config: AgentConfig): void {
    const now = new Date().toISOString()
    config.metadata.updated_at = now
    this.stmts.setConfig!.run(JSON.stringify(config), now)

    // Keep denormalized meta keys in sync
    this.setMeta('adf_name', config.name)
    if (config.handle) this.setMeta('adf_handle', config.handle)
    this.setMeta('adf_updated_at', now)
  }

  // ===========================================================================
  // Loop Table
  // ===========================================================================

  getLoopEntries(limit?: number, offset?: number): LoopEntry[] {
    let rows: Array<{ seq: number; role: string; content_json: string; model: string | null; tokens: string | null; created_at: number }>

    if (limit !== undefined) {
      rows = this.stmts.getLoopEntriesLimited!.all(limit, offset ?? 0) as typeof rows
    } else {
      rows = this.stmts.getLoopEntries!.all() as typeof rows
    }

    return rows.map((row) => {
      let tokens: LoopTokenUsage | undefined
      if (row.tokens) {
        try { tokens = JSON.parse(row.tokens) } catch { /* ignore legacy integer values */ }
      }
      return {
        seq: row.seq,
        role: row.role as 'user' | 'assistant',
        content_json: JSON.parse(row.content_json) as ContentBlock[],
        model: row.model ?? undefined,
        tokens,
        created_at: row.created_at
      }
    })
  }

  appendLoopEntry(
    role: 'user' | 'assistant',
    content: ContentBlock[],
    model?: string,
    tokens?: LoopTokenUsage,
    createdAt?: number
  ): number {
    const result = this.stmts.appendLoopEntry!.run(
      role,
      JSON.stringify(content),
      model ?? null,
      tokens ? JSON.stringify(tokens) : null,
      createdAt ?? Date.now()
    )
    return Number(result.lastInsertRowid)
  }

  clearLoop(): void {
    this.stmts.clearLoop!.run()
  }

  getLoopCount(): number {
    const row = this.stmts.getLoopCount!.get() as { count: number }
    return row.count
  }

  getLastAssistantTokens(): LoopTokenUsage | undefined {
    const row = this.stmts.getLastAssistantTokens!.get() as { tokens: string } | undefined
    if (!row?.tokens) return undefined
    try { return JSON.parse(row.tokens) } catch { return undefined }
  }

  getLoopSeqs(): number[] {
    const rows = this.stmts.getLoopSeqs!.all() as Array<{ seq: number }>
    return rows.map(r => r.seq)
  }

  getLoopEntriesBySeqRange(minSeq: number, maxSeq: number): LoopEntry[] {
    const rows = this.stmts.getLoopEntriesBySeqRange!.all(minSeq, maxSeq) as Array<{
      seq: number; role: string; content_json: string; model: string | null; tokens: string | null; created_at: number
    }>
    return rows.map((row) => {
      let tokens: LoopTokenUsage | undefined
      if (row.tokens) {
        try { tokens = JSON.parse(row.tokens) } catch { /* ignore */ }
      }
      return {
        seq: row.seq,
        role: row.role as 'user' | 'assistant',
        content_json: JSON.parse(row.content_json) as ContentBlock[],
        model: row.model ?? undefined,
        tokens,
        created_at: row.created_at
      }
    })
  }

  deleteLoopBySeqRange(minSeq: number, maxSeq: number): number {
    const result = this.stmts.deleteLoopBySeqRange!.run(minSeq, maxSeq)
    return result.changes
  }

  // ===========================================================================
  // Audit
  // ===========================================================================

  insertAudit(source: string, startAt: number, endAt: number, entryCount: number, sizeBytes: number, data: Buffer): number {
    const result = this.stmts.insertAudit!.run(source, startAt, endAt, entryCount, sizeBytes, data, Date.now())
    return Number(result.lastInsertRowid)
  }

  getAuditById(id: number): {
    id: number; source: string; start_at: number; end_at: number
    entry_count: number; size_bytes: number; data: Buffer; created_at: number
  } | null {
    const row = this.stmts.getAuditById!.get(id) as {
      id: number; source: string; start_at: number; end_at: number
      entry_count: number; size_bytes: number; data: Buffer; created_at: number
    } | undefined
    return row ?? null
  }

  listAudits(): Array<{
    id: number; source: string; start_at: number; end_at: number
    entry_count: number; size_bytes: number; created_at: number
  }> {
    return this.stmts.listAudits!.all() as Array<{
      id: number; source: string; start_at: number; end_at: number
      entry_count: number; size_bytes: number; created_at: number
    }>
  }

  // ===========================================================================
  // Filter-based Inbox/Outbox queries (for msg_delete audit)
  // ===========================================================================

  getInboxByFilter(filter: { status?: string; from?: string; source?: string; before?: number; thread_id?: string }): InboxMessage[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.status) { conditions.push('status = ?'); params.push(filter.status) }
    if (filter.from) { conditions.push('"from" = ?'); params.push(filter.from) }
    if (filter.source) { conditions.push('source = ?'); params.push(filter.source) }
    if (filter.before) { conditions.push('received_at < ?'); params.push(filter.before) }
    if (filter.thread_id) { conditions.push('thread_id = ?'); params.push(filter.thread_id) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM adf_inbox ${where} ORDER BY received_at DESC`).all(...params) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToInboxMessage(r))
  }

  deleteInboxByFilter(filter: { status?: string; from?: string; source?: string; before?: number; thread_id?: string }): number {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.status) { conditions.push('status = ?'); params.push(filter.status) }
    if (filter.from) { conditions.push('"from" = ?'); params.push(filter.from) }
    if (filter.source) { conditions.push('source = ?'); params.push(filter.source) }
    if (filter.before) { conditions.push('received_at < ?'); params.push(filter.before) }
    if (filter.thread_id) { conditions.push('thread_id = ?'); params.push(filter.thread_id) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = this.db.prepare(`DELETE FROM adf_inbox ${where}`).run(...params)
    return result.changes
  }

  getOutboxByFilter(filter: { status?: string; to?: string; before?: number; thread_id?: string }): OutboxMessage[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.status) { conditions.push('status = ?'); params.push(filter.status) }
    if (filter.to) { conditions.push('"to" = ?'); params.push(filter.to) }
    if (filter.before) { conditions.push('created_at < ?'); params.push(filter.before) }
    if (filter.thread_id) { conditions.push('thread_id = ?'); params.push(filter.thread_id) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM adf_outbox ${where} ORDER BY created_at DESC`).all(...params) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToOutboxMessage(r))
  }

  deleteOutboxByFilter(filter: { status?: string; to?: string; before?: number; thread_id?: string }): number {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.status) { conditions.push('status = ?'); params.push(filter.status) }
    if (filter.to) { conditions.push('"to" = ?'); params.push(filter.to) }
    if (filter.before) { conditions.push('created_at < ?'); params.push(filter.before) }
    if (filter.thread_id) { conditions.push('thread_id = ?'); params.push(filter.thread_id) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = this.db.prepare(`DELETE FROM adf_outbox ${where}`).run(...params)
    return result.changes
  }

  // ===========================================================================
  // Transaction wrapper
  // ===========================================================================

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // ===========================================================================
  // Inbox
  // ===========================================================================

  getInboxMessages(status?: InboxStatus): InboxMessage[] {
    let rows: Array<Record<string, unknown>>

    if (status) {
      rows = this.stmts.getInboxByStatus!.all(status) as typeof rows
    } else {
      rows = this.stmts.getInboxMessages!.all() as typeof rows
    }

    return rows.map((row) => this.rowToInboxMessage(row))
  }

  getInboxMessageById(id: string): InboxMessage | null {
    const row = this.db.prepare('SELECT * FROM adf_inbox WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToInboxMessage(row) : null
  }

  addInboxMessage(msg: Omit<InboxMessage, 'id'>): string {
    const id = nanoid()
    const args = [
      id,
      msg.message_id ?? null,
      msg.from,
      msg.to ?? null,
      msg.reply_to ?? null,
      msg.network ?? 'devnet',
      msg.thread_id ?? null,
      msg.parent_id ?? null,
      msg.subject ?? null,
      msg.content,
      msg.content_type ?? null,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.meta ? JSON.stringify(msg.meta) : null,
      msg.sender_alias ?? null,
      msg.recipient_alias ?? null,
      msg.owner ?? null,
      msg.card ?? null,
      msg.return_path ?? null,
      msg.source ?? 'mesh',
      msg.source_context ? JSON.stringify(msg.source_context) : null,
      msg.sent_at ?? null,
      msg.received_at,
      msg.status,
      msg.original_message ?? null
    ]
    this.stmts.addInboxMessage!.run(...args)
    return id
  }

  updateInboxStatus(id: string, status: InboxStatus): void {
    this.stmts.updateInboxStatus!.run(status, id)
  }

  archiveAllInbox(): number {
    const result = this.db.prepare("UPDATE adf_inbox SET status = 'archived' WHERE status != 'archived'").run()
    return result.changes
  }

  deleteInboxMessage(id: string): boolean {
    const result = this.db.prepare('DELETE FROM adf_inbox WHERE id = ?').run(id)
    return result.changes > 0
  }

  getUnreadInboxCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM adf_inbox WHERE status = 'unread'")
      .get() as { count: number }
    return row.count
  }

  private rowToInboxMessage(row: Record<string, unknown>): InboxMessage {
    return {
      id: row.id as string,
      from: row.from as string,
      to: row.to as string | undefined,
      reply_to: row.reply_to as string | undefined,
      network: row.network as string | undefined,
      thread_id: row.thread_id as string | undefined,
      parent_id: row.parent_id as string | undefined,
      subject: row.subject as string | undefined,
      content: row.content as string,
      content_type: row.content_type as string | undefined,
      attachments: row.attachments
        ? (JSON.parse(row.attachments as string) as StoredAttachment[])
        : undefined,
      meta: row.meta ? (JSON.parse(row.meta as string) as Record<string, unknown>) : undefined,
      sender_alias: row.sender_alias as string | undefined,
      recipient_alias: row.recipient_alias as string | undefined,
      message_id: row.message_id as string | undefined,
      owner: row.owner as string | undefined,
      card: row.card as string | undefined,
      return_path: row.return_path as string | undefined,
      source: (row.source as string) ?? 'mesh',
      source_context: row.source_context ? (JSON.parse(row.source_context as string) as Record<string, unknown>) : undefined,
      sent_at: row.sent_at as number | undefined,
      received_at: row.received_at as number,
      status: row.status as InboxStatus,
      original_message: row.original_message as string | undefined
    }
  }

  // ===========================================================================
  // Outbox
  // ===========================================================================

  getOutboxMessages(status?: OutboxStatus): OutboxMessage[] {
    let rows: Array<Record<string, unknown>>

    if (status) {
      rows = this.stmts.getOutboxByStatus!.all(status) as typeof rows
    } else {
      rows = this.stmts.getOutboxMessages!.all() as typeof rows
    }

    return rows.map((row) => this.rowToOutboxMessage(row))
  }

  addOutboxMessage(msg: Omit<OutboxMessage, 'id'>): string {
    const id = nanoid()
    this.stmts.addOutboxMessage!.run(
      id,
      msg.message_id ?? null,
      msg.from,
      msg.to,
      msg.address ?? '',
      msg.reply_to ?? null,
      msg.network ?? 'devnet',
      msg.thread_id ?? null,
      msg.parent_id ?? null,
      msg.subject ?? null,
      msg.content,
      msg.content_type ?? null,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.meta ? JSON.stringify(msg.meta) : null,
      msg.sender_alias ?? null,
      msg.recipient_alias ?? null,
      msg.owner ?? null,
      msg.card ?? null,
      msg.return_path ?? null,
      msg.status_code ?? null,
      msg.created_at,
      msg.delivered_at ?? null,
      msg.status,
      msg.original_message ?? null
    )
    return id
  }

  updateOutboxStatus(id: string, status: OutboxStatus, deliveredAt?: number): void {
    if (deliveredAt !== undefined) {
      this.stmts.updateOutboxDelivery!.run(status, deliveredAt, id)
    } else {
      this.stmts.updateOutboxStatus!.run(status, id)
    }
  }

  updateOutboxDeliveryFull(id: string, status: OutboxStatus, statusCode: number | null, deliveredAt: number | null): void {
    this.stmts.updateOutboxDeliveryFull!.run(status, statusCode, deliveredAt, id)
  }

  updateOutboxMeta(id: string, meta: Record<string, unknown>): void {
    this.stmts.updateOutboxMeta!.run(JSON.stringify(meta), id)
  }

  /**
   * Find an outbox entry by a specific key/value in its meta JSON.
   * Returns the outbox ID if found, null otherwise.
   */
  findOutboxByMetaValue(jsonKey: string, value: unknown): string | null {
    const row = this.stmts.findOutboxByMetaValue!.get(`$.${jsonKey}`, value) as { id: string } | undefined
    return row?.id ?? null
  }

  private rowToOutboxMessage(row: Record<string, unknown>): OutboxMessage {
    return {
      id: row.id as string,
      from: row.from as string,
      to: row.to as string,
      address: (row.address as string) ?? '',
      reply_to: row.reply_to as string | undefined,
      network: row.network as string | undefined,
      thread_id: row.thread_id as string | undefined,
      parent_id: row.parent_id as string | undefined,
      subject: row.subject as string | undefined,
      content: row.content as string,
      content_type: row.content_type as string | undefined,
      attachments: row.attachments
        ? (JSON.parse(row.attachments as string) as StoredAttachment[])
        : undefined,
      meta: row.meta ? (JSON.parse(row.meta as string) as Record<string, unknown>) : undefined,
      sender_alias: row.sender_alias as string | undefined,
      recipient_alias: row.recipient_alias as string | undefined,
      message_id: row.message_id as string | undefined,
      owner: row.owner as string | undefined,
      card: row.card as string | undefined,
      return_path: row.return_path as string | undefined,
      status_code: row.status_code as number | undefined,
      created_at: row.created_at as number,
      delivered_at: row.delivered_at as number | undefined,
      status: row.status as OutboxStatus,
      original_message: row.original_message as string | undefined
    }
  }

  // ===========================================================================
  // Timers
  // ===========================================================================

  private rowToTimer(row: {
    id: number
    schedule_json: string
    next_wake_at: number
    payload: string | null
    scope: string
    lambda: string | null
    warm: number
    run_count: number
    created_at: number
    last_fired_at: number | null
    locked: number
  }): Timer {
    // Parse scope: JSON array like '["system"]' or legacy single value like 'agent'
    let scope: Timer['scope']
    try {
      const parsed = JSON.parse(row.scope)
      scope = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      scope = [row.scope as 'system' | 'agent']
    }
    return {
      id: row.id,
      schedule: JSON.parse(row.schedule_json) as TimerSchedule,
      next_wake_at: row.next_wake_at,
      payload: row.payload ?? undefined,
      scope,
      lambda: row.lambda ?? undefined,
      warm: row.warm === 1 ? true : undefined,
      run_count: row.run_count,
      created_at: row.created_at,
      last_fired_at: row.last_fired_at ?? undefined,
      locked: !!row.locked || undefined
    }
  }

  getTimers(): Timer[] {
    const rows = this.stmts.getTimers!.all() as Array<Parameters<AdfDatabase['rowToTimer']>[0]>
    return rows.map((row) => this.rowToTimer(row))
  }

  addTimer(schedule: TimerSchedule, nextWakeAt: number, payload?: string, scope: string[] = ['system'], lambda?: string, warm?: boolean, locked?: boolean): number {
    const now = Date.now()
    const result = this.stmts.addTimer!.run(
      JSON.stringify(schedule), nextWakeAt, payload ?? null, JSON.stringify(scope), lambda ?? null, warm ? 1 : 0, now, locked ? 1 : 0
    )
    return Number(result.lastInsertRowid)
  }

  renewTimer(
    schedule: TimerSchedule, nextWakeAt: number,
    payload: string | undefined, scope: string[],
    lambda: string | undefined, warm: boolean | undefined,
    runCount: number, createdAt: number, lastFiredAt: number,
    locked?: boolean
  ): number {
    const result = this.stmts.renewTimer!.run(
      JSON.stringify(schedule), nextWakeAt, payload ?? null, JSON.stringify(scope),
      lambda ?? null, warm ? 1 : 0, runCount, createdAt, lastFiredAt, locked ? 1 : 0
    )
    return Number(result.lastInsertRowid)
  }

  updateTimer(id: number, schedule: TimerSchedule, nextWakeAt: number, payload?: string, scope: string[] = ['system'], lambda?: string, warm?: boolean, locked?: boolean): boolean {
    const result = this.stmts.updateTimer!.run(
      JSON.stringify(schedule), nextWakeAt, payload ?? null, JSON.stringify(scope), lambda ?? null, warm ? 1 : 0, locked ? 1 : 0, id
    )
    return result.changes > 0
  }

  deleteTimer(id: number): boolean {
    const result = this.stmts.deleteTimer!.run(id)
    return result.changes > 0
  }

  deleteTimers(ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const result = this.db.prepare(`DELETE FROM adf_timers WHERE id IN (${placeholders})`).run(...ids)
    return result.changes
  }

  getExpiredTimers(): Timer[] {
    const now = Date.now()
    const rows = this.stmts.getExpiredTimers!.all(now) as Array<Parameters<AdfDatabase['rowToTimer']>[0]>
    return rows.map((row) => this.rowToTimer(row))
  }

  // ===========================================================================
  // Files Table
  // ===========================================================================

  readFile(path: string): FileEntry | null {
    const row = this.stmts.readFile!.get(path) as
      | {
          content: Buffer
          mime_type: string | null
          size: number
          protection: FileProtectionLevel
          authorized: number
          created_at: string
          updated_at: string
        }
      | undefined

    if (!row) return null

    return {
      path,
      content: row.content,
      mime_type: row.mime_type ?? undefined,
      size: row.size,
      protection: row.protection,
      authorized: !!row.authorized,
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  }

  writeFile(path: string, content: Buffer, mimeType?: string, protection?: FileProtectionLevel): void {
    const now = new Date().toISOString()
    const size = content.length

    const exists = this.stmts.fileExists!.get(path)

    if (exists) {
      this.stmts.updateFile!.run(content, mimeType ?? null, size, now, path)
    } else {
      this.stmts.writeFile!.run(path, content, mimeType ?? null, size, protection ?? 'none', now, now)
    }
  }

  deleteFile(path: string): boolean {
    const result = this.stmts.deleteFile!.run(path)
    return result.changes > 0
  }

  getFileMeta(path: string): { path: string; mime_type: string | null; size: number; protection: FileProtectionLevel; authorized: boolean; created_at: string; updated_at: string } | null {
    const row = this.db.prepare(
      'SELECT path, mime_type, size, protection, authorized, created_at, updated_at FROM adf_files WHERE path = ?'
    ).get(path) as { path: string; mime_type: string | null; size: number; protection: FileProtectionLevel; authorized: number; created_at: string; updated_at: string } | undefined
    if (!row) return null
    return { ...row, authorized: !!row.authorized }
  }

  listFiles(): Array<{
    path: string
    mime_type?: string
    size: number
    protection: FileProtectionLevel
    authorized: boolean
    created_at: string
    updated_at: string
  }> {
    const rows = this.stmts.listFiles!.all() as Array<{
      path: string
      mime_type: string | null
      size: number
      protection: FileProtectionLevel
      authorized: number
      created_at: string
      updated_at: string
    }>

    return rows.map((row) => ({
      path: row.path,
      mime_type: row.mime_type ?? undefined,
      size: row.size,
      protection: row.protection,
      authorized: !!row.authorized,
      created_at: row.created_at,
      updated_at: row.updated_at
    }))
  }

  renameFile(oldPath: string, newPath: string): boolean {
    const exists = this.stmts.fileExists!.get(newPath)
    if (exists) {
      throw new Error(`File already exists: ${newPath}`)
    }
    const now = new Date().toISOString()
    const result = this.stmts.renameFile!.run(newPath, now, oldPath)
    return result.changes > 0
  }

  renameFolder(oldPrefix: string, newPrefix: string): number {
    const now = new Date().toISOString()
    const likePattern = oldPrefix + '/%'
    const stmt = this.db.prepare(
      `UPDATE adf_files SET path = ? || substr(path, ?), updated_at = ? WHERE path LIKE ?`
    )
    const result = stmt.run(newPrefix, oldPrefix.length + 1, now, likePattern)
    return result.changes
  }

  setFileProtection(path: string, protection: FileProtectionLevel): boolean {
    const now = new Date().toISOString()
    const result = this.stmts.setFileProtection!.run(protection, now, path)
    return result.changes > 0
  }

  getFileProtection(path: string): FileProtectionLevel | null {
    const row = this.stmts.getFileProtection!.get(path) as { protection: FileProtectionLevel } | undefined
    return row?.protection ?? null
  }

  getFileAuthorized(path: string): boolean {
    const row = this.stmts.getFileAuthorized!.get(path) as { authorized: number } | undefined
    return !!row?.authorized
  }

  setFileAuthorized(path: string, authorized: boolean): boolean {
    const now = new Date().toISOString()
    const result = this.stmts.setFileAuthorized!.run(authorized ? 1 : 0, now, path)
    return result.changes > 0
  }

  // ===========================================================================
  // Tasks
  // ===========================================================================

  insertTask(id: string, tool: string, args: string, origin?: string, requiresAuthorization?: boolean, executorManaged?: boolean): void {
    this.stmts.insertTask!.run(id, tool, args, 'pending', Date.now(), origin ?? null, requiresAuthorization ? 1 : 0, executorManaged ? 1 : 0)
  }

  private mapTaskRow(row: Record<string, unknown>): TaskEntry {
    return {
      ...row,
      requires_authorization: !!(row as { requires_authorization: number }).requires_authorization,
      executor_managed: !!(row as { executor_managed: number }).executor_managed
    } as TaskEntry
  }

  getTask(id: string): TaskEntry | null {
    const row = this.stmts.getTask!.get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this.mapTaskRow(row)
  }

  updateTaskStatus(id: string, status: TaskStatus, result?: string, error?: string): void {
    const completedAt = ['completed', 'failed', 'denied', 'cancelled'].includes(status) ? Date.now() : null
    this.stmts.updateTaskStatus!.run(status, result ?? null, error ?? null, completedAt, id)
  }

  setTaskRequiresAuthorization(id: string, _value: true): void {
    this.stmts.setTaskRequiresAuthorization!.run(id)
  }

  getTasksByStatus(status: TaskStatus): TaskEntry[] {
    const rows = this.stmts.getTasksByStatus!.all(status) as Record<string, unknown>[]
    return rows.map(r => this.mapTaskRow(r))
  }

  getAllTasks(limit: number = 200): TaskEntry[] {
    const rows = this.stmts.getAllTasks!.all(limit) as Record<string, unknown>[]
    return rows.map(r => this.mapTaskRow(r))
  }

  // ===========================================================================
  // Logs
  // ===========================================================================

  insertLog(level: string, origin: string | null, event: string | null, target: string | null, message: string, data?: unknown): void {
    this.stmts.insertLog!.run(level, origin, event, target, message, data ? JSON.stringify(data) : null, Date.now())
  }

  getLogs(limit: number = 500): Array<{ id: number; level: string; origin: string | null; event: string | null; target: string | null; message: string; data: string | null; created_at: number }> {
    return this.stmts.getLogs!.all(limit) as Array<{ id: number; level: string; origin: string | null; event: string | null; target: string | null; message: string; data: string | null; created_at: number }>
  }

  getLogsAfterId(afterId: number): Array<{ id: number; level: string; origin: string | null; event: string | null; target: string | null; message: string; data: string | null; created_at: number }> {
    return this.stmts.getLogsAfterId!.all(afterId) as Array<{ id: number; level: string; origin: string | null; event: string | null; target: string | null; message: string; data: string | null; created_at: number }>
  }

  clearLogs(): void {
    this.stmts.clearLogs!.run()
  }

  trimLogs(maxRows: number): void {
    const { count } = this.stmts.countLogs!.get() as { count: number }
    if (count > maxRows) {
      this.stmts.trimLogs!.run(maxRows)
    }
  }

  // ===========================================================================
  // Direct SQL Execution (for db_query / db_execute tools)
  // ===========================================================================

  /**
   * List all user-created (local_*) tables plus the adf_audit table.
   */
  listLocalTables(): Array<{ name: string; row_count: number }> {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'local_%' OR name = 'adf_audit') ORDER BY name")
      .all() as Array<{ name: string }>

    return tables.map((t) => {
      const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get() as { count: number }
      return { name: t.name, row_count: countRow.count }
    })
  }

  /**
   * Drop a user-created local_* table.
   */
  dropLocalTable(name: string): boolean {
    if (!name.startsWith('local_') || /[^a-zA-Z0-9_]/.test(name)) return false
    this.db.prepare(`DROP TABLE IF EXISTS "${name}"`).run()
    return true
  }

  /**
   * Execute a read-only SQL query. Only allows SELECT on approved tables.
   */
  querySQL(sql: string, params?: unknown[]): unknown[] {
    const stmt = this.db.prepare(sql)
    return params ? stmt.all(...params) : stmt.all()
  }

  /**
   * Execute a write SQL statement. Only for local_* tables (enforced by tool).
   */
  executeSQL(sql: string, params?: unknown[]): { changes: number } {
    const stmt = this.db.prepare(sql)
    const result = params ? stmt.run(...params) : stmt.run()
    return { changes: result.changes }
  }

  // ===========================================================================
  // Convenience Methods for Document/Mind
  // ===========================================================================

  getDocument(): { path: string; content: string } | null {
    const row = this.stmts.getDocumentFile!.get() as
      | { path: string; content: Buffer }
      | undefined
    if (!row) return null
    return { path: row.path, content: row.content.toString('utf-8') }
  }

  setDocument(content: string, path?: string): void {
    const targetPath = path ?? 'document.md'
    const mimeType = this.getMimeTypeForPath(targetPath)
    this.writeFile(targetPath, Buffer.from(content, 'utf-8'), mimeType, 'no_delete')
  }

  getMind(): string {
    const entry = this.readFile('mind.md')
    return entry?.content.toString('utf-8') ?? ''
  }

  setMind(content: string): void {
    this.writeFile('mind.md', Buffer.from(content, 'utf-8'), 'text/markdown', 'no_delete')
  }

  private getMimeTypeForPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase()
    const mimeTypes: Record<string, string> = {
      md: 'text/markdown',
      txt: 'text/plain',
      json: 'application/json',
      js: 'text/javascript',
      ts: 'text/typescript',
      py: 'text/x-python',
      html: 'text/html',
      css: 'text/css'
    }
    return mimeTypes[ext ?? ''] ?? 'application/octet-stream'
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /** Create a pre-destructive-operation backup of this database. */
  backupBeforeDestructive(): string {
    return AdfDatabase.backupBeforeDestructive(this.db, this.filePath)
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  /** Non-blocking checkpoint — flushes WAL to main DB without waiting for readers. */
  checkpointPassive(): void {
    this.db.pragma('wal_checkpoint(PASSIVE)')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
    const remaining = AdfDatabase.decrementOpen(this.filePath)
    // Only the last connection for a given file cleans up -shm/-wal. Earlier
    // closes would hit EBUSY on Windows because another connection still has
    // the files mapped.
    if (remaining > 0) return
    const shmPath = `${this.filePath}-shm`
    const walPath = `${this.filePath}-wal`
    try {
      if (existsSync(shmPath)) unlinkSync(shmPath)
      if (existsSync(walPath)) unlinkSync(walPath)
    } catch (err) {
      console.warn('[AdfDatabase] Could not delete WAL files:', err)
    }
  }

  getFilePath(): string {
    return this.filePath
  }
}
