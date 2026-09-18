/**
 * Agent templates: the `.adf` files in `<userData>/templates`.
 *
 * Every agent Studio creates is an INSTANCE of a template. A template is an
 * ordinary agent file, so anything an agent can hold — config, VFS files,
 * `local_*` tables, timers, peers, stored credentials — a template can hold
 * and pass on. The one rule, printed to users verbatim:
 *
 *   "New agents get everything in a template except its identity and history."
 *
 * The folder is NOT a tracked directory, so templates never show in the
 * sidebar and are never started. Studio ships three (see shipped-templates.ts)
 * and regenerates any that go missing; a user may drop any `.adf` in.
 *
 * Electron-free at module scope: this file sits in the daemon's import graph
 * (RuntimeService hands the default template to sys_create_adf), so `shell`
 * and `dialog` are required lazily, exactly as agent-template-files.ts does
 * for `app`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { basename, extname, join } from 'path'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { CronExpressionParser } from 'cron-parser'
import { watch as watchPaths, type FSWatcher } from 'chokidar'
import type {
  AgentConfig,
  AgentTemplate,
  ModelConfig,
  TimerSchedule
} from '../../shared/types/adf-v02.types'
import { AGENT_DEFAULTS } from '../../shared/types/adf-v02.types'
import type {
  AgentTemplateContents,
  AgentTemplateListResult,
  AgentTemplateSummary,
  ProviderConfig
} from '../../shared/types/ipc.types'
import {
  DEFAULT_SHIPPED_TEMPLATE_ID,
  SHIPPED_TEMPLATES,
  SHIPPED_TEMPLATE_META_KEY,
  getShippedTemplate,
  isShippedTemplateId,
  type ShippedTemplateId
} from '../../shared/constants/shipped-templates'
import {
  RESERVED_SEED_FILE_PATHS,
  TEMPLATE_EXTRA_FILE_MAX_BYTES,
  validateTemplateFilePath
} from '../../shared/utils/agent-template'
import { getUserDataPath } from '../utils/user-data-path'
import { AdfDatabase } from './adf-database'
import { AgentConfigSchema } from './adf-schema'
import { AdfWorkspace } from './adf-workspace'
import { agentTemplateFilesDir } from './agent-template-files'
import { applyDefaultProviderToOptions, resolveDefaultProvider } from './apply-default-provider'
import { deriveReviewIdentity, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { ensureWorkspaceIdentity } from '../runtime/identity-provisioner'

/** History tables an instance never inherits. */
const HISTORY_TABLES = ['adf_loop', 'adf_inbox', 'adf_outbox', 'adf_tasks', 'adf_logs', 'adf_audit'] as const

/** adf_meta keys that describe a PAST run, not a configuration. */
const HISTORY_META_PREFIXES = ['context_baseline_tokens'] as const

/** Seed files the template contents editor owns; everything else is `extra`. */
const SEED_PATHS: readonly string[] = RESERVED_SEED_FILE_PATHS

export type { ShippedTemplateId }

// ---------------------------------------------------------------------------
// Paths and ids
// ---------------------------------------------------------------------------

/** `<userData>/templates`. Sibling of agent-template-files / agent-registry-files. */
export function templatesDir(): string {
  return join(getUserDataPath(), 'templates')
}

export function templateFilePath(id: string): string {
  return join(templatesDir(), `${id}.adf`)
}

/** A template id is a file stem: lowercase, filesystem-safe, never a path. */
export function slugifyTemplateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'template'
}

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.includes('..')
}

function availableTemplateId(base: string): string {
  let id = base
  let n = 2
  while (existsSync(templateFilePath(id))) {
    id = `${base}-${n++}`
  }
  return id
}

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

export interface InstantiateModelChoice {
  /** Provider id from the composer chip. Wins over the template's own provider. */
  providerId?: string
  /** Model id from the composer chip. Falls back to the provider's defaultModel. */
  modelId?: string
  /** App-level providers (settings.providers), used to resolve the ids above. */
  appProviders: ProviderConfig[]
  /** App default provider, used when neither the chip nor the template names a usable one. */
  defaultProvider?: ProviderConfig
}

export interface InstantiateFileArgs extends InstantiateModelChoice {
  /** Absolute path of the template `.adf`. */
  templateFile: string
  /** Absolute path the instance is written to. Must not exist. */
  destPath: string
  /** The instance's name (also its file stem). */
  name: string
}

