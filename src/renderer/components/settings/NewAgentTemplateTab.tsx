import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_AGENT_CONFIG } from '../../../shared/constants/adf-defaults'
import { MESSAGING_MODES, VISIBILITY_VALUES } from '../../../shared/types/adf-v02.types'
import type { AgentTemplate, LimitsConfig, MessagingMode, Visibility } from '../../../shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../shared/types/ipc.types'
import {
  diffAgentTemplate,
  mergeAgentTemplate,
  templateOverrides,
  type AgentTemplateBase,
  type AgentTemplateKey,
} from '../../../shared/utils/agent-template'
import { Button, Select, SettingsGroup, SettingsRow, TextInput, Textarea } from '../ui'

/**
 * Settings > New agent template.
 *
 * Holds a draft of the user's overrides (settings.agentTemplate). Every field
 * shows the EFFECTIVE value (code default + override), and every edit writes
 * back only the diff against the code defaults, so untouched fields keep
 * following DEFAULT_AGENT_CONFIG across releases. Applied at create time by
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

const MODEL_KEYS: readonly AgentTemplateKey[] = ['model']
const INSTRUCTIONS_KEYS: readonly AgentTemplateKey[] = ['instructions']
const BEHAVIOR_KEYS: readonly AgentTemplateKey[] = ['autonomous', 'limits', 'messaging']
const TOOLS_KEYS: readonly AgentTemplateKey[] = ['tools']

type NumericLimitKey = {
  [K in keyof LimitsConfig]-?: LimitsConfig[K] extends number | undefined ? K : never
}[keyof LimitsConfig]

const LIMIT_FIELDS: { key: NumericLimitKey; label: string; description?: string }[] = [
  { key: 'execution_timeout_ms', label: 'Execution timeout (ms)', description: 'Sandbox code and tool calls.' },
  { key: 'max_file_read_tokens', label: 'Max file read tokens' },
  { key: 'max_file_write_bytes', label: 'Max file write bytes' },
  { key: 'max_tool_result_tokens', label: 'Max tool result tokens', description: 'Larger results are truncated.' },
  { key: 'max_tool_result_preview_chars', label: 'Tool result preview chars' },
  { key: 'max_image_size_bytes', label: 'Max image size (bytes)' },
  { key: 'max_audio_size_bytes', label: 'Max audio size (bytes)' },
  { key: 'max_video_size_bytes', label: 'Max video size (bytes)' },
]

const MESSAGING_MODE_LABELS: Record<MessagingMode, string> = {
  proactive: 'Proactive',
  respond_only: 'Respond only',
  listen_only: 'Listen only',
}

const VISIBILITY_LABELS: Record<Visibility, string> = {
  off: 'Off',
  directory: 'Directory',
  localhost: 'Localhost',
  lan: 'LAN',
  public: 'Public',
}

interface NumberInputProps {
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  step?: number
  ariaLabel: string
}

/** Number field that tolerates intermediate text ("0.") and commits only finite values in range. */
function NumberInput({ value, onCommit, min, max, step, ariaLabel }: NumberInputProps) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  const commit = (raw: string) => {
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed)) return
    if (min !== undefined && parsed < min) return
    if (max !== undefined && parsed > max) return
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <TextInput
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      className="w-40 text-right"
      value={text}
      min={min}
      max={max}
      step={step}
      onChange={(e) => { setText(e.target.value); commit(e.target.value) }}
      onBlur={() => setText(String(value))}
    />
  )
}

function CheckboxField({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded text-blue-500"
      />
      <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{label}</span>
    </label>
  )
}

