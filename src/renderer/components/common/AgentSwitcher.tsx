import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { useKeyboardStore } from '../../stores/keyboard.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useApprovalsStore } from '../../stores/approvals.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { collectSwitcherAgents, rankAgents, type SwitcherAgent, type SwitcherMatch } from '../../utils/agent-switcher'
import { runtimeName, useMultiRuntime, useRuntimeLabel, useRuntimes } from '../../stores/runtimes.store'
import { selectTrackedSlice } from '../../stores/tracked-dirs.store'
import { selectBackgroundAgents } from '../../stores/background-agents.store'
import { agentKey } from '../../../shared/types/agent-ref'
import { LOCAL_RUNTIME } from '../../../shared/runtime-tag'
import { isAgentWindow, windowRuntime } from '../../utils/window-kind'

/** An agent's key across runtimes: its path on This computer. */
const keyOf = (a: Pick<SwitcherAgent, 'runtimeId' | 'filePath'>): string => agentKey({ runtimeId: a.runtimeId, filePath: a.filePath })

/**
 * Go to agent (View → Go to Agent…, Cmd/Ctrl+K): fuzzy search over the
 * tracked agents. ↑/↓ move, Enter opens, Esc closes. The input is a
 * combobox that owns a listbox; the active option is its
 * aria-activedescendant, so focus never leaves the input.
 */
export function AgentSwitcher() {
  const open = useKeyboardStore((s) => s.switcherOpen)
  const setOpen = useKeyboardStore((s) => s.setSwitcherOpen)
  const close = useCallback(() => setOpen(false), [setOpen])
  // An agent window reaches its own runtime only: with more than one runtime, the title names the one it lists.
  const label = useRuntimeLabel(isAgentWindow ? windowRuntime : null)
  const title = isAgentWindow && label ? `Agents · ${label}` : 'Agents'
  return (
    <Dialog open={open} onClose={close} title={title}>
      {open && <SwitcherBody onDone={close} />}
    </Dialog>
  )
}

