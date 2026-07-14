import { memo, useCallback, useMemo, useState } from 'react'
import { useFleetStore } from '../../stores/fleet.store'
import { useMeshStore } from '../../stores/mesh.store'

function MoreItem({
  label,
  hint,
  onClick,
  disabled,
  danger
}: {
  label: string
  hint: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-baseline gap-2 px-3 py-1 text-left whitespace-nowrap hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed ${
        danger ? 'text-red-500 dark:text-red-400' : 'text-neutral-700 dark:text-neutral-200'
      }`}
    >
      <span className="text-[11px] font-medium">{label}</span>
      <span className="text-[9px] text-neutral-400 dark:text-neutral-500">{hint}</span>
    </button>
  )
}

/**
 * Batch command bar — appears while agents are selected (marquee, click,
 * or control-group recall). Commands: start offline agents, stop running
 * ones, and message the selected group (delivered into each agent's inbox
 * over the normal mesh rails). No mid-turn pause semantics.
 */
export const FleetCommandBar = memo(function FleetCommandBar({
  onDone,
  onOpenAgent,
  onFlyTo
}: {
  /** Called after a batch command completes so the canvas can refresh */
  onDone: () => void
  /** Open an agent's file + loop panel (single selection) */
  onOpenAgent: (filePath: string) => void
  /** Center the viewport on the selection */
  onFlyTo: (filePaths: string[]) => void
}) {
  const selection = useFleetStore((s) => s.selection)
  const clearSelection = useFleetStore((s) => s.setSelection)
  const agents = useMeshStore((s) => s.agents)
  const [busy, setBusy] = useState<'start' | 'stop' | 'message' | 'hold' | 'resume' | 'halt' | 'hibernate' | 'wake' | 'restart' | null>(null)
  // Composer visibility lives in the fleet store so the M hotkey can open it
  const messageOpen = useFleetStore((s) => s.composerOpen)
  const setMessageOpen = useFleetStore((s) => s.setComposerOpen)
  const [message, setMessage] = useState('')
  const [messageResult, setMessageResult] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [groupNameOpen, setGroupNameOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const setNamedGroups = useFleetStore((s) => s.setNamedGroups)
  const stewards = useFleetStore((s) => s.stewards)
  const setStewards = useFleetStore((s) => s.setStewards)

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

  const runMore = useCallback(async (kind: 'halt' | 'hibernate' | 'wake' | 'restart') => {
    const online = stoppable.map((a) => a.filePath)
    if (online.length === 0 || busy) return
    setBusy(kind)
    setMoreOpen(false)
    try {
      if (kind === 'halt') {
        await window.adfApi.haltFleetAgents(online)
      } else if (kind === 'hibernate' || kind === 'wake') {
        await window.adfApi.setFleetAgentState(online, kind === 'hibernate' ? 'hibernate' : 'idle')
      } else {
        // Restart: stop then start, sequentially per agent
        for (const filePath of online) {
          try {
            await window.adfApi.stopBackgroundAgent(filePath)
            await window.adfApi.startBackgroundAgent(filePath)
          } catch { /* per-agent failure shouldn't stop the batch */ }
        }
      }
    } catch { /* poll reflects the outcome */ } finally {
      setBusy(null)
      onDone()
    }
  }, [stoppable, busy, onDone])

  // Steward — one agent per directory whose status speaks for the group.
  // Exact-DID designation: DIDs rarely rotate, and when one does the user
  // just reappoints (no history cascade here by design). An agent can lead
  // any level of its ancestor chain — its own folder, a parent, or the
  // tracked root — so nested fleets get a voice at every layer.
  const single = selection.length === 1 ? selected[0] : null
  const stewardDirs = useMemo(() => {
    if (!single) return []
    const root = single.trackedDirRoot
    const rootName = root ? root.split('/').filter(Boolean).pop() ?? root : ''
    let dir = single.filePath.slice(0, single.filePath.lastIndexOf('/'))
    const dirs: { dir: string; label: string }[] = []
    while (dir) {
      const inRoot = !!root && (dir === root || dir.startsWith(root + '/'))
      const label = !inRoot
        ? dir.split('/').pop() ?? dir
        : dir === root ? rootName : `${rootName}/${dir.slice(root.length + 1)}`
      dirs.push({ dir, label })
      if (!inRoot || dir === root) break
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
    return dirs
  }, [single])

  const appointSteward = useCallback(async (dir: string, appoint: boolean) => {
    if (!single?.did) return
    setMoreOpen(false)
    const next = { ...stewards }
    if (appoint) next[dir] = single.did
    else delete next[dir]
    setStewards(next)
    try {
      await window.adfApi.setSettings({ fleetStewards: next })
    } catch { /* store already updated; settings retry on next save */ }
  }, [single, stewards, setStewards])

  const saveGroup = useCallback(async () => {
    const name = groupName.trim()
    if (!name || selection.length === 0) return
    try {
      const settings = await window.adfApi.getSettings()
      const groups = {
        ...((settings as unknown as { fleetGroups?: Record<string, string[]> }).fleetGroups ?? {}),
        [name]: selection
      }
      await window.adfApi.setSettings({ fleetGroups: groups })
      setNamedGroups(groups)
      setGroupName('')
      setGroupNameOpen(false)
    } catch { /* leave the input open on failure */ }
  }, [groupName, selection, setNamedGroups])

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
      {/* Group-name composer */}
      {groupNameOpen && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm border border-neutral-200 dark:border-neutral-700 shadow-lg w-[300px]">
          <input
            autoFocus
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveGroup()
              if (e.key === 'Escape') { e.stopPropagation(); setGroupNameOpen(false) }
            }}
            placeholder={`Name this group of ${selection.length}…`}
            className="flex-1 px-2 py-1 text-[12px] bg-transparent focus:outline-none text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400"
          />
          <button
            onClick={saveGroup}
            disabled={!groupName.trim()}
            className="px-2.5 py-1 text-[11px] rounded-full bg-neutral-700 dark:bg-neutral-200 text-white dark:text-neutral-900 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}

      {/* Message composer — expands above the bar, grows with long messages */}
      {messageOpen && (
        <div className="flex items-end gap-1.5 px-2.5 py-1.5 rounded-2xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm border border-neutral-200 dark:border-neutral-700 shadow-lg w-[420px]">
          <textarea
            autoFocus
            value={message}
            rows={Math.min(4, Math.max(1, message.split('\n').length, Math.ceil(message.length / 52)))}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
              if (e.key === 'Escape') { e.stopPropagation(); setMessageOpen(false) }
            }}
            placeholder={`Message ${selection.length} agent${selection.length !== 1 ? 's' : ''}…`}
            className="flex-1 px-2 py-1 text-[12px] bg-transparent focus:outline-none resize-none text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400"
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
      {selection.length === 1 && (
        <button
          onClick={() => onOpenAgent(selection[0])}
          className="px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap bg-blue-500 text-white hover:bg-blue-600"
          title="Open this agent's file and loop panel"
        >
          Open
        </button>
      )}
      <button
        onClick={() => onFlyTo(selection)}
        className="px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        title="Center the map on the selection"
      >
        Fly to
      </button>
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
        onClick={() => setMessageOpen(!messageOpen)}
        className={`px-2.5 py-0.5 text-[11px] rounded-full whitespace-nowrap ${
          messageOpen
            ? 'bg-violet-500 text-white'
            : 'bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900/60'
        }`}
      >
        Message
      </button>
      <div className="relative">
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className={`px-2 py-0.5 text-[11px] rounded-full whitespace-nowrap ${
            moreOpen
              ? 'bg-neutral-300 dark:bg-neutral-600 text-neutral-800 dark:text-neutral-100'
              : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700'
          }`}
        >
          More ▾
        </button>
        {moreOpen && (
          <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 flex flex-col min-w-[168px] py-1 rounded-xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm border border-neutral-200 dark:border-neutral-700 shadow-lg">
            <MoreItem
              label="Hibernate"
              hint="only timers wake them"
              disabled={stoppable.length === 0 || busy !== null}
              onClick={() => runMore('hibernate')}
            />
            <MoreItem
              label="Wake"
              hint="back to idle"
              disabled={stoppable.length === 0 || busy !== null}
              onClick={() => runMore('wake')}
            />
            <MoreItem
              label="Restart"
              hint="stop, then start"
              disabled={stoppable.length === 0 || busy !== null}
              onClick={() => runMore('restart')}
            />
            <MoreItem
              label="Halt"
              hint="abort turn + hold"
              danger
              disabled={stoppable.length === 0 || busy !== null}
              onClick={() => runMore('halt')}
            />
            <div className="my-1 h-px bg-neutral-100 dark:bg-neutral-800" />
            {stewardDirs.length > 0 ? (
              stewardDirs.map(({ dir, label }) => {
                const mine = !!single?.did && stewards[dir] === single.did
                return (
                  <MoreItem
                    key={dir}
                    label={mine ? `Remove steward of ${label}` : `Steward of ${label}`}
                    hint={mine ? 'folder loses its voice' : 'its status speaks for this folder'}
                    disabled={!single?.did}
                    onClick={() => appointSteward(dir, !mine)}
                  />
                )
              })
            ) : (
              <MoreItem label="Appoint steward" hint="select a single agent" disabled onClick={() => {}} />
            )}
            <MoreItem
              label="Save as group…"
              hint="persisted, recall from top bar"
              disabled={selection.length === 0}
              onClick={() => { setMoreOpen(false); setGroupNameOpen(true) }}
            />
          </div>
        )}
      </div>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
      <span
        className="text-[10px] text-neutral-400 dark:text-neutral-500 select-none hidden xl:flex items-center gap-1 whitespace-nowrap"
        title="M message · H hold/resume · G start · S stop · Space jump to selection · A select all running · ⌘1-9 assign group · 1-9 recall · arrows pan"
      >
        <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">M</kbd> msg ·
        <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">H</kbd> hold ·
        <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-700">⌘1-9</kbd> assign
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
