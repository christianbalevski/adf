import { memo, useCallback, useMemo, useState } from 'react'
import { useFleetStore } from '../../stores/fleet.store'
import { useMeshStore } from '../../stores/mesh.store'

/**
 * Batch command bar — appears while agents are selected (marquee, click,
 * or control-group recall). Commands: start offline agents, stop running
 * ones, and message the selected group (delivered into each agent's inbox
 * over the normal mesh rails). No mid-turn pause semantics.
 */
export const FleetCommandBar = memo(function FleetCommandBar({
  onDone
}: {
  /** Called after a batch command completes so the canvas can refresh */
  onDone: () => void
}) {
  const selection = useFleetStore((s) => s.selection)
  const clearSelection = useFleetStore((s) => s.setSelection)
  const agents = useMeshStore((s) => s.agents)
  const [busy, setBusy] = useState<'start' | 'stop' | 'message' | 'hold' | 'resume' | null>(null)
  const [messageOpen, setMessageOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [messageResult, setMessageResult] = useState<string | null>(null)

  const selected = useMemo(() => {
    const byPath = new Map(agents.map((a) => [a.filePath, a]))
    return selection.map((p) => byPath.get(p)).filter((a): a is NonNullable<typeof a> => !!a)
  }, [agents, selection])

  const startable = useMemo(() => selected.filter((a) => !a.online), [selected])
  const stoppable = useMemo(() => selected.filter((a) => a.online), [selected])
  const holdable = useMemo(() => selected.filter((a) => !a.held), [selected])
  const resumable = useMemo(() => selected.filter((a) => a.held), [selected])

  const runHold = useCallback(async (held: boolean) => {
    const targets = held ? holdable : resumable
    if (targets.length === 0 || busy) return
    setBusy(held ? 'hold' : 'resume')
    try {
      await window.adfApi.holdFleetAgents(targets.map((a) => a.filePath), held)
    } catch { /* poll reflects the outcome */ } finally {
      setBusy(null)
      onDone()
    }
  }, [holdable, resumable, busy, onDone])

  const runBatch = useCallback(async (kind: 'start' | 'stop') => {
    const targets = kind === 'start' ? startable : stoppable
    if (targets.length === 0 || busy) return
    setBusy(kind)
    try {
      for (const agent of targets) {
        try {
          if (kind === 'start') {
            await window.adfApi.startBackgroundAgent(agent.filePath)
          } else {
            await window.adfApi.stopBackgroundAgent(agent.filePath)
          }
        } catch { /* per-agent failure shouldn't stop the batch */ }
      }
    } finally {
      setBusy(null)
      onDone()
    }
  }, [startable, stoppable, busy, onDone])

  const sendMessage = useCallback(async () => {
    const content = message.trim()
    if (!content || busy) return
    setBusy('message')
    setMessageResult(null)
    try {
      const result = await window.adfApi.messageFleetAgents(selection, content)
      const failedNote = result.failed.length > 0 ? ` · ${result.failed.length} failed` : ''
      setMessageResult(`Sent to ${result.delivered.length}${failedNote}`)
      setMessage('')
      setTimeout(() => { setMessageResult(null); setMessageOpen(false) }, 2500)
    } catch {
      setMessageResult('Send failed')
    } finally {
      setBusy(null)
      onDone()
    }
  }, [selection, message, busy, onDone])

  if (selection.length === 0) return null

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5">
      {/* Message composer — expands above the bar */}
      {messageOpen && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm border border-neutral-200 dark:border-neutral-700 shadow-lg w-[420px]">
          <input
            autoFocus
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendMessage()
              if (e.key === 'Escape') { e.stopPropagation(); setMessageOpen(false) }
            }}
            placeholder={`Message ${selection.length} agent${selection.length !== 1 ? 's' : ''}…`}
            className="flex-1 px-2 py-1 text-[12px] bg-transparent focus:outline-none text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400"
          />
          {messageResult ? (
            <span className="text-[10px] text-green-600 dark:text-green-400 whitespace-nowrap px-1">{messageResult}</span>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!message.trim() || busy !== null}
              className="px-2.5 py-1 text-[11px] rounded-full bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40"
            >
              {busy === 'message' ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-nowrap items-center gap-2 px-3 py-1.5 rounded-full bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-neutral-200 dark:border-neutral-700 shadow-lg">
      <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300 select-none whitespace-nowrap">
        {selection.length} selected
      </span>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
      <button
        onClick={() => runBatch('start')}
        disabled={startable.length === 0 || busy !== null}
        className="px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap bg-green-500 text-white hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy === 'start' ? 'Starting…' : `Start${startable.length > 0 ? ` ${startable.length}` : ''}`}
      </button>
      <button
        onClick={() => runBatch('stop')}
        disabled={stoppable.length === 0 || busy !== null}
        className="px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy === 'stop' ? 'Stopping…' : `Stop${stoppable.length > 0 ? ` ${stoppable.length}` : ''}`}
      </button>
      {resumable.length > 0 ? (
        <button
          onClick={() => runHold(false)}
          disabled={busy !== null}
          className="px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap bg-neutral-700 dark:bg-neutral-200 text-white dark:text-neutral-900 hover:bg-neutral-600 dark:hover:bg-white disabled:opacity-40"
          title="Release hold — queued triggers fire immediately"
        >
          {busy === 'resume' ? 'Resuming…' : `Resume ${resumable.length}`}
        </button>
      ) : (
        <button
          onClick={() => runHold(true)}
          disabled={holdable.length === 0 || busy !== null}
          className="px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-300 dark:hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Hold — current turn finishes, then triggers queue until resumed"
        >
          {busy === 'hold' ? 'Holding…' : `Hold${holdable.length > 0 ? ` ${holdable.length}` : ''}`}
        </button>
      )}
      <button
        onClick={() => setMessageOpen((v) => !v)}
        className={`px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap ${
          messageOpen
            ? 'bg-violet-500 text-white'
            : 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900/60'
        }`}
      >
        Message
      </button>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
      <span className="text-[10px] text-neutral-400 dark:text-neutral-500 select-none hidden xl:flex items-center gap-1 whitespace-nowrap">
        <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">⌘1-9</kbd> assign · <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">1-9</kbd> recall
      </span>
      <button
        onClick={() => clearSelection([])}
        className="px-2 py-0.5 text-[11px] rounded-full whitespace-nowrap text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Clear
      </button>
      </div>
    </div>
  )
})
