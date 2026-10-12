import { useCallback, useEffect, useState } from 'react'
import type { AdfProviderConfig, AgentConfig } from '../../../shared/types/adf-v02.types'
import type { AgentProviderKeySource, ProviderConfig } from '../../../shared/types/ipc.types'
import { invalidateProviderModels, useProviderModels } from '../../hooks/useProviderModels'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../ui'

interface ProviderChoice { id: string; label: string }

const labelOf = (p: { id: string; name?: string; baseUrl?: string }) => p.name || p.baseUrl || p.id

/** Providers the agent carries (they travel with the file) vs app-only ones. */
export function groupProviders(agentProviders: AdfProviderConfig[] | undefined, appProviders: ProviderConfig[]) {
  const onAgent: ProviderChoice[] = (agentProviders ?? []).map((p) => ({ id: p.id, label: labelOf(p) }))
  const agentIds = new Set(onAgent.map((p) => p.id))
  const appOnly: ProviderChoice[] = appProviders.filter((p) => !agentIds.has(p.id)).map((p) => ({ id: p.id, label: labelOf(p) }))
  return { onAgent, appOnly }
}

/** `<option>`s for a provider `<select>`, grouped by where the provider lives. */
export function ProviderOptions({ agentProviders, appProviders }: { agentProviders: AdfProviderConfig[] | undefined; appProviders: ProviderConfig[] }) {
  const { onAgent, appOnly } = groupProviders(agentProviders, appProviders)
  return (
    <>
      {onAgent.length > 0 && (
        <optgroup label="On this agent">
          {onAgent.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </optgroup>
      )}
      {appOnly.length > 0 && (
        <optgroup label="App only (not saved on this agent)">
          {appOnly.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </optgroup>
      )}
    </>
  )
}

/**
 * Model id picker: the provider's model list plus a custom entry. Lists with
 * the agent's own key when the provider is stored on the agent.
 */
export function ModelIdField({ providerId, filePath, value, onChange, className = 'field-input w-full' }: {
  providerId: string
  /** The agent file, when the provider is stored on it. */
  filePath?: string
  value: string
  onChange: (modelId: string) => void
  className?: string
}) {
  const { models, error, loading } = useProviderModels(providerId || undefined, filePath)
  const [custom, setCustom] = useState(false)
  const sorted = [...models].sort((a, b) => a.localeCompare(b))

  if (loading) {
    return <div className={`${className} text-neutral-400 dark:text-neutral-500 text-xs flex items-center`}>Loading models...</div>
  }
  return (
    <div className="min-w-0 flex-1">
      {custom || sorted.length === 0 ? (
        <div className="flex gap-1 items-center">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`${className} font-mono`}
            placeholder="Enter model ID"
          />
          {sorted.length > 0 && (
            <button
              type="button"
              className="text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap"
              onClick={() => setCustom(false)}
            >
              Pick from list
            </button>
          )}
        </div>
      ) : (
        <select
          value={sorted.includes(value) ? value : value ? `__current__` : ''}
          onChange={(e) => {
            if (e.target.value === '__custom__') setCustom(true)
            else if (e.target.value !== '__current__') onChange(e.target.value)
          }}
          className={className}
        >
          {!value && <option value="" disabled>Select a model</option>}
          {value && !sorted.includes(value) && <option value="__current__">{value} (current)</option>}
          {sorted.map((m) => <option key={m} value={m}>{m}</option>)}
          <option value="__custom__">Custom...</option>
        </select>
      )}
      {error && <p className="text-[10px] text-red-400 mt-0.5">{error}</p>}
    </div>
  )
}

// Only these types can be stored on an agent (PROVIDER_ATTACH); subscription
// providers sign in through the app and stay app-only.
const STORABLE_TYPES = new Set(['anthropic', 'openai', 'openai-compatible', 'openrouter'])

const SOURCE_TEXT: Record<AgentProviderKeySource, string> = {
  agent: 'Own key',
  locked: 'Own key (locked)',
  app: "Uses the app's key",
  not_needed: 'No key needed',
  none: 'No key: calls will fail',
  app_sign_in: "Uses the app's sign-in",
}

const SOURCE_TIP: Record<AgentProviderKeySource, string> = {
  agent: 'The key is stored on this agent and goes with the file.',
  locked: 'The key is stored on this agent but cannot be read until the agent is unlocked.',
  app: "No key is stored on this agent. It uses the app's key for this provider, which does not go with the file.",
  not_needed: 'No key is stored, and this provider works without one.',
  none: 'No key is stored on this agent and the app has none for this provider.',
  app_sign_in: 'Subscriptions sign in through the app. The agent stores only the provider settings, so on another machine it uses that machine\'s sign-in.',
}

/** What on the agent still points at a provider (blocks removal). */
export function providerUsers(config: AgentConfig, providerId: string): string[] {
  const users: string[] = []
  if (config.model.provider === providerId) users.push('the main model')
  if (config.context?.compaction_model?.provider === providerId) users.push('the compaction model')
  for (const loop of config.loops ?? []) {
    if (loop.model?.provider === providerId) users.push(`loop "${loop.name}"`)
  }
  return users
}

/**
 * The providers stored on this agent: where each key comes from, setting a
 * key, removing a copy, and adding one from the app's providers (settings
 * only — a key is always a separate, explicit step).
 */
export function AgentProvidersList({ filePath, config, appProviders, save }: {
  /** Null while editing a template: copies can be added, keys cannot. */
  filePath: string | null
  config: AgentConfig
  appProviders: ProviderConfig[]
  save: (updated: AgentConfig) => void
}) {
  const carried = config.providers ?? []
  const [sources, setSources] = useState<Record<string, AgentProviderKeySource>>({})
  const [keyEditing, setKeyEditing] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState('')

  const entriesKey = JSON.stringify(carried.map((p) => [p.id, p.type, p.baseUrl]))
  const refreshSources = useCallback(() => {
    if (!filePath) return
    const providers = (JSON.parse(entriesKey) as [string, string, string][]).map(([id, type, baseUrl]) => ({ id, type, baseUrl }))
    window.adfApi?.getAgentProviderKeySources({ filePath, providers })
      .then((r) => setSources(r?.sources ?? {}))
      .catch(() => setSources({}))
  }, [filePath, entriesKey])
  useEffect(() => { refreshSources() }, [refreshSources])

  const addable = appProviders.filter((p) => STORABLE_TYPES.has(p.type) && !carried.some((c) => c.id === p.id))

  const add = () => {
    const app = appProviders.find((p) => p.id === adding)
    if (!app) return
    // Settings only, never the key (the same "sans secrets" copy new agents get).
    const copy: AdfProviderConfig = {
      id: app.id,
      type: app.type as AdfProviderConfig['type'],
      name: app.name,
      baseUrl: app.baseUrl,
      ...(app.preset ? { preset: app.preset } : {}),
      ...(app.defaultModel ? { defaultModel: app.defaultModel } : {}),
      ...(app.params?.length ? { params: app.params.map((x) => ({ ...x })) } : {}),
      ...(app.requestDelayMs !== undefined ? { requestDelayMs: app.requestDelayMs } : {}),
    }
    save({ ...config, providers: [...carried, copy] })
    setAdding('')
  }

  const saveKey = async (providerId: string, value: string) => {
    if (!filePath || !value) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.adfApi?.setProviderCredential({ filePath, providerId, value })
      if (r && !r.success) throw new Error(r.error ?? 'Failed to save key')
      invalidateProviderModels()
      setKeyEditing(null)
      setKeyDraft('')
      refreshSources()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: AdfProviderConfig) => {
    if (!window.confirm(`Remove ${labelOf(p)} from this agent? Its key stored on the agent is deleted.`)) return
    setBusy(true)
    setError(null)
    try {
      if (filePath) {
        const r = await window.adfApi?.detachProvider({ filePath, providerId: p.id })
        if (r && !r.success) throw new Error(r.error ?? 'Failed to remove provider')
      }
      const rest = carried.filter((c) => c.id !== p.id)
      save({ ...config, providers: rest.length > 0 ? rest : undefined })
      invalidateProviderModels()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      {carried.length === 0 && (
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
          None. The agent uses the app&apos;s providers, which don&apos;t go with the file.
        </p>
      )}
      {carried.map((p) => {
        const source = sources[p.id]
        const users = providerUsers(config, p.id)
        const appKey = appProviders.find((a) => a.id === p.id)?.apiKey
        const editingKey = keyEditing === p.id
        return (
          <div key={p.id} className="rounded-md border border-neutral-200 dark:border-neutral-700 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">{labelOf(p)}</span>
              {filePath && source && (
                <Tooltip tip={SOURCE_TIP[source]}>
                  <span className={`shrink-0 text-[10px] ${source === 'none' ? 'text-red-500' : source === 'locked' ? 'text-amber-500' : 'text-neutral-400 dark:text-neutral-500'}`}>
                    {SOURCE_TEXT[source]}
                  </span>
                </Tooltip>
              )}
              {filePath && !editingKey && source !== 'app_sign_in' && (
                <Button size="compact" variant="ghost" disabled={busy} onClick={() => { setKeyEditing(p.id); setKeyDraft('') }}>
                  {source === 'agent' || source === 'locked' ? 'Replace key' : 'Set key'}
                </Button>
              )}
              {users.length > 0 ? (
                <Tooltip tip={`Used by ${users.join(', ')}. Switch those to another provider first.`}>
                  <Button size="compact" variant="ghost" disabled>Remove</Button>
                </Tooltip>
              ) : (
                <Button size="compact" variant="ghost" className="text-[var(--adf-ui-danger)]" disabled={busy} onClick={() => void remove(p)}>Remove</Button>
              )}
            </div>
            {editingKey && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="password"
                  autoFocus
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(p.id, keyDraft) }}
                  placeholder="API key"
                  className="field-input flex-1 font-mono"
                />
                <Button size="compact" variant="primary" disabled={busy || !keyDraft} onClick={() => void saveKey(p.id, keyDraft)}>Save</Button>
                {appKey && (
                  <Button size="compact" disabled={busy} onClick={() => void saveKey(p.id, appKey)}>Copy app key</Button>
                )}
                <Button size="compact" variant="ghost" disabled={busy} onClick={() => setKeyEditing(null)}>Cancel</Button>
              </div>
            )}
          </div>
        )
      })}
      {addable.length > 0 && (
        <div className="flex items-center gap-1.5">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} className="field-input flex-1">
            <option value="">Add a provider from the app...</option>
            {addable.map((p) => <option key={p.id} value={p.id}>{labelOf(p)}</option>)}
          </select>
          <Button size="compact" disabled={!adding || busy} onClick={add}>Add</Button>
        </div>
      )}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}
