import { useEffect, useId, useState } from 'react'
import type { AgentCommand } from '../../../shared/types/adf-v02.types'
import { agentCommandsDraftFromConfig, validateAgentCommandsDraft } from './agent-commands-config'
import { openApi } from '../../utils/runtime-api'
import { Tooltip } from '../common/Tooltip'
import { LockIcon, PERMISSION_ON_CLASS, WarningIcon } from './config-panel-parts'

export function AgentCommandsSection({ commands, onSave, template = false }: {
  commands?: AgentCommand[]
  onSave: (commands: AgentCommand[]) => void
  template?: boolean
}) {
  const [draft, setDraft] = useState(() => agentCommandsDraftFromConfig(commands))
  const [dirty, setDirty] = useState(false)
  const [files, setFiles] = useState<string[] | undefined>()
  const listId = useId()
  useEffect(() => {
    if (!dirty) setDraft(agentCommandsDraftFromConfig(commands))
  }, [commands, dirty])
  useEffect(() => {
    if (template) return
    let live = true
    const refresh = (): void => {
      void openApi()?.getInternalFiles().then(result => {
        if (live) setFiles(result.files.map(file => file.path).filter(path => /\.(ts|js|mjs)$/.test(path)))
      }).catch(() => { /* File suggestions are optional; shared validation still applies. */ })
    }
    refresh()
    const unsubscribe = openApi()?.onWorkspaceDataChanged?.(refresh)
    return () => { live = false; unsubscribe?.() }
  }, [template])
  const validation = validateAgentCommandsDraft(draft, files)
  const edit = (index: number, patch: Partial<AgentCommand>): void => {
    setDraft(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row))
    setDirty(true)
  }
  const inputClass = 'w-full rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none'
  return <div className="space-y-3">
    <datalist id={listId}>{(files ?? []).map(file => <option key={file} value={`${file}:`} />)}</datalist>
    {draft.map((command, index) => <div key={index} className="space-y-2 rounded border border-neutral-200 dark:border-neutral-700 p-3">
      {command.malformed !== undefined && <details className="text-xs text-red-600 dark:text-red-400">
        <summary className="cursor-pointer">Invalid command data</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{command.malformed}</pre>
      </details>}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">Command {index + 1}</span>
        <div className="flex items-center gap-3">
          <Tooltip tip={command.locked ? 'Locked by the owner: the agent cannot change or remove it. Click to unlock.' : 'Lock this command to prevent the agent from changing or removing it.'}>
            <button type="button" aria-label={command.locked ? 'Unlock command' : 'Lock command'} aria-pressed={command.locked ?? false} className={`inline-flex items-center transition-colors ${command.locked ? PERMISSION_ON_CLASS.locked : 'text-[var(--adf-ui-icon-muted)] hover:text-[var(--adf-ui-text-subtle)]'}`} onClick={() => edit(index, { locked: !command.locked })}>
              <LockIcon size={14} open={!command.locked} />
            </button>
          </Tooltip>
          <button type="button" className="text-xs text-red-600 dark:text-red-400" onClick={() => { setDraft(rows => rows.filter((_, i) => i !== index)); setDirty(true) }}>Remove</button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(['name', 'description', 'usage', 'lambda'] as const).map(field => {
          const errors = validation.errors.filter(issue => issue.index === index && issue.field === field)
          const warnings = validation.warnings.filter(issue => issue.index === index && issue.field === field)
          const message = [...errors, ...warnings].map(issue => issue.message).join('\n')
          const fieldId = `${listId}-${index}-${field}`
          return <div key={field} className="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
            <div className="flex items-center gap-1">
              <label htmlFor={fieldId}>{({ name: 'Name', description: 'Description', usage: 'Usage (optional)', lambda: 'Lambda file:functionName' })[field]}</label>
              {message && <Tooltip tip={message} className="inline-flex">
                <button type="button" aria-label={`Command ${index + 1} ${field}: ${errors.length ? 'error' : 'warning'}`} aria-describedby={`${fieldId}-issue`} className={`inline-flex cursor-help ${errors.length ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  <WarningIcon />
                </button>
              </Tooltip>}
            </div>
            <input id={fieldId} aria-label={`Command ${index + 1} ${field}`} aria-invalid={errors.length > 0} aria-describedby={message ? `${fieldId}-issue` : undefined} className={inputClass} value={command[field] ?? ''} list={field === 'lambda' ? listId : undefined} placeholder={field === 'lambda' ? 'lib/commands.ts:run' : field === 'usage' ? '<city>' : undefined} onChange={event => edit(index, { [field]: event.target.value })} />
            {message && <span id={`${fieldId}-issue`} className="sr-only">{message}</span>}
          </div>
        })}
      </div>
    </div>)}
    <div className="flex items-center gap-3">
      <button type="button" disabled={draft.length >= 64} className="rounded border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-xs disabled:opacity-40" onClick={() => { setDraft(rows => [...rows, { name: '', description: '', lambda: '' }]); setDirty(true) }}>Add command</button>
      <button type="button" disabled={!dirty || !validation.canSave} className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-40" onClick={() => {
        if (!validation.commands) return
        onSave(validation.commands)
        setDirty(false)
      }}>Save commands</button>
      {dirty && <button type="button" className="text-xs text-neutral-500 dark:text-neutral-400" onClick={() => { setDraft(agentCommandsDraftFromConfig(commands)); setDirty(false) }}>Discard</button>}
    </div>
  </div>
}
