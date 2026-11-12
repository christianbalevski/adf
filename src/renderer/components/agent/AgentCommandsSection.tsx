import { useEffect, useId, useState } from 'react'
import type { AgentCommand } from '../../../shared/types/adf-v02.types'
import { agentCommandsDraftFromConfig, validateAgentCommandsDraft } from './agent-commands-config'
import { openApi } from '../../utils/runtime-api'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../ui'
import { LockBadge, WarningIcon } from './config-panel-parts'

const FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'weather', mono: true },
  { key: 'description', label: 'Description', placeholder: 'What the command does', mono: false },
  { key: 'usage', label: 'Usage', placeholder: '<city> — optional', mono: false },
  { key: 'lambda', label: 'Lambda', placeholder: 'lib/commands.ts:run', mono: true },
] as const

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
  return <div className="space-y-2">
    <datalist id={listId}>{(files ?? []).map(file => <option key={file} value={`${file}:`} />)}</datalist>
    <div className="flex items-center justify-between">
      <span className="block text-xs text-neutral-500 dark:text-neutral-400">Commands</span>
      <button type="button" disabled={draft.length >= 64} onClick={() => { setDraft(rows => [...rows, { name: '', description: '', lambda: '' }]); setDirty(true) }}
        className="text-[11px] font-medium text-blue-500 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
        + Add command
      </button>
    </div>
    {draft.map((command, index) => <div key={index} className={`rounded-md border p-2 space-y-1.5 ${command.locked ? 'border-amber-300 dark:border-amber-600 bg-amber-50/30 dark:bg-amber-900/10' : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50'}`}>
      {command.malformed !== undefined && <details className="text-[10px] text-[var(--adf-ui-danger)]">
        <summary className="cursor-pointer">Invalid command data</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{command.malformed}</pre>
      </details>}
      {FIELDS.map(({ key: field, label, placeholder, mono }) => {
        const errors = validation.errors.filter(issue => issue.index === index && issue.field === field)
        const warnings = validation.warnings.filter(issue => issue.index === index && issue.field === field)
        const message = [...errors, ...warnings].map(issue => issue.message).join('\n')
        const fieldId = `${listId}-${index}-${field}`
        return <div key={field} className="flex items-center gap-1.5">
          <label htmlFor={fieldId} className="text-[10px] text-[var(--adf-ui-text-subtle)] w-16 shrink-0">{label}</label>
          <input id={fieldId} type="text" className={`field-input text-[10px] flex-1 min-w-0${mono ? ' font-mono' : ''}`}
            aria-label={`Command ${index + 1} ${field}`} aria-invalid={errors.length > 0} aria-describedby={message ? `${fieldId}-issue` : undefined}
            value={command[field] ?? ''} list={field === 'lambda' ? listId : undefined} placeholder={placeholder}
            onChange={event => edit(index, { [field]: event.target.value })} />
          {message && <Tooltip tip={message} className="inline-flex shrink-0">
            <button type="button" aria-label={`Command ${index + 1} ${field}: ${errors.length ? 'error' : 'warning'}`} aria-describedby={`${fieldId}-issue`} className={`inline-flex cursor-help ${errors.length ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-warning)]'}`}>
              <WarningIcon />
            </button>
          </Tooltip>}
          {message && <span id={`${fieldId}-issue`} className="sr-only">{message}</span>}
          {field === 'name' && <div className="flex items-center gap-1 shrink-0">
            <LockBadge locked={!!command.locked} size="xs" onClick={() => edit(index, { locked: !command.locked || undefined })} />
            <button type="button" title="Remove command" aria-label={`Remove command ${index + 1}`}
              className="text-[10px] text-red-400 hover:text-red-600 dark:hover:text-red-300"
              onClick={() => { setDraft(rows => rows.filter((_, i) => i !== index)); setDirty(true) }}>
              ×
            </button>
          </div>}
        </div>
      })}
    </div>)}
    {(draft.length > 0 || dirty) && <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="compact" disabled={!dirty || !validation.canSave} onClick={() => {
        if (!validation.commands) return
        onSave(validation.commands)
        setDirty(false)
      }}>Save commands</Button>
      {dirty && <Button variant="ghost" size="compact" onClick={() => { setDraft(agentCommandsDraftFromConfig(commands)); setDirty(false) }}>Discard</Button>}
    </div>}
  </div>
}
