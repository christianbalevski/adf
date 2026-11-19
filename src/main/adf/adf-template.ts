/**
 * ADF Template Helper
 *
 * Reads a template .adf blob from a parent agent's VFS, validates locked fields,
 * and merges template config with explicit overrides in a single pass.
 */

import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { tmpdir } from 'os'
import { join } from 'path'
import { isDeepStrictEqual } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { AdfDatabase } from './adf-database'
import type { AdfWorkspace } from './adf-workspace'
import type {
  AgentConfig,
  CreateAgentOptions,
  FileProtectionLevel,
  ToolDeclaration,
  TriggersConfigV3,
  TriggerTypeV3,
  ServingConfig
} from '../../shared/types/adf-v02.types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateFile {
  path: string
  content: Buffer
  mime_type: string | null
  protection: FileProtectionLevel
}

export interface TemplateIdentityRow {
  purpose: string
  value: Buffer
  encryption_algo: string
  salt: Buffer | null
  kdf_params: string | null
  code_access: boolean
}

export interface TemplateCustomTable {
  name: string
  ddl: string
  rows: Record<string, unknown>[]
}

export interface TemplateData {
  config: AgentConfig
  files: TemplateFile[]
  identityRows: TemplateIdentityRow[]
  customTables: TemplateCustomTable[]
  customIndexes: string[]
}

export type MergeResult =
  | { ok: true; options: CreateAgentOptions }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// readTemplate
// ---------------------------------------------------------------------------

/**
 * Read a template .adf from the parent workspace's VFS. Writes it to a temp
 * file so SQLite can open it, reads config/files/identity, then cleans up.
 */
