import { useState, memo } from 'react'
import { Dialog } from '../common/Dialog'
import { useAgentStore } from '../../stores/agent.store'
import { useInboxStore } from '../../stores/inbox.store'
import type { InboxMessage, RendererOutboxMessage } from '../../../shared/types/adf.types'

type StatusFilter = 'all' | 'unread' | 'read' | 'archived' | 'outbox'

export function InboxPanel() {
  // Read inbox data from shared store (populated by AppShell polling)
  const inboxData = useInboxStore((s) => s.inboxData)
  const outboxMessages = useInboxStore((s) => s.outboxMessages)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selectedMessage, setSelectedMessage] = useState<InboxMessage | null>(null)
  const [selectedOutboxMessage, setSelectedOutboxMessage] = useState<RendererOutboxMessage | null>(null)
  const config = useAgentStore((s) => s.config)

  const inboxMode = config?.messaging?.inbox_mode === true

  if (!inboxMode) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Inbox mode is not enabled.
          </p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
            Enable it in Agent &rarr; Config &rarr; Messaging &rarr; Inbox mode.
          </p>
        </div>
      </div>
    )
  }

  const messages = inboxData?.messages ?? []
  const filtered = filter === 'all'
    ? messages
    : filter === 'outbox'
      ? []
      : messages.filter((m) => m.status === filter)

  // Sort newest-first for the panel view
  const sorted = [...filtered].sort((a, b) => b.received_at - a.received_at)
  const sortedOutbox = filter === 'outbox'
    ? [...outboxMessages].sort((a, b) => b.created_at - a.created_at)
    : []

  const counts = {
    all: messages.length,
    unread: messages.filter((m) => m.status === 'unread').length,
    read: messages.filter((m) => m.status === 'read').length,
    archived: messages.filter((m) => m.status === 'archived').length,
    outbox: outboxMessages.length
  }

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="shrink-0 px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            {(['all', 'unread', 'read', 'archived', 'outbox'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                  filter === f
                    ? 'bg-blue-500 text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                } ${f !== 'all' ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
              >
                {f === 'outbox' ? 'Sent' : f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
              </button>
            ))}
          </div>
          {messages.length > 0 && (
            <button
              onClick={async () => {
                await window.adfApi?.clearInbox()
              }}
              className="text-[10px] text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
              title="Clear all messages"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto">
        {filter === 'outbox' ? (
          sortedOutbox.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-neutral-400 dark:text-neutral-500">No sent messages yet.</p>
            </div>
          ) : (
            <div className="p-2 space-y-1.5">
              {sortedOutbox.map((msg) => (
                <OutboxRow key={msg.id} message={msg} onClick={() => setSelectedOutboxMessage(msg)} />
              ))}
            </div>
          )
        ) : sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              {messages.length === 0 ? 'No messages yet.' : 'No messages match this filter.'}
            </p>
          </div>
        ) : (
          <div className="p-2 space-y-1.5">
            {sorted.map((msg) => (
              <MessageRow
                key={msg.id}
                message={msg}
                onClick={() => setSelectedMessage(msg)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Message detail modal */}
      <Dialog
        open={selectedMessage !== null}
        onClose={() => setSelectedMessage(null)}
        title="Message"
        wide
      >
        {selectedMessage && <MessageDetail message={selectedMessage} />}
        <div className="mt-4 flex justify-end">
          <button
            className="px-3 py-1.5 text-xs bg-neutral-200 dark:bg-neutral-700 rounded hover:bg-neutral-300 dark:hover:bg-neutral-600"
            onClick={() => setSelectedMessage(null)}
          >
            Close
          </button>
        </div>
      </Dialog>

      {/* Outbox detail modal */}
      <Dialog
        open={selectedOutboxMessage !== null}
        onClose={() => setSelectedOutboxMessage(null)}
        title="Sent Message"
        wide
      >
        {selectedOutboxMessage && <OutboxDetail message={selectedOutboxMessage} />}
        <div className="mt-4 flex justify-end">
          <button
            className="px-3 py-1.5 text-xs bg-neutral-200 dark:bg-neutral-700 rounded hover:bg-neutral-300 dark:hover:bg-neutral-600"
            onClick={() => setSelectedOutboxMessage(null)}
          >
            Close
          </button>
        </div>
      </Dialog>
    </div>
  )
}

const MessageRow = memo(function MessageRow({ message, onClick }: { message: InboxMessage; onClick: () => void }) {
  const isUnread = message.status === 'unread'
  const displayName = message.sender_alias || message.from

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg p-2.5 transition-colors cursor-pointer bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 hover:bg-purple-100 dark:hover:bg-purple-900/30"
    >
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        {/* Unread indicator */}
        {isUnread && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
        )}
        <span
          className="text-[10px] font-semibold truncate min-w-0 text-purple-600 dark:text-purple-400"
          title={message.from}
        >
          {displayName}
        </span>
        {message.source && message.source !== 'mesh' && (
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${sourceChipStyle(message.source)}`}
          >
            {message.source}
          </span>
        )}
        <StatusBadge status={message.status} />
        <VerificationBadge meta={message.meta} />
        <span className="ml-auto text-[9px] text-neutral-400 dark:text-neutral-500 shrink-0">
          {formatTime(message.received_at)}
        </span>
      </div>
      {message.subject && (
        <div className="text-[10px] font-medium text-purple-700 dark:text-purple-300 truncate mb-0.5">
          {message.subject}
        </div>
      )}
      <div className="text-xs truncate text-purple-800 dark:text-purple-300">
        {message.content}
      </div>
    </button>
  )
})

const OutboxRow = memo(function OutboxRow({ message, onClick }: { message: RendererOutboxMessage; onClick: () => void }) {
  const displayName = message.recipient_alias || message.to
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg p-2.5 transition-colors cursor-pointer bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 hover:bg-indigo-100 dark:hover:bg-indigo-900/30"
    >
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        <span
          className="text-[10px] font-semibold truncate min-w-0 text-indigo-600 dark:text-indigo-400"
          title={message.to}
        >
          To: {displayName}
        </span>
        <OutboxStatusBadge status={message.status} />
        {message.status_code != null && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 shrink-0">
            {message.status_code}
          </span>
        )}
        <span className="ml-auto text-[9px] text-neutral-400 dark:text-neutral-500 shrink-0">
          {formatTime(message.created_at)}
        </span>
      </div>
      {message.subject && (
        <div className="text-[10px] font-medium text-indigo-700 dark:text-indigo-300 truncate mb-0.5">
          {message.subject}
        </div>
      )}
      <div className="text-xs truncate text-indigo-800 dark:text-indigo-300">
        {message.content}
      </div>
    </button>
  )
})

const OutboxStatusBadge = memo(function OutboxStatusBadge({ status }: { status: RendererOutboxMessage['status'] }) {
  const styles: Record<RendererOutboxMessage['status'], string> = {
    pending: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400',
    sent: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    delivered: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    failed: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
  }
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${styles[status]}`}>
      {status}
    </span>
  )
})

const OutboxDetail = memo(function OutboxDetail({ message }: { message: RendererOutboxMessage }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <MetaRow label="To" value={message.recipient_alias ? `${message.recipient_alias} (${message.to})` : message.to} mono />
        <MetaRow label="From" value={message.sender_alias ? `${message.sender_alias} (${message.from})` : message.from} mono />
        <MetaRow label="Reply-To" value={message.reply_to} mono />
        <MetaRow label="Subject" value={message.subject} />

        <span className="text-neutral-400 dark:text-neutral-500">Status</span>
        <span className="flex items-center gap-1.5">
          <OutboxStatusBadge status={message.status} />
        </span>

        <MetaRow label="Status Code" value={message.status_code} />
        <MetaRow label="Created" value={message.created_at} />
        <MetaRow label="Delivered" value={message.delivered_at} />
        <MetaRow label="Thread ID" value={message.thread_id} mono />
        <MetaRow label="Parent ID" value={message.parent_id} mono />
        <MetaRow label="ID" value={message.id} mono />
      </div>

      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
        <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Content
        </label>
        <pre className="whitespace-pre-wrap overflow-auto max-h-[50vh] text-xs font-mono text-neutral-800 dark:text-neutral-200 bg-neutral-50 dark:bg-neutral-900 rounded-lg p-3 border border-neutral-200 dark:border-neutral-700">
          {message.content}
        </pre>
      </div>
    </div>
  )
})

const MetaRow = memo(function MetaRow({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (value == null || value === '') return null
  return (
    <>
      <span className="text-neutral-400 dark:text-neutral-500">{label}</span>
      <span className={`text-neutral-700 dark:text-neutral-300 ${mono ? 'font-mono text-[10px]' : ''}`}>
        {typeof value === 'number' ? new Date(value).toLocaleString() : value}
      </span>
    </>
  )
})

const MessageDetail = memo(function MessageDetail({ message }: { message: InboxMessage }) {
  return (
    <div className="space-y-3">
      {/* Metadata grid */}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <MetaRow label="From" value={message.sender_alias ? `${message.sender_alias} (${message.from})` : message.from} mono />
        <MetaRow label="To" value={message.to} mono />
        <MetaRow label="Reply-To" value={message.reply_to} mono />
        <MetaRow label="Subject" value={message.subject} />
        <MetaRow label="Source" value={message.source} />
        <MetaRow label="Network" value={message.network} />

        <span className="text-neutral-400 dark:text-neutral-500">Status</span>
        <StatusBadge status={message.status} />

        {(message.meta?.message_verified != null || message.meta?.payload_verified != null || message.meta?.identity_verified != null) && (
          <>
            <span className="text-neutral-400 dark:text-neutral-500">Security</span>
            <span className="flex items-center gap-1.5">
              <VerificationBadge meta={message.meta} />
              {message.meta?.message_verified === true && message.meta?.payload_verified !== true && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">message only</span>
              )}
              {message.meta?.message_verified === true && message.meta?.payload_verified === true && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">message + payload</span>
              )}
            </span>
          </>
        )}

        <MetaRow label="Received" value={message.received_at} />
        <MetaRow label="Sent" value={message.sent_at} />
        <MetaRow label="Thread ID" value={message.thread_id} mono />
        <MetaRow label="Parent ID" value={message.parent_id} mono />
        <MetaRow label="ID" value={message.id} mono />
      </div>

      {/* Source context */}
      {message.source_context && Object.keys(message.source_context).length > 0 && (
        <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Source Context
          </label>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {Object.entries(message.source_context).map(([key, val]) => (
              <MetaRow key={key} label={key} value={String(val)} mono />
            ))}
          </div>
        </div>
      )}

      {/* Attachments */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Attachments ({message.attachments.length})
          </label>
          <div className="space-y-1">
            {message.attachments.map((att, i) => (
              <div key={i} className="text-xs text-neutral-700 dark:text-neutral-300 font-mono bg-neutral-50 dark:bg-neutral-800 rounded px-2 py-1">
                {att.filename} <span className="text-neutral-400 dark:text-neutral-500">({att.content_type}{att.size_bytes != null ? `, ${formatSize(att.size_bytes)}` : ''})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
        <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Content
        </label>
        <pre className="whitespace-pre-wrap overflow-auto max-h-[50vh] text-xs font-mono text-neutral-800 dark:text-neutral-200 bg-neutral-50 dark:bg-neutral-900 rounded-lg p-3 border border-neutral-200 dark:border-neutral-700">
          {message.content}
        </pre>
      </div>

      {/* Raw original message */}
      {message.original_message && <RawMessageSection rawMessage={message.original_message} />}
    </div>
  )
})

const RawMessageSection = memo(function RawMessageSection({ rawMessage }: { rawMessage: string }) {
  const [expanded, setExpanded] = useState(false)
  let formatted: string
  try {
    formatted = JSON.stringify(JSON.parse(rawMessage), null, 2)
  } catch {
    formatted = rawMessage
  }
  return (
    <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1 hover:text-neutral-600 dark:hover:text-neutral-300"
      >
        <span className="text-[8px]">{expanded ? '\u25BC' : '\u25B6'}</span>
        Raw Message
      </button>
      {expanded && (
        <pre className="whitespace-pre-wrap overflow-auto max-h-[40vh] text-[10px] font-mono text-neutral-600 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-900 rounded-lg p-3 border border-neutral-200 dark:border-neutral-700">
          {formatted}
        </pre>
      )}
    </div>
  )
})

const StatusBadge = memo(function StatusBadge({ status }: { status: InboxMessage['status'] }) {
  const styles: Record<InboxMessage['status'], string> = {
    unread: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    read: 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400',
    archived: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
  }

  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${styles[status]}`}>
      {status}
    </span>
  )
})

/** Verification badge for signed/unsigned messages. */
const VerificationBadge = memo(function VerificationBadge({ meta }: { meta?: Record<string, unknown> }) {
  if (!meta) return null
  const msgVerified = meta.message_verified
  const payVerified = meta.payload_verified
  const idVerified = meta.identity_verified
  // Only show if verification data exists (message went through ALF pipeline or WS cold path)
  if (msgVerified == null && payVerified == null && idVerified == null) return null

  if (msgVerified === true && payVerified === true) {
    return (
      <span
        className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 font-medium"
        title="Message and payload signatures verified"
      >
        signed
      </span>
    )
  }
  if (msgVerified === true) {
    return (
      <span
        className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 font-medium"
        title="Message signature verified"
      >
        signed
      </span>
    )
  }
  if (idVerified === false) {
    return (
      <span
        className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium"
        title="Sender identity not cryptographically verified (WebSocket)"
      >
        unverified
      </span>
    )
  }
  return (
    <span
      className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 font-medium"
      title="No signature"
    >
      unsigned
    </span>
  )
})

/** Color mapping for known adapter sources. */
function sourceChipStyle(source: string): string {
  switch (source) {
    case 'telegram':
      return 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
    default:
      return 'bg-purple-100 dark:bg-purple-900/30 text-purple-500 dark:text-purple-400'
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}