/**
 * Write a new agent from a template file, per the instantiate rule.
 *
 * Carries: config (fresh id, the new name, model per the precedence below),
 * every VFS file, agent-created `local_*` tables and their indexes, timers,
 * `adf_peers`, and the stored credentials rows (the credentials envelope is
 * wrapped to this install's owner and runtime keyslots, so the instance can
 * still unseal them).
 *
 * Never carries: identity (signing keys, identity envelope, attestations, DID
 * meta) and history (loop, inbox, outbox, tasks, logs, audit). The template's
 * DID is recorded as the instance's `adf_parent_did` for lineage.
 *
 * Built on a `.partial` and renamed into place at the end, so a failure part
 * way through leaves nothing behind. Identity provisioning is the CALLER's
 * job (it owns the owner keys) — an instance is created, not received.
 */
export async function instantiateTemplateFile(args: InstantiateFileArgs): Promise<void> {
  const { templateFile, destPath, name } = args
  if (!existsSync(templateFile)) throw new Error(`Template file not found: ${templateFile}`)
  const partial = `${destPath}.partial`
  try {
    // A template may be open in the contents editor; snapshotTo takes a
    // consistent copy from under a live writer and leaves it self-contained.
    await AdfDatabase.snapshotTo(templateFile, partial)

    // The template's DID, read BEFORE it is stripped — lineage, not identity.
    let parentDid = ''
    try {
      parentDid = AdfDatabase.peek(partial, (db) => {
        const row = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_did'").get() as
          | { value: string }
          | undefined
        return row?.value ?? ''
      })
    } catch {
      parentDid = ''
    }

    // Signing keys, identity envelope, attestations, DID meta. The credentials
    // envelope and the rows it protects stay (see the rule above).
    AdfDatabase.stripIdentity(partial)

    const db = new Database(partial, { fileMustExist: true })
    try {
      db.pragma('busy_timeout = 5000')
      const hasTable = (table: string): boolean =>
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)

      for (const table of HISTORY_TABLES) {
        if (hasTable(table)) db.prepare(`DELETE FROM "${table}"`).run()
      }
      for (const prefix of HISTORY_META_PREFIXES) {
        db.prepare('DELETE FROM adf_meta WHERE key = ? OR key LIKE ?').run(prefix, `${prefix}:%`)
      }
      if (hasTable('adf_timers')) resetTimers(db)

      // --- config ---
      const configRow = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
        | { config_json: string }
        | undefined
      if (!configRow) throw new Error('Template is not a valid .adf file (no config row)')
      const config = JSON.parse(configRow.config_json) as AgentConfig
      const nowIso = new Date().toISOString()
      config.id = nanoid(12)
      config.name = name
      // The live `state` of a template that has run is not a setting. An
      // instance always starts where its config says a new agent starts.
      config.state = config.start_in_state ?? AGENT_DEFAULTS.state
      config.metadata = { ...config.metadata, created_at: nowIso, updated_at: nowIso }
      applyInstanceModel(config, args)
      db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(config))

      // --- meta ---
      const setMeta = db.prepare(
        'INSERT INTO adf_meta (key, value, protection) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      setMeta.run('adf_name', name, 'readonly')
      setMeta.run('adf_handle', config.handle || slugifyTemplateId(name), 'readonly')
      setMeta.run('adf_created_at', nowIso, 'readonly')
      setMeta.run('adf_updated_at', nowIso, 'readonly')
      setMeta.run('adf_parent_did', parentDid, 'readonly')
      setMeta.run('status', '', 'none')
      // An instance is a brand new file nobody has opened: it closed cleanly by
      // construction, so the next open can skip the full integrity check.
      setMeta.run('adf_clean_close', nowIso, 'none')
      // Not a shipped template any more, it is an agent.
      db.prepare('DELETE FROM adf_meta WHERE key = ?').run(SHIPPED_TEMPLATE_META_KEY)
    } finally {
      try { db.close() } catch { /* ignore */ }
    }

    for (const side of ['-wal', '-shm']) {
      try { if (existsSync(`${partial}${side}`)) unlinkSync(`${partial}${side}`) } catch { /* none */ }
    }
    renameSync(partial, destPath)
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm', '.bak', '.corrupt', '.repaired']) {
      try { if (existsSync(`${partial}${suffix}`)) unlinkSync(`${partial}${suffix}`) } catch { /* none */ }
    }
    throw error
  }
}

