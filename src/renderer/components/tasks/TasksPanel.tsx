import { useState, useEffect, useRef, useCallback } from 'react'
import { useDocumentStore } from '../../stores/document.store'
import { formatTime } from '../logs/LogsPanel'
import type { TaskEntry, TaskStatus } from '../../../shared/types/adf-v02.types'
import { TASK_STATUSES } from '../../../shared/types/adf-v02.types'

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'text-yellow-400',
  pending_approval: 'text-orange-400',
  running: 'text-blue-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
  denied: 'text-red-400',
  cancelled: 'text-neutral-500'
}

export function useTasksCount(): number {
  const [count, setCount] = useState(0)
  const filePath = useDocumentStore((s) => s.filePath)

  useEffect(() => {
    if (!filePath) { setCount(0); return }
    window.adfApi?.getTasks(1).then(({ tasks }) => setCount(tasks.length > 0 ? -1 : 0))
    // We just need to know if there are tasks; actual count comes from the full fetch
  }, [filePath])

  return count
}

export function TasksPanel() {
  const filePath = useDocumentStore((s) => s.filePath)

  const [tasks, setTasks] = useState<TaskEntry[]>([])
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchTasks = useCallback(() => {
    window.adfApi?.getTasks(200).then(({ tasks: fetched }) => {
      // API returns newest-first; reverse for chronological (newest at bottom)
      setTasks([...fetched].reverse())
    })
  }, [])

  // Load tasks when file changes
  useEffect(() => {
    setTasks([])
    setExpandedId(null)
    setUserScrolledUp(false)
    if (!filePath) return
    fetchTasks()
  }, [filePath, fetchTasks])

  // Auto-scroll to bottom when new tasks arrive (unless user scrolled up)
  useEffect(() => {
    if (!userScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [tasks, userScrolledUp])

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(fetchTasks, 2000)
    return () => clearInterval(interval)
  }, [autoRefresh, fetchTasks])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setUserScrolledUp(scrollHeight - scrollTop - clientHeight > 40)
  }, [])

  const filtered = statusFilter === 'all'
    ? tasks
    : tasks.filter((t) => t.status === statusFilter)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-400 shrink-0">
        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'all')}
          className="bg-neutral-800 text-neutral-300 border border-neutral-700 rounded px-1.5 py-0.5 text-[11px] outline-none"
        >
          <option value="all">All Statuses</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>

        {/* Auto-refresh toggle */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
            autoRefresh
              ? 'bg-green-900/40 text-green-400 border border-green-800'
              : 'hover:bg-neutral-800 text-neutral-500'
          }`}
          title={autoRefresh ? 'Stop auto-refresh' : 'Start auto-refresh (2s)'}
        >
          {autoRefresh && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          )}
          Auto
        </button>

        {/* Manual refresh */}
        {!autoRefresh && (
          <button
            onClick={fetchTasks}
            className="hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300 px-1.5 py-0.5 rounded text-[11px]"
            title="Refresh"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}

        <div className="flex-1" />

        <span className="text-neutral-600 text-[10px]">{filtered.length} tasks</span>
      </div>

      {/* Task content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-[11px] leading-[18px] px-3 py-1"
      >
        {filtered.length === 0 ? (
          <div className="text-neutral-600 py-4 text-center">No tasks</div>
        ) : (
          filtered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={expandedId === task.id}
              onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function TaskRow({
  task,
  expanded,
  onToggle
}: {
  task: TaskEntry
  expanded: boolean
  onToggle: () => void
}) {
  const statusColor = STATUS_COLORS[task.status] || 'text-neutral-500'
  const hasDuration = task.completed_at && task.created_at
  const duration = hasDuration
    ? ((task.completed_at! - task.created_at) / 1000).toFixed(1) + 's'
    : null

  return (
    <div>
      <div
        onClick={onToggle}
        className="flex gap-2 cursor-pointer hover:bg-neutral-900/50"
      >
        <span className="text-neutral-600 shrink-0 select-none">
          [{formatTime(task.created_at)}]
        </span>
        <span className={`shrink-0 font-semibold uppercase ${statusColor}`}>
          {task.status.replace('_', ' ')}
        </span>
        <span className="text-cyan-400 shrink-0">{task.tool}</span>
        {task.requires_authorization && (
          <span className="text-orange-400 shrink-0" title="Requires authorized code to resolve">AUTH</span>
        )}
        {task.origin && (
          <span className="text-neutral-500">
            — {task.origin}
          </span>
        )}
        {duration && (
          <span className="text-neutral-600 shrink-0">({duration})</span>
        )}
        <span className="text-neutral-600 shrink-0 select-none ml-auto">
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
      </div>
      {expanded && (
        <pre className="ml-8 my-1 px-2 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-[10px] text-neutral-400 overflow-x-auto whitespace-pre-wrap">
          {formatTaskDetails(task)}
        </pre>
      )}
    </div>
  )
}

function formatTaskDetails(task: TaskEntry): string {
  const parts: string[] = []

  if (task.args && task.args !== '{}') {
    parts.push(`Args: ${formatJsonSafe(task.args)}`)
  }
  if (task.result) {
    parts.push(`Result: ${formatJsonSafe(task.result)}`)
  }
  if (task.error) {
    parts.push(`Error: ${task.error}`)
  }
  if (task.completed_at && task.created_at) {
    const dur = ((task.completed_at - task.created_at) / 1000).toFixed(1)
    parts.push(`Duration: ${dur}s`)
  }
  if (task.requires_authorization) {
    parts.push(`Requires Authorization: yes`)
  }
  parts.push(`ID: ${task.id}`)

  return parts.join('\n')
}

function formatJsonSafe(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
