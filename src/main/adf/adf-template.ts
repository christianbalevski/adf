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
import { writeFileSync, unlinkSync } from 'fs'
import type { AdfWorkspace } from './adf-workspace'
import type {
  AgentConfig,
  CreateAgentOptions,
  FileProtectionLevel,
  ToolDeclaration,
  TriggersConfigV3,
  TriggerTypeV3,
  ServingApiRoute,
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
    const db = new Database(tempPath, { readonly: true })
    try {
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

      // Read identity rows — exclude signing keys and KDF params
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
          (r) =>
            !r.purpose.startsWith('crypto:signing:') &&
            !r.purpose.startsWith('crypto:kdf:') &&
            r.encryption_algo === 'plain'
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

      db.close()
      return { config, files, identityRows: filteredIdentity, customTables, customIndexes: indexRows.map((r) => r.sql) }
    } catch (e) {
      db.close()
      throw e
    }
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

  // ---- 1. Section-level locked_fields check ----
  // Keys that map directly to CreateAgentOptions sections
  const sectionKeys: Array<keyof CreateAgentOptions> = [
    'description', 'instructions', 'icon', 'handle', 'autonomous', 'autostart',
    'start_in_state', 'model', 'context', 'tools', 'triggers',
    'security', 'limits', 'messaging', 'audit', 'code_execution',
    'logging', 'mcp', 'adapters', 'serving', 'providers',
    'ws_connections', 'locked_fields', 'card', 'metadata'
  ]
  for (const key of sectionKeys) {
    if (overrides[key] === undefined) continue
    if (key === 'name') continue // name is always overridable

    // Check if this section is locked
    if (lockedFields.includes(key)) {
      return { ok: false, error: `Template has locked field '${key}' — cannot override` }
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

  return { ok: true, options }
}

// ---------------------------------------------------------------------------
// Tools merge helper
// ---------------------------------------------------------------------------

type ToolMergeResult =
  | { ok: true; value: ToolDeclaration[] }
  | { ok: false; error: string }

function mergeTools(
  templateTools: ToolDeclaration[],
  overrideTools?: ToolDeclaration[]
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
      return {
        ok: false,
        error: `Template has locked tool '${tmplTool.name}' — cannot override`
      }
    }
    if (override) {
      // Merge, preserving locked flag from template
      merged.push({ ...tmplTool, ...override, ...(tmplTool.locked ? { locked: true } : {}) })
    } else {
      merged.push(tmplTool)
    }
  }

  // Append new tools not in template
  for (const overrideTool of overrideTools) {
    if (!templateTools.some((t) => t.name === overrideTool.name)) {
      merged.push(overrideTool)
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

    // Check trigger-level lock
    if (tmplTrigger.locked) {
      return {
        ok: false,
        error: `Template has locked trigger '${triggerType}' — cannot override`
      }
    }

    // Check for locked targets within the trigger
    const lockedTargets = tmplTrigger.targets.filter((t) => t.locked)
    if (lockedTargets.length > 0) {
      // Override is replacing targets — must carry locked targets forward
      const mergedTargets = [...lockedTargets]

      // Add non-locked targets from override
      if (override.targets) {
        for (const overrideTarget of override.targets) {
          // Don't allow override to include targets with same identity as locked ones
          mergedTargets.push(overrideTarget)
        }
      }

      merged[triggerType] = {
        ...override,
        targets: mergedTargets,
        // Preserve trigger-level locked flag
        ...(tmplTrigger.locked ? { locked: true } : {})
      }
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
      // Cannot wholesale replace if locked routes exist
      // Carry locked routes forward, merge in non-locked from override
      const mergedRoutes: ServingApiRoute[] = [...lockedRoutes]

      for (const overrideRoute of overrideServing.api) {
        // Check if this override conflicts with a locked route (same method+path)
        const conflictsWithLocked = lockedRoutes.some(
          (lr) => lr.method === overrideRoute.method && lr.path === overrideRoute.path
        )
        if (conflictsWithLocked) {
          return {
            ok: false,
            error: `Template has locked API route '${overrideRoute.method} ${overrideRoute.path}' — cannot override`
          }
        }
        mergedRoutes.push(overrideRoute)
      }

      merged.api = mergedRoutes
    } else {
      // No locked routes — use override entirely
      merged.api = overrideServing.api
    }
  }

  return { ok: true, value: merged }
}
