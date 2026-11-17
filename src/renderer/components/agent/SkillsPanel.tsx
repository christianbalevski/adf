import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentSwitching, useEditorTabsStore } from '../../stores/editor-tabs.store'
import { DocsLink, InfoHint } from '../common/DocsLink'
import { useConfirm } from '../common/ConfirmDialog'
import { DOCS } from '../../../shared/constants/docs-links'
import type { AgentExecutionEvent } from '../../../shared/types/ipc.types'
import {
  SKILLS_REGISTRY_PATH,
  SKILLS_STATE_PATH,
  SKILL_MANIFEST,
  MAX_SKILLS,
  MAX_REGISTRY_BYTES,
  MAX_SKILL_FILE_BYTES,
  estimateTokens,
  sanitizeDisplayText,
  type ParsedRegistry,
  type RegistryEntry
} from '../../../shared/utils/skills-panel'
import { type AdfCompat } from '../../../shared/utils/skill-import'
import { slotOf } from '../../../shared/utils/skill-install-plan'
import { createDebouncedRefresh, isFileUpdatedEvent } from '../../utils/agent-files'
import { setSkillMuted, syncOpenTab } from '../../utils/skills-state'
import { apiFor, openApi, useOpenRuntime } from '../../utils/runtime-api'
import { captureAgentView, isCurrentAgentView } from '../../utils/agent-view'
import { readSkillsPanel } from '../../utils/skills-panel-refresh'
import { removeSkillPackage } from '../../utils/skill-remove'
import { commitSkillInstall, prepareSkillInstall, type InstallOutcome, type InstallRequest, type PreparedInstall } from '../../utils/skill-install'
import { CatalogDialog } from './skills/CatalogDialog'
import { CompatChip } from './skills/CompatChip'
import { SkillActionsMenu } from './skills/SkillActionsMenu'

/**
 * Skills — the human half of file-backed skills (design doc §4).
 *
 * Everything here is a file operation, never a config edit:
 *
 *   install / remove  →  write a package into skills/<name>/ in one batch, or delete that folder
 *   mute / unmute     →  edit the `disabled` list in skills-state.json
 *
 * Both paths run through the workspace write choke point, which reindexes and
 * regenerates skills-registry.json on its own — this panel never writes the
 * registry, never edits config, and never touches tools, approvals, or
 * `authorized`. Indexing is unconditional, so there is nothing here to turn on.
 *
 * Two hazards shape the code below.
 *
 * 1. A file write lands in whichever agent the backend has in the foreground.
 *    An install captures the view it started under (file, runtime, view
 *    generation) and the runtime's API, re-checks the view after every await,
 *    and sends ONE batch (DOC_WRITE_INTERNAL_FILES) that names the file it
 *    means; the backend compares that with its open file in the same turn it
 *    commits. Nothing is written piecemeal, so there is no half-installed
 *    package to clean up.
 * 2. skills-state.json is read-modify-write, so two toggles racing lose one
 *    edit. That is handled in utils/skills-state.ts, whose write queue is
 *    shared with the composer's `/skills disable|enable` commands; the
 *    toggle here is optimistic with rollback so the UI never stalls on IPC.
 */

interface FileEntry {
  path: string
  size: number
  protection?: 'read_only' | 'no_delete' | 'none'
}

const NO_BUSY: ReadonlySet<string> = new Set()
const NO_FILES: FileEntry[] = []
const NO_COMPAT: Record<string, AdfCompat> = {}
/** The identity a panel snapshot belongs to. */
const viewKey = (view: { filePath: string | null; runtimeId: string; viewGeneration: number }) => `${view.runtimeId}|${view.viewGeneration}|${view.filePath ?? ''}`

