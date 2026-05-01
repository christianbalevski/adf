import { useState, useEffect, useCallback } from 'react'
import { Dialog } from '../common/Dialog'
import type { MeshDebugInfo, MessageBusLogEntry } from '../../../shared/types/ipc.types'

interface Props {
  open: boolean
  onClose: () => void
}

export function MeshMonitor({ open, onClose }: Props) {
  const [debug, setDebug] = useState<(MeshDebugInfo & { error?: string }) | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const info = await window.adfApi.getMeshDebug()
      setDebug(info as MeshDebugInfo & { error?: string })
      setFetchError(null)
    } catch (err) {
      console.error('[Monitor] Failed to fetch debug info:', err)
      setFetchError(String(err))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    refresh()
    if (!autoRefresh) return
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [open, autoRefresh, refresh])

  return (
    <Dialog open={open} onClose={onClose} title="Mesh Monitor" wide>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
        {/* Controls */}
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (2s)
          </label>
          <button
            onClick={refresh}
            className="text-xs px-2 py-1 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 rounded text-neutral-600 dark:text-neutral-300"
          >
            Refresh now
          </button>
        </div>

        {fetchError && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded p-2 text-xs text-red-700 dark:text-red-400">
            <span className="font-semibold">Fetch error:</span> {fetchError}
          </div>
        )}

        {debug?.error && (
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded p-2 text-xs text-amber-700 dark:text-amber-400">
            <span className="font-semibold">Backend error:</span> {debug.error}
          </div>
        )}

        {!debug && !fetchError ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 text-center py-4">Loading...</p>
        ) : debug && !debug.running ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 text-center py-4">Mesh is not enabled.</p>
        ) : debug ? (
          <>
            {/* Bus Registrations */}
            <Section title="Bus Registrations">
              {debug.busRegistrations.length === 0 ? (
                <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">No agents registered on the bus</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-neutral-400 dark:text-neutral-500 border-b border-neutral-100 dark:border-neutral-700">
                      <th className="pb-1 font-medium">Agent Key</th>
                      <th className="pb-1 font-medium">Channels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {debug.busRegistrations.map((reg, i) => (
                      <tr key={i} className="border-b border-neutral-50 dark:border-neutral-700">
                        <td className="py-1 font-mono text-neutral-600 dark:text-neutral-400 truncate max-w-[200px]" title={reg.name}>
                          {shortPath(reg.name)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Background Agents */}
            <Section title={`Background Agents (${debug.backgroundAgents.length})`}>
              {debug.backgroundAgents.length === 0 ? (
                <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">No background agents loaded</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-neutral-400 dark:text-neutral-500 border-b border-neutral-100 dark:border-neutral-700">
                      <th className="pb-1 font-medium">Name</th>
                      <th className="pb-1 font-medium">State</th>
                      <th className="pb-1 font-medium">on_msg_recv</th>
                      <th className="pb-1 font-medium">Messaging</th>
                      <th className="pb-1 font-medium">Tools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {debug.backgroundAgents.map((agent) => (
                      <tr key={agent.filePath} className="border-b border-neutral-50 dark:border-neutral-700">
                        <td className="py-1 font-medium text-neutral-700 dark:text-neutral-300">{agent.name}</td>
                        <td className="py-1">
                          <StateBadge state={agent.state} />
                        </td>
                        <td className="py-1">
                          <BoolBadge value={agent.onMessageReceived} />
                        </td>
                        <td className="py-1">
                          <BoolBadge value={agent.hasMessaging} />
                        </td>
                        <td className="py-1 text-neutral-500 dark:text-neutral-400">{agent.toolCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Foreground Agents */}
            <Section title={`Foreground Agents (${debug.foregroundAgents.length})`}>
              {debug.foregroundAgents.length === 0 ? (
                <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">No foreground agents registered on the bus</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-neutral-400 dark:text-neutral-500 border-b border-neutral-100 dark:border-neutral-700">
                      <th className="pb-1 font-medium">Name</th>
                      <th className="pb-1 font-medium">on_msg_recv</th>
                      <th className="pb-1 font-medium">Messaging</th>
                    </tr>
                  </thead>
                  <tbody>
                    {debug.foregroundAgents.map((agent) => (
                      <tr key={agent.filePath} className="border-b border-neutral-50 dark:border-neutral-700">
                        <td className="py-1 font-medium text-neutral-700 dark:text-neutral-300">{agent.name}</td>
                        <td className="py-1">
                          <BoolBadge value={agent.onMessageReceived} />
                        </td>
                        <td className="py-1">
                          <BoolBadge value={agent.hasMessaging} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            {/* Message Log */}
            <Section title={`Message Log (${debug.messageLog.length})`}>
              {debug.messageLog.length === 0 ? (
                <p className="text-xs text-neutral-400 dark:text-neutral-500 italic">No messages sent yet</p>
              ) : (
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {[...debug.messageLog].reverse().map((entry) => (
                    <MessageLogRow key={entry.messageId} entry={entry} />
                  ))}
                </div>
              )}
            </Section>
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-neutral-50 dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
      <h4 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-2">
        {title}
      </h4>
      {children}
    </div>
  )
}

function MessageLogRow({ entry }: { entry: MessageBusLogEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString()
  const toLabel = Array.isArray(entry.to) ? (entry.to.length > 0 ? entry.to.map(shortPath).join(', ') : '*') : shortPath(String(entry.to))
  return (
    <div
      className={`text-xs rounded p-2 border ${
        entry.delivered
          ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700'
          : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700'
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-neutral-400">{time}</span>
        <span className={`font-semibold ${entry.delivered ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
          {entry.delivered ? 'DELIVERED' : 'FAILED'}
        </span>
        {entry.channel && (
          <span className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded text-[10px]">
            {entry.channel}
          </span>
        )}
        <span className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded text-[10px]">
          {entry.type}
        </span>
      </div>
      <div className="text-neutral-600 dark:text-neutral-400 font-mono">
        <span title={entry.from}>{shortPath(entry.from)}</span>
        {' -> '}
        <span>{toLabel}</span>
      </div>
      {entry.deliveredTo.length > 0 && (
        <div className="text-neutral-400 mt-0.5">
          Delivered to: {entry.deliveredTo.map(shortPath).join(', ')}
        </div>
      )}
      {entry.error && (
        <div className="text-red-600 mt-0.5 font-medium">{entry.error}</div>
      )}
      <div className="text-neutral-500 dark:text-neutral-400 mt-1 truncate" title={entry.content}>
        {entry.content}
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    active: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
    idle: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
    hibernate: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
    suspended: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
    off: 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400',
    error: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
    not_participating: 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[state] ?? 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'}`}>
      {state}
    </span>
  )
}

function BoolBadge({ value }: { value: boolean }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
        value ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
      }`}
    >
      {value ? 'YES' : 'NO'}
    </span>
  )
}

function shortPath(p: string): string {
  const parts = p.split('/')
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p
}
