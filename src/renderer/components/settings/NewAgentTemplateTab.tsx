import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_AGENT_CONFIG, DEFAULT_DOCUMENT_CONTENT, DEFAULT_MIND_CONTENT } from '../../../shared/constants/adf-defaults'
import type { AgentConfig as AgentConfigType, AgentTemplate, AgentTemplateFiles } from '../../../shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import { diffAgentTemplate, mergeAgentTemplate } from '../../../shared/utils/agent-template'
import { AgentConfig, ensureRuntimeTools } from '../agent/AgentConfig'
import { Button, Select, SettingsGroup, SettingsRow, Textarea } from '../ui'

/**
 * Settings > Agent template.
 *
 * Holds a draft of the user's overrides (settings.agentTemplate). The real
 * agent Config editor renders in controlled ("template") mode against the
 * EFFECTIVE config (code defaults + overrides); every edit writes back only
 * the diff against the code defaults, so untouched fields keep following
 * DEFAULT_AGENT_CONFIG across releases. Seed file content (README.md,
 * mind.md) travels alongside as `files`. Applied at create time by
 * AdfDatabase.create for agents the user creates from Studio.
 */

type SettingsApi = {
  getSettings?: () => Promise<Record<string, unknown>>
  setSettings?: (patch: Record<string, unknown>) => Promise<unknown>
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

const FILE_DEFAULTS: Required<AgentTemplateFiles> = {
  readme: DEFAULT_DOCUMENT_CONTENT,
  mind: DEFAULT_MIND_CONTENT,
}

/** Attach `files` to a config diff, dropping the key when nothing is overridden. */
function withFiles(diff: AgentTemplate, files: AgentTemplateFiles | undefined): AgentTemplate {
  const next: AgentTemplate = { ...diff }
  delete next.files
  if (files && (files.readme !== undefined || files.mind !== undefined)) next.files = files
  return next
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

  useEffect(() => {
    let cancelled = false
    settingsApi()?.getSettings?.().then((settings) => {
      if (cancelled) return
      const stored = settings?.agentTemplate
      setTemplate(stored && typeof stored === 'object' ? (stored as AgentTemplate) : {})
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
  const filesOverridden = files.readme !== undefined || files.mind !== undefined

  const onConfigChange = (next: AgentConfigType) => {
    dirty.current = true
    setTemplate((prev) => withFiles(diffAgentTemplate(BASELINE, next), prev.files))
  }

  const setFile = (key: keyof AgentTemplateFiles, text: string) => {
    dirty.current = true
    setTemplate((prev) => {
      const nextFiles: AgentTemplateFiles = { ...(prev.files ?? {}) }
      if (text === FILE_DEFAULTS[key]) delete nextFiles[key]
      else nextFiles[key] = text
      return withFiles(prev, nextFiles)
    })
  }

  const resetFiles = () => {
    dirty.current = true
    setTemplate((prev) => withFiles(prev, undefined))
  }

  const resetAll = () => {
    if (!window.confirm('Reset the agent template to the code defaults?')) return
    dirty.current = true
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
      </SettingsGroup>

      <AgentConfig template={{ value, onChange: onConfigChange }} />
    </>
  )
}