export function SkillsPanel() {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)

  /**
   * What the panel last read, and for which view. Only the current view's
   * snapshot is ever shown; any other (the previous agent, or this agent
   * before a switch away and back) shows as loading, never as rows.
   */
  const [shown, setShown] = useState<{ key: string; files: FileEntry[]; registry: ParsedRegistry | null; compat: Record<string, AdfCompat>; error?: string } | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(NO_BUSY)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [confirmDialog, confirm] = useConfirm()

  /**
   * Pending mute/unmute the registry has not caught up with yet. The indexer is
   * debounced, so a refetch right after a toggle still reports the old value —
   * an override outranks the registry until the registry agrees with it, which
   * is what makes the checkbox instant instead of frozen for half a second.
   */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  /** Timers owned by this panel, so nothing fires into an unmounted component. */
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])
  const later = useCallback((ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      run()
    }, ms)
    timersRef.current.add(timer)
  }, [])

  /**
   * Refetch everything the panel shows. Resolves true when a catalog exists.
   * Responses from a superseded call — or from before an agent switch — are
   * dropped rather than painted over newer state.
   */
  const refreshSeq = useRef(0)
  const refresh = useCallback(async (): Promise<boolean> => {
    const seq = ++refreshSeq.current
    // One view, one runtime API, for the whole refresh (utils/skills-panel-refresh.ts).
    const view = captureAgentView()
    try {
      const snapshot = await readSkillsPanel(view, apiFor(view.runtimeId))
      if (seq !== refreshSeq.current || !snapshot || !isCurrentAgentView(view)) return false
      const { registry: parsed, registryFile, stateFile } = snapshot
      setShown({ key: viewKey(view), files: snapshot.files, registry: parsed, compat: snapshot.compat })
      // Retire every optimistic toggle the catalog now reflects (or that names
      // a skill the catalog no longer has).
      setOverrides((prev) => {
        if (Object.keys(prev).length === 0) return prev
        const byName = new Map((parsed?.entries ?? []).map((entry) => [entry.name, entry.enabled]))
        const next: Record<string, boolean> = {}
        for (const [name, value] of Object.entries(prev)) {
          if (parsed && (!byName.has(name) || byName.get(name) === value)) continue
          next[name] = value
        }
        return Object.keys(next).length === Object.keys(prev).length ? prev : next
      })
      if (!registryFile?.binary) syncOpenTab(SKILLS_REGISTRY_PATH, registryFile?.content)
      if (!stateFile?.binary) syncOpenTab(SKILLS_STATE_PATH, stateFile?.content)
      return parsed !== null
    } catch (err) {
      // A read that failed for the view still showing is said, with Retry; it never stays "Loading".
      if (seq === refreshSeq.current && isCurrentAgentView(view)) {
        setShown({ key: viewKey(view), files: [], registry: null, compat: {}, error: err instanceof Error ? err.message : String(err) })
      }
      return false
    }
  }, [])

  // A new view (another file, another runtime, or the same file opened again)
  // is read once the switch to it is over: during the switch the open agent
  // is not settled, so a read then is refused (isCurrentAgentView) and would
  // leave nothing to show.
  const viewRuntime = useDocumentStore((s) => s.runtimeId)
  const viewGeneration = useDocumentStore((s) => s.viewGeneration)
  const switching = useAgentSwitching()
  useEffect(() => {
    if (!switching) void refresh()
  }, [filePath, viewRuntime, viewGeneration, switching, refresh])
  const current = shown?.key === viewKey({ filePath, runtimeId: viewRuntime, viewGeneration }) ? shown : null
  const files = current?.files ?? NO_FILES
  const registry = current?.registry ?? null
  const compat = current?.compat ?? NO_COMPAT
  const registryBytes = files.find((f) => f.path === SKILLS_REGISTRY_PATH)?.size ?? 0

  /**
   * Live updates, as the Files panel follows them (AgentFiles.tsx): the
   * runtime's `file_updated` for a text write, or the workspace `files`
   * signal, which every writer raises, whether a runtime is attached or not
   * (a stopped agent's document included). The indexer's registry rewrite
   * raises it too, so the index's answer reaches the panel. One debounced
   * refresh per burst.
   */
  const runtime = useOpenRuntime()
  useEffect(() => {
    const live = createDebouncedRefresh(() => void refresh(), 150)
    const offEvent = openApi()?.onAgentEvent?.((event: AgentExecutionEvent) => {
      if (isFileUpdatedEvent(event)) live.trigger()
    })
    const offData = openApi()?.onWorkspaceDataChanged?.(({ scope }) => {
      if (scope === 'files') live.trigger()
    })
    return () => {
      live.cancel()
      offEvent?.()
      offData?.()
    }
  }, [refresh, runtime])

  /** Installed packages as the VFS sees them — the ground truth the indexer reads. */
  const installedNames = useMemo(() => {
    const names = new Set<string>()
    for (const file of files) {
      const match = SKILL_MANIFEST.exec(file.path)
      if (match) names.add(match[1])
    }
    return names
  }, [files])
  /** Slots holding any file at all (a name is a slot): what the catalog's "Name in use" reads. Display only. */
  const occupiedNames = useMemo(() => new Set(files.flatMap((f) => slotOf(f.path) ?? [])), [files])

  /** Registry entries with any pending toggle applied. */
  const skills: RegistryEntry[] = useMemo(() => {
    const entries = registry?.entries ?? []
    if (Object.keys(overrides).length === 0) return entries
    return entries.map((entry) =>
      entry.name in overrides ? { ...entry, enabled: overrides[entry.name] } : entry
    )
  }, [registry, overrides])

  /**
   * Everything the indexer refused. Its reasons ride in the registry's
   * `rejected` array and are authoritative — including rejections that are not
   * packages at all (an unparseable skills-state.json is reported there too).
   * A package on disk that is in neither list gets the checklist of what the
   * indexer enforces, since the panel cannot see which bound it hit.
   */
  const problems = useMemo(() => {
    if (!registry) return []
    const indexed = new Set(registry.entries.map((s) => s.name))
    const rows = new Map<string, { label: string; path: string; reason: string | null; isPackage: boolean }>()
    for (const name of installedNames) {
      if (indexed.has(name)) continue
      rows.set(name, { label: name, path: `skills/${name}/SKILL.md`, reason: null, isPackage: true })
    }
    for (const rejection of registry.rejected) {
      // A rejection whose path is not a package manifest has no name to show —
      // the path is the only identity it has.
      const key = rejection.name ?? rejection.path
      if (rejection.name && indexed.has(rejection.name)) continue
      rows.set(key, {
        label: rejection.name ?? rejection.path,
        path: rejection.path,
        reason: rejection.reason,
        isPackage: rejection.name !== null
      })
    }
    return [...rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, row]) => ({ key, ...row }))
  }, [installedNames, registry])

  const disabledCount = skills.filter((s) => !s.enabled).length

  const markBusy = useCallback((name: string, active: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (active) next.add(name)
      else next.delete(name)
      return next
    })
  }, [])

  const setRowError = useCallback((name: string, message: string | null) => {
    setRowErrors((prev) => {
      if (message === null) {
        if (!(name in prev)) return prev
        const next = { ...prev }
        delete next[name]
        return next
      }
      return { ...prev, [name]: message }
    })
  }, [])

  /**
   * Mute or unmute through the shared serialized writer, which merges into
   * skills-state.json — unknown keys and names this panel cannot see (a package
   * removed while muted) survive untouched. The write itself triggers the
   * reindex; the catalog arrives over the `file_updated` push, and the toggle
   * does not wait for it.
   */
  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    const owner = useDocumentStore.getState().filePath
    setRowError(name, null)
    setOverrides((prev) => ({ ...prev, [name]: enabled }))
    markBusy(name, true)
    try {
      const error = await setSkillMuted(name, enabled, owner)
      if (error) {
        setOverrides((prev) => {
          const next = { ...prev }
          delete next[name]
          return next
        })
        setRowError(name, error)
        return
      }
      // The push covers the common case; this catches a workspace with no
      // runtime attached to emit one.
      later(600, () => void refresh())
    } catch (err) {
      setOverrides((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      setRowError(name, err instanceof Error ? err.message : String(err))
    } finally {
      markBusy(name, false)
    }
  }, [later, markBusy, refresh, setRowError])

  const handleRemove = useCallback(async (name: string, path: string) => {
    const view = captureAgentView()
    if (!isCurrentAgentView(view)) return
    markBusy(name, true)
    try {
      const confirmed = await confirm({
        title: `Remove ${sanitizeDisplayText(name)}?`,
        body: `This deletes all files in skills/${name}/ from this agent, including local edits and unsaved changes in open tabs. This cannot be undone.`,
        confirmLabel: 'Remove skill',
        danger: true,
      })
      if (!confirmed || !isCurrentAgentView(view)) return
      setRowError(name, null)
      setNotice(null)
      const result = await removeSkillPackage(path, view, apiFor(view.runtimeId), (deletedPath) => {
        useEditorTabsStore.getState().closeTab(deletedPath)
      })
      if (!isCurrentAgentView(view)) return
      if (result.error) {
        setRowError(name, result.error)
        setNotice(result.deleted
          ? `Removal of ${name} is incomplete: ${result.deleted} file(s) deleted. ${result.error} Remaining files are available in Files.`
          : result.error)
      }
      await refresh()
      later(600, () => { if (isCurrentAgentView(view)) void refresh() })
    } finally {
      markBusy(name, false)
    }
  }, [confirm, later, markBusy, refresh, setRowError])

  /** Prepare an install (skill-install.ts): every byte fetched, the batch planned, nothing written yet. */
  const prepareInstall = useCallback(async (request: InstallRequest): Promise<InstallOutcome> => {
    markBusy(request.key, true)
    try {
      return await prepareSkillInstall(request, refresh)
    } finally {
      markBusy(request.key, false)
    }
  }, [markBusy, refresh])

  /** Write a prepared install (an explicit replacement) as ONE batch. */
  const commitInstall = useCallback(async (prepared: PreparedInstall): Promise<InstallOutcome> => {
    markBusy(prepared.key, true)
    try {
      return await commitSkillInstall(prepared, refresh)
    } finally {
      markBusy(prepared.key, false)
    }
  }, [markBusy, refresh])

  /** Open any workspace file in the editor — the registry button and every row. */
  const openInEditor = useCallback(async (path: string) => {
    const result = await openApi()?.readInternalFile(path)
    if (result?.content != null) {
      useEditorTabsStore.getState().openTab(path, result.binary ? '' : result.content, result.binary, result.mimeType, result.revision)
    }
  }, [])

  if (!filePath || !config) {
    return (
      <div className="p-4 text-sm text-[var(--adf-ui-text-subtle)] text-center mt-8">
        Open a file to view agent skills.
      </div>
    )
  }

  // Exactly one empty state at a time: the catalog is unreadable, or it has not
  // been written yet, or it exists and has nothing in it.
  const catalogUnreadable = registry === null && registryBytes > 0
  const showNotGenerated = registry === null && registryBytes === 0 && installedNames.size > 0
  const showNothingInstalled =
    !!current && !current.error && !catalogUnreadable && !showNotGenerated && skills.length === 0 && problems.length === 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span>{current?.error ? 'Could not read skills' : current ? `${skills.length} skill${skills.length !== 1 ? 's' : ''} installed` : 'Loading skills…'}</span>
          <DocsLink href={DOCS.skills} />
        </div>
        <button
          onClick={() => setCatalogOpen(true)}
          className="text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
        >
          + Browse catalog
        </button>
      </div>

      {notice && (
        <div className="mx-3 mb-1 border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 rounded-lg px-2.5 py-1.5">
          <span className="text-[11px] text-amber-700 dark:text-amber-400">{notice}</span>
        </div>
      )}

      {/* Installed list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {current?.error && (
          <p className="text-[11px] text-red-600 dark:text-red-400 py-8 text-center">
            Could not read skills: {sanitizeDisplayText(current.error)}{' '}
            <button onClick={() => void refresh()} className="text-blue-500 hover:text-blue-600 dark:text-blue-400 cursor-pointer">Retry</button>
          </p>
        )}

        {showNothingInstalled && (
          <div className="text-center py-8">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              No skills installed.
              <InfoHint tip="Every skills/<name>/SKILL.md in this agent is indexed and listed in its prompt. A skill is instructions only; it grants no tools, files, or approvals." className="ml-1 align-middle" />
            </p>
            <button
              onClick={() => setCatalogOpen(true)}
              className="mt-3 px-3 py-1.5 text-xs font-medium bg-[var(--adf-ui-accent)] text-[var(--adf-ui-on-accent)] hover:bg-[var(--adf-ui-accent-hover)] rounded-lg cursor-pointer"
            >
              Browse catalog
            </button>
          </div>
        )}

        {showNotGenerated && (
          <p className="text-[11px] text-[var(--adf-ui-text-subtle)] py-8 text-center">
            The catalog hasn&apos;t been generated yet — it appears on the next workspace write.
          </p>
        )}

        {catalogUnreadable && (
          <p className="text-[11px] text-amber-600 dark:text-amber-500 py-8 text-center">
            <span className="font-mono">skills-registry.json</span> could not be read — the runtime
            rewrites it on the next workspace write.
          </p>
        )}

        {skills.map((skill) => (
          <div
            key={skill.name}
            role="button"
            tabIndex={0}
            title={`Open ${skill.path}`}
            onClick={() => void openInEditor(skill.path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void openInEditor(skill.path)
              }
            }}
            className={`border rounded-lg p-3 bg-white dark:bg-neutral-800 cursor-pointer hover:border-blue-300 dark:hover:border-blue-700 ${
              rowErrors[skill.name]
                ? 'border-red-300 dark:border-red-700'
                : skill.enabled
                  ? 'border-neutral-200 dark:border-neutral-700'
                  : 'border-neutral-200 dark:border-neutral-700 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300 font-mono truncate" title={sanitizeDisplayText(skill.name)}>
                    {sanitizeDisplayText(skill.name)}
                  </span>
                  {compat[skill.name] && <CompatChip compat={compat[skill.name]} />}
                </div>
                {skill.enabled ? (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 leading-relaxed">
                    {skill.description
                      ? sanitizeDisplayText(skill.description)
                      : <span className="italic">no description</span>}
                  </p>
                ) : (
                  <p className="text-[11px] text-[var(--adf-ui-text-subtle)] mt-1 italic">
                    muted — description removed from context
                  </p>
                )}
                <div className="text-[10px] text-[var(--adf-ui-text-subtle)] mt-1 font-mono truncate" title={skill.path}>
                  {sanitizeDisplayText(skill.path)}
                </div>
                {rowErrors[skill.name] && (
                  <p className="text-[11px] text-red-600 dark:text-red-400 mt-1">{rowErrors[skill.name]}</p>
                )}
              </div>
              <SkillActionsMenu
                name={skill.name}
                busy={busy.has(skill.name)}
                items={[
                  { label: 'Open in editor', onSelect: () => void openInEditor(skill.path) },
                  { label: skill.enabled ? 'Turn off' : 'Turn on', onSelect: () => void handleToggle(skill.name, !skill.enabled) },
                  { label: 'Remove skill', danger: true, separatorBefore: true, onSelect: () => void handleRemove(skill.name, skill.path) },
                ]}
              />
            </div>
          </div>
        ))}

        {/* Present on disk, absent from the catalog */}
        {problems.map((problem) => (
          <div
            key={problem.key}
            className="border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-400 font-mono truncate">
                {sanitizeDisplayText(problem.label)}
              </div>
              {problem.isPackage && (
                <SkillActionsMenu
                  name={problem.label}
                  busy={busy.has(problem.key)}
                  items={[
                    { label: 'Open in editor', onSelect: () => void openInEditor(problem.path) },
                    { label: 'Remove skill', danger: true, separatorBefore: true, onSelect: () => void handleRemove(problem.key, problem.path) },
                  ]}
                />
              )}
            </div>
            {problem.reason ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-1 leading-relaxed">
                {problem.isPackage ? 'not indexed — ' : ''}
                {sanitizeDisplayText(problem.reason)}
              </p>
            ) : (
              <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-1 leading-relaxed">
                not indexed — the folder name must be lowercase kebab-case and match the frontmatter{' '}
                <span className="font-mono">name</span>,{' '}
                <span className="font-mono">description</span> must be one line under 500 characters,
                and the file must be under {Math.round(MAX_SKILL_FILE_BYTES / 1024)} KB. The catalog
                also stops at {MAX_SKILLS} skills or {Math.round(MAX_REGISTRY_BYTES / 1024)} KB,
                whichever comes first.
              </p>
            )}
            <div className="text-[10px] text-amber-500 dark:text-amber-600 mt-1 font-mono truncate" title={problem.path}>
              {sanitizeDisplayText(problem.path)}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-neutral-200 dark:border-neutral-700 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
            {skills.length} skill{skills.length !== 1 ? 's' : ''}, {disabledCount} muted
            {registryBytes > 0 && ` · ~${estimateTokens(registryBytes)} tokens`}
          </span>
          <div className="flex-1" />
          {registryBytes > 0 && (
            <button
              onClick={() => void openInEditor(SKILLS_REGISTRY_PATH)}
              title="Runtime-generated — the indexer overwrites any edit on the next workspace write."
              className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer"
            >
              Open skills-registry.json
            </button>
          )}
        </div>
        {registryBytes > 0 && (
          <div className="text-[10px] text-[var(--adf-ui-text-subtle)] text-right mt-0.5">
            runtime-generated — edits are overwritten
          </div>
        )}
      </div>

      {confirmDialog}
      <CatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        occupiedNames={occupiedNames}
        busy={busy}
        onPrepare={prepareInstall}
        onCommit={commitInstall}
      />
    </div>
  )
}
