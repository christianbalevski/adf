import { useEffect, useRef } from 'react'
import type { AdapterLogEntry } from '../../../shared/types/channel-adapter.types'

interface AdapterLogsProps {
  logs: AdapterLogEntry[]
  onClose: () => void
  adapterType: string
}

export function AdapterLogs({ logs, onClose, adapterType }: AdapterLogsProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  return (
    <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Logs: {adapterType}
        </span>
        <button
          onClick={onClose}
          className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          Close
        </button>
      </div>
      <div
        ref={scrollRef}
        className="max-h-48 overflow-y-auto bg-neutral-900 p-2"
      >
        {logs.length === 0 ? (
          <p className="text-xs text-neutral-500 font-mono">No logs yet.</p>
        ) : (
          logs.map((entry, i) => {
            const time = new Date(entry.timestamp).toLocaleTimeString()
            const color =
              entry.level === 'error' ? 'text-red-400' :
              entry.level === 'warn' ? 'text-yellow-400' :
              entry.level === 'system' ? 'text-blue-400' :
              'text-neutral-300'
            return (
              <div key={i} className="flex gap-2 text-[11px] font-mono leading-relaxed">
                <span className="text-neutral-500 shrink-0">{time}</span>
                <span className={color}>{entry.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
