import { useEffect, useState } from 'react'
import type { AdapterRegistryEntry, AdapterCredentialField } from '../../../shared/constants/adapter-registry'
import type { AdapterLogEntry } from '../../../shared/types/channel-adapter.types'
import { adfDisplayNameForPath, type TrackedAdfFile } from '../../utils/tracked-adf-files'
import { Dialog } from '../common/Dialog'
import { BrandMark } from '../common/BrandMark'
import { DocsLink } from '../common/DocsLink'
import { Button, Select, TextInput } from '../ui'
import { AdapterLogs } from './AdapterLogs'

interface ChannelSetupModalProps {
  open: boolean
  onClose: () => void
  type: string
  entry?: AdapterRegistryEntry
  /** Agent being edited; undefined = connect a new agent */
  filePath?: string
  agents: TrackedAdfFile[]
  /** Agents already on this channel (excluded from the picker) */
  connectedPaths: string[]
  /** Live status of the edited agent's adapter, if running */
  liveStatus?: { status: string; error?: string }
  onSaved: () => void
}

/**
 * Connect an agent to a channel, or edit the credentials of one already
 * connected. Credentials are written to that agent's identity store only;
 * saving also enables the adapter in the agent's config, which starts it
 * (or restarts it) if the agent is running.
 */
export function ChannelSetupModal({ open, onClose, type, entry, filePath, agents, connectedPaths, liveStatus, onSaved }: ChannelSetupModalProps) {
  const label = entry?.displayName ?? type
  // Known channel types describe their own keys. Unknown ones (a package the
  // registry has never heard of) get whatever the agent already stores, plus
  // free-form key/value rows.
  const registryFields: AdapterCredentialField[] = entry?.credentials ?? [
    ...(entry?.requiredEnvKeys ?? []).map((key) => ({ key, label: key, required: true })),
    ...(entry?.optionalEnvKeys ?? []).map((key) => ({ key, label: key, required: false })),
  ]
  const freeForm = registryFields.length === 0
  const editing = !!filePath
  const [agent, setAgent] = useState<string>(filePath ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState<Record<string, string>>({})
  const [storedKeys, setStoredKeys] = useState<string[]>([])
  const [extraKeys, setExtraKeys] = useState<string[]>([])
  const [newKey, setNewKey] = useState('')
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachFailed, setAttachFailed] = useState(false)
  const [done, setDone] = useState<null | { changed: boolean; alreadyOn: boolean }>(null)
  const [logs, setLogs] = useState<AdapterLogEntry[] | null>(null)
  const [logsNote, setLogsNote] = useState<string | null>(null)

  // Reset per open; load stored values when editing.
  useEffect(() => {
    if (!open) return
    setAgent(filePath ?? '')
    setValues({})
    setLoaded({})
    setExtraKeys([])
    setNewKey('')
    setRevealed({})
    setError(null)
    setAttachFailed(false)
    setDone(null)
    setLogs(null)
    setLogsNote(null)
    if (filePath) {
      window.adfApi?.getAdapterCredentials({ filePath, adapterType: type }).then((r) => {
        if (r?.credentials) {
          setLoaded(r.credentials)
          setValues(r.credentials)
          // Keys that exist on the agent even when they cannot be decrypted
          // here: shown as "stored", never as an empty field.
          const stored = r.storedKeys ?? Object.keys(r.credentials)
          setStoredKeys(stored)
          setExtraKeys(stored)
        }
      }).catch(() => {})
    }
  }, [open, filePath, type])

  // Keys the agent stores (or the user just added) that the registry does not
  // name. Always shown, so nothing stored is invisible here.
  const customFields: AdapterCredentialField[] = extraKeys
    .filter((k) => !registryFields.some((f) => f.key === k))
    .map((key) => ({ key, label: key, required: false }))
  const fields: AdapterCredentialField[] = [...registryFields, ...customFields]

  const connected = editing || !!done
  const available = agents.filter((a) => !connectedPaths.includes(a.filePath))
  // A key already stored on the agent satisfies "required" even when it
  // cannot be decrypted here (the field then reads "stored").
  const missingRequired = fields.filter((f) => f.required && !(values[f.key] ?? '').trim() && !storedKeys.includes(f.key))
  const canSave = !!agent && missingRequired.length === 0 && !saving
  const changedFields = fields.filter((f) => (values[f.key] ?? '').trim() && (values[f.key] ?? '').trim() !== (loaded[f.key] ?? ''))
  const agentLabel = (path: string) => adfDisplayNameForPath(path, agents)

  /**
   * The config write is what switches the channel on and starts the adapter.
   * When it fails after the credentials landed, say so precisely: the tokens
   * are on the agent, but nothing is listening.
   */
  const runAttach = async (target: string, credentialsWritten: boolean): Promise<{ ok: boolean; alreadyOn: boolean }> => {
    const attach = await window.adfApi?.attachAdapter({
      filePath: target,
      adapterType: type,
      config: { enabled: true, policy: { dm: 'all', groups: 'mention' } },
    })
    if (attach && !attach.success) {
      const why = attach.error ?? 'the agent config could not be written'
      setAttachFailed(true)
      setError(credentialsWritten
        ? `The credentials are stored on ${agentLabel(target)}, but ${label} could not be switched on for it: ${why}. Nothing is listening yet.`
        : `${label} could not be switched on for ${agentLabel(target)}: ${why}.`)
      return { ok: false, alreadyOn: false }
    }
    setAttachFailed(false)
    return { ok: true, alreadyOn: attach?.alreadyAttached ?? false }
  }

  const save = async () => {
    if (!agent) return
    setSaving(true)
    setError(null)
    setDone(null)
    const changed = changedFields
    try {
      // Credentials first, then the config write: the config change is what
      // (re)starts the adapter, and it must find the token already in place.
      for (const f of changed) {
        const r = await window.adfApi?.setAdapterCredential({ filePath: agent, adapterType: type, envKey: f.key, value: (values[f.key] ?? '').trim() })
        if (r && !r.success) throw new Error(r.error ?? `Could not save ${f.label}`)
      }
      setLoaded((prev) => ({ ...prev, ...Object.fromEntries(changed.map((f) => [f.key, (values[f.key] ?? '').trim()])) }))
      const attach = await runAttach(agent, changed.length > 0)
      if (!attach.ok) return
      setDone({ changed: changed.length > 0, alreadyOn: attach.alreadyOn })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /** Retry after a failed attach: the credentials are already written. */
  const retryAttach = async () => {
    if (!agent) return
    setSaving(true)
    setError(null)
    try {
      const attach = await runAttach(agent, true)
      if (attach.ok) {
        setDone({ changed: true, alreadyOn: attach.alreadyOn })
        onSaved()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    const target = filePath ?? agent
    if (!target) return
    if (!window.confirm(`Disconnect ${agentLabel(target)} from ${label}? Its stored ${label} credentials are deleted.`)) return
    setSaving(true)
    try {
      const r = await window.adfApi?.detachAdapter({ filePath: target, adapterType: type })
      if (r && !r.success) throw new Error(r.error ?? 'Could not disconnect')
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Logs and restarts go to the agent that hosts this adapter, not to
  // whichever agent happens to be open.
  const showLogs = async () => {
    const target = filePath ?? agent
    if (!target) return
    if (logs) { setLogs(null); setLogsNote(null); return }
    const r = await window.adfApi?.getAdapterLogs({ type, filePath: target })
    setLogs(r?.logs ?? [])
    setLogsNote(r?.running === false ? 'This agent is not running, so it holds no logs for this channel.' : null)
  }

  const restart = async () => {
    const target = filePath ?? agent
    if (!target) return
    setSaving(true)
    setError(null)
    try {
      const r = await window.adfApi?.restartAdapter({ type, filePath: target })
      if (r && !r.success) setError(r.error ?? `Could not restart ${label}.`)
      else onSaved()
    } finally {
      setSaving(false)
    }
  }

  const addKey = () => {
    const key = newKey.trim()
    if (!key || fields.some((f) => f.key === key)) return
    setExtraKeys((k) => [...k, key])
    setNewKey('')
  }

  return (
    <Dialog open={open} onClose={onClose} title={connected ? `${label} on this agent` : `Connect an agent to ${label}`} wide lightDismiss={false}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <BrandMark iconKey={entry?.iconKey} label={label} size={36} />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">{entry?.tagline ?? entry?.description}</p>
            {entry?.docsUrl && <DocsLink href={entry.docsUrl} label="Full setup guide" className="mt-0.5" />}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* Form */}
          <div className="space-y-3">
            <div>
              <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">Agent</label>
              {/* Once connected the agent leaves the picker's list, so show
                  its name instead of an empty select. */}
              {connected ? (
                <div className="flex items-center justify-between rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-2.5 py-1.5">
                  <span className="truncate text-[12px] text-[var(--adf-ui-text)]">{agentLabel(filePath ?? agent)}</span>
                  {liveStatus && (
                    <span className={`text-[10.5px] ${liveStatus.status === 'connected' ? 'text-[var(--adf-ui-success)]' : liveStatus.status === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-subtle)]'}`}>
                      {liveStatus.status}
                    </span>
                  )}
                </div>
              ) : (
                <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
                  <option value="" disabled>{agents.length === 0 ? 'No agents in tracked folders' : available.length === 0 ? 'Every tracked agent is already connected' : 'Choose an agent…'}</option>
                  {available.map((a) => <option key={a.filePath} value={a.filePath}>{adfDisplayNameForPath(a.filePath, agents)}</option>)}
                </Select>
              )}
              {!connected && <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">Stored in this agent's file.</p>}
            </div>

            {fields.length === 0 && !freeForm && (
              <p className="rounded-[var(--adf-ui-control-radius)] border border-dashed border-[var(--adf-ui-border)] px-3 py-2.5 text-[12px] text-[var(--adf-ui-text-muted)]">
                No credentials needed. Save to switch {label} on for the agent; pairing happens when it starts.
              </p>
            )}
            {fields.map((f) => {
              const custom = customFields.some((c) => c.key === f.key)
              const plain = f.key.toLowerCase().includes('username') || f.key.toLowerCase().endsWith('_id')
              // Stored on the agent but not readable here (its envelope is
              // locked for this session): say so instead of showing a blank.
              const storedUnreadable = storedKeys.includes(f.key) && !(loaded[f.key] ?? '')
              return (
                <div key={f.key}>
                  <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">
                    {f.label}{!f.required && <span className="text-[var(--adf-ui-text-subtle)]"> (optional)</span>}
                  </label>
                  <div className="flex items-center gap-1.5">
                    <TextInput
                      type={(custom ? !revealed[f.key] : !plain) ? 'password' : 'text'}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={storedUnreadable ? '•••••••• stored on the agent' : (f.placeholder ?? f.key)}
                      className="font-mono text-[12px]"
                      aria-label={f.label}
                    />
                    {custom && (
                      <Button variant="ghost" size="compact" onClick={() => setRevealed((r) => ({ ...r, [f.key]: !r[f.key] }))}>
                        {revealed[f.key] ? 'Hide' : 'Show'}
                      </Button>
                    )}
                  </div>
                  {f.hint && <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">{f.hint}</p>}
                </div>
              )
            })}

            {/* Unknown channel type: the registry names no keys, so the agent's
                own stored keys are listed above and new ones are typed here. */}
            {freeForm && (
              <div>
                <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">Add a credential key</label>
                <div className="flex items-center gap-1.5">
                  <TextInput
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKey() } }}
                    placeholder="MY_CHANNEL_TOKEN"
                    className="font-mono text-[12px]"
                    aria-label="Credential key"
                  />
                  <Button variant="secondary" size="compact" onClick={addKey} disabled={!newKey.trim()}>+ Add key</Button>
                </div>
                <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">
                  This channel is not in the registry, so name the keys its package reads.
                </p>
              </div>
            )}

            {liveStatus?.error && (
              <p className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-danger-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--adf-ui-danger)]">{liveStatus.error}</p>
            )}
            {error && (
              <div className="space-y-1">
                <p className="text-[11px] text-[var(--adf-ui-danger)]">{error}</p>
                {attachFailed && (
                  <Button variant="secondary" size="compact" onClick={() => void retryAttach()} disabled={saving}>
                    Retry switching {label} on
                  </Button>
                )}
              </div>
            )}
            {done && (
              <p className="text-[11px] text-[var(--adf-ui-success)]">
                {!done.changed && done.alreadyOn
                  ? 'Nothing changed.'
                  : done.changed && done.alreadyOn
                    ? `Credentials saved. Restart ${label} below so the agent picks them up.`
                    : `${label} is on for this agent. It starts now if the agent is running, otherwise the next time the agent starts.`}
              </p>
            )}

            {connected && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--adf-ui-separator)] pt-2">
                <Button variant="ghost" size="compact" onClick={() => void showLogs()}>{logs ? 'Hide logs' : 'Logs'}</Button>
                <Button variant="ghost" size="compact" onClick={() => void restart()} disabled={saving}>Restart</Button>
                <span className="text-[10.5px] text-[var(--adf-ui-text-subtle)]">Runs on the agent hosting this channel.</span>
              </div>
            )}
            {logsNote && <p className="text-[10.5px] text-[var(--adf-ui-text-subtle)]">{logsNote}</p>}
            {logs && <AdapterLogs logs={logs} onClose={() => { setLogs(null); setLogsNote(null) }} adapterType={type} />}
          </div>

          {/* Guidance */}
          {(entry?.setupSteps?.length ?? 0) > 0 && (
            <aside className="rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] p-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--adf-ui-text-muted)]">Where to get this</div>
              <ol className="space-y-1.5 text-[11.5px] leading-4 text-[var(--adf-ui-text)]">
                {entry!.setupSteps!.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-[var(--adf-ui-text-subtle)]">{i + 1}.</span>
                    <span>
                      {s.text}
                      {s.url && (
                        <>
                          {' '}
                          <a href={s.url} onClick={(e) => { e.preventDefault(); window.open(s.url, '_blank', 'noopener,noreferrer') }} className="text-[var(--adf-ui-accent)] underline-offset-2 hover:underline">Open ↗</a>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </aside>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--adf-ui-separator)] pt-3">
          {connected ? (
            <Button variant="ghost" size="compact" className="text-[var(--adf-ui-danger)]" onClick={() => void disconnect()} disabled={saving}>Disconnect</Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving}>
              {saving ? 'Saving…' : connected ? 'Save' : 'Connect'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
