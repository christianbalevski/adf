import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_AGENT_CONFIG, DEFAULT_DOCUMENT_CONTENT, DEFAULT_MIND_CONTENT } from '../../../shared/constants/adf-defaults'
import { DEFAULT_SOUL_CONTENT } from '../../../shared/types/adf-v02.types'
import type { AgentConfig as AgentConfigType, AgentTemplate, AgentTemplateExtraFile, AgentTemplateFiles } from '../../../shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { diffAgentTemplate, mergeAgentTemplate, validateTemplateFilePath } from '../../../shared/utils/agent-template'
import { AgentConfig, ensureRuntimeTools } from '../agent/AgentConfig'
import { Button, Select, SettingsGroup, SettingsRow, TextInput, Textarea } from '../ui'

/**
 * Settings > Agent template.
 *
 * Holds a draft of the user's overrides (settings.agentTemplate). The real
 * agent Config editor renders in controlled ("template") mode against the
 * EFFECTIVE config (code defaults + overrides); every edit writes back only
 * the diff against the code defaults, so untouched fields keep following
 * DEFAULT_AGENT_CONFIG across releases. Seed file content (README.md,
 * mind.md, soul.md) and the extra-file metadata list travel alongside as
 * `files`; extra-file bytes live in main's blob store, never in settings.
 * Applied at create time by AdfDatabase.create for agents the user creates
 * from Studio.
 */

type SettingsApi = {
  getSettings?: () => Promise<Record<string, unknown>>
  setSettings?: (patch: Record<string, unknown>) => Promise<unknown>
  agentTemplateFilesAdd?: () => Promise<{ success: boolean; added?: AgentTemplateExtraFile[]; error?: string }>
  agentTemplateFilesRemove?: (id: string) => Promise<{ success: boolean }>
  agentTemplateFilesStat?: (ids: string[]) => Promise<{ missing: string[] }>
}

/** Same `globalThis` accessor as SettingsPage — the web tsconfig lacks the preload's Window augmentation. */
function settingsApi(): SettingsApi | undefined {
  return (globalThis as { adfApi?: SettingsApi }).adfApi
}

const EPOCH = new Date(0).toISOString()

/**
 * The code defaults as a full AgentConfig so the editor's type is satisfied.
 * `id`/`name`/`metadata` are synthetic and never reach the template (the diff
 * excludes them). Tools carry the runtime catalog the editor adds anyway, so
 * its first save does not register as a tools override.
 */
const BASELINE: AgentConfigType = {
  ...DEFAULT_AGENT_CONFIG,
  tools: ensureRuntimeTools(DEFAULT_AGENT_CONFIG.tools),
  id: 'template',
  name: 'New agent',
  metadata: { created_at: EPOCH, updated_at: EPOCH },
}

type SeedFileKey = 'readme' | 'mind' | 'soul'

const FILE_DEFAULTS: Record<SeedFileKey, string> = {
  readme: DEFAULT_DOCUMENT_CONTENT,
  mind: DEFAULT_MIND_CONTENT,
  soul: DEFAULT_SOUL_CONTENT,
}

const SEED_KEYS: SeedFileKey[] = ['readme', 'mind', 'soul']

function seedsOverridden(files: AgentTemplateFiles | undefined): boolean {
  return !!files && SEED_KEYS.some((k) => files[k] !== undefined)
}

