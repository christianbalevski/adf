import { useState, useEffect, useRef } from 'react'
import { Dialog } from '../common/Dialog'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import type { MeshDebugInfo, MessageBusLogEntry } from '../../../shared/types/ipc.types'

interface MeshLogDrawerProps {
  debugInfo: MeshDebugInfo | null
  onRefresh: () => void
}

export function MeshLogDrawer({ debugInfo, onRefresh }: MeshLogDrawerProps) {
  const show = useMeshGraphStore((s) => s.showLogDrawer)
  const setShow = useMeshGraphStore((s) => s.setShowLogDrawer)

  if (!show) return null

  return (
    <div className="absolute top-0 right-0 h-full w-[320px] bg-white dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-700 shadow-lg z-20 flex flex-col animate-[slideIn_0.2s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
        <h3 className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">Mesh Log</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="text-[10px] px-2 py-0.5 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 rounded text-neutral-600 dark:text-neutral-300"
          >
            Refresh
          </button>
          <button
            onClick={() => setShow(false)}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {!debugInfo ? (
          <p className="text-xs text-neutral-400 text-center py-4">Loading...</p>
        ) : (
          <>
            {/* Bus Registrations */}
            <Section title="Bus Registrations">
              {debugInfo.busRegistrations.length === 0 ? (
                <p className="text-[10px] text-neutral-400 italic">No agents registered</p>
              ) : (
                <div className="space-y-1">
                  {debugInfo.busRegistrations.map((reg, i) => (
                    <div key={i} className="text-[10px]">
                      <span className="font-mono text-neutral-600 dark:text-neutral-400">{shortPath(reg.name)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Agents */}
            <Section title={`Agents (${debugInfo.backgroundAgents.length + debugInfo.foregroundAgents.length})`}>
              {debugInfo.backgroundAgents.map((a) => (
                <div key={a.filePath} className="flex items-center gap-1.5 text-[10px] py-0.5">
                  <StateBadge state={a.state} />
                  <span className="text-neutral-700 dark:text-neutral-300">{a.name}</span>
                  <span className="text-neutral-400 ml-auto">bg</span>
                </div>
              ))}
              {debugInfo.foregroundAgents.map((a) => (
                <div key={a.filePath} className="flex items-center gap-1.5 text-[10px] py-0.5">
                  <span className="w-1 h-1 rounded-full bg-blue-400 shrink-0" />
                  <span className="text-neutral-700 dark:text-neutral-300">{a.name}</span>
                  <span className="text-neutral-400 ml-auto">fg</span>
                </div>
              ))}
            </Section>

            {/* Message Log */}
            <MessageLogSection messages={debugInfo.messageLog} />
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">
        {title}
      </h4>
      {children}
    </div>
  )
}

function MessageLogSection({ messages }: { messages: MessageBusLogEntry[] }) {
  const [selected, setSelected] = useState<MessageBusLogEntry | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(messages.length)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = messages.length
  }, [messages.length])

  return (
    <>
      <Section title={`Messages (${messages.length})`}>
        {messages.length === 0 ? (
          <p className="text-[10px] text-neutral-400 italic">No messages</p>
        ) : (
          <div ref={scrollRef} className="space-y-1 max-h-[400px] overflow-y-auto">
            {messages.map((entry) => (
              <MessageRow key={entry.messageId} entry={entry} onClick={() => setSelected(entry)} />
            ))}
          </div>
        )}
      </Section>

      <Dialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Mesh Message"
        wide
      >
        {selected && <MeshMessageDetail entry={selected} />}
        <div className="mt-4 flex justify-end">
          <button
            className="px-3 py-1.5 text-xs bg-neutral-200 dark:bg-neutral-700 rounded hover:bg-neutral-300 dark:hover:bg-neutral-600"
            onClick={() => setSelected(null)}
          >
            Close
          </button>
        </div>
      </Dialog>
    </>
  )
}

function MessageRow({ entry, onClick }: { entry: MessageBusLogEntry; onClick: () => void }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const preview = entry.content
    ? entry.content.length > 80 ? entry.content.slice(0, 80) + '...' : entry.content
    : undefined

  return (
    <button
      onClick={onClick}
      className={`w-full text-left text-[10px] p-2 rounded border transition-colors cursor-pointer ${
        entry.delivered
          ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/20'
          : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/20'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-neutral-700 dark:text-neutral-300">
          {shortPath(entry.from)}
        </span>
        <span className="text-neutral-400">&rarr;</span>
        <span className="font-medium text-neutral-700 dark:text-neutral-300 truncate">
          {entry.deliveredTo.map(shortPath).join(', ') || entry.to.map(shortPath).join(', ') || '*'}
        </span>
        {entry.channel && entry.channel !== '*' && (
          <span className="ml-auto px-1 bg-blue-50 dark:bg-blue-900/20 text-blue-500 rounded text-[9px] shrink-0">
            #{entry.channel}
          </span>
        )}
      </div>
      {preview && (
        <div className="text-neutral-500 dark:text-neutral-500 mt-0.5 truncate">
          {preview}
        </div>
      )}
      <div className="text-neutral-400 dark:text-neutral-600 mt-0.5">{time}</div>
    </button>
  )
}

function MeshMessageDetail({ entry }: { entry: MessageBusLogEntry }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <span className="text-neutral-400 dark:text-neutral-500">From</span>
        <span className="text-neutral-700 dark:text-neutral-300">{shortPath(entry.from)}</span>

        <span className="text-neutral-400 dark:text-neutral-500">To</span>
        <span className="text-neutral-700 dark:text-neutral-300">{entry.to.map(shortPath).join(', ') || '*'}</span>

        <span className="text-neutral-400 dark:text-neutral-500">Delivered to</span>
        <span className="text-neutral-700 dark:text-neutral-300">{entry.deliveredTo.map(shortPath).join(', ') || 'none'}</span>

        {entry.channel && (
          <>
            <span className="text-neutral-400 dark:text-neutral-500">Channel</span>
            <span className="text-neutral-700 dark:text-neutral-300">{entry.channel}</span>
          </>
        )}

        <span className="text-neutral-400 dark:text-neutral-500">Type</span>
        <span className="text-neutral-700 dark:text-neutral-300">{entry.type}</span>

        <span className="text-neutral-400 dark:text-neutral-500">Status</span>
        <span className={`font-medium ${entry.delivered ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {entry.delivered ? 'Delivered' : 'Failed'}
        </span>

        <span className="text-neutral-400 dark:text-neutral-500">Time</span>
        <span className="text-neutral-700 dark:text-neutral-300">{new Date(entry.timestamp).toLocaleString()}</span>

        <span className="text-neutral-400 dark:text-neutral-500">ID</span>
        <span className="text-neutral-700 dark:text-neutral-300 font-mono text-[10px]">{entry.messageId}</span>
      </div>

      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
        <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Content
        </label>
        <div className="rounded-lg p-3 text-xs whitespace-pre-wrap bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700 max-h-[400px] overflow-y-auto">
          {entry.content || '(empty)'}
        </div>
      </div>

      {entry.error && (
        <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Error
          </label>
          <div className="rounded-lg p-3 text-xs whitespace-pre-wrap bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700">
            {entry.error}
          </div>
        </div>
      )}
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    active: 'bg-yellow-400',
    idle: 'bg-green-400',
    hibernate: 'bg-purple-500',
    suspended: 'bg-red-400',
    off: 'bg-neutral-400',
    error: 'bg-red-400'
  }
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[state] ?? 'bg-neutral-400'}`} />
}

function shortPath(p: string): string {
  const parts = p.split('/')
  const last = parts[parts.length - 1] ?? p
  return last.replace('.adf', '')
}