/**
 * Timers carry, their history does not. Run counts reset to zero and every
 * wake time is recomputed from NOW, so a template that sat on disk for a week
 * cannot hand its instance a backlog of past-due rows that all fire on the
 * first tick (`getDueTimers` selects `next_wake_at <= now`).
 *
 * Rows that can no longer mean anything are dropped rather than carried as
 * dead history: already-expired rows, one-shots whose moment has passed, and
 * cron rows whose expression no longer parses.
 */
function resetTimers(db: Database.Database): void {
  const now = Date.now()
  db.prepare('DELETE FROM adf_timers WHERE expired = 1').run()
  const rows = db.prepare('SELECT id, schedule_json FROM adf_timers').all() as Array<{
    id: number
    schedule_json: string
  }>
  const drop = db.prepare('DELETE FROM adf_timers WHERE id = ?')
  const reset = db.prepare(
    'UPDATE adf_timers SET next_wake_at = ?, run_count = 0, last_fired_at = NULL, created_at = ?, expired = 0 WHERE id = ?'
  )
  for (const row of rows) {
    let schedule: TimerSchedule
    try {
      schedule = JSON.parse(row.schedule_json) as TimerSchedule
    } catch {
      drop.run(row.id)
      continue
    }
    const next = nextWakeFromNow(schedule, now)
    if (next === null) drop.run(row.id)
    else reset.run(next, now, row.id)
  }
}