/** Attach `files` to a config diff, dropping the key (and an empty `extra`) when nothing is set. */
function withFiles(diff: AgentTemplate, files: AgentTemplateFiles | undefined): AgentTemplate {
  const next: AgentTemplate = { ...diff }
  delete next.files
  if (!files) return next
  const cleaned: AgentTemplateFiles = { ...files }
  if (!cleaned.extra || cleaned.extra.length === 0) delete cleaned.extra
  if (seedsOverridden(cleaned) || cleaned.extra) next.files = cleaned
  return next
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface NewAgentTemplateTabProps {
  providers: ProviderConfig[]
  /** settings.defaultProviderId — persisted by SettingsPage's auto-save. */
  defaultProviderId: string | undefined
  onDefaultProviderChange: (id: string | undefined) => void
}

export function NewAgentTemplateTab({ providers, defaultProviderId, onDefaultProviderChange }: NewAgentTemplateTabProps) {
  const [template, setTemplate] = useState<AgentTemplate>({})
  const loaded = useRef(false)
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingSave = useRef<(() => void) | null>(null)
  // settings.agentTemplateForChildren — written immediately, not debounced.
  const [forChildren, setForChildren] = useState(false)
  const toggleForChildren = (enabled: boolean) => {
    setForChildren(enabled)
    void settingsApi()?.setSettings?.({ agentTemplateForChildren: enabled })
  }

  useEffect(() => {
    let cancelled = false
    settingsApi()?.getSettings?.().then((settings) => {
      if (cancelled) return
      const stored = settings?.agentTemplate
      setTemplate(stored && typeof stored === 'object' ? (stored as AgentTemplate) : {})
      setForChildren(settings?.agentTemplateForChildren === true)
      loaded.current = true
    })
    return () => { cancelled = true }
  }, [])

  // Debounced write of the overrides; flushes on unmount. Text fields ride the
  // same debounce, so typing does not write per keystroke.
  useEffect(() => {
    if (!loaded.current || !dirty.current) return
    clearTimeout(saveTimer.current)
    const doSave = () => {
      pendingSave.current = null
      void settingsApi()?.setSettings?.({ agentTemplate: template })
    }
    pendingSave.current = doSave
    saveTimer.current = setTimeout(doSave, 400)
    return () => clearTimeout(saveTimer.current)
  }, [template])

  useEffect(() => () => { pendingSave.current?.() }, [])

  const value = useMemo(() => mergeAgentTemplate(BASELINE, template), [template])
  const files = template.files ?? {}
  const filesOverridden = seedsOverridden(files)
  const extra = files.extra ?? []
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [extraError, setExtraError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Blob presence check: a stored entry whose file vanished from the blob dir
  // is shown as "missing" (create() skips it with a warning).
  const extraIds = extra.map((f) => f.id).join('\n')
  useEffect(() => {
    if (!extraIds) { setMissing(new Set()); return }
    let cancelled = false
    settingsApi()?.agentTemplateFilesStat?.(extraIds.split('\n')).then((res) => {
      if (!cancelled) setMissing(new Set(res?.missing ?? []))
    })
    return () => { cancelled = true }
  }, [extraIds])

  const onConfigChange = (next: AgentConfigType) => {
    dirty.current = true
    setTemplate((prev) => withFiles(diffAgentTemplate(BASELINE, next), prev.files))
  }

  const setFile = (key: SeedFileKey, text: string) => {
    dirty.current = true
    setTemplate((prev) => {
      const nextFiles: AgentTemplateFiles = { ...(prev.files ?? {}) }
      if (text === FILE_DEFAULTS[key]) delete nextFiles[key]
      else nextFiles[key] = text
      return withFiles(prev, nextFiles)
    })
  }

  const setExtra = (updater: (list: AgentTemplateExtraFile[]) => AgentTemplateExtraFile[]) => {
    dirty.current = true
    setTemplate((prev) => withFiles(prev, { ...(prev.files ?? {}), extra: updater(prev.files?.extra ?? []) }))
  }

  const addExtraFiles = async () => {
    const api = settingsApi()
    if (!api?.agentTemplateFilesAdd) return
    setAdding(true)
    setExtraError(null)
    try {
      const res = await api.agentTemplateFilesAdd()
      if (!res.success) {
        if (res.error && res.error !== 'Cancelled') setExtraError(res.error)
        return
      }
      if (res.added?.length) setExtra((list) => [...list, ...res.added!])
    } finally {
      setAdding(false)
    }
  }

  const removeExtraFile = (id: string) => {
    setExtra((list) => list.filter((f) => f.id !== id))
    void settingsApi()?.agentTemplateFilesRemove?.(id)
  }

  const setExtraPath = (id: string, path: string) => {
    setExtra((list) => list.map((f) => (f.id === id ? { ...f, path } : f)))
  }

  /** Reset the seed textareas only; extra files stay (their blobs would otherwise be orphaned). */
  const resetFiles = () => {
    dirty.current = true
    setTemplate((prev) => withFiles(prev, prev.files?.extra ? { extra: prev.files.extra } : undefined))
  }

  const resetAll = () => {
    if (!window.confirm('Reset the agent template to the code defaults?')) return
    dirty.current = true
    for (const f of template.files?.extra ?? []) void settingsApi()?.agentTemplateFilesRemove?.(f.id)
    setTemplate({})
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
          Changes here affect only agents created after this. Existing agents keep their own config.
        </p>
        <Button onClick={resetAll} variant="ghost" size="compact" className="shrink-0">
          Reset everything to defaults
        </Button>
      </div>

      <SettingsGroup title="Applies to" description="Agents you create in Studio always start from this template.">
        <SettingsRow
          label="Agents created by other agents"
          description="Children made with sys_create_adf start from this template. The parent's own settings still win. Off when the parent names a template agent."
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={forChildren}
              onChange={(e) => toggleForChildren(e.target.checked)}
              className="rounded text-blue-500"
            />
            <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{forChildren ? 'On' : 'Off'}</span>
          </label>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Default provider" description="Used when the template leaves Provider unset. Its default model fills Model ID.">
        <SettingsRow label="Default provider">
          {providers.length === 0 ? (
            <span className="text-[12px] text-[var(--adf-ui-text-subtle)]">No providers configured.</span>
          ) : (
            <Select
              aria-label="Default provider"
              className="w-64"
              value={defaultProviderId ?? ''}
              onChange={(e) => onDefaultProviderChange(e.target.value || undefined)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.type}</option>
              ))}
            </Select>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Files" description="Starting content for a new agent's files.">
        {filesOverridden && (
          <div className="flex justify-end px-4 pt-3">
            <Button onClick={resetFiles} variant="ghost" size="compact">
              Reset to defaults
            </Button>
          </div>
        )}
        <SettingsRow label="README.md" description="Starting content." stacked>
          <Textarea
            aria-label="README.md"
            value={files.readme ?? FILE_DEFAULTS.readme}
            onChange={(e) => setFile('readme', e.target.value)}
            rows={6}
            className="font-mono text-xs resize-y"
          />
        </SettingsRow>
        <SettingsRow label="mind.md" description="Starting content." stacked separator>
          <Textarea
            aria-label="mind.md"
            value={files.mind ?? FILE_DEFAULTS.mind}
            onChange={(e) => setFile('mind', e.target.value)}
            rows={10}
            className="font-mono text-xs resize-y"
          />
        </SettingsRow>
        <SettingsRow label="soul.md" description="Starting content." stacked separator>
          <Textarea
            aria-label="soul.md"
            value={files.soul ?? FILE_DEFAULTS.soul}
            onChange={(e) => setFile('soul', e.target.value)}
            rows={8}
            className="font-mono text-xs resize-y"
          />
        </SettingsRow>
        <SettingsRow label="Extra files" description="Copied into every new agent." stacked separator error={extraError}>
          {extra.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {extra.map((f) => {
                const others = extra.filter((o) => o.id !== f.id).map((o) => o.path)
                const invalid = validateTemplateFilePath(f.path, others)
                const isMissing = missing.has(f.id)
                return (
                  <li key={f.id} className="flex items-center gap-2">
                    <TextInput
                      aria-label={`Path for ${f.path}`}
                      value={f.path}
                      onChange={(e) => setExtraPath(f.id, e.target.value)}
                      spellCheck={false}
                      className={`flex-1 font-mono text-xs ${invalid ? 'border-[var(--adf-ui-danger)]' : ''}`}
                      title={invalid ?? undefined}
                    />
                    <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-[var(--adf-ui-text-subtle)]">
                      {isMissing ? 'missing' : formatSize(f.size)}
                    </span>
                    <Button
                      onClick={() => removeExtraFile(f.id)}
                      variant="ghost"
                      size="compact"
                      aria-label={`Remove ${f.path}`}
                      title="Remove"
                      className="shrink-0 px-2"
                    >
                      ×
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {extra.some((f) => validateTemplateFilePath(f.path, extra.filter((o) => o.id !== f.id).map((o) => o.path))) && (
            <p className="mt-1 text-[11px] text-[var(--adf-ui-danger)]">
              Fix the highlighted paths; invalid entries are skipped when an agent is created.
            </p>
          )}
          <div className={extra.length > 0 ? 'mt-2' : ''}>
            <Button onClick={() => void addExtraFiles()} variant="ghost" size="compact" disabled={adding}>
              {adding ? 'Adding…' : 'Add files…'}
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <AgentConfig template={{ value, onChange: onConfigChange }} />
    </>
  )
}
