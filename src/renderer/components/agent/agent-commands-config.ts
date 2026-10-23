import type { AgentCommand } from '../../../shared/types/adf-v02.types'
import { parseLambdaRef, validateAgentCommands, type AgentCommandIssue } from '../../../shared/utils/agent-commands'

export const AGENT_COMMANDS_SECTION_LOCK = 'commands'
export interface AgentCommandDraft extends AgentCommand {
  /** Retained and shown verbatim; saving requires explicit removal/replacement. */
  malformed?: string
}

export function agentCommandsDraftFromConfig(commands?: unknown): AgentCommandDraft[] {
  if (commands === undefined) return []
  const malformedDraft = (value: unknown): AgentCommandDraft => ({ name: '', description: '', lambda: '', malformed: JSON.stringify(value, null, 2) ?? String(value) })
  if (!Array.isArray(commands)) return [malformedDraft(commands)]
  const rows: unknown[] = commands
  return rows.map(command => {
    if (command && typeof command === 'object' && !Array.isArray(command)) {
      const row = command as Record<string, unknown>
      if (typeof row.name === 'string' && typeof row.description === 'string' && typeof row.lambda === 'string' &&
        (row.usage === undefined || typeof row.usage === 'string') && (row.locked === undefined || typeof row.locked === 'boolean')) {
        return { ...row } as unknown as AgentCommandDraft
      }
    }
    return malformedDraft(command)
  })
}

export function agentCommandsConfigFromDraft(draft: readonly AgentCommandDraft[]): AgentCommand[] {
  return draft.map(command => ({ ...command }))
}

export function validateAgentCommandsDraft(draft: readonly AgentCommandDraft[], files?: readonly string[]): {
  commands?: AgentCommand[]
  errors: AgentCommandIssue[]
  warnings: AgentCommandIssue[]
  canSave: boolean
} {
  const commands = agentCommandsConfigFromDraft(draft)
  const errors = validateAgentCommands(commands)
  draft.forEach((row, index) => {
    if (row.malformed !== undefined) errors.push({ index, field: 'name', message: 'Malformed command data is retained below. Remove this row and add its corrected replacement before saving.' })
  })
  const warnings: AgentCommandIssue[] = []
  if (files) commands.forEach((command, index) => {
    const ref = parseLambdaRef(command.lambda)
    if (!('error' in ref) && !files.includes(ref.file)) {
      warnings.push({ index, field: 'lambda', message: `Lambda file "${ref.file}" not found. You can save now and create it later.` })
    }
  })
  return { commands: errors.length ? undefined : commands, errors, warnings, canSave: errors.length === 0 }
}

/** Every config save path uses this guard, including unrelated section edits and retries. */
export function agentCommandsSaveError(commands?: unknown): string | null {
  const issue = validateAgentCommands(commands === undefined ? [] : commands)[0]
  return issue ? `Commands: ${issue.message}` : null
}
