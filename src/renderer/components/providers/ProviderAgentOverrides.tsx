import { useState, useEffect, useCallback, useRef } from 'react'
import type { ProviderConfig, ProviderCredentialFileInfo } from '../../../shared/types/ipc.types'
import { loadTrackedAdfFiles, adfDisplayName, type TrackedAdfFile } from '../../utils/tracked-adf-files'
import { Tooltip } from '../common/Tooltip'
import { Button, IconButton, Select, TextInput } from '../ui'
import { DocsLink } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'

interface AdfProviderOverride {
  defaultModel?: string
  params?: { key: string; value: string }[]
  requestDelayMs?: number
}

interface ProviderAgentOverridesProps {
  provider: ProviderConfig
  apiKeyPlaceholder?: string
  /** Called after a carrier is added or removed so the row chip can refresh. */
  onCountChange?: (count: number) => void
}

/**
 * Agents that carry a copy of one provider.
 *
 * A carrier is an agent whose .adf stores this provider in its config
 * `providers[]`, optionally with a key in `adf_identity`. At runtime that copy
 * is used for every field it carries; only a missing key falls back to the
 * app key for the same provider id (provider-factory.ts
 * resolveEffectiveProviderConfig).
 *
 * Carriers are not all hand-made: Studio copies the default provider into every
 * agent it creates (config only, never the key), so a brand-new agent shows up
 * here with no key of its own. The list therefore says "carries a copy", not
 * "overrides", and calls out the missing key rather than implying it is normal.
 */