function GroupReset({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  if (!visible) return null
  return (
    <div className="flex justify-end px-4 pt-3">
      <Button onClick={onClick} variant="ghost" size="compact">
        Reset to defaults
      </Button>
    </div>
  )
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
  // same debounce, so typing in Instructions does not write per keystroke.
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

  const effective = useMemo(() => mergeAgentTemplate(DEFAULT_AGENT_CONFIG, template), [template])

  /** Mutate a fresh copy of the effective config; persist the diff against the code defaults. */
  const update = (mutate: (draft: AgentTemplateBase) => void) => {
    const draft = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, template)
    mutate(draft)
    dirty.current = true
    setTemplate(diffAgentTemplate(DEFAULT_AGENT_CONFIG, draft))
  }

  const resetKeys = (keys: readonly AgentTemplateKey[]) => {
    dirty.current = true
    setTemplate((prev) => {
      const next: AgentTemplate = { ...prev }
      for (const key of keys) delete next[key]
      return next
    })
  }

  const providerKnown = effective.model.provider === '' || providers.some((p) => p.id === effective.model.provider)

  return (
    <>
      <p className="text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
        Changes here affect only agents created after this. Existing agents keep their own config.
      </p>

      <SettingsGroup title="Model">
        <GroupReset visible={templateOverrides(template, MODEL_KEYS)} onClick={() => resetKeys(MODEL_KEYS)} />
        <SettingsRow label="Provider" description="Provider written into the new agent. Not set uses the default provider below.">
          <Select
            aria-label="Provider"
            className="w-64"
            value={effective.model.provider}
            onChange={(e) => update((d) => { d.model.provider = e.target.value })}
          >
            <option value="">Not set</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name || p.type}</option>
            ))}
            {!providerKnown && <option value={effective.model.provider}>{effective.model.provider} (not configured)</option>}
          </Select>
        </SettingsRow>
        <SettingsRow label="Default provider" description="Used when Provider is Not set. Its default model fills Model id." separator>
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
        <SettingsRow label="Model id" description="Empty uses the provider's default model." separator>
          <TextInput
            aria-label="Model id"
            className="w-64 font-mono text-xs"
            value={effective.model.model_id}
            onChange={(e) => update((d) => { d.model.model_id = e.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="Temperature" description="0 to 2." separator>
          <NumberInput
            ariaLabel="Temperature"
            value={effective.model.temperature ?? DEFAULT_AGENT_CONFIG.model.temperature ?? 0.7}
            min={0}
            max={2}
            step={0.1}
            onCommit={(v) => update((d) => { d.model.temperature = v })}
          />
        </SettingsRow>
        <SettingsRow label="Max tokens" description="Output tokens per response." separator>
          <NumberInput
            ariaLabel="Max tokens"
            value={effective.model.max_tokens ?? DEFAULT_AGENT_CONFIG.model.max_tokens ?? 4096}
            min={1}
            step={256}
            onCommit={(v) => update((d) => { d.model.max_tokens = Math.round(v) })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Instructions" description="The new agent's own instructions. Prompts under Prompts are added on top.">
        <GroupReset visible={templateOverrides(template, INSTRUCTIONS_KEYS)} onClick={() => resetKeys(INSTRUCTIONS_KEYS)} />
        <SettingsRow label="Instructions" stacked>
          <Textarea
            aria-label="Instructions"
            value={effective.instructions}
            onChange={(e) => update((d) => { d.instructions = e.target.value })}
            rows={6}
            className="font-mono text-xs resize-y"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Behavior">
        <GroupReset visible={templateOverrides(template, BEHAVIOR_KEYS)} onClick={() => resetKeys(BEHAVIOR_KEYS)} />
        <SettingsRow label="Autonomous" description="Runs without waiting for chat input.">
          <CheckboxField
            checked={effective.autonomous}
            onChange={(v) => update((d) => { d.autonomous = v })}
            label={effective.autonomous ? 'On' : 'Off'}
          />
        </SettingsRow>
        <SettingsRow label="Receive messages" description="Joins the mesh and accepts inbox messages." separator>
          <CheckboxField
            checked={effective.messaging.receive}
            onChange={(v) => update((d) => { d.messaging.receive = v })}
            label={effective.messaging.receive ? 'On' : 'Off'}
          />
        </SettingsRow>
        <SettingsRow label="Messaging mode" separator>
          <Select
            aria-label="Messaging mode"
            className="w-48"
            value={effective.messaging.mode}
            onChange={(e) => update((d) => { d.messaging.mode = e.target.value as MessagingMode })}
          >
            {MESSAGING_MODES.map((mode) => (
              <option key={mode} value={mode}>{MESSAGING_MODE_LABELS[mode]}</option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow label="Visibility" description="Who can reach the agent's inbox." separator>
          <Select
            aria-label="Visibility"
            className="w-48"
            value={effective.messaging.visibility ?? 'localhost'}
            onChange={(e) => update((d) => { d.messaging.visibility = e.target.value as Visibility })}
          >
            {VISIBILITY_VALUES.map((tier) => (
              <option key={tier} value={tier}>{VISIBILITY_LABELS[tier]}</option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow label="Inbox mode" description="Wakes the agent on new inbox messages." separator>
          <CheckboxField
            checked={effective.messaging.inbox_mode ?? true}
            onChange={(v) => update((d) => { d.messaging.inbox_mode = v })}
            label={(effective.messaging.inbox_mode ?? true) ? 'On' : 'Off'}
          />
        </SettingsRow>
        {LIMIT_FIELDS.map((field) => (
          <SettingsRow key={field.key} label={field.label} description={field.description} separator>
            <NumberInput
              ariaLabel={field.label}
              value={effective.limits[field.key] ?? DEFAULT_AGENT_CONFIG.limits[field.key] ?? 0}
              min={0}
              step={1}
              onCommit={(v) => update((d) => { d.limits[field.key] = Math.round(v) })}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title="Tools" description="Tools a new agent starts with. Unchecked tools are off; the agent's Config tab controls visibility and restrictions.">
        <GroupReset visible={templateOverrides(template, TOOLS_KEYS)} onClick={() => resetKeys(TOOLS_KEYS)} />
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 min-[900px]:grid-cols-3">
          {effective.tools.map((tool) => (
            <label key={tool.name} className="flex items-center gap-2 cursor-pointer min-w-0">
              <input
                type="checkbox"
                checked={tool.enabled}
                onChange={(e) => update((d) => {
                  const entry = d.tools.find((t) => t.name === tool.name)
                  if (!entry) return
                  entry.enabled = e.target.checked
                  // Keep code-path-only tools (e.g. chat_info) hidden from the schema when re-enabled.
                  const defaultVisible = DEFAULT_AGENT_CONFIG.tools.find((t) => t.name === tool.name)?.visible ?? true
                  entry.visible = e.target.checked && defaultVisible
                })}
                className="rounded text-blue-500"
              />
              <span className="truncate font-mono text-[12px] text-[var(--adf-ui-text)]">{tool.name}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>
    </>
  )
}
