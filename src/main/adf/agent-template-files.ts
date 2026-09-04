/**
 * Blob store for the agent template's extra files.
 *
 * Settings JSON (settings.agentTemplate.files.extra) holds only metadata
 * ({ id, path, mime, size }); the bytes live here as
 * `<userData>/agent-template-files/<id>` where `id` is random hex. The
 * renderer owns the metadata list (single source of truth = settings store);
 * these helpers only copy blobs in and out. AdfDatabase.create reads the
 * blobs via CreateAgentOptions.templateFilesDir.
 */

import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { randomBytes } from 'crypto'
import type { AgentTemplateExtraFile } from '../../shared/types/adf-v02.types'
import { TEMPLATE_EXTRA_FILE_MAX_BYTES, validateTemplateFilePath } from '../../shared/utils/agent-template'
import { AdfWorkspace } from './adf-workspace'

/** Same root the settings store uses, so blobs and metadata travel together. */
export function agentTemplateFilesDir(): string {
  const userDataPath = process.env.ADF_USER_DATA_DIR ?? app.getPath('userData')
  return join(userDataPath, 'agent-template-files')
}

export interface AddTemplateFilesResult {
  success: boolean
  added?: AgentTemplateExtraFile[]
  error?: string
}

/**
 * Copy host files into the store. Refuses (whole batch, nothing copied) when a
 * file exceeds the size cap or is not a regular file. `taken` are the
 * destination paths already in use, so the default path (the basename) is
 * suffixed with the id when it would collide or is reserved.
 */
export function addAgentTemplateFiles(hostPaths: string[], taken: readonly string[] = []): AddTemplateFilesResult {
  const staged: { host: string; meta: AgentTemplateExtraFile }[] = []
  const used = [...taken]
  for (const host of hostPaths) {
    let stat
    try {
      stat = statSync(host)
    } catch {
      return { success: false, error: `Cannot read ${basename(host)}.` }
    }
    if (!stat.isFile()) return { success: false, error: `${basename(host)} is not a file.` }
    if (stat.size > TEMPLATE_EXTRA_FILE_MAX_BYTES) {
      const mb = Math.round(TEMPLATE_EXTRA_FILE_MAX_BYTES / (1024 * 1024))
      return { success: false, error: `${basename(host)} is larger than ${mb} MB.` }
    }
    const id = randomBytes(8).toString('hex')
    const name = basename(host)
    const path = validateTemplateFilePath(name, used) === null ? name : `${id}-${name}`
    used.push(path)
    staged.push({ host, meta: { id, path, mime: AdfWorkspace.mimeTypeForPath(name), size: stat.size } })
  }

  const dir = agentTemplateFilesDir()
  mkdirSync(dir, { recursive: true })
  const added: AgentTemplateExtraFile[] = []
  try {
    for (const { host, meta } of staged) {
      copyFileSync(host, join(dir, meta.id))
      added.push(meta)
    }
  } catch (err) {
    for (const meta of added) {
      try { unlinkSync(join(dir, meta.id)) } catch { /* best-effort rollback */ }
    }
    return { success: false, error: `Copy failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { success: true, added }
}

/** Ids whose blob is absent from the store (malformed ids count as missing). */
export function missingAgentTemplateFiles(ids: string[]): string[] {
  const dir = agentTemplateFilesDir()
  return ids.filter((id) => !/^[0-9a-f]+$/i.test(id) || !existsSync(join(dir, id)))
}

/** Delete one stored blob. Missing blob counts as success (idempotent). */
export function removeAgentTemplateFile(id: string): { success: boolean } {
  if (!/^[0-9a-f]+$/i.test(id)) return { success: false }
  const blob = join(agentTemplateFilesDir(), id)
  if (!existsSync(blob)) return { success: true }
  try {
    unlinkSync(blob)
    return { success: true }
  } catch (err) {
    console.warn(`[AgentTemplateFiles] Could not delete ${id}:`, err)
    return { success: false }
  }
}
