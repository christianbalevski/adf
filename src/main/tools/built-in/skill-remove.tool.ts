/**
 * skill_remove — uninstall a skill package from skills/<name>/.
 *
 * The mirror of skill_install, with the write order reversed: SKILL.md goes
 * FIRST so the package de-indexes immediately and stops being advertised to the
 * model, then the resources follow. Deletes go through the ordinary workspace
 * path, so file protection still applies — a protected file is reported with a
 * reason, never forced.
 *
 * A stale entry in the `skills-state.json` mute list is cleared too, so a later
 * reinstall of the same name does not come back silently disabled. That file is
 * the agent's own; parsing is best-effort and a malformed one is left alone
 * rather than rewritten.
 *
 * Headless-safe: no Electron imports.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { SKILLS_ROOT, SKILLS_STATE_PATH } from '../../adf/skill-indexer'

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const InputSchema = z.object({
  name: z.string().describe('Installed skill name (the directory under skills/). Every file in skills/<name>/ is deleted.'),
})

interface RemovalRejection {
  path: string
  reason: string
}

export class SkillRemoveTool implements Tool {
  readonly name = 'skill_remove'
  readonly description =
    'Uninstall a skill: delete every file under skills/<name>/, SKILL.md first so the package leaves the catalog immediately, ' +
    'and clear a stale entry for it from the disabled list in skills-state.json. ' +
    'Normal file protection applies — a read-only or no-delete file is reported and left in place, not forced. ' +
    'To mute a skill without uninstalling it, add its name to the disabled array in skills-state.json instead.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const name = String(parsed.name ?? '').trim()

    if (!SKILL_NAME.test(name)) {
      return {
        content: JSON.stringify({
          success: false,
          error: `"${name}" is not a usable skill name. Names are lowercase kebab-case, 1-64 characters (a-z, 0-9, hyphen), and match the directory under skills/.`,
        }),
        isError: true,
      }
    }

    const directory = `${SKILLS_ROOT}${name}/`
    const manifestPath = `${directory}SKILL.md`
    const paths = workspace.listFiles()
      .map((file) => file.path)
      .filter((path) => path.startsWith(directory))
      .sort()

    if (!paths.length) {
      return {
        content: JSON.stringify({
          success: false,
          name,
          error: `No skill package at ${directory} — nothing to remove. Use fs_list to see what is installed.`,
        }),
        isError: true,
      }
    }

    // Manifest first: that write is what the indexer keys on, so the catalog
    // drops the skill before its resources start disappearing.
    const ordered = [
      ...paths.filter((path) => path === manifestPath),
      ...paths.filter((path) => path !== manifestPath),
    ]

    const deleted: string[] = []
    const rejected: RemovalRejection[] = []
    for (const path of ordered) {
      const protection = workspace.getFileProtection(path)
      if (protection === 'read_only' || protection === 'no_delete') {
        rejected.push({ path, reason: `file is protected (${protection})` })
        continue
      }
      if (workspace.deleteFile(path)) deleted.push(path)
      else rejected.push({ path, reason: 'delete failed' })
    }

    const state = this.clearMuteEntry(workspace, name)
    if (state.rejected) rejected.push(state.rejected)

    const summary = [
      deleted.length
        ? `Removed "${name}" — deleted ${deleted.length} file(s)${deleted[0] === manifestPath ? ', SKILL.md first so the catalog dropped it immediately' : ''}.`
        : `Removed nothing for "${name}".`,
      state.updated ? `Cleared its stale entry from the disabled list in ${SKILLS_STATE_PATH}.` : '',
      rejected.length
        ? `Left in place: ${rejected.map((r) => `${r.path} (${r.reason})`).join('; ')}. A protected file needs your principal, or fs_delete with an approval.`
        : '',
    ].filter(Boolean).join(' ')

    return {
      content: JSON.stringify({
        success: deleted.length > 0,
        name,
        deleted,
        rejected,
        ...(state.updated ? { state_updated: true } : {}),
        message: summary,
      }),
      isError: deleted.length === 0,
    }
  }

  /**
   * Drop `name` from the mute list. Best-effort by design: an unreadable or
   * malformed state file is the agent's to fix, and rewriting it here would
   * destroy whatever it was trying to say.
   */
  private clearMuteEntry(
    workspace: AdfWorkspace,
    name: string
  ): { updated: boolean; rejected?: RemovalRejection } {
    const text = workspace.readFile(SKILLS_STATE_PATH)
    if (text === null) return { updated: false }
    let state: Record<string, unknown>
    try {
      const value = JSON.parse(text) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { updated: false, rejected: { path: SKILLS_STATE_PATH, reason: 'not a JSON object — mute list left alone' } }
      }
      state = value as Record<string, unknown>
    } catch {
      return { updated: false, rejected: { path: SKILLS_STATE_PATH, reason: 'not valid JSON — mute list left alone' } }
    }
    const disabled = state.disabled
    if (!Array.isArray(disabled) || !disabled.includes(name)) return { updated: false }
    if (workspace.getFileProtection(SKILLS_STATE_PATH) === 'read_only') {
      return { updated: false, rejected: { path: SKILLS_STATE_PATH, reason: 'file is read-only — stale disabled entry left in place' } }
    }
    const next = { ...state, disabled: disabled.filter((item) => item !== name) }
    workspace.writeFile(SKILLS_STATE_PATH, JSON.stringify(next, null, 2) + '\n')
    return { updated: true }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