/** First wake time an instance should have for `schedule`, or null when it can never fire. */
function nextWakeFromNow(schedule: TimerSchedule, now: number): number | null {
  switch (schedule.mode) {
    case 'once':
      return schedule.at > now ? schedule.at : null
    case 'interval': {
      const next = now + schedule.every_ms
      if (schedule.end_at !== undefined && next > schedule.end_at) return null
      return next
    }
    case 'cron': {
      try {
        const next = CronExpressionParser.parse(schedule.cron, { currentDate: new Date(now) })
          .next()
          .getTime()
        if (schedule.end_at !== undefined && next > schedule.end_at) return null
        return next
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

/**
 * Provider and model precedence: the composer's chip wins, then the template's
 * own provider when this install still has it, then the app default. Whatever
 * provider ends up on `config.model` also gets a secrets-stripped entry in
 * `config.providers`, so the instance stays self-contained.
 */
function applyInstanceModel(config: AgentConfig, choice: InstantiateModelChoice): void {
  const chosen = choice.providerId
    ? choice.appProviders.find((p) => p.id === choice.providerId)
    : undefined

  if (chosen) {
    const modelId = (choice.modelId ?? '').trim() || chosen.defaultModel || ''
    config.model = { ...config.model, provider: chosen.id, model_id: modelId } as ModelConfig
    if (chosen.params?.length) config.model.params = chosen.params.map((p) => ({ ...p }))
    mergeProviderEntry(config, chosen)
    return
  }

  // No chip choice. A template provider this install no longer has would leave
  // the instance pointing at nothing, so it is cleared and the default fills in.
  const templateProviderId = config.model?.provider
  const templateProviderUsable =
    !!templateProviderId && choice.appProviders.some((p) => p.id === templateProviderId)
  if (templateProviderUsable) {
    const local = choice.appProviders.find((p) => p.id === templateProviderId)!
    mergeProviderEntry(config, local)
    return
  }

  const patched = applyDefaultProviderToOptions(
    { name: config.name, model: { ...config.model, provider: '', model_id: '' }, providers: config.providers },
    choice.defaultProvider
  )
  config.model = { ...config.model, ...(patched.model as AgentConfig['model']) }
  if (patched.providers) config.providers = patched.providers
}

/** Add a secrets-stripped copy of `provider` to config.providers when absent. */
function mergeProviderEntry(config: AgentConfig, provider: ProviderConfig): void {
  const patched = applyDefaultProviderToOptions(
    { name: config.name, model: { provider: '', model_id: '' }, providers: config.providers },
    provider
  )
  if (patched.providers) config.providers = patched.providers
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface TemplatesSettings {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface AgentTemplatesDeps {
  settings: TemplatesSettings
  /** Local owner DID, for classifying a template's identity (own / foreign / unclaimed). */
  getOwnerDid: () => string
  /** Push IPC.TEMPLATES_CHANGED to the renderer. */
  notifyChanged: () => void
}

export class AgentTemplatesService {
  private watcher: FSWatcher | null = null
  private notifyTimer: NodeJS.Timeout | null = null
  private shippedEnsured = false

  constructor(private readonly deps: AgentTemplatesDeps) {}

  /** settings.defaultTemplateId, else 'standard'. */
  defaultTemplateId(): string {
    const id = this.deps.settings.get('defaultTemplateId')
    return isSafeId(id) ? id : DEFAULT_SHIPPED_TEMPLATE_ID
  }

  // --- shipped ---

  /**
   * Create any shipped template whose file is missing. Idempotent and cheap:
   * a file that already exists is never rewritten, and a user file that
   * happens to share a shipped name is left alone (only files carrying the
   * `adf_template_shipped` marker are ours to regenerate).
   */
  ensureShipped(): void {
    mkdirSync(templatesDir(), { recursive: true })
    for (const shipped of SHIPPED_TEMPLATES) {
      const path = templateFilePath(shipped.id)
      if (existsSync(path)) continue
      try {
        this.writeShipped(shipped.id)
      } catch (err) {
        console.warn(`[Templates] Could not create shipped template "${shipped.id}":`, err)
      }
    }
    this.shippedEnsured = true
  }

  /**
   * Overwrite a shipped template with the code version. A same-named file that
   * does NOT carry the shipped marker is somebody's own template that happens
   * to share the name, and is refused rather than replaced.
   */
  resetShipped(id: string): { success: boolean; error?: string } {
    if (!isShippedTemplateId(id)) return { success: false, error: `"${id}" is not a shipped template.` }
    const path = templateFilePath(id)
    if (existsSync(path) && this.shippedMarker(path) !== id) {
      return { success: false, error: `${id}.adf in the templates folder is not the shipped template. Rename or remove it first.` }
    }
    try {
      this.writeShipped(id)
      this.pushChanged()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The file's `adf_template_shipped` value, or null when it carries none. */
  private shippedMarker(filePath: string): string | null {
    try {
      return AdfDatabase.peek(filePath, (db) => {
        const row = db.prepare('SELECT value FROM adf_meta WHERE key = ?').get(SHIPPED_TEMPLATE_META_KEY) as
          | { value: string }
          | undefined
        return row?.value ?? null
      })
    } catch {
      return null
    }
  }

  private writeShipped(id: ShippedTemplateId): void {
    const shipped = getShippedTemplate(id)!
    const path = templateFilePath(id)
    mkdirSync(templatesDir(), { recursive: true })
    const workspace = AdfWorkspace.create(path, {
      name: shipped.name,
      description: shipped.description,
      template: { ...shipped.template, files: { readme: shipped.readme } }
    })
    try {
      // A template is the owner's own file: it gets an identity so instances
      // have a parent DID to record, and it is reviewed by construction.
      ensureWorkspaceIdentity(workspace)
      workspace.setMeta(SHIPPED_TEMPLATE_META_KEY, id, 'readonly')
      this.markReviewed(workspace.getAgentConfig())
    } finally {
      workspace.close()
    }
  }

  // --- list ---

  list(): AgentTemplateListResult {
    if (!this.shippedEnsured) this.ensureShipped()
    this.migrateLegacySnapshot()
    const folder = templatesDir()
    mkdirSync(folder, { recursive: true })

    const templates: AgentTemplateSummary[] = []
    for (const file of listAdfFiles(folder)) {
      const summary = this.summarize(file)
      if (summary) templates.push(summary)
    }
    templates.sort((a, b) => a.name.localeCompare(b.name))

    const result: AgentTemplateListResult = {
      templates,
      folder,
      defaultId: this.defaultTemplateId()
    }
    const migratedId = this.deps.settings.get('templatesMigratedAt')
      && this.deps.settings.get('templatesMigrationSeen') !== true
      ? this.migratedTemplateId()
      : null
    if (migratedId) result.migrated = { id: migratedId }
    return result
  }

  private migratedTemplateId(): string | null {
    const id = this.deps.settings.get('defaultTemplateId')
    return isSafeId(id) && existsSync(templateFilePath(id)) && !isShippedTemplateId(id) ? id : null
  }

  markMigrationSeen(): void {
    this.deps.settings.set('templatesMigrationSeen', true)
  }

  private summarize(filePath: string): AgentTemplateSummary | null {
    const id = basename(filePath, '.adf')
    try {
      const peeked = AdfDatabase.peek(filePath, (db) => {
        const configRow = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as
          | { config_json: string }
          | undefined
        if (!configRow) return null
        const metaRows = db
          .prepare("SELECT key, value FROM adf_meta WHERE key IN ('adf_did', 'adf_owner_did', ?)")
          .all(SHIPPED_TEMPLATE_META_KEY) as Array<{ key: string; value: string }>
        const meta = new Map(metaRows.map((r) => [r.key, r.value]))
        // Informational only, and an ancient file may not have the table.
        let hasHistory = false
        try {
          hasHistory = !!(db.prepare('SELECT EXISTS(SELECT 1 FROM adf_loop) AS present').get() as { present: number }).present
        } catch { /* no loop table */ }
        return {
          config: JSON.parse(configRow.config_json) as AgentConfig,
          agentDid: meta.get('adf_did') || null,
          ownerDid: meta.get('adf_owner_did') || null,
          shipped: meta.get(SHIPPED_TEMPLATE_META_KEY) || undefined,
          hasHistory
        }
      })
      if (!peeked) return null

      // Only `needsClaim` is wanted here, and it is decided by the agent DID
      // and the file's owner DID alone: the envelope states below split 'mine'
      // from 'recognized', neither of which needs a claim. Reading them would
      // mean unwrapping keys for every file on every folder refresh.
      const identity = deriveReviewIdentity({
        agentDid: peeked.agentDid,
        fileOwnerDid: peeked.ownerDid,
        fileRuntimeDid: null,
        localOwnerDid: this.deps.getOwnerDid(),
        localRuntimeDid: '',
        identityEnvelope: 'absent',
        credentialsEnvelope: 'absent',
        sharePasswordSet: false,
        filePasswordProtected: false,
        ownerKeyAvailable: true
      })
      const reviewed =
        !identity.needsClaim || isConfigReviewed(this.deps.settings.get('reviewedAgents'), peeked.config)

      return {
        id,
        name: peeked.config.name || id,
        description: peeked.config.description || undefined,
        icon: peeked.config.icon,
        filePath,
        ...(isShippedTemplateId(peeked.shipped ?? '') ? { shipped: peeked.shipped as ShippedTemplateId } : {}),
        reviewed,
        modelProvider: peeked.config.model?.provider || undefined,
        modelId: peeked.config.model?.model_id || undefined,
        modifiedAt: safeMtime(filePath),
        hasHistory: peeked.hasHistory
      }
    } catch (err) {
      console.warn(`[Templates] Could not read ${basename(filePath)}:`, err)
      return null
    }
  }

  // --- create / delete / reveal / default ---

  /**
   * A new template: blank from the code defaults, or a duplicate of `fromId`.
   * A duplicate is a template, not a received file, so it starts clean by the
   * same rule instances do: no identity, no history.
   */
  async create(args: { name: string; fromId?: string }): Promise<{ success: boolean; id?: string; error?: string }> {
    const name = (args?.name ?? '').trim()
    if (!name) return { success: false, error: 'Name is required.' }
    if (name.length > 64) return { success: false, error: 'Name is longer than 64 characters.' }

    let source: string | null = null
    if (args.fromId !== undefined) {
      if (!isSafeId(args.fromId)) return { success: false, error: 'Unknown template.' }
      source = templateFilePath(args.fromId)
      if (!existsSync(source)) return { success: false, error: `${args.fromId}.adf is not in the templates folder.` }
    }

    const id = availableTemplateId(slugifyTemplateId(name))
    const path = templateFilePath(id)
    mkdirSync(templatesDir(), { recursive: true })
    try {
      if (source) {
        const appProviders = this.appProviders()
        await instantiateTemplateFile({
          templateFile: source,
          destPath: path,
          name,
          appProviders,
          defaultProvider: this.defaultProvider(appProviders)
        })
        const workspace = AdfWorkspace.open(path)
        try {
          ensureWorkspaceIdentity(workspace)
          this.markReviewed(workspace.getAgentConfig())
        } finally {
          workspace.close()
        }
      } else {
        const workspace = AdfWorkspace.create(path, { name })
        try {
          ensureWorkspaceIdentity(workspace)
          this.markReviewed(workspace.getAgentConfig())
        } finally {
          workspace.close()
        }
      }
      this.pushChanged()
      return { success: true, id }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async delete(id: string): Promise<{ success: boolean; error?: string }> {
    if (!isSafeId(id)) return { success: false, error: 'Unknown template.' }
    const path = templateFilePath(id)
    if (!existsSync(path)) return { success: true }
    try {
      const { shell } = require('electron') as typeof import('electron')
      await shell.trashItem(path)
      if (this.defaultTemplateId() === id) {
        this.deps.settings.set('defaultTemplateId', DEFAULT_SHIPPED_TEMPLATE_ID)
      }
      this.pushChanged()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  reveal(id: string): void {
    const { shell } = require('electron') as typeof import('electron')
    const path = isSafeId(id) ? templateFilePath(id) : ''
    if (path && existsSync(path)) shell.showItemInFolder(path)
    else shell.openPath(templatesDir())
  }

  setDefault(id: string): { success: boolean; error?: string } {
    if (!isSafeId(id)) return { success: false, error: 'Unknown template.' }
    if (!existsSync(templateFilePath(id))) return { success: false, error: `${id}.adf is not in the templates folder.` }
    this.deps.settings.set('defaultTemplateId', id)
    this.pushChanged()
    return { success: true }
  }

  // --- contents ---

  getContents(id: string): { success: boolean; contents?: AgentTemplateContents; error?: string } {
    if (!isSafeId(id)) return { success: false, error: 'Unknown template.' }
    const path = templateFilePath(id)
    if (!existsSync(path)) return { success: false, error: `${id}.adf is not in the templates folder.` }
    try {
      const workspace = AdfWorkspace.open(path)
      try {
        const contents: AgentTemplateContents = {
          config: workspace.getAgentConfig(),
          files: {
            readme: workspace.readFile('README.md') ?? '',
            mind: workspace.readFile('mind.md') ?? '',
            soul: workspace.readFile('soul.md') ?? ''
          },
          extra: workspace
            .listFiles()
            .filter((f) => !SEED_PATHS.includes(f.path))
            .map((f) => ({ path: f.path, size: f.size, mime: f.mime_type ?? 'application/octet-stream' }))
        }
        return { success: true, contents }
      } finally {
        workspace.close()
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  setConfig(args: { id: string; config: AgentConfig }): { success: boolean; error?: string } {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    const path = templateFilePath(args.id)
    if (!existsSync(path)) return { success: false, error: `${args.id}.adf is not in the templates folder.` }
    // Validate before opening: an invalid config must not touch the file.
    const parsed = AgentConfigSchema.safeParse(args.config)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return { success: false, error: `${first.path.join('.') || 'config'}: ${first.message}` }
    }
    try {
      const workspace = AdfWorkspace.open(path)
      try {
        workspace.setAgentConfig(args.config)
        workspace.setMeta('adf_name', args.config.name, 'readonly')
      } finally {
        workspace.close()
      }
      this.pushChanged()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  setFile(args: { id: string; path: string; content: string }): { success: boolean; error?: string } {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    const file = (args?.path ?? '').trim()
    if (!file) return { success: false, error: 'Path is required.' }
    if (!SEED_PATHS.includes(file) && validateExtraPath(file) !== null) {
      return { success: false, error: validateExtraPath(file)! }
    }
    const path = templateFilePath(args.id)
    if (!existsSync(path)) return { success: false, error: `${args.id}.adf is not in the templates folder.` }
    try {
      const workspace = AdfWorkspace.open(path)
      try {
        workspace.writeFile(file, args.content ?? '')
      } finally {
        workspace.close()
      }
      this.pushChanged()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Native multi-select picker; copies the chosen host files into the template's VFS. */
  async addFiles(id: string): Promise<{ success: boolean; added?: string[]; error?: string }> {
    if (!isSafeId(id)) return { success: false, error: 'Unknown template.' }
    const path = templateFilePath(id)
    if (!existsSync(path)) return { success: false, error: `${id}.adf is not in the templates folder.` }
    const { BrowserWindow, dialog } = require('electron') as typeof import('electron')
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (picked.canceled || picked.filePaths.length === 0) return { success: false, error: 'Cancelled' }

    // Whole batch or nothing: stat everything before any write.
    const staged: { host: string; dest: string }[] = []
    try {
      const workspace = AdfWorkspace.open(path)
      try {
        const taken = new Set(workspace.listFiles().map((f) => f.path))
        for (const host of picked.filePaths) {
          const stat = statSync(host)
          if (!stat.isFile()) return { success: false, error: `${basename(host)} is not a file.` }
          if (stat.size > TEMPLATE_EXTRA_FILE_MAX_BYTES) {
            const mb = Math.round(TEMPLATE_EXTRA_FILE_MAX_BYTES / (1024 * 1024))
            return { success: false, error: `${basename(host)} is larger than ${mb} MB.` }
          }
          const dest = availableVfsPath(basename(host), taken)
          const invalid = validateExtraPath(dest)
          if (invalid) return { success: false, error: `${basename(host)}: ${invalid}` }
          taken.add(dest)
          staged.push({ host, dest })
        }
        for (const { host, dest } of staged) {
          workspace.writeFileBuffer(dest, readFileSync(host), AdfWorkspace.mimeTypeForPath(dest))
        }
      } finally {
        workspace.close()
      }
      this.pushChanged()
      return { success: true, added: staged.map((s) => s.dest) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  removeFile(args: { id: string; path: string }): { success: boolean; error?: string } {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    const file = (args?.path ?? '').trim()
    if (!file) return { success: false, error: 'Path is required.' }
    if (SEED_PATHS.includes(file)) return { success: false, error: `${file} is a seed file; clear its text instead.` }
    const path = templateFilePath(args.id)
    if (!existsSync(path)) return { success: false, error: `${args.id}.adf is not in the templates folder.` }
    try {
      const workspace = AdfWorkspace.open(path)
      try {
        workspace.deleteFile(file, { force: true })
      } finally {
        workspace.close()
      }
      this.pushChanged()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // --- instantiate ---

  /**
   * Create an agent at `destPath` from a template. Refuses plainly when the
   * template is gone (`template_missing`) or came from someone else and has
   * not been reviewed (`template_unreviewed`). Identity provisioning and the
   * reviewed mark are the caller's tail, exactly as for a hand-made agent.
   */
  async instantiate(args: {
    templateId?: string
    destPath: string
    name: string
    providerId?: string
    modelId?: string
  }): Promise<{ success: boolean; error?: string; code?: 'template_missing' | 'template_unreviewed' }> {
    const requestedId = isSafeId(args.templateId) ? args.templateId : this.defaultTemplateId()
    let file = templateFilePath(requestedId)

    if (!existsSync(file)) {
      // A shipped template is code, so a missing one is regenerated rather
      // than refused. A user template that is gone is gone.
      if (isShippedTemplateId(requestedId)) {
        try {
          this.writeShipped(requestedId)
        } catch (err) {
          return { success: false, code: 'template_missing', error: `Could not regenerate the "${requestedId}" template: ${err instanceof Error ? err.message : String(err)}` }
        }
        file = templateFilePath(requestedId)
      } else {
        return { success: false, code: 'template_missing', error: `${requestedId}.adf is not in the templates folder any more.` }
      }
    }

    const summary = this.summarize(file)
    if (!summary) {
      return { success: false, code: 'template_missing', error: `${basename(file)} could not be read as an agent file.` }
    }
    if (!summary.reviewed) {
      return { success: false, code: 'template_unreviewed', error: `Review the "${summary.name}" template before creating agents from it.` }
    }

    const appProviders = this.appProviders()
    await instantiateTemplateFile({
      templateFile: file,
      destPath: args.destPath,
      name: args.name,
      providerId: args.providerId,
      modelId: args.modelId,
      appProviders,
      defaultProvider: this.defaultProvider(appProviders)
    })
    return { success: true }
  }

  /**
   * Host path of the template children get (`sys_create_adf`), or undefined
   * when the owner has not opted children in. Children get config + files +
   * local tables, never credentials or identity rows.
   */
  childTemplatePath(): string | undefined {
    if (this.deps.settings.get('agentTemplateForChildren') !== true) return undefined
    const id = this.defaultTemplateId()
    const file = templateFilePath(id)
    if (existsSync(file)) return file
    if (!isShippedTemplateId(id)) return undefined
    try {
      this.writeShipped(id)
      return templateFilePath(id)
    } catch {
      return undefined
    }
  }

  // --- legacy migration ---

  /**
   * One-time move off `settings.agentTemplate` (a config diff plus seed files
   * plus a blob store) onto a template FILE. A non-empty snapshot becomes
   * `my-defaults.adf` and the default; an empty one just stamps the date. The
   * setting is deleted either way, so nothing reads it again.
   */
  migrateLegacySnapshot(): void {
    if (this.deps.settings.get('templatesMigratedAt')) return
    const snapshot = this.deps.settings.get('agentTemplate') as AgentTemplate | undefined
    const isEmpty = !snapshot || Object.keys(snapshot).length === 0
    if (isEmpty) {
      this.deps.settings.set('templatesMigratedAt', Date.now())
      this.deps.settings.set('templatesMigrationSeen', true)
      this.deps.settings.delete('agentTemplate')
      return
    }
    try {
      mkdirSync(templatesDir(), { recursive: true })
      const id = availableTemplateId('my-defaults')
      const workspace = AdfWorkspace.create(templateFilePath(id), {
        name: 'My defaults',
        description: 'Your previous Settings agent template, saved as a template file.',
        template: snapshot,
        templateFilesDir: agentTemplateFilesDir()
      })
      try {
        ensureWorkspaceIdentity(workspace)
        this.markReviewed(workspace.getAgentConfig())
      } finally {
        workspace.close()
      }
      this.deps.settings.set('defaultTemplateId', id)
      this.deps.settings.set('templatesMigratedAt', Date.now())
      this.deps.settings.delete('agentTemplate')
    } catch (err) {
      console.warn('[Templates] Legacy agent template migration failed:', err)
      // Leave templatesMigratedAt unset so the next list retries; the old
      // setting stays put meanwhile.
    }
  }

  // --- watcher ---

  /**
   * A small watcher of its own. The tracked-directory watcher must not be
   * pointed here: it maps every event back to a tracked root and autostarts
   * new files, and templates are neither tracked nor runnable.
   */
  startWatcher(): void {
    if (this.watcher) return
    const folder = templatesDir()
    mkdirSync(folder, { recursive: true })
    this.watcher = watchPaths(folder, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (path: string, stats?: import('fs').Stats) =>
        !!stats?.isFile() && !path.endsWith('.adf')
    })
    const bump = (): void => this.pushChanged()
    this.watcher.on('add', bump)
    this.watcher.on('change', bump)
    this.watcher.on('unlink', bump)
  }

  stopWatcher(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    void this.watcher?.close()
    this.watcher = null
  }

  /** Debounced TEMPLATES_CHANGED. Called by the watcher and after our own writes. */
  pushChanged(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      try {
        this.deps.notifyChanged()
      } catch (err) {
        console.warn('[Templates] Change notification failed:', err)
      }
    }, 150)
  }

  // --- helpers ---

  private appProviders(): ProviderConfig[] {
    return (this.deps.settings.get('providers') as ProviderConfig[]) ?? []
  }

  private defaultProvider(appProviders: ProviderConfig[]): ProviderConfig | undefined {
    return resolveDefaultProvider(appProviders, this.deps.settings.get('defaultProviderId') as string | undefined)
  }

  markReviewed(config: AgentConfig): void {
    this.deps.settings.set('reviewedAgents', markConfigReviewed(this.deps.settings.get('reviewedAgents'), config))
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function listAdfFiles(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((f: string) => f.toLowerCase().endsWith('.adf'))
      .map((f: string) => join(folder, f))
  } catch {
    return []
  }
}

function safeMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/** Reuse the extra-file path rules, minus the "reserved seed" clause callers check themselves. */
function validateExtraPath(path: string): string | null {
  return validateTemplateFilePath(path)
}

/** `report.pdf` → `report-2.pdf` when the basename is already in the VFS. */
function availableVfsPath(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let n = 2
  while (taken.has(`${stem}-${n}${ext}`)) n++
  return `${stem}-${n}${ext}`
}
