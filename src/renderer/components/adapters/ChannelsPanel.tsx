import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdapterRegistration, AdapterStatusEvent } from '../../../shared/types/ipc.types'
import type { AdapterState, AdapterAgentStatus, AdapterCredentialFileInfo } from '../../../shared/types/channel-adapter.types'
import { ADAPTER_REGISTRY, findAdapterRegistryEntry, withBuiltInAdapterRegistrations } from '../../../shared/constants/adapter-registry'
import { loadTrackedAdfFiles, adfDisplayNameForPath, type TrackedAdfFile } from '../../utils/tracked-adf-files'
import { BrandMark } from '../common/BrandMark'
import { Tooltip } from '../common/Tooltip'
import { Button } from '../ui'
import { ChannelSetupModal } from './ChannelSetupModal'

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  error: 'bg-red-500',
  disconnected: 'bg-neutral-400',
}

interface ChannelsPanelProps {
  adapters: AdapterRegistration[]
  onAdaptersChanged: (adapters: AdapterRegistration[]) => void
}

/**
 * Settings → Channels. One row per channel type; each row lists the agents
 * connected to it with a live status dot. Credentials are per agent (stored
 * in that agent's identity table), never app-wide: adapters run per agent,
 * and one token shared by two agents would put two pollers on one bot.
 */