function SwitcherBody({ onDone }: { onDone: () => void }) {
  const listId = useId()
  const optionId = (i: number) => `${listId}-option-${i}`
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const directories = useTrackedDirsStore((s) => s.directories)
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)
  const filePath = useDocumentStore((s) => s.filePath)
  const openRuntime = useDocumentStore((s) => s.runtimeId)
  const foregroundState = useAgentStore((s) => s.state)
  const backgroundAgents = useBackgroundAgentsStore((s) => s.agents)
  // Every runtime while there is more than one (multi-runtime.md §5.4): its agents, named by runtime.
  const multi = useMultiRuntime()
  const runtimes = useRuntimes()
  const trackedByRuntime = useTrackedDirsStore((s) => s.byRuntime)
  const backgroundByRuntime = useBackgroundAgentsStore((s) => s.byRuntime)
  const startingPaths = useAppStore((s) => s.startingFilePaths)
  const approvals = useApprovalsStore((s) => s.approvals)
  const { openFile } = useAdfFile()
  const { loadDirectories } = useTrackedDirs()

  // An agent window has no sidebar to load the tracked folders: load them here.
  useEffect(() => {
    if (useTrackedDirsStore.getState().directories.length === 0) {
      loadDirectories().catch((err: unknown) => console.error('[AgentSwitcher] Loading tracked folders failed:', err))
    }
    // The dialog focuses its first control when it opens; the search field is that control.
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const matches = useMemo<SwitcherMatch[]>(() => {
    // This window's own runtime's slice: This computer in the main window.
    const ownRuntime = windowRuntime
    const background = new Set(backgroundAgents.map((a) => a.filePath))
    const local = collectSwitcherAgents({
      directories,
      filesByDir,
      currentFilePath: openRuntime === ownRuntime ? filePath : null,
      foregroundRunning: foregroundState !== 'off',
      isBackgroundRunning: (fp) => background.has(fp) || startingPaths.has(fp),
      pendingFilePaths: approvals.filter((a) => (a.runtimeId ?? LOCAL_RUNTIME) === ownRuntime).map((a) => a.filePath),
    })
    if (!multi) return rankAgents(local, query)
    const agents: SwitcherAgent[] = local.map((a) => ({ ...a, ...(ownRuntime !== LOCAL_RUNTIME ? { runtimeId: ownRuntime } : {}), runtimeName: runtimeName(ownRuntime, runtimes) }))
    for (const rt of runtimes) {
      if (rt.id === ownRuntime) continue
      const slice = selectTrackedSlice({ directories: [], filesByDir: {}, byRuntime: trackedByRuntime }, rt.id)
      const running = new Set(selectBackgroundAgents({ agents: [], byRuntime: backgroundByRuntime }, rt.id).map((a) => a.filePath))
      const rtKey = rt.id === LOCAL_RUNTIME ? undefined : rt.id
      for (const a of collectSwitcherAgents({
        directories: slice.directories,
        filesByDir: slice.filesByDir,
        currentFilePath: openRuntime === rt.id ? filePath : null,
        foregroundRunning: foregroundState !== 'off',
        isBackgroundRunning: (fp) => running.has(fp) || startingPaths.has(agentKey({ runtimeId: rtKey, filePath: fp })),
        pendingFilePaths: approvals.filter((n) => (n.runtimeId ?? LOCAL_RUNTIME) === rt.id).map((n) => n.filePath),
      })) agents.push({ ...a, ...(rtKey ? { runtimeId: rtKey } : {}), runtimeName: rt.name })
    }
    return rankAgents(agents, query)
  }, [directories, filesByDir, filePath, openRuntime, foregroundState, backgroundAgents, startingPaths, approvals, query, multi, runtimes, trackedByRuntime, backgroundByRuntime])

  // A new query starts at the top; a shorter list keeps the active row on it.
  useEffect(() => { setActive(0) }, [query])
  const current = Math.min(active, Math.max(0, matches.length - 1))

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  const choose = useCallback((target: string, runtimeId?: string) => {
    onDone()
    const app = useAppStore.getState()
    if (app.showSettings) app.setShowSettings(false)
    if (app.showMeshGraph) app.setShowMeshGraph(false)
    if (app.showHome) app.setShowHome(false)
    const runtime = runtimeId ?? (multi ? LOCAL_RUNTIME : windowRuntime)
    const doc = useDocumentStore.getState()
    if (doc.filePath === target && doc.runtimeId === runtime) return
    void openFile(target, runtime)
  }, [onDone, openFile, multi])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const n = matches.length
    if (e.key === 'ArrowDown' && n > 0) {
      e.preventDefault()
      setActive((current + 1) % n)
    } else if (e.key === 'ArrowUp' && n > 0) {
      e.preventDefault()
      setActive((current - 1 + n) % n)
    } else if (e.key === 'PageDown' && n > 0) {
      e.preventDefault()
      setActive(Math.min(n - 1, current + 8))
    } else if (e.key === 'PageUp' && n > 0) {
      e.preventDefault()
      setActive(Math.max(0, current - 8))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = matches[current]
      if (hit) choose(hit.agent.filePath, hit.agent.runtimeId)
    }
  }

  return (
    <SwitcherView
      listId={listId}
      query={query}
      matches={matches}
      current={current}
      openFilePath={filePath ? agentKey({ runtimeId: openRuntime, filePath }) : null}
      inputRef={inputRef}
      onQuery={setQuery}
      onKeyDown={onKeyDown}
      onHover={setActive}
      onChoose={choose}
    />
  )
}

