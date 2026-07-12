import { memo, useCallback, useMemo, useState } from 'react'
import { useFleetStore } from '../../stores/fleet.store'
import { useMeshStore } from '../../stores/mesh.store'

/**
 * Batch command bar — appears while agents are selected (marquee, click,
 * or control-group recall). Commands stick to safe lifecycle operations:
 * start offline agents, stop running ones. No mid-turn pause semantics.
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
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)

  const selected = useMemo(() => {
    const byPath = new Map(agents.map((a) => [a.filePath, a]))
    return selection.map((p) => byPath.get(p)).filter((a): a is NonNullable<typeof a> => !!a)
  }, [agents, selection])

  const startable = useMemo(() => selected.filter((a) => !a.online), [selected])
  const stoppable = useMemo(() => selected.filter((a) => a.online), [selected])

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

  if (selection.length === 0) return null

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-neutral-200 dark:border-neutral-700 shadow-lg">
      <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300 select-none">
        {selection.length} selected
      </span>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
      <button
        onClick={() => runBatch('start')}
        disabled={startable.length === 0 || busy !== null}
        className="px-2.5 py-0.5 text-[11px] rounded-full bg-green-500 text-white hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy === 'start' ? 'Starting…' : `Start${startable.length > 0 ? ` ${startable.length}` : ''}`}
      </button>
      <button
        onClick={() => runBatch('stop')}
        disabled={stoppable.length === 0 || busy !== null}
        className="px-2.5 py-0.5 text-[11px] rounded-full bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy === 'stop' ? 'Stopping…' : `Stop${stoppable.length > 0 ? ` ${stoppable.length}` : ''}`}
      </button>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
      <span className="text-[10px] text-neutral-400 dark:text-neutral-500 select-none hidden md:inline">
        <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">⌘1-9</kbd> assign · <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">1-9</kbd> recall
      </span>
      <button
        onClick={() => clearSelection([])}
        className="px-2 py-0.5 text-[11px] rounded-full text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Clear
      </button>
    </div>
  )
})
