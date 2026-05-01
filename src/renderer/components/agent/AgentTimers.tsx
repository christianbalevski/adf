import { useState, useEffect, useCallback } from 'react'
import { Dialog } from '../common/Dialog'
import type { TimerSchedule } from '../../../shared/types/adf-v02.types'

interface Timer {
  id: number
  schedule: TimerSchedule
  next_wake_at: number
  payload?: string
  scope: string[]
  lambda?: string
  warm?: boolean
  run_count: number
  created_at: number
  last_fired_at?: number
  locked?: boolean
}

function formatRelative(ms: number): string {
  const now = Date.now()
  const diff = ms - now
  if (diff <= 0) return 'overdue'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `in ${days}d ${hours % 24}h`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  if (ms < 3600000) return `${(ms / 60000).toFixed(0)}m`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`
  return `${(ms / 86400000).toFixed(1)}d`
}

function ScheduleBadge({ schedule }: { schedule: TimerSchedule }) {
  switch (schedule.mode) {
    case 'once':
      return (
        <span className="inline-block px-1.5 py-0.5 text-[10px] bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded">
          once
        </span>
      )
    case 'interval':
      return (
        <span className="inline-block px-1.5 py-0.5 text-[10px] bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded">
          every {formatDuration(schedule.every_ms)}
        </span>
      )
    case 'cron':
      return (
        <span className="inline-block px-1.5 py-0.5 text-[10px] bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 rounded font-mono">
          {schedule.cron}
        </span>
      )
  }
}

// =============================================================================
// Shared input/label classes
// =============================================================================

const inputClass =
  'w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg ' +
  'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500'

const labelClass = 'block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1'

// =============================================================================
// Interval helpers — let user pick a number + unit instead of raw ms
// =============================================================================

type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days'

function unitToMs(value: number, unit: IntervalUnit): number {
  switch (unit) {
    case 'seconds': return value * 1000
    case 'minutes': return value * 60_000
    case 'hours':   return value * 3_600_000
    case 'days':    return value * 86_400_000
  }
}

// =============================================================================
// Reverse-map helpers for edit mode
// =============================================================================

function msToUnit(ms: number): { value: number; unit: IntervalUnit } {
  if (ms % 86_400_000 === 0) return { value: ms / 86_400_000, unit: 'days' }
  if (ms % 3_600_000 === 0) return { value: ms / 3_600_000, unit: 'hours' }
  if (ms % 60_000 === 0) return { value: ms / 60_000, unit: 'minutes' }
  return { value: ms / 1000, unit: 'seconds' }
}

function toDatetimeLocal(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// =============================================================================
// TimerDialog (create + edit)
// =============================================================================

type ScheduleMode = 'once_delay' | 'once_at' | 'interval' | 'cron'

function TimerDialog({ open, onClose, onSaved, editTimer }: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  editTimer?: Timer
}) {
  const isEdit = !!editTimer

  // Schedule mode
  const [mode, setMode] = useState<ScheduleMode>('once_delay')

  // once_delay
  const [delayValue, setDelayValue] = useState('5')
  const [delayUnit, setDelayUnit] = useState<IntervalUnit>('minutes')

  // once_at
  const [atDatetime, setAtDatetime] = useState('')

  // interval
  const [intervalValue, setIntervalValue] = useState('1')
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('hours')
  const [maxRuns, setMaxRuns] = useState('')
  const [endAt, setEndAt] = useState('')

  // cron
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [cronMaxRuns, setCronMaxRuns] = useState('')
  const [cronEndAt, setCronEndAt] = useState('')

  // scope
  const [scope, setScope] = useState<'system' | 'agent'>('system')

  // lambda, warm & payload
  const [lambda, setLambda] = useState('')
  const [warm, setWarm] = useState(false)
  const [payload, setPayload] = useState('')

  // submission state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const resetForm = useCallback(() => {
    setMode('once_delay')
    setDelayValue('5')
    setDelayUnit('minutes')
    setAtDatetime('')
    setIntervalValue('1')
    setIntervalUnit('hours')
    setMaxRuns('')
    setEndAt('')
    setCron('0 9 * * 1-5')
    setCronMaxRuns('')
    setCronEndAt('')
    setScope('system')
    setLambda('')
    setWarm(false)
    setPayload('')
    setError('')
  }, [])

  // Populate form when editing
  useEffect(() => {
    if (!open) return
    if (!editTimer) { resetForm(); return }

    const s = editTimer.schedule
    switch (s.mode) {
      case 'once':
        setMode('once_at')
        setAtDatetime(toDatetimeLocal(s.at))
        break
      case 'interval': {
        setMode('interval')
        const mapped = msToUnit(s.every_ms)
        setIntervalValue(String(mapped.value))
        setIntervalUnit(mapped.unit)
        setMaxRuns(s.max_runs ? String(s.max_runs) : '')
        setEndAt(s.end_at ? toDatetimeLocal(s.end_at) : '')
        break
      }
      case 'cron':
        setMode('cron')
        setCron(s.cron)
        setCronMaxRuns(s.max_runs ? String(s.max_runs) : '')
        setCronEndAt(s.end_at ? toDatetimeLocal(s.end_at) : '')
        break
    }

    const sc = editTimer.scope[0] === 'agent' ? 'agent' : 'system'
    setScope(sc)
    setLambda(editTimer.lambda ?? '')
    setWarm(editTimer.warm ?? false)
    setPayload(editTimer.payload ?? '')
    setError('')
  }, [open, editTimer, resetForm])

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleSubmit = async () => {
    setError('')

    setSaving(true)
    try {
      const base = {
        scope: [scope],
        lambda: lambda.trim() || undefined,
        warm: (scope === 'system' && lambda.trim() && warm) ? true : undefined,
        payload: payload.trim() || undefined
      }

      let modeArgs: Record<string, unknown>

      switch (mode) {
        case 'once_delay': {
          const v = parseFloat(delayValue)
          if (!v || v <= 0) { setError('Delay must be a positive number'); return }
          modeArgs = { mode: 'once_delay', delay_ms: unitToMs(v, delayUnit) }
          break
        }
        case 'once_at': {
          if (!atDatetime) { setError('Select a date and time'); return }
          const ts = new Date(atDatetime).getTime()
          if (ts <= Date.now()) { setError('Timestamp must be in the future'); return }
          modeArgs = { mode: 'once_at', at: ts }
          break
        }
        case 'interval': {
          const v = parseFloat(intervalValue)
          if (!v || v <= 0) { setError('Interval must be a positive number'); return }
          modeArgs = {
            mode: 'interval',
            every_ms: unitToMs(v, intervalUnit),
            ...(maxRuns ? { max_runs: parseInt(maxRuns) } : {}),
            ...(endAt ? { end_at: new Date(endAt).getTime() } : {})
          }
          break
        }
        case 'cron': {
          if (!cron.trim()) { setError('Cron expression required'); return }
          modeArgs = {
            mode: 'cron',
            cron: cron.trim(),
            ...(cronMaxRuns ? { max_runs: parseInt(cronMaxRuns) } : {}),
            ...(cronEndAt ? { end_at: new Date(cronEndAt).getTime() } : {})
          }
          break
        }
      }

      const args = { ...base, ...modeArgs } as Parameters<NonNullable<typeof window.adfApi>['addTimer']>[0]

      let result: { success: boolean; error?: string } | undefined
      if (isEdit) {
        result = await window.adfApi?.updateTimer({ ...args, id: editTimer!.id })
      } else {
        result = await window.adfApi?.addTimer(args)
      }

      if (result?.success) {
        resetForm()
        onSaved()
        onClose()
      } else {
        setError(result?.error ?? (isEdit ? 'Failed to update timer' : 'Failed to create timer'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} title={isEdit ? 'Edit Timer' : 'Add Timer'}>
      <div className="space-y-4">
        {/* Schedule mode */}
        <div>
          <label className={labelClass}>Schedule</label>
          <div className="grid grid-cols-4 gap-1">
            {([
              ['once_delay', 'Delay'],
              ['once_at', 'At time'],
              ['interval', 'Interval'],
              ['cron', 'Cron']
            ] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`px-2 py-1.5 text-xs rounded-lg border transition-colors ${
                  mode === value
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Mode-specific fields */}
        {mode === 'once_delay' && (
          <div>
            <label className={labelClass}>Fire after</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="1"
                value={delayValue}
                onChange={(e) => setDelayValue(e.target.value)}
                className={inputClass}
              />
              <select
                value={delayUnit}
                onChange={(e) => setDelayUnit(e.target.value as IntervalUnit)}
                className={inputClass}
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          </div>
        )}

        {mode === 'once_at' && (
          <div>
            <label className={labelClass}>Fire at</label>
            <input
              type="datetime-local"
              value={atDatetime}
              onChange={(e) => setAtDatetime(e.target.value)}
              className={inputClass}
            />
          </div>
        )}

        {mode === 'interval' && (
          <>
            <div>
              <label className={labelClass}>Every</label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min="1"
                  value={intervalValue}
                  onChange={(e) => setIntervalValue(e.target.value)}
                  className={inputClass}
                />
                <select
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                  className={inputClass}
                >
                  <option value="seconds">seconds</option>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Max runs</label>
                <input
                  type="number"
                  min="1"
                  placeholder="Unlimited"
                  value={maxRuns}
                  onChange={(e) => setMaxRuns(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>End at</label>
                <input
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
          </>
        )}

        {mode === 'cron' && (
          <>
            <div>
              <label className={labelClass}>Cron expression</label>
              <input
                type="text"
                placeholder="0 9 * * 1-5"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className={inputClass + ' font-mono'}
              />
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
                min hour dom month dow
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Max runs</label>
                <input
                  type="number"
                  min="1"
                  placeholder="Unlimited"
                  value={cronMaxRuns}
                  onChange={(e) => setCronMaxRuns(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>End at</label>
                <input
                  type="datetime-local"
                  value={cronEndAt}
                  onChange={(e) => setCronEndAt(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
          </>
        )}

        {/* Scope */}
        <div>
          <label className={labelClass}>Scope</label>
          <div className="grid grid-cols-2 gap-1">
            {(['system', 'agent'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setScope(value)}
                className={`px-2 py-1.5 text-xs rounded-lg border transition-colors capitalize ${
                  scope === value
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-600'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
            System executes a lambda. Agent wakes the LLM loop.
          </p>
        </div>

        {/* Lambda (only relevant if system scope is selected) */}
        {scope === 'system' && (
          <div>
            <label className={labelClass}>Lambda</label>
            <input
              type="text"
              placeholder="path/file.ts:functionName"
              value={lambda}
              onChange={(e) => setLambda(e.target.value)}
              className={inputClass + ' font-mono text-xs'}
            />
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
              System scope handler. File path and exported function in adf_files.
            </p>
            <label className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300 cursor-pointer mt-2">
              <input
                type="checkbox"
                checked={warm}
                onChange={(e) => setWarm(e.target.checked)}
                className="rounded border-neutral-300 dark:border-neutral-600"
              />
              <span className="text-xs">Keep sandbox warm between invocations</span>
            </label>
          </div>
        )}

        {/* Payload */}
        <div>
          <label className={labelClass}>Payload</label>
          <input
            type="text"
            placeholder="Optional data passed to handler"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Error */}
        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={handleClose}
            className="px-3 py-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-3 py-1.5 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
          >
            {saving ? (isEdit ? 'Saving...' : 'Creating...') : (isEdit ? 'Save' : 'Create Timer')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// =============================================================================
// AgentTimers
// =============================================================================

export function AgentTimers() {
  const [timers, setTimers] = useState<Timer[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTimer, setEditingTimer] = useState<Timer | undefined>()

  const fetchTimers = useCallback(() => {
    window.adfApi?.getTimers().then((result) => {
      setTimers(result?.timers ?? [])
    })
  }, [])

  useEffect(() => {
    fetchTimers()
    const interval = setInterval(fetchTimers, 5000)
    return () => clearInterval(interval)
  }, [fetchTimers])

  const handleDelete = async (id: number) => {
    await window.adfApi?.deleteTimer(id)
    fetchTimers()
  }

  const handleToggleLock = async (timer: Timer) => {
    const s = timer.schedule
    let mode: 'once_at' | 'interval' | 'cron'
    if (s.mode === 'once') mode = 'once_at'
    else if (s.mode === 'interval') mode = 'interval'
    else mode = 'cron'

    await window.adfApi?.updateTimer({
      id: timer.id,
      mode,
      ...(s.mode === 'once' ? { at: s.at } : {}),
      ...(s.mode === 'interval' ? { every_ms: s.every_ms, start_at: s.start_at, end_at: s.end_at, max_runs: s.max_runs } : {}),
      ...(s.mode === 'cron' ? { cron: s.cron, end_at: s.end_at, max_runs: s.max_runs } : {}),
      scope: timer.scope,
      lambda: timer.lambda,
      warm: timer.warm,
      payload: timer.payload,
      locked: !timer.locked
    })
    fetchTimers()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {timers.length} timer{timers.length !== 1 ? 's' : ''} scheduled
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          className="text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
        >
          + Add Timer
        </button>
      </div>

      {/* Timer list */}
      {timers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No timers scheduled.
            </p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              Add a timer or use the sys_set_timer tool.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
          {timers.map((timer) => (
            <div
              key={timer.id}
              className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 bg-white dark:bg-neutral-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                    {new Date(timer.next_wake_at).toLocaleString()}
                  </div>
                  <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                    {formatRelative(timer.next_wake_at)}
                  </div>
                  {timer.payload && (
                    <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-1.5 truncate" title={timer.payload}>
                      {timer.payload}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    <ScheduleBadge schedule={timer.schedule} />
                    <span className="inline-block px-1.5 py-0.5 text-[10px] bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded">
                      {timer.scope.join(', ')}
                    </span>
                    {timer.locked && (
                      <span className="inline-block px-1.5 py-0.5 text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded">
                        locked
                      </span>
                    )}
                  </div>
                  {timer.lambda && (
                    <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 font-mono truncate" title={timer.lambda}>
                      {timer.lambda}
                    </div>
                  )}
                  {timer.schedule.mode !== 'once' && (
                    <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
                      Fired {timer.run_count} time{timer.run_count !== 1 ? 's' : ''}
                      {timer.last_fired_at && (
                        <> &middot; last {formatRelative(timer.last_fired_at)}</>
                      )}
                    </div>
                  )}
                  {timer.schedule.mode !== 'once' && (
                    ('end_at' in timer.schedule && timer.schedule.end_at) ||
                    ('max_runs' in timer.schedule && timer.schedule.max_runs)
                  ) && (
                    <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                      {('end_at' in timer.schedule && timer.schedule.end_at) && (
                        <>Ends {new Date(timer.schedule.end_at).toLocaleString()}</>
                      )}
                      {('end_at' in timer.schedule && timer.schedule.end_at) &&
                       ('max_runs' in timer.schedule && timer.schedule.max_runs) && ' · '}
                      {('max_runs' in timer.schedule && timer.schedule.max_runs) && (
                        <>Max {timer.schedule.max_runs} runs</>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] text-neutral-400/60 dark:text-neutral-600 mt-1">
                    Created {new Date(timer.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="shrink-0 flex flex-col gap-1">
                  <button
                    onClick={() => handleToggleLock(timer)}
                    className={`px-2 py-1 text-[10px] rounded ${
                      timer.locked
                        ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/30'
                        : 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                    }`}
                    title={timer.locked ? 'Unlock timer' : 'Lock timer'}
                  >
                    {timer.locked ? 'Unlock' : 'Lock'}
                  </button>
                  <button
                    onClick={() => { setEditingTimer(timer); setDialogOpen(true) }}
                    disabled={timer.locked}
                    className={`px-2 py-1 text-[10px] rounded ${
                      timer.locked
                        ? 'text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
                        : 'text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30'
                    }`}
                    title={timer.locked ? 'Unlock to edit' : 'Edit timer'}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(timer.id)}
                    disabled={timer.locked}
                    className={`px-2 py-1 text-[10px] rounded ${
                      timer.locked
                        ? 'text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
                        : 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30'
                    }`}
                    title={timer.locked ? 'Unlock to delete' : 'Delete timer'}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <TimerDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingTimer(undefined) }}
        onSaved={fetchTimers}
        editTimer={editingTimer}
      />
    </div>
  )
}