export function ChannelsPanel({ adapters, onAdaptersChanged }: ChannelsPanelProps) {
  const adaptersRef = useRef(adapters)
  adaptersRef.current = adapters
  const rows = withBuiltInAdapterRegistrations(adapters)

  const [agents, setAgents] = useState<TrackedAdfFile[]>([])
  const [filesByType, setFilesByType] = useState<Record<string, AdapterCredentialFileInfo[]>>({})
  const [byType, setByType] = useState<AdapterState[]>([])
  const [perAgent, setPerAgent] = useState<AdapterAgentStatus[]>([])
  const [setup, setSetup] = useState<{ type: string; filePath?: string } | null>(null)

  const refreshStatus = useCallback(async () => {
    const r = await window.adfApi?.getAdapterStatus()
    if (r?.adapters) setByType(r.adapters)
    setPerAgent(r?.perAgent ?? [])
  }, [])

  const refreshFiles = useCallback(async () => {
    const types = rows.map((r) => r.type)
    const scans = await Promise.all(types.map(async (type) => {
      try {
        const r = await window.adfApi?.listAdapterCredentialFiles({ adapterType: type })
        return r?.files ?? []
      } catch {
        return [] as AdapterCredentialFileInfo[]
      }
    }))
    const next: Record<string, AdapterCredentialFileInfo[]> = {}
    types.forEach((type, i) => { next[type] = scans[i] })
    setFilesByType(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.type).join('|')])

  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => { void refreshFiles() }, [refreshFiles])
  useEffect(() => { loadTrackedAdfFiles().then(setAgents).catch(() => setAgents([])) }, [])

  // Live status: the event carries no file path, so re-pull the per-agent view.
  useEffect(() => {
    const unsub = window.adfApi?.onAdapterStatusChanged((_e: AdapterStatusEvent) => { void refreshStatus() })
    return () => { unsub?.() }
  }, [refreshStatus])

  const removePackage = async (reg: AdapterRegistration) => {
    const entry = findAdapterRegistryEntry(reg.type)
    if (entry?.builtIn) return
    const label = entry?.displayName ?? reg.type
    const message = reg.npmPackage && reg.managed
      ? `Remove ${label} from this list and uninstall ${reg.npmPackage}? Agents keep the credentials stored in their own files.`
      : `Remove ${label} from this list? Agents keep the credentials stored in their own files.`
    if (!window.confirm(message)) return
    if (reg.npmPackage && reg.managed) await window.adfApi?.uninstallAdapterPackage({ package: reg.npmPackage })
    onAdaptersChanged(adaptersRef.current.filter((a) => a.id !== reg.id))
  }

  const agentName = (filePath: string): string => adfDisplayNameForPath(filePath, agents)

  const liveFor = (filePath: string, type: string) =>
    perAgent.find((p) => p.filePath === filePath)?.adapters.find((a) => a.type === type)

  const anyConnected = Object.values(filesByType).some((f) => f.length > 0)
  const setupEntry = setup ? findAdapterRegistryEntry(setup.type) : undefined
  const setupConnected = setup ? (filesByType[setup.type] ?? []).map((f) => f.filePath) : []

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[13px] font-medium text-[var(--adf-ui-text)]">Channels</label>
        <p className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
          One agent per connection; credentials live in that agent's file.
        </p>
      </div>

      {setup && (
        <ChannelSetupModal
          open
          onClose={() => setSetup(null)}
          type={setup.type}
          entry={setupEntry}
          filePath={setup.filePath}
          agents={agents}
          connectedPaths={setupConnected}
          liveStatus={setup.filePath ? liveFor(setup.filePath, setup.type) : undefined}
          onSaved={() => { void refreshFiles(); void refreshStatus() }}
        />
      )}

      {/* First-run hero: nothing connected anywhere */}
      {!anyConnected && (
        <div className="rounded-[var(--adf-ui-container-radius)] border border-dashed border-[var(--adf-ui-border)] p-4">
          <p className="text-[13px] font-medium text-[var(--adf-ui-text)]">Give an agent a place to talk</p>
          <p className="mt-0.5 max-w-xl text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            Pick a channel, choose the agent, paste the token.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
            {ADAPTER_REGISTRY.map((e) => (
              <button
                key={e.type}
                type="button"
                onClick={() => setSetup({ type: e.type })}
                className="flex items-start gap-2 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-2.5 text-left transition-colors hover:border-[var(--adf-ui-accent)] hover:bg-[var(--adf-ui-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
              >
                <BrandMark iconKey={e.iconKey} label={e.displayName} size={28} />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-[var(--adf-ui-text)]">{e.displayName}</span>
                  <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-4 text-[var(--adf-ui-text-muted)]">{e.tagline ?? e.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Channel rows. Hidden behind the hero until something is connected:
          five rows of "No agents connected" say nothing the tiles don't. */}
      {anyConnected && <div className="space-y-2">
        {rows.map((reg) => {
          const entry = findAdapterRegistryEntry(reg.type)
          const files = filesByType[reg.type] ?? []
          const aggregate = byType.find((s) => s.type === reg.type)
          const label = entry?.displayName ?? reg.type
          return (
            <div key={reg.id} className="rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)]">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <BrandMark iconKey={entry?.iconKey} label={label} size={26} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-[var(--adf-ui-text)]">{label}</span>
                      {!entry?.builtIn && reg.npmPackage && <span className="truncate font-mono text-[10px] text-[var(--adf-ui-text-subtle)]">{reg.npmPackage}</span>}
                    </div>
                    <p className="truncate text-[10.5px] text-[var(--adf-ui-text-subtle)]">{entry?.tagline ?? entry?.description ?? `Channel type "${reg.type}"`}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!entry?.builtIn && <Button variant="ghost" size="compact" className="text-[var(--adf-ui-danger)]" onClick={() => void removePackage(reg)}>Remove</Button>}
                  <Button variant="secondary" size="compact" onClick={() => setSetup({ type: reg.type })}>+ Connect an agent</Button>
                </div>
              </div>

              {/* Connected agents: a small table (scrolls past ~4 rows). */}
              <div className="border-t border-[var(--adf-ui-separator)]">
                {files.length === 0 ? (
                  <p className="px-3 py-2 text-[11px] text-[var(--adf-ui-text-subtle)]">No agents connected.</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto">
                    <table className="w-full border-collapse text-[11.5px]">
                      <thead className="sticky top-0 bg-[var(--adf-ui-surface)] text-left text-[10px] uppercase tracking-wide text-[var(--adf-ui-text-subtle)]">
                        <tr>
                          <th className="px-3 py-1 font-medium">Agent</th>
                          <th className="px-2 py-1 font-medium">Status</th>
                          <th className="px-2 py-1 font-medium">Credentials</th>
                          <th className="px-3 py-1" />
                        </tr>
                      </thead>
                      <tbody>
                        {files.map((f) => {
                          const live = liveFor(f.filePath, reg.type)
                          const status = live?.status ?? 'disconnected'
                          // `populatedKeys` is the truth: "has some credentials" is not
                          // "has all of them" (Slack needs an app token and a bot token).
                          const required = entry?.requiredEnvKeys ?? []
                          const missingKeys = required.filter((k) => !f.populatedKeys.includes(k))
                          const credText = required.length === 0
                            ? (f.populatedKeys.length > 0 ? `${f.populatedKeys.length} stored` : 'none needed')
                            : missingKeys.length > 0
                              ? `missing ${missingKeys.join(', ')}`
                              : `${required.length} of ${required.length} stored`
                          const statusText = live
                            ? (live.error ? `${status}: ${live.error}` : status)
                            // No live adapter and no way to tell the two causes apart from
                            // here: the file list does not report whether the channel is
                            // switched on in the agent's config.
                            : 'not running'
                          return (
                            <tr
                              key={f.filePath}
                              onClick={() => setSetup({ type: reg.type, filePath: f.filePath })}
                              className="cursor-pointer border-t border-[var(--adf-ui-separator)] transition-colors hover:bg-[var(--adf-ui-surface-hover)]"
                            >
                              <td className="px-3 py-1.5">
                                <span className="flex items-center gap-1.5 text-[var(--adf-ui-text)]">
                                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${missingKeys.length > 0 ? 'bg-amber-400' : STATUS_DOT[status] ?? 'bg-neutral-400'}`} />
                                  <span className="truncate">{agentName(f.filePath)}</span>
                                </span>
                              </td>
                              <td className={`max-w-[18rem] truncate px-2 py-1.5 ${live?.error ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`} title={statusText}>{statusText}</td>
                              <td className={`px-2 py-1.5 ${missingKeys.length > 0 ? 'text-[var(--adf-ui-warning)]' : 'text-[var(--adf-ui-text-muted)]'}`}>{credText}</td>
                              <td className="px-3 py-1.5 text-right text-[var(--adf-ui-text-subtle)]">Edit ›</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {aggregate?.error && !files.some((f) => liveFor(f.filePath, reg.type)?.error) && (
                <p className="border-t border-[var(--adf-ui-separator)] px-3 py-1.5 text-[11px] text-[var(--adf-ui-danger)]">{aggregate.error}</p>
              )}
            </div>
          )
        })}
      </div>}
    </div>
  )
}