/** The switcher's markup: a combobox owning a listbox (exported for tests). */
export function SwitcherView({ listId, query, matches, current, openFilePath, inputRef, onQuery, onKeyDown, onHover, onChoose }: {
  listId: string
  query: string
  matches: SwitcherMatch[]
  /** Index of the active option. */
  current: number
  /** The open agent's key (agentKey): its path on This computer. */
  openFilePath: string | null
  inputRef?: React.MutableRefObject<HTMLInputElement | null>
  onQuery: (query: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onHover: (index: number) => void
  onChoose: (filePath: string, runtimeId?: string) => void
}) {
  const optionId = (i: number) => `${listId}-option-${i}`
  return (
    <div className="-mt-1">
      <input
        ref={(el) => {
          if (inputRef) inputRef.current = el
          // A modal <dialog> focuses its [autofocus] control on open (React's autoFocus sets no attribute).
          el?.setAttribute('autofocus', '')
        }}
        type="text"
        role="combobox"
        aria-label="Search agents"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={matches.length > 0 ? optionId(current) : undefined}
        placeholder="Search agents"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2.5 py-1.5 text-[13px] text-[var(--adf-ui-text)] placeholder:text-[var(--adf-ui-text-subtle)] outline-none focus-visible:border-[var(--adf-ui-accent)]"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Agents"
        className="mt-2 max-h-[50vh] overflow-y-auto"
      >
        {matches.map((m, i) => (
          <SwitcherOption
            key={keyOf(m.agent)}
            id={optionId(i)}
            match={m}
            selected={i === current}
            isOpen={keyOf(m.agent) === openFilePath}
            onHover={() => onHover(i)}
            onChoose={() => onChoose(m.agent.filePath, m.agent.runtimeId)}
          />
        ))}
      </ul>
      {matches.length === 0 && (
        <p role="status" className="px-2 py-3 text-[12px] text-[var(--adf-ui-text-muted)]">
          {query.trim() ? 'No match' : 'No agents'}
        </p>
      )}
    </div>
  )
}

function SwitcherOption({ id, match, selected, isOpen, onHover, onChoose }: {
  id: string
  match: SwitcherMatch
  selected: boolean
  isOpen: boolean
  onHover: () => void
  onChoose: () => void
}) {
  const { agent, matched } = match
  const status = agent.needsYou > 0 ? 'Needs you' : agent.running ? 'Running' : null
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      onMouseMove={selected ? undefined : onHover}
      // Keep the focus in the search field.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
      className={`flex items-center gap-2 rounded-[var(--adf-ui-control-radius)] px-2 py-1.5 text-[13px] cursor-pointer ${
        selected ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]' : 'text-[var(--adf-ui-text)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          agent.needsYou > 0
            ? 'bg-[var(--adf-ui-warning)]'
            : agent.running
              ? 'bg-[var(--adf-ui-success)]'
              : 'border border-[var(--adf-ui-text-subtle)]'
        }`}
      />
      <span className="min-w-0 truncate">
        <Highlighted text={agent.name} matched={matched} />
      </span>
      {agent.runtimeName && <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-muted)]">{agent.runtimeName}</span>}
      {agent.folder && <span className="min-w-0 shrink truncate text-[11px] text-[var(--adf-ui-text-subtle)]">{agent.folder}</span>}
      <span className="flex-1" />
      {isOpen && <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-muted)]">Open</span>}
      {status && (
        <span className={`shrink-0 text-[11px] ${agent.needsYou > 0 ? 'text-[var(--adf-ui-warning)]' : 'text-[var(--adf-ui-text-muted)]'}`}>
          {status}
        </span>
      )}
    </li>
  )
}

function Highlighted({ text, matched }: { text: string; matched: number[] }) {
  if (matched.length === 0) return <>{text}</>
  const hit = new Set(matched)
  const parts: Array<{ s: string; on: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    const on = hit.has(i)
    const last = parts[parts.length - 1]
    if (last && last.on === on) last.s += text[i]
    else parts.push({ s: text[i], on })
  }
  return <>{parts.map((p, i) => (p.on ? <strong key={i} className="font-semibold">{p.s}</strong> : <span key={i}>{p.s}</span>))}</>
}