export function ProviderAgentOverrides({ provider, apiKeyPlaceholder, onCountChange }: ProviderAgentOverridesProps) {
  const [files, setFiles] = useState<ProviderCredentialFileInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [tracked, setTracked] = useState<TrackedAdfFile[]>([])
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [overrides, setOverrides] = useState<Record<string, AdfProviderOverride>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, 'ok' | string>>({})
  // Rows added from the picker but not yet saved: a scan that lands later
  // must not drop them.
  const manualPaths = useRef(new Set<string>())
  // Parent passes an inline callback; keep the loader's identity stable.
  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.adfApi?.listProviderCredentialFiles({ providerId: provider.id })
      const scanned = result?.files ?? []
      setFiles((prev) => {
        const keep = prev.filter((f) => manualPaths.current.has(f.filePath) && !scanned.some((s) => s.filePath === f.filePath))
        return [...scanned, ...keep]
      })
      onCountChangeRef.current?.(scanned.length)
    } finally {
      setLoading(false)
    }
  }, [provider.id])

  useEffect(() => { void load() }, [load])
  useEffect(() => { loadTrackedAdfFiles().then(setTracked).catch(() => setTracked([])) }, [])

  const nameFor = (filePath: string, fileName: string): string => {
    const t = tracked.find((f) => f.filePath === filePath)
    return t ? adfDisplayName(t) : fileName.replace(/\.adf$/, '')
  }

  const openRow = async (filePath: string) => {
    if (editing === filePath) { setEditing(null); return }
    setEditing(filePath)
    try {
      const result = await window.adfApi?.getProviderCredentials({ filePath, providerId: provider.id })
      if (result?.credentials) setKeys((prev) => ({ ...prev, [filePath]: result.credentials.apiKey ?? '' }))
      if (result?.providerConfig) setOverrides((prev) => ({ ...prev, [filePath]: result.providerConfig! }))
    } catch {
      // Row stays editable with empty fields.
    }
  }

  const addAgent = (filePath: string) => {
    setPicking(false)
    if (!filePath || files.some((f) => f.filePath === filePath)) return
    const t = tracked.find((f) => f.filePath === filePath)
    manualPaths.current.add(filePath)
    setFiles((prev) => [...prev, { filePath, fileName: t?.fileName ?? filePath.split('/').pop() ?? 'agent.adf', hasCredentials: false, populatedKeys: [] }])
    setEditing(filePath)
  }

  const save = async (filePath: string) => {
    setSaving(filePath)
    setStatus((prev) => { const n = { ...prev }; delete n[filePath]; return n })
    try {
      const apiKey = keys[filePath] ?? ''
      const o = overrides[filePath] ?? {}
      // The agent's copy starts from the app default, then applies the override.
      const { apiKey: _k, credentialStorage: _s, ...base } = provider
      const attach = await window.adfApi?.attachProvider({
        filePath,
        provider: {
          ...base,
          ...(o.defaultModel !== undefined ? { defaultModel: o.defaultModel } : {}),
          ...(o.params !== undefined ? { params: o.params } : {}),
          ...(o.requestDelayMs !== undefined ? { requestDelayMs: o.requestDelayMs } : {}),
        },
      })
      if (attach && !attach.success) throw new Error(attach.error ?? 'Failed to attach provider')
      if (apiKey) {
        const r = await window.adfApi?.setProviderCredential({ filePath, providerId: provider.id, value: apiKey })
        if (r && !r.success) throw new Error(r.error ?? 'Failed to save key')
      }
      setFiles((prev) => prev.map((f) => f.filePath === filePath
        ? { ...f, hasCredentials: !!apiKey || f.hasCredentials, populatedKeys: apiKey ? ['apiKey'] : f.populatedKeys }
        : f))
      setStatus((prev) => ({ ...prev, [filePath]: 'ok' }))
      manualPaths.current.delete(filePath)
      onCountChangeRef.current?.(files.length)
    } catch (err) {
      setStatus((prev) => ({ ...prev, [filePath]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(null)
    }
  }

  const remove = async (filePath: string) => {
    if (!window.confirm(`Remove this agent's copy of ${provider.name || 'this provider'}? It goes back to the app values, and its own key for this provider is deleted.`)) return
    await window.adfApi?.detachProvider({ filePath, providerId: provider.id })
    manualPaths.current.delete(filePath)
    const next = files.filter((f) => f.filePath !== filePath)
    setFiles(next)
    onCountChangeRef.current?.(next.length)
    if (editing === filePath) setEditing(null)
    // Drop the detached row's form state: re-adding the same agent must start
    // from the app values, not from the key and edits that were just removed.
    const drop = <T,>(prev: Record<string, T>): Record<string, T> => {
      if (!(filePath in prev)) return prev
      const n = { ...prev }
      delete n[filePath]
      return n
    }
    setKeys(drop)
    setOverrides(drop)
    setStatus(drop)
  }

  const patchOverride = (filePath: string, patch: AdfProviderOverride) =>
    setOverrides((prev) => ({ ...prev, [filePath]: { ...prev[filePath], ...patch } }))

  const available = tracked.filter((t) => !files.some((f) => f.filePath === t.filePath))

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--adf-ui-text)]">
            Agents carrying this provider
            <DocsLink href={DOCS.settingsProviderCopies} />
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            The agent's copy is used; a copy with no key uses the app key above.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="compact" onClick={() => void load()} disabled={loading}>{loading ? 'Scanning…' : 'Refresh'}</Button>
          <Button variant="secondary" size="compact" onClick={() => setPicking(true)} disabled={picking}>+ Give an agent a copy</Button>
        </div>
      </div>

      {picking && (
        <div className="flex items-center gap-1.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] p-1.5">
          <Select defaultValue="" onChange={(e) => addAgent(e.target.value)} className="text-[12px]" aria-label="Agent to give a copy of this provider">
            <option value="" disabled>{tracked.length === 0 ? 'No agents in tracked folders' : 'Pick an agent…'}</option>
            {available.map((t) => <option key={t.filePath} value={t.filePath}>{adfDisplayName(t)}</option>)}
          </Select>
          <IconButton aria-label="Cancel" onClick={() => setPicking(false)}>&times;</IconButton>
        </div>
      )}

      {files.length === 0 && !picking ? (
        <p className="rounded-[var(--adf-ui-control-radius)] border border-dashed border-[var(--adf-ui-border)] px-3 py-2.5 text-[12px] text-[var(--adf-ui-text-subtle)]">
          No agent carries a copy.
        </p>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {files.map((file) => {
            const isEditing = editing === file.filePath
            const o = overrides[file.filePath] ?? {}
            const st = status[file.filePath]
            return (
              <div key={file.filePath} className="overflow-hidden rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)]">
                <div className="flex items-center hover:bg-[var(--adf-ui-surface-hover)]">
                  <button
                    type="button"
                    onClick={() => void openRow(file.filePath)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--adf-ui-focus)]"
                  >
                    <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">{isEditing ? '▼' : '▶'}</span>
                    <span className="truncate text-[12px] font-medium text-[var(--adf-ui-text)]">{nameFor(file.filePath, file.fileName)}</span>
                    {file.hasCredentials ? (
                      <Tooltip tip="This agent uses its own key for this provider.">
                        <span className="rounded bg-[var(--adf-ui-success-subtle)] px-1 py-0.5 text-[9px] font-medium text-[var(--adf-ui-success)]">Own key</span>
                      </Tooltip>
                    ) : (
                      <Tooltip tip="This agent's copy has no key, so it runs on the app key above. Give it a key here to use its own.">
                        <span className="rounded border border-[var(--adf-ui-border)] px-1 py-0.5 text-[9px] font-medium text-[var(--adf-ui-text-muted)]">App key</span>
                      </Tooltip>
                    )}
                    {o.defaultModel && o.defaultModel !== provider.defaultModel && (
                      <Tooltip tip="Model stored on this agent's copy, instead of the app value.">
                        <span className="truncate text-[10px] text-[var(--adf-ui-text-subtle)]">{o.defaultModel}</span>
                      </Tooltip>
                    )}
                  </button>
                  <Button variant="ghost" size="compact" className="mr-1 text-[var(--adf-ui-danger)]" onClick={() => void remove(file.filePath)}>Remove</Button>
                </div>

                {isEditing && (
                  <div className="space-y-2 border-t border-[var(--adf-ui-separator)] px-2.5 pb-2.5 pt-2">
                    <p className="truncate font-mono text-[10px] text-[var(--adf-ui-text-subtle)]" title={file.filePath}>{file.filePath}</p>
                    <div>
                      <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">API key</label>
                      <TextInput
                        type="password"
                        value={keys[file.filePath] ?? ''}
                        onChange={(e) => setKeys((prev) => ({ ...prev, [file.filePath]: e.target.value }))}
                        placeholder={apiKeyPlaceholder ?? 'API key'}
                        className="font-mono text-[12px]"
                      />
                    </div>
                    <div>
                      <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">Default model</label>
                      <TextInput
                        type="text"
                        value={o.defaultModel ?? ''}
                        onChange={(e) => patchOverride(file.filePath, { defaultModel: e.target.value })}
                        placeholder={provider.defaultModel ? `Copied from the app value (${provider.defaultModel})` : 'Copied from the app value'}
                        className="text-[12px]"
                      />
                    </div>
                    <details className="group">
                      <summary className="cursor-pointer select-none text-[11px] text-[var(--adf-ui-text-muted)] hover:text-[var(--adf-ui-text)]">Advanced</summary>
                      <div className="mt-1.5 space-y-2">
                        <div>
                          <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">Request delay (ms)</label>
                          <TextInput
                            type="number" min={0} step={100}
                            value={o.requestDelayMs ?? 0}
                            onChange={(e) => patchOverride(file.filePath, { requestDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
                            className="text-[12px]"
                          />
                        </div>
                        <ParamsEditor
                          params={o.params ?? []}
                          onChange={(params) => patchOverride(file.filePath, { params })}
                        />
                      </div>
                    </details>
                    <div className="flex items-center gap-2">
                      <Button variant="primary" size="compact" loading={saving === file.filePath} disabled={saving === file.filePath} onClick={() => void save(file.filePath)}>
                        {saving === file.filePath ? 'Saving…' : 'Save to agent'}
                      </Button>
                      {st === 'ok' && <span className="text-[11px] text-[var(--adf-ui-success)]">Saved</span>}
                      {st && st !== 'ok' && <span className="text-[11px] text-[var(--adf-ui-danger)]">{st}</span>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Key/value request parameter rows. Values are parsed as JSON when they parse
 * (otherwise sent as a string), and a blank value sends null — which deletes
 * the key the SDK put in the request body.
 */
export function ParamsEditor({ params, onChange, compact }: {
  params: { key: string; value: string }[]
  onChange: (params: { key: string; value: string }[]) => void
  compact?: boolean
}) {
  const update = (i: number, patch: Partial<{ key: string; value: string }>) => {
    const next = [...params]
    next[i] = { ...next[i], ...patch }
    onChange(next)
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="block text-[11px] text-[var(--adf-ui-text-muted)]">Request parameters</label>
        <Button variant="ghost" size="compact" className="text-[11px]" onClick={() => onChange([...params, { key: '', value: '' }])}>+ Add</Button>
      </div>
      {params.length === 0 ? (
        <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">
          {compact ? 'None.' : 'None. Values are parsed as JSON and merged into every request body; a blank value sends null, which deletes that key.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {params.map((param, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <TextInput aria-label={`Parameter ${i + 1} key`} type="text" value={param.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="key" className="flex-1 font-mono text-[12px]" />
              <TextInput aria-label={`Parameter ${i + 1} value`} type="text" value={param.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="blank = null" className="flex-1 font-mono text-[12px]" />
              <IconButton onClick={() => onChange(params.filter((_, j) => j !== i))} aria-label={`Remove parameter ${i + 1}`} variant="danger">&times;</IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
