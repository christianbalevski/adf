import { useEffect, useState } from 'react'
import type { AdapterRegistryEntry, AdapterCredentialField } from '../../../shared/constants/adapter-registry'
import { adfDisplayName, type TrackedAdfFile } from '../../utils/tracked-adf-files'
import { Dialog } from '../common/Dialog'
import { BrandMark } from '../common/BrandMark'
import { DocsLink } from '../common/DocsLink'
import { Button, Select, TextInput } from '../ui'

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
  const fields: AdapterCredentialField[] = entry?.credentials ?? [
    ...(entry?.requiredEnvKeys ?? []).map((key) => ({ key, label: key, required: true })),
    ...(entry?.optionalEnvKeys ?? []).map((key) => ({ key, label: key, required: false })),
  ]
  const editing = !!filePath
  const [agent, setAgent] = useState<string>(filePath ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Reset per open; load stored values when editing.
  useEffect(() => {
    if (!open) return
    setAgent(filePath ?? '')
    setValues({})
    setLoaded({})
    setError(null)
    setDone(false)
    if (filePath) {
      window.adfApi?.getAdapterCredentials({ filePath, adapterType: type }).then((r) => {
        if (r?.credentials) { setLoaded(r.credentials); setValues(r.credentials) }
      }).catch(() => {})
    }
  }, [open, filePath, type])

  const available = agents.filter((a) => !connectedPaths.includes(a.filePath))
  const missingRequired = fields.filter((f) => f.required && !(values[f.key] ?? '').trim())
  const canSave = !!agent && missingRequired.length === 0 && !saving

  const save = async () => {
    if (!agent) return
    setSaving(true)
    setError(null)
    try {
      // Credentials first, then the config write: the config change is what
      // (re)starts the adapter, and it must find the token already in place.
      for (const f of fields) {
        const v = (values[f.key] ?? '').trim()
        if (!v || v === loaded[f.key]) continue
        const r = await window.adfApi?.setAdapterCredential({ filePath: agent, adapterType: type, envKey: f.key, value: v })
        if (r && !r.success) throw new Error(r.error ?? `Could not save ${f.label}`)
      }
      const attach = await window.adfApi?.attachAdapter({
        filePath: agent,
        adapterType: type,
        config: { enabled: true, policy: { dm: 'all', groups: 'mention' } },
      })
      if (attach && !attach.success) throw new Error(attach.error ?? 'Could not enable the channel on this agent')
      setDone(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    if (!filePath) return
    const name = agents.find((a) => a.filePath === filePath)
    if (!window.confirm(`Disconnect ${name ? adfDisplayName(name) : 'this agent'} from ${label}? Its stored ${label} credentials are deleted.`)) return
    setSaving(true)
    try {
      const r = await window.adfApi?.detachAdapter({ filePath, adapterType: type })
      if (r && !r.success) throw new Error(r.error ?? 'Could not disconnect')
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const rotated = editing && fields.some((f) => (values[f.key] ?? '') !== (loaded[f.key] ?? ''))

  return (
    <Dialog open={open} onClose={onClose} title={editing ? `${label} on this agent` : `Connect an agent to ${label}`} wide lightDismiss={false}>
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
              {editing ? (
                <div className="flex items-center justify-between rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-2.5 py-1.5">
                  <span className="truncate text-[12px] text-[var(--adf-ui-text)]">{(() => { const a = agents.find((x) => x.filePath === filePath); return a ? adfDisplayName(a) : filePath })()}</span>
                  {liveStatus && (
                    <span className={`text-[10.5px] ${liveStatus.status === 'connected' ? 'text-[var(--adf-ui-success)]' : liveStatus.status === 'error' ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-subtle)]'}`}>
                      {liveStatus.status}
                    </span>
                  )}
                </div>
              ) : (
                <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
                  <option value="" disabled>{agents.length === 0 ? 'No agents in tracked folders' : available.length === 0 ? 'Every tracked agent is already connected' : 'Choose an agent…'}</option>
                  {available.map((a) => <option key={a.filePath} value={a.filePath}>{adfDisplayName(a)}</option>)}
                </Select>
              )}
              {!editing && <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">Credentials are stored inside this agent's file. One bot per agent.</p>}
            </div>

            {fields.length === 0 ? (
              <p className="rounded-[var(--adf-ui-control-radius)] border border-dashed border-[var(--adf-ui-border)] px-3 py-2.5 text-[12px] text-[var(--adf-ui-text-muted)]">
                No credentials needed. Save to enable {label} on the agent; pairing happens when it starts.
              </p>
            ) : fields.map((f) => (
              <div key={f.key}>
                <label className="mb-0.5 block text-[11px] text-[var(--adf-ui-text-muted)]">
                  {f.label}{!f.required && <span className="text-[var(--adf-ui-text-subtle)]"> (optional)</span>}
                </label>
                <TextInput
                  type={f.key.toLowerCase().includes('username') || f.key.toLowerCase().endsWith('_id') ? 'text' : 'password'}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? f.key}
                  className="font-mono text-[12px]"
                  aria-label={f.label}
                />
                {f.hint && <p className="mt-0.5 text-[10.5px] text-[var(--adf-ui-text-subtle)]">{f.hint}</p>}
              </div>
            ))}

            {liveStatus?.error && (
              <p className="rounded-[var(--adf-ui-control-radius)] bg-[var(--adf-ui-danger-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--adf-ui-danger)]">{liveStatus.error}</p>
            )}
            {error && <p className="text-[11px] text-[var(--adf-ui-danger)]">{error}</p>}
            {done && (
              <p className="text-[11px] text-[var(--adf-ui-success)]">
                Saved. {rotated ? 'Restart the agent to pick up the new credentials.' : 'The channel starts with the agent.'}
              </p>
            )}
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
          {editing ? (
            <Button variant="ghost" size="compact" className="text-[var(--adf-ui-danger)]" onClick={() => void disconnect()} disabled={saving}>Disconnect</Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Connect'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