export function readTemplate(
  parentWorkspace: AdfWorkspace,
  templatePath: string
): TemplateData {
  const blob = parentWorkspace.readFileBuffer(templatePath)
  if (!blob) {
    throw new Error(`Template not found: ${templatePath}`)
  }

  const tempPath = join(tmpdir(), `adf-tpl-${nanoid(8)}.adf`)
  writeFileSync(tempPath, blob)

  try {
    return readTemplateDatabase(tempPath)
  } finally {
    try {
      unlinkSync(tempPath)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tempPath + '-shm')
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tempPath + '-wal')
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a template straight from a HOST `.adf` — the Studio agent-templates
 * folder, which the host hands the tool as a path (`getStudioTemplate`).
 *
 * `includeIdentityRows: false` drops the template's stored credentials. A
 * Studio template is the owner's file and may hold API keys; a child an agent
 * spawns must not gain credentials it was never granted, so the host passes
 * false and only config, files and `local_*` tables travel.
 */
export function readTemplateFile(
  hostPath: string,
  opts: { includeIdentityRows?: boolean } = {}
): TemplateData {
  // peek, not a bare readonly open: a readonly connection to a WAL database
  // creates -wal/-shm it cannot remove, and the templates folder must not
  // collect sidecars every time a child is spawned.
  const data = AdfDatabase.peek(hostPath, readTemplateFromDb)
  if (opts.includeIdentityRows === false) data.identityRows = []
  return data
}

/** Shared reader over an already-open readonly connection to a template database. */
function readTemplateDatabase(dbPath: string): TemplateData {
  const db = new Database(dbPath, { readonly: true })
  try {
    return readTemplateFromDb(db)
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function readTemplateFromDb(db: Database.Database): TemplateData {
  // Read config
  const configRow = db
    .prepare('SELECT config_json FROM adf_config WHERE id = 1')
    .get() as { config_json: string } | undefined
  if (!configRow) {
    throw new Error('Template is not a valid .adf file')
  }
  const config = JSON.parse(configRow.config_json) as AgentConfig

  // Read files
  const fileRows = db
    .prepare(
      'SELECT path, content, mime_type, protection FROM adf_files'
    )
    .all() as Array<{
    path: string
    content: Buffer
    mime_type: string | null
    protection: string
  }>
  const files: TemplateFile[] = fileRows.map((r) => ({
    path: r.path,
    content: r.content,
    mime_type: r.mime_type,
    protection: r.protection as FileProtectionLevel
  }))

  // Read identity rows — exclude all key material (crypto:*): signing keys,
  // KDF params, and envelope descriptors. A descriptor is stored plain but
  // wraps the template's DEK; copied over a child's own, it replaces the DEK
  // the child's private key was sealed with, so the child's signing key can
  // no longer be opened.
  const identityRows = db
    .prepare(
      'SELECT purpose, value, encryption_algo, salt, kdf_params, code_access FROM adf_identity'
    )
    .all() as Array<{
    purpose: string
    value: Buffer
    encryption_algo: string
    salt: Buffer | null
    kdf_params: string | null
    code_access: number
  }>

  const filteredIdentity: TemplateIdentityRow[] = identityRows
    .filter(
      (r) => !r.purpose.startsWith('crypto:') && r.encryption_algo === 'plain'
    )
    .map((r) => ({
      purpose: r.purpose,
      value: r.value,
      encryption_algo: r.encryption_algo,
      salt: r.salt,
      kdf_params: r.kdf_params,
      code_access: !!r.code_access
    }))

  // Read custom tables (non-adf_, non-sqlite_ tables)
  const tableRows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' " +
      "AND name NOT LIKE 'adf_%' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as Array<{ name: string; sql: string }>

  const customTables: TemplateCustomTable[] = tableRows.map((t) => {
    const rows = db
      .prepare(`SELECT * FROM "${t.name}"`)
      .all() as Record<string, unknown>[]
    return { name: t.name, ddl: t.sql, rows }
  })

  // Also grab indexes for custom tables
  const indexRows = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' " +
      "AND tbl_name NOT LIKE 'adf_%' AND tbl_name NOT LIKE 'sqlite_%' " +
      "AND sql IS NOT NULL"
    )
  .all() as Array<{ sql: string }>

  return { config, files, identityRows: filteredIdentity, customTables, customIndexes: indexRows.map((r) => r.sql) }
}

// ---------------------------------------------------------------------------
// mergeTemplateWithOverrides — unified validate + merge
// ---------------------------------------------------------------------------

/**
 * Walks the template config and overrides at the same granularity, checking
 * locks at every merge point. Returns either the merged CreateAgentOptions
 * or an error string describing the first lock violation found.
 */
export function mergeTemplateWithOverrides(
  templateConfig: AgentConfig,
  overrides: Partial<CreateAgentOptions>
): MergeResult {
  const lockedFields = templateConfig.locked_fields ?? []

  // ---- 1. locked_fields ----
  // A lock is a top-level key or a dotted path ('model', 'model.model_id').
  // Leaving a locked field out of the overrides keeps the template value;
  // setting it to anything else is refused. Fields beside it stay open.
  // `name` is the new file's name, so every child sets its own.
  const locks: { lock: string; path: string[] }[] = []
  for (const lock of lockedFields) {
    const path = lock.split('.')
    if (path.some((key) => UNSAFE_KEYS.has(key))) {
      return { ok: false, error: `Template lock '${lock}' is not a config path.` }
    }
    if (path[0] !== 'name') locks.push({ lock, path })
  }
  for (const { lock, path } of locks) {
    const wanted = valueAt(overrides, path)
    if (wanted !== undefined && changes(wanted, valueAt(templateConfig, path))) {
      return { ok: false, error: `Template locks '${lock}'; it cannot be changed. Leave it out of the overrides to keep the template value.` }
    }
  }

  // Prevent overriding locked_fields itself
  if (overrides.locked_fields !== undefined) {
    return { ok: false, error: 'Cannot override template locked_fields' }
  }

  // ---- 2. Tools merge ----
  const mergedTools = mergeTools(templateConfig.tools, overrides.tools)
  if (!mergedTools.ok) return mergedTools

  // ---- 3. Triggers merge ----
  const mergedTriggers = mergeTriggers(templateConfig.triggers, overrides.triggers)
  if (!mergedTriggers.ok) return mergedTriggers

  // ---- 4. Serving merge ----
  const mergedServing = mergeServing(templateConfig.serving, overrides.serving)
  if (!mergedServing.ok) return mergedServing

  let commands = templateConfig.commands
  if (overrides.commands !== undefined) {
    const kept = keepLocked((templateConfig.commands ?? []).filter((c) => c.locked), overrides.commands,
      (a, b) => a.name === b.name, (c) => `command '${c.name}'`)
    if (!kept.ok) return kept
    commands = kept.value
  }

  // ---- 5. Build final CreateAgentOptions ----
  const options: CreateAgentOptions = {
    name: overrides.name ?? templateConfig.name,
    description: overrides.description ?? templateConfig.description,
    instructions: overrides.instructions ?? templateConfig.instructions,
    icon: overrides.icon ?? templateConfig.icon,
    handle: overrides.handle ?? templateConfig.handle,
    autonomous: overrides.autonomous ?? templateConfig.autonomous,
    autostart: overrides.autostart ?? templateConfig.autostart,
    start_in_state: overrides.start_in_state ?? templateConfig.start_in_state,

    // Shallow merge per section
    model: overrides.model
      ? { ...templateConfig.model, ...overrides.model }
      : templateConfig.model,
    context: overrides.context
      ? { ...templateConfig.context, ...overrides.context }
      : templateConfig.context,
    security: overrides.security
      ? { ...templateConfig.security, ...overrides.security }
      : templateConfig.security,
    limits: overrides.limits
      ? { ...templateConfig.limits, ...overrides.limits }
      : templateConfig.limits,
    messaging: overrides.messaging
      ? { ...templateConfig.messaging, ...overrides.messaging }
      : templateConfig.messaging,

    // Deep-merged sections
    tools: mergedTools.value,
    triggers: mergedTriggers.value,

    // Always preserve template locked_fields
    locked_fields: lockedFields.length > 0 ? lockedFields : undefined,

    // Optional sections: override if provided, else use template if present
    ...(overrides.audit ?? templateConfig.audit
      ? { audit: overrides.audit ?? templateConfig.audit }
      : {}),
    ...(overrides.pre_llm_hook ?? templateConfig.pre_llm_hook
      ? { pre_llm_hook: overrides.pre_llm_hook ?? templateConfig.pre_llm_hook }
      : {}),
    ...(overrides.code_execution ?? templateConfig.code_execution
      ? {
          code_execution: overrides.code_execution
            ? { ...templateConfig.code_execution, ...overrides.code_execution }
            : templateConfig.code_execution
        }
      : {}),
    ...(overrides.logging ?? templateConfig.logging
      ? { logging: overrides.logging ?? templateConfig.logging }
      : {}),
    ...(overrides.mcp ?? templateConfig.mcp
      ? { mcp: overrides.mcp ?? templateConfig.mcp }
      : {}),
    ...(overrides.adapters ?? templateConfig.adapters
      ? { adapters: overrides.adapters ?? templateConfig.adapters }
      : {}),
    ...(commands ? { commands } : {}),
    ...(mergedServing.value ? { serving: mergedServing.value } : {}),
    ...(overrides.providers ?? templateConfig.providers
      ? { providers: overrides.providers ?? templateConfig.providers }
      : {}),
    ...(overrides.ws_connections ?? templateConfig.ws_connections
      ? { ws_connections: overrides.ws_connections ?? templateConfig.ws_connections }
      : {}),
    ...(overrides.card ?? templateConfig.card
      ? { card: overrides.card ?? templateConfig.card }
      : {}),
    metadata: (overrides.metadata || templateConfig.metadata)
      ? {
          ...(templateConfig.metadata
            ? { author: templateConfig.metadata.author, tags: templateConfig.metadata.tags, version: templateConfig.metadata.version }
            : {}),
          ...overrides.metadata
        }
      : undefined
  }

  // Sections taken whole from the overrides (audit, mcp, logging, ...) can
  // drop a locked field by leaving it out; put the template value back.
  for (const { path } of locks) {
    const kept = valueAt(templateConfig, path)
    if (kept !== undefined) setAt(options as unknown as Record<string, unknown>, path, structuredClone(kept))
  }
  // A child records its own creation time, even under a `metadata` lock.
  if (options.metadata) {
    const { author, tags, version } = options.metadata
    options.metadata = { author, tags, version }
  }

  // A template baseline must never be able to pre-grant a locked dangerous
  // capability with no HIL ever firing. sys-update-config's code-level lock
  // (DEFAULT_LOCKED_PATHS: security.allow_local_fetch, stream_bind) only
  // gates future WRITES to these paths — it says nothing about the value a
  // brand-new agent is BORN with, so a template could otherwise ship them
  // pre-enabled and skip approval entirely. Force both to safe defaults here,
  // and only let a value through when the CALLER explicitly asked for it via
  // `overrides` — never when it was merely inherited from the template.
  if (overrides.security?.allow_local_fetch !== true) {
    options.security = { ...options.security, allow_local_fetch: false }
  }
  // stream_bind is never populated from the template baseline above (it isn't
  // one of the sections merged into `options`), and CreateAgentOptions has no
  // caller-facing override path for it today either — so it is already absent
  // from `options`. This is an explicit, unconditional strip rather than an
  // assumption, so the guarantee holds even if a future edit adds stream_bind
  // to the merged sections above.
  delete options.stream_bind

  return { ok: true, options }
}

// A lock path is walked into objects; these would reach a prototype.
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function valueAt(obj: unknown, path: string[]): unknown {
  let cur = obj
  for (const key of path) {
    if (!isRecord(cur) || !Object.hasOwn(cur, key)) return undefined
    cur = cur[key]
  }
  return cur
}

function setAt(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(cur, key) || !isRecord(cur[key])) cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
}

/** True when `wanted` sets any field to something other than `current`. Fields it leaves out are not changes. */
function changes(wanted: unknown, current: unknown): boolean {
  if (isRecord(wanted) && isRecord(current)) {
    return Object.keys(wanted).some((k) => wanted[k] !== undefined && changes(wanted[k], current[k]))
  }
  return !isDeepStrictEqual(wanted, current)
}

type KeepResult<T> = { ok: true; value: T[] } | { ok: false; error: string }

/**
 * A list the overrides replace, with the template's locked items carried
 * forward. An override item matching a locked one may restate it unchanged
 * (it is not added twice); changing it is refused.
 */
function keepLocked<T>(locked: T[], incoming: T[], same: (a: T, b: T) => boolean, label: (item: T) => string): KeepResult<T> {
  const rest: T[] = []
  for (const item of incoming) {
    const held = locked.find((l) => same(l, item))
    if (!held) rest.push(item)
    else if (changes(item, held)) {
      return { ok: false, error: `Template locks ${label(held)}; it cannot be changed. Leave it out of the overrides to keep the template setting.` }
    }
  }
  return { ok: true, value: [...locked, ...rest] }
}

// ---------------------------------------------------------------------------
// Tools merge helper
// ---------------------------------------------------------------------------

type ToolMergeResult =
  | { ok: true; value: ToolDeclaration[] }
  | { ok: false; error: string }

function mergeTools(
  templateTools: ToolDeclaration[],
  overrideTools?: CreateAgentOptions['tools']
): ToolMergeResult {
  if (!overrideTools) {
    return { ok: true, value: templateTools }
  }

  const overrideMap = new Map(overrideTools.map((t) => [t.name, t]))
  const merged: ToolDeclaration[] = []

  // Walk template tools — check locks at each
  for (const tmplTool of templateTools) {
    const override = overrideMap.get(tmplTool.name)
    if (override && tmplTool.locked) {
      // Restating a locked tool as it is is fine; changing it is not.
      if (changes(override, tmplTool)) {
        return { ok: false, error: `Template locks tool '${tmplTool.name}'; it cannot be changed. Leave it out of the overrides to keep the template setting.` }
      }
      merged.push(tmplTool)
    } else if (override) {
      merged.push({ ...tmplTool, ...override })
    } else {
      merged.push(tmplTool)
    }
  }

  // Append new tools not in template
  for (const overrideTool of overrideTools) {
    if (!templateTools.some((t) => t.name === overrideTool.name)) {
      merged.push({ visible: true, ...overrideTool })
    }
  }

  return { ok: true, value: merged }
}

// ---------------------------------------------------------------------------
// Triggers merge helper
// ---------------------------------------------------------------------------

type TriggerMergeResult =
  | { ok: true; value: Partial<TriggersConfigV3> }
  | { ok: false; error: string }

function mergeTriggers(
  templateTriggers: TriggersConfigV3,
  overrideTriggers?: Partial<TriggersConfigV3>
): TriggerMergeResult {
  if (!overrideTriggers) {
    return { ok: true, value: templateTriggers }
  }

  const merged: TriggersConfigV3 = { ...templateTriggers }
  const overrideKeys = Object.keys(overrideTriggers) as TriggerTypeV3[]

  for (const triggerType of overrideKeys) {
    const override = overrideTriggers[triggerType]
    if (!override) continue

    const tmplTrigger = templateTriggers[triggerType]
    if (!tmplTrigger) {
      // No template trigger for this type — use override directly
      merged[triggerType] = override
      continue
    }

    if (tmplTrigger.locked) {
      if (changes(override, tmplTrigger)) {
        return { ok: false, error: `Template locks trigger '${triggerType}'; it cannot be changed. Leave it out of the overrides to keep the template setting.` }
      }
      continue
    }

    // Override is replacing targets — carry locked targets forward. A target
    // has no name, so a restated locked target is one equal to it (its
    // `locked` flag aside); any other target is a new one.
    const lockedTargets = tmplTrigger.targets.filter((t) => t.locked)
    if (lockedTargets.length > 0) {
      const same = (l: object, t: object) => isDeepStrictEqual({ ...l, locked: undefined }, { ...t, locked: undefined })
      const kept = keepLocked(lockedTargets, override.targets ?? [], same, () => `a '${triggerType}' target`)
      if (!kept.ok) return kept
      merged[triggerType] = { ...override, targets: kept.value }
    } else {
      // No locked targets — use override entirely
      merged[triggerType] = override
    }
  }

  return { ok: true, value: merged }
}

// ---------------------------------------------------------------------------
// Serving merge helper
// ---------------------------------------------------------------------------

type ServingMergeResult =
  | { ok: true; value: ServingConfig | undefined }
  | { ok: false; error: string }

function mergeServing(
  templateServing?: ServingConfig,
  overrideServing?: Partial<ServingConfig>
): ServingMergeResult {
  if (!overrideServing) {
    return { ok: true, value: templateServing }
  }
  if (!templateServing) {
    return { ok: true, value: overrideServing as ServingConfig }
  }

  const merged: ServingConfig = { ...templateServing }

  // Merge shared/public with shallow spread
  if (overrideServing.shared !== undefined) {
    merged.shared = overrideServing.shared
  }
  if (overrideServing.public !== undefined) {
    merged.public = overrideServing.public
  }

  // Merge API routes — check for locked routes
  if (overrideServing.api !== undefined) {
    const templateRoutes = templateServing.api ?? []
    const lockedRoutes = templateRoutes.filter((r) => r.locked)

    if (lockedRoutes.length > 0) {
      const kept = keepLocked(lockedRoutes, overrideServing.api,
        (a, b) => a.method === b.method && a.path === b.path, (r) => `API route '${r.method} ${r.path}'`)
      if (!kept.ok) return kept
      merged.api = kept.value
    } else {
      // No locked routes — use override entirely
      merged.api = overrideServing.api
    }
  }

  return { ok: true, value: merged }
}
