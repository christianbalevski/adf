import { useEffect, useMemo, useState } from 'react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import type { MeshDebugInfo, MessageBusLogEntry } from '../../../shared/types/ipc.types'

interface MeshLogDrawerProps {
  debugInfo: MeshDebugInfo | null
  onRefresh: () => void
}

type DrawerTab = 'feed' | 'bus'
type StatusFilter = 'all' | 'delivered' | 'failed'

/**
 * Fleet activity drawer — message feed (filterable, expandable rows)
 * plus a Bus tab covering registrations and running agents.
 */
export function MeshLogDrawer({ debugInfo, onRefresh }: MeshLogDrawerProps) {
  const show = useMeshGraphStore((s) => s.showLogDrawer)
  const setShow = useMeshGraphStore((s) => s.setShowLogDrawer)
  const [tab, setTab] = useState<DrawerTab>('feed')

  if (!show) return null

  const messageCount = debugInfo?.messageLog.length ?? 0
  const agentCount = debugInfo
    ? debugInfo.backgroundAgents.length + debugInfo.foregroundAgents.length
    : 0

  return (
    <div className="absolute top-0 right-0 h-full w-[320px] bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm border-l border-neutral-200 dark:border-neutral-800 shadow-xl z-20 flex flex-col animate-[slideIn_0.2s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
          <h3 className="text-[11px] font-semibold text-neutral-700 dark:text-neutral-200 tracking-wide">
            Activity
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            title="Refresh"
            className="p-1 rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 11-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            onClick={() => setShow(false)}
            title="Close"
            className="p-1 rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <TabButton active={tab === 'feed'} onClick={() => setTab('feed')}>
          Feed{messageCount > 0 ? ` · ${messageCount}` : ''}
        </TabButton>
        <TabButton active={tab === 'bus'} onClick={() => setTab('bus')}>
          Bus{agentCount > 0 ? ` · ${agentCount}` : ''}
        </TabButton>
      </div>

      {!debugInfo ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-neutral-400 dark:text-neutral-500">Loading…</p>
        </div>
      ) : tab === 'feed' ? (
        <MessageFeed messages={debugInfo.messageLog} />
      ) : (
        <BusPanel debugInfo={debugInfo} />
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-0.5 text-[11px] rounded-full transition-colors ${
        active
          ? 'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 font-medium'
          : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
      }`}
    >
      {children}
    </button>
  )
}

// --- Message feed ---

function MessageFeed({ messages }: { messages: MessageBusLogEntry[] }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const now = useNow(30_000)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const result = messages.filter((m) => {
      if (status === 'delivered' && !m.delivered) return false
      if (status === 'failed' && m.delivered) return false
      if (!q) return true
      return (
        shortPath(m.from).toLowerCase().includes(q) ||
        m.to.some((t) => shortPath(t).toLowerCase().includes(q)) ||
        m.deliveredTo.some((t) => shortPath(t).toLowerCase().includes(q)) ||
        m.channel.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q)
      )
    })
    // Newest first
    return [...result].sort((a, b) => b.timestamp - a.timestamp)
  }, [messages, query, status])

  const failedCount = useMemo(() => messages.filter((m) => !m.delivered).length, [messages])

  return (
    <>
      {/* Filter bar */}
      <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 space-y-1.5 shrink-0">
        <div className="relative">
          <svg
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500 pointer-events-none"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by agent, channel, content…"
            className="w-full pl-7 pr-2 py-1 text-[11px] rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 border border-transparent focus:border-violet-300 dark:focus:border-violet-700 focus:bg-white dark:focus:bg-neutral-900 outline-none transition-colors"
          />
        </div>
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 w-fit">
          {(['all', 'delivered', 'failed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-2 py-px text-[10px] rounded-full capitalize transition-colors ${
                status === s
                  ? 'bg-white dark:bg-neutral-900 shadow-sm text-neutral-700 dark:text-neutral-200 font-medium'
                  : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
              }`}
            >
              {s === 'failed' && failedCount > 0 ? `failed · ${failedCount}` : s}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-300 dark:text-neutral-600 mb-2">
              <path d="M22 2L11 13" />
              <path d="M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
            {messages.length === 0 ? (
              <>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">No messages yet</p>
                <p className="text-[10px] text-neutral-300 dark:text-neutral-600 mt-1">
                  Agent-to-agent traffic will show up here
                </p>
              </>
            ) : (
              <>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">Nothing matches</p>
                <p className="text-[10px] text-neutral-300 dark:text-neutral-600 mt-1">
                  Try a different filter
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {filtered.map((entry) => (
              <MessageRow
                key={entry.messageId}
                entry={entry}
                now={now}
                expanded={expandedId === entry.messageId}
                onToggle={() =>
                  setExpandedId((id) => (id === entry.messageId ? null : entry.messageId))
                }
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function MessageRow({
  entry,
  now,
  expanded,
  onToggle
}: {
  entry: MessageBusLogEntry
  now: number
  expanded: boolean
  onToggle: () => void
}) {
  const recipients = entry.deliveredTo.length > 0 ? entry.deliveredTo : entry.to
  const shownRecipients = recipients.slice(0, 2)
  const extraRecipients = recipients.length - shownRecipients.length

  return (
    <div
      className={`border-l-2 ${
        entry.delivered
          ? 'border-l-transparent'
          : 'border-l-red-400 dark:border-l-red-500 bg-red-50/50 dark:bg-red-900/10'
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
      >
        {/* Route line: glyph · from → to · channel · time */}
        <div className="flex items-center gap-1 min-w-0">
          <svg
            width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className="text-violet-400 dark:text-violet-500 shrink-0"
          >
            <path d="M22 2L11 13" />
            <path d="M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
          <HandleChip handle={shortPath(entry.from)} />
          <span className="text-neutral-300 dark:text-neutral-600 text-[10px] shrink-0">&rarr;</span>
          <span className="flex items-center gap-1 min-w-0 truncate">
            {shownRecipients.length === 0 ? (
              <HandleChip handle="*" />
            ) : (
              shownRecipients.map((r) => <HandleChip key={r} handle={shortPath(r)} />)
            )}
            {extraRecipients > 0 && (
              <span className="text-[9px] text-neutral-400 dark:text-neutral-500 shrink-0">
                +{extraRecipients}
              </span>
            )}
          </span>
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {entry.channel && entry.channel !== '*' && (
              <span className="px-1.5 py-px rounded-full text-[9px] bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border border-violet-100 dark:border-violet-800/60">
                #{entry.channel}
              </span>
            )}
            <span className="text-[9px] text-neutral-400 dark:text-neutral-500 tabular-nums" title={new Date(entry.timestamp).toLocaleString()}>
              {relTime(entry.timestamp, now)}
            </span>
            <DeliveryMark delivered={entry.delivered} error={entry.error} />
          </span>
        </div>

        {/* Content preview */}
        {entry.content && !expanded && (
          <p className="mt-0.5 pl-4 text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
            {entry.content}
          </p>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-2.5 pl-7 space-y-1.5">
          <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/70 border border-neutral-200 dark:border-neutral-700/70 p-2 text-[10px] text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono">
            {entry.content || '(empty)'}
          </div>
          {entry.error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 p-2 text-[10px] text-red-600 dark:text-red-300 whitespace-pre-wrap break-words font-mono">
              {entry.error}
            </div>
          )}
          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[9px] font-mono">
            <span className="text-neutral-400 dark:text-neutral-500">to</span>
            <span className="text-neutral-600 dark:text-neutral-300 break-all">
              {entry.to.map(shortPath).join(', ') || '*'}
            </span>
            <span className="text-neutral-400 dark:text-neutral-500">delivered</span>
            <span className="text-neutral-600 dark:text-neutral-300 break-all">
              {entry.deliveredTo.map(shortPath).join(', ') || 'none'}
            </span>
            <span className="text-neutral-400 dark:text-neutral-500">type</span>
            <span className="text-neutral-600 dark:text-neutral-300">{entry.type}</span>
            <span className="text-neutral-400 dark:text-neutral-500">id</span>
            <span className="text-neutral-500 dark:text-neutral-400 break-all">{entry.messageId}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function HandleChip({ handle }: { handle: string }) {
  return (
    <span className="px-1.5 py-px rounded-full text-[9px] font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700 truncate max-w-[80px] shrink-0">
      {handle}
    </span>
  )
}

function DeliveryMark({ delivered, error }: { delivered: boolean; error?: string }) {
  if (delivered) {
    return (
      <svg
        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
        className="text-green-500 dark:text-green-400 shrink-0"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    )
  }
  return (
    <span title={error || 'Delivery failed'} className="shrink-0">
      <svg
        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
        className="text-red-500 dark:text-red-400"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </span>
  )
}

// --- Bus panel (registrations + agents) ---

function BusPanel({ debugInfo }: { debugInfo: MeshDebugInfo }) {
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      <section>
        <h4 className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">
          Bus registrations ({debugInfo.busRegistrations.length})
        </h4>
        {debugInfo.busRegistrations.length === 0 ? (
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 italic">
            No agents registered on the bus
          </p>
        ) : (
          <div className="space-y-1">
            {debugInfo.busRegistrations.map((reg, i) => (
              <div key={i} className="flex items-center gap-1.5 flex-wrap py-0.5">
                <span className="text-[10px] font-mono text-neutral-600 dark:text-neutral-300">
                  {shortPath(reg.name)}
                </span>
                {reg.channels.filter((c) => c !== '*').map((c) => (
                  <span
                    key={c}
                    className="px-1.5 py-px rounded-full text-[9px] bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300 border border-violet-100 dark:border-violet-800/60"
                  >
                    #{c}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">
          Agents ({debugInfo.backgroundAgents.length + debugInfo.foregroundAgents.length})
        </h4>
        {debugInfo.backgroundAgents.length === 0 && debugInfo.foregroundAgents.length === 0 ? (
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 italic">
            No agents running
          </p>
        ) : (
          <div className="space-y-0.5">
            {debugInfo.backgroundAgents.map((a) => (
              <div key={a.filePath} className="flex items-center gap-1.5 text-[10px] py-0.5">
                <StateDot state={a.state} />
                <span className="text-neutral-700 dark:text-neutral-300 truncate">{a.name}</span>
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  <span className="px-1.5 py-px rounded-full text-[9px] bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500 border border-neutral-200 dark:border-neutral-700">
                    bg
                  </span>
                </span>
              </div>
            ))}
            {debugInfo.foregroundAgents.map((a) => (
              <div key={a.filePath} className="flex items-center gap-1.5 text-[10px] py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                <span className="text-neutral-700 dark:text-neutral-300 truncate">{a.name}</span>
                <span className="ml-auto px-1.5 py-px rounded-full text-[9px] bg-blue-50 dark:bg-blue-900/30 text-blue-500 dark:text-blue-300 border border-blue-100 dark:border-blue-800/60 shrink-0">
                  fg
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StateDot({ state }: { state: string }) {
  const colors: Record<string, string> = {
    active: 'bg-yellow-400',
    idle: 'bg-green-400',
    hibernate: 'bg-purple-500',
    suspended: 'bg-red-400',
    off: 'bg-neutral-400',
    error: 'bg-red-400'
  }
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[state] ?? 'bg-neutral-400'}`}
      title={state}
    />
  )
}

// --- Helpers ---

/** Re-render on an interval so relative timestamps stay fresh-ish */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function shortPath(p: string): string {
  const parts = p.split('/')
  const last = parts[parts.length - 1] ?? p
  return last.replace('.adf', '')
}
