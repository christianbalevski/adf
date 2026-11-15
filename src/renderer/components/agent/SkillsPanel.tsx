import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentSwitching, useEditorTabsStore } from '../../stores/editor-tabs.store'
import { DocsLink, InfoHint } from '../common/DocsLink'
import { DOCS } from '../../../shared/constants/docs-links'
import type { AgentExecutionEvent } from '../../../shared/types/ipc.types'
import {
  SKILLS_REGISTRY_PATH,
  SKILLS_STATE_PATH,
  SKILL_MANIFEST,
  MAX_SKILLS,
  MAX_REGISTRY_BYTES,
  MAX_SKILL_FILE_BYTES,
  CATALOG_PAGE_SIZE,
  installSlot,
  addBrowserSource,
  browserResults,
  configuredBrowserSources,
  removeBrowserSource,
  settleBrowserSource,
  toCatalogSourceResult,
  buildCatalogCards,
  cardName,
  cardPath,
  catalogSourceLabel,
  estimateTokens,
  filterCatalogCards,
  isCatalogUrl,
  normalizeCatalogSources,
  sanitizeDisplayText,
  type BrowserSource,
  type CatalogCard,
  type CatalogSourceResult,
  type LoadedManifestName,
  type ParsedRegistry,
  type RegistryEntry
} from '../../../shared/utils/skills-panel'
import { adfCompatLabel, importAs, type AdfCompat } from '../../../shared/utils/skill-import'
import { slotOf } from '../../../shared/utils/skill-install-plan'
import { renderMarkdownToSafeHtml, useMarkdownHighlightVersion } from '../../utils/markdown'
import { createDebouncedRefresh, isFileUpdatedEvent } from '../../utils/agent-files'
import { elideMiddle, splitSkillDocument } from '../../../shared/utils/skill-preview'
import { setSkillMuted, syncOpenTab } from '../../utils/skills-state'
import { Dialog } from '../common/Dialog'
import { apiFor, openApi, useOpenRuntime } from '../../utils/runtime-api'
import { captureAgentView, isCurrentAgentView } from '../../utils/agent-view'
import { readSkillsPanel } from '../../utils/skills-panel-refresh'
import { commitSkillInstall, installFromCard, manifestName, prepareSkillInstall, toManifestState, type InstallOutcome, type InstallRequest, type ManifestState, type PreparedInstall } from '../../utils/skill-install'

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
 *    checkbox here is optimistic with rollback so the UI never stalls on IPC.
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
   * reindex; the catalog arrives over the `file_updated` push, and the checkbox
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
              {/* The row opens SKILL.md; the checkbox must not. */}
              <label
                className="flex items-center gap-1.5 shrink-0 cursor-pointer"
                title={skill.enabled ? 'Mute this skill' : 'Unmute this skill'}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={busy.has(skill.name)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => void handleToggle(skill.name, e.target.checked)}
                  className="rounded text-blue-500"
                />
                <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                  {skill.enabled ? 'on' : 'off'}
                </span>
              </label>
            </div>
          </div>
        ))}

        {/* Present on disk, absent from the catalog */}
        {problems.map((problem) => (
          <div
            key={problem.key}
            className="border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-3"
          >
            <div className="text-xs font-medium text-amber-700 dark:text-amber-400 font-mono truncate">
              {sanitizeDisplayText(problem.label)}
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

/**
 * Catalog browser — a marketplace over every configured source at once, or
 * over one URL pasted at the top of it.
 *
 * The source list is an APP preference (Settings → Skills), not agent config:
 * the dialog reads `skillCatalogSources` each time it opens and fetches every
 * source concurrently in the main process, since the renderer's CSP blocks
 * remote origins. Catalog entries merge first-wins by name in LIST ORDER.
 *
 * A pasted URL (a GitHub repository, folder, SKILL.md or marketplace.json, or
 * any catalog document) is added first to the same source list. A GitHub
 * source lists packages straight from the repository tree, pinned to one
 * commit; their SKILL.md files load a page at a time (and all at once only
 * when asked), so a repository of hundreds of skills costs no more requests
 * than the cards on screen. A package is its source and folder until its
 * manifest loads; its name is the manifest's.
 *
 * Catalog text is remote data. Names, descriptions, publishers and error
 * strings are all sanitized before they are painted.
 *
 * The dialog has two views, not two dialogs: clicking a card swaps the grid for
 * that skill's preview and Escape (or the breadcrumb) swaps it back.
 */
function CatalogDialog({
  open,
  onClose,
  occupiedNames,
  busy,
  onPrepare,
  onCommit
}: {
  open: boolean
  onClose: () => void
  occupiedNames: Set<string>
  busy: ReadonlySet<string>
  onPrepare: (request: InstallRequest) => Promise<InstallOutcome>
  onCommit: (prepared: PreparedInstall) => Promise<InstallOutcome>
}) {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)

  /**
   * The one list of sources the browser reads, in precedence order: pasted
   * URLs first (this dialog-open only, never saved), then the configured list.
   * `null` until the configured list has been read.
   */
  const [sources, setSources] = useState<BrowserSource[] | null>(null)
  const [query, setQuery] = useState('')
  const [pasteInput, setPasteInput] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  /** Install outcomes per card key. */
  const [outcomes, setOutcomes] = useState<Record<string, { error?: string; notice?: string }>>({})
  /** A prepared install that replaces existing files, waiting for explicit confirmation. */
  const [confirm, setConfirm] = useState<PreparedInstall | null>(null)
  const [pageSize, setPageSize] = useState(CATALOG_PAGE_SIZE)

  /** The card being previewed, or null for the grid. */
  const [preview, setPreview] = useState<CatalogCard | null>(null)

  /**
   * Fetched SKILL.md files, keyed by their URL, for the life of one
   * dialog-open: previews, card details and Install all read this one copy,
   * so what was previewed is exactly what installs.
   */
  const [previews, setPreviews] = useState<Map<string, ManifestState>>(() => new Map())

  /**
   * Which dialog-open work belongs to. Closing the dialog or unmounting the
   * panel ends it: a late answer is dropped, and an install that has not
   * written yet is cancelled (it checks this before every step).
   */
  const sessionRef = useRef(0)
  useEffect(() => () => { sessionRef.current++ }, [])
  /** Source fetch ids, so a late answer for a replaced or removed row is dropped. */
  const requestRef = useRef(0)
  /** Manifest loads waiting or running, so a URL is fetched once. */
  const queueRef = useRef<{ waiting: string[]; running: number; known: Set<string> }>({ waiting: [], running: 0, known: new Set() })

  /** Fetch one source into its row, if the row still waits for this request. */
  const fetchSource = useCallback(async (url: string, request: number) => {
    const session = sessionRef.current
    let result: CatalogSourceResult
    try {
      result = toCatalogSourceResult(url, await openApi()?.getSkillsCatalog(url))
    } catch (err) {
      result = { url, ok: false, entries: [], error: err instanceof Error ? err.message : String(err) }
    }
    if (session === sessionRef.current) setSources((prev) => (prev ? settleBrowserSource(prev, url, request, result) : prev))
  }, [])

  useEffect(() => {
    // Closing ends this dialog-open: an install it started stops before writing.
    if (!open) { sessionRef.current++; return }
    setQuery('')
    setOutcomes({})
    setConfirm(null)
    setPreview(null)
    setPreviews(new Map())
    setSources(null)
    setPasteError(null)
    setPageSize(CATALOG_PAGE_SIZE)
    sessionRef.current++
    const session = sessionRef.current
    queueRef.current = { waiting: [], running: 0, known: new Set() }
    void (async () => {
      const stored = (await openApi()?.getSettings?.()) as unknown as
        { skillCatalogSources?: unknown } | undefined
      if (session !== sessionRef.current) return
      const rows = configuredBrowserSources(normalizeCatalogSources(stored?.skillCatalogSources), () => ++requestRef.current)
      // A URL pasted while Settings was being read stays first.
      setSources((prev) => [...(prev ?? []).filter((s) => s.transient), ...rows.filter((r) => !(prev ?? []).some((s) => s.url === r.url))])
      for (const row of rows) void fetchSource(row.url, row.request)
    })()
  }, [open, fetchSource])

  /** Fetch one SKILL.md through the package IPC (https-only, guarded, capped) into the shared cache. */
  const loadManifest = useCallback(async (url: string): Promise<ManifestState> => {
    const session = sessionRef.current
    setPreviews((prev) => new Map(prev).set(url, { status: 'loading' }))
    let next: ManifestState
    try {
      next = toManifestState(await openApi()?.getSkillPackage(url))
    } catch (err) {
      next = { status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
    if (session === sessionRef.current) setPreviews((prev) => new Map(prev).set(url, next))
    return next
  }, [])

  /** Queue manifest loads, at most four at a time. */
  const enqueue = useCallback((urls: string[]) => {
    const queue = queueRef.current
    for (const url of urls) {
      if (queue.known.has(url)) continue
      queue.known.add(url)
      queue.waiting.push(url)
    }
    const session = sessionRef.current
    const pump = () => {
      if (session !== sessionRef.current) return
      while (queue.running < 4 && queue.waiting.length > 0) {
        const url = queue.waiting.shift()!
        queue.running++
        void loadManifest(url).finally(() => {
          queue.running--
          pump()
        })
      }
    }
    pump()
  }, [loadManifest])

  const results = useMemo(() => browserResults(sources ?? []), [sources])
  const loadedName = useCallback((url: string): LoadedManifestName | null => manifestName(previews.get(url)), [previews])
  const cards = useMemo(() => buildCatalogCards(results), [results])
  const visible = useMemo(() => filterCatalogCards(cards, query, loadedName), [cards, query, loadedName])
  const page = useMemo(() => visible.slice(0, pageSize), [visible, pageSize])
  const failures = useMemo(() => results.filter((result) => !result.ok), [results])
  const pending = (sources ?? []).filter((s) => s.result === null).length
  const packageCards = useMemo(() => cards.filter((card) => card.kind === 'package'), [cards])
  // Only descriptions that actually arrived count as loaded; failures are counted apart.
  const readyCount = packageCards.filter((card) => previews.get(card.manifestUrl)?.status === 'ready').length
  const failedCount = packageCards.filter((card) => previews.get(card.manifestUrl)?.status === 'error').length

  // The cards on screen load their manifests; nothing else does unless asked.
  useEffect(() => {
    if (!open) return
    enqueue(page.filter((card) => card.kind === 'package').map((card) => card.manifestUrl))
  }, [open, page, enqueue])

  const setOutcome = useCallback((key: string, outcome: InstallOutcome) => {
    setOutcomes((prev) => ({ ...prev, [key]: { ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.notice ? { notice: outcome.notice } : {}) } }))
  }, [])

  /** Prepare an install from the manifest already loaded (loading it first if needed). */
  const install = useCallback(async (card: CatalogCard, fromPreview: boolean) => {
    // The agent this click means, captured before anything is awaited, and
    // the dialog-open it belongs to (closing the dialog ends it).
    const view = captureAgentView()
    const session = sessionRef.current
    const active = () => session === sessionRef.current
    setOutcomes((prev) => {
      if (!(card.key in prev)) return prev
      const next = { ...prev }
      delete next[card.key]
      return next
    })
    const result = await installFromCard({
      view,
      active,
      key: card.key,
      manifestUrl: card.manifestUrl,
      files: card.kind === 'entry' ? card.entry.files ?? [] : card.pkg.files,
      ...(card.kind === 'entry' ? { expectedName: card.entry.name } : {}),
      fromPreview,
      cached: previews.get(card.manifestUrl),
      load: () => loadManifest(card.manifestUrl),
    }, onPrepare)
    if (!active()) return
    if (result.kind === 'preview') setPreview(card)
    else if (result.outcome.confirm) setConfirm(result.outcome.confirm)
    else setOutcome(card.key, result.outcome)
  }, [loadManifest, onPrepare, previews, setOutcome])

  const replace = useCallback(async () => {
    const prepared = confirm
    if (!prepared) return
    setConfirm(null)
    setOutcome(prepared.key, await onCommit(prepared))
  }, [confirm, onCommit, setOutcome])

  const openPreview = (card: CatalogCard): void => {
    setPreview(card)
    if (!previews.has(card.manifestUrl)) enqueue([card.manifestUrl])
  }

  /** Add a pasted URL to the source list (first, this dialog-open only), or fetch it again if it is listed. */
  const openPasted = useCallback(() => {
    const url = pasteInput.trim()
    if (!isCatalogUrl(url)) {
      setPasteError('Paste an https:// URL: a GitHub repository, folder, SKILL.md or marketplace.json, or a catalog document.')
      return
    }
    setPasteError(null)
    setPasteInput('')
    setPageSize(CATALOG_PAGE_SIZE)
    const request = ++requestRef.current
    setSources((prev) => addBrowserSource(prev ?? [], url, request))
    void fetchSource(url, request)
  }, [fetchSource, pasteInput])

  const manageSources = () => {
    onClose()
    openSettingsAt('skills')
  }

  const sourceCount = sources?.length ?? 0
  const noSources = sources !== null && sources.length === 0
  const discovered = results.flatMap((result) => (result.ok && result.discovered ? [{ url: result.url, source: result.discovered }] : []))
  const shown = query ? visible.length : cards.length

  return (
    <Dialog open={open} onClose={onClose} title="Skill catalog" wide>
      <div
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          if (confirm) {
            e.preventDefault(); e.stopPropagation()
            setConfirm(null)
            return
          }
          if (preview) {
            e.preventDefault(); e.stopPropagation()
            setPreview(null)
            return
          }
          if (query) {
            e.preventDefault(); e.stopPropagation()
            setQuery('')
          }
        }}
      >
        <div className="flex h-[58vh] flex-col">
          {confirm ? (
            <ReplaceConfirm prepared={confirm} onCancel={() => setConfirm(null)} onReplace={() => void replace()} />
          ) : preview ? (
            <SkillPreview
              card={preview}
              state={previews.get(preview.manifestUrl)}
              occupiedNames={occupiedNames}
              installing={busy.has(preview.key)}
              outcome={outcomes[preview.key]}
              onBack={() => setPreview(null)}
              onInstall={() => void install(preview, true)}
              onRetry={() => void loadManifest(preview.manifestUrl)}
            />
          ) : (
            <>
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => { e.preventDefault(); openPasted() }}
              >
                <input
                  type="url"
                  value={pasteInput}
                  onChange={(e) => setPasteInput(e.target.value)}
                  spellCheck={false}
                  aria-label="Skill source URL"
                  placeholder="Paste a GitHub repository, folder, SKILL.md or marketplace.json URL…"
                  className="min-w-0 flex-1 px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  type="submit"
                  className="shrink-0 px-2.5 py-1.5 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
                >
                  Add
                </button>
              </form>
              {pasteError && <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">{pasteError}</p>}

              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPageSize(CATALOG_PAGE_SIZE) }}
                spellCheck={false}
                aria-label="Search skills"
                placeholder="Search skills…"
                className="mt-2 w-full px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
              />

              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
                  {query ? `${visible.length} of ${cards.length} skill${cards.length !== 1 ? 's' : ''}` : `${shown} skill${shown !== 1 ? 's' : ''}`}
                  {` · ${sourceCount} source${sourceCount !== 1 ? 's' : ''}`}
                  {pending > 0 && ` (${pending} loading)`}
                  {packageCards.length > 0 && ` · descriptions loaded ${readyCount} of ${packageCards.length}`}
                  {failedCount > 0 && ` · ${failedCount} could not be read`}
                </span>
                {packageCards.length > readyCount + failedCount && (
                  <button
                    onClick={() => enqueue(packageCards.map((card) => card.manifestUrl))}
                    title="Read every SKILL.md of this list now (four at a time), so search covers every name and description."
                    className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
                  >
                    Load all
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={manageSources}
                  className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
                >
                  Manage sources in Settings
                </button>
              </div>

              {/* Per-source status: how many it contributed, or why it failed. */}
              {sources && sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {sources.map(({ url, transient, result }) => (
                    <span
                      key={url}
                      title={
                        result?.ok
                          ? `${url}${result.dropped ? ` — ${result.dropped} entr${result.dropped === 1 ? 'y' : 'ies'} dropped as invalid` : ''}${transient ? ' — added here for this session, not saved' : ''}`
                          : url
                      }
                      className={`inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] ${
                        !result || result.ok
                          ? 'bg-neutral-100 dark:bg-neutral-700/60 text-neutral-500 dark:text-neutral-400'
                          : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      <span className="truncate">
                        {catalogSourceLabel(url, result?.discovered?.repository ?? result?.publisher)}
                        {' · '}
                        {!result
                          ? 'loading…'
                          : result.ok
                            ? result.discovered
                              ? `${result.discovered.packages.length} found at ${result.discovered.sha.slice(0, 7)}`
                              : `${result.entries.length} loaded`
                            : sanitizeDisplayText(result.error)}
                      </span>
                      {transient && (
                        <button
                          onClick={() => setSources((prev) => (prev ? removeBrowserSource(prev, url) : prev))}
                          aria-label={`Remove ${url}`}
                          title="Remove this pasted source"
                          className="shrink-0 cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-200"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {/* What a GitHub source names but does not list, said out loud. */}
              {discovered.some((d) => d.source.problems.length > 0) && (
                <details className="mt-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                  <summary className="cursor-pointer">
                    {discovered.reduce((n, d) => n + d.source.problems.length, 0)} note(s) about these sources
                  </summary>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    {discovered.flatMap((d) => d.source.problems.map((problem, i) => (
                      <li key={`${d.url}#${i}`}>{sanitizeDisplayText(problem)}</li>
                    )))}
                  </ul>
                </details>
              )}

              <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
                {noSources ? (
                  <div className="m-auto py-6 text-center">
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      No catalog sources configured.
                    </p>
                    <button
                      onClick={manageSources}
                      className="mt-2 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
                    >
                      Add one in Settings
                    </button>
                  </div>
                ) : cards.length === 0 && (sources === null || pending > 0) ? (
                  <p className="m-auto py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    Loading sources…
                  </p>
                ) : cards.length === 0 ? (
                  <p className="m-auto py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
                    {failures.length === results.length && results.length > 0 ? 'No source could be read.' : 'These sources list no skills.'}
                  </p>
                ) : visible.length === 0 ? (
                  <div className="m-auto py-6 text-center">
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      No skill matches “{sanitizeDisplayText(query)}”{packageCards.length > readyCount ? ' in the descriptions loaded so far' : ''}.
                    </p>
                    <button
                      onClick={() => setQuery('')}
                      className="mt-2 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
                    >
                      Clear search
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {page.map((card) => (
                        <CatalogCardView
                          key={card.key}
                          card={card}
                          state={previews.get(card.manifestUrl)}
                          occupiedNames={occupiedNames}
                          installing={busy.has(card.key)}
                          outcome={outcomes[card.key]}
                          onOpen={() => openPreview(card)}
                          onInstall={() => void install(card, false)}
                        />
                      ))}
                    </div>
                    {visible.length > page.length && (
                      <button
                        onClick={() => setPageSize((n) => n + CATALOG_PAGE_SIZE)}
                        className="mx-auto mt-3 shrink-0 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
                      >
                        Show more ({visible.length - page.length} more)
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">
            {busy.size > 0
              ? 'Installing… Closing this dialog cancels an install that has not written yet; one already written stays.'
              : 'Installing writes files under skills/<name>/. Nothing is run, and no tools or approvals are granted.'}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            title={busy.size > 0 ? 'Cancel the install in progress (if it has not written yet) and close' : undefined}
            className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
          >
            {busy.size > 0 ? 'Cancel and close' : 'Close'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

/** The label chip: shown for a package that does not declare a valid `adf` version. */
function CompatChip({ compat, showNative = false }: { compat: AdfCompat; showNative?: boolean }) {
  const label = adfCompatLabel(compat)
  if (label.native && !showNative) return null
  return (
    <span
      title={label.title}
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${
        label.native
          ? 'bg-neutral-100 dark:bg-neutral-700/60 text-neutral-600 dark:text-neutral-300'
          : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
      }`}
    >
      {sanitizeDisplayText(label.text)}
    </span>
  )
}

/** One card: a catalog entry, or a discovered package that may not have loaded yet. */
function CatalogCardView({
  card,
  state,
  occupiedNames,
  installing,
  outcome,
  onOpen,
  onInstall
}: {
  card: CatalogCard
  state: ManifestState | undefined
  occupiedNames: Set<string>
  installing: boolean
  outcome?: { error?: string; notice?: string }
  onOpen: () => void
  onInstall: () => void
}) {
  const imported = state?.status === 'ready' ? state.import : null
  const name = cardName(card, imported?.ok ? { name: imported.name, description: imported.description } : null)
  const folder = card.kind === 'package' ? (card.pkg.dir.split('/').pop() || card.source.repository) : null
  const description = card.kind === 'entry' ? card.entry.description : imported?.ok ? imported.description : null
  const path = cardPath(card)
  const slot = installSlot(name, occupiedNames)
  const problem = card.kind === 'package' ? card.pkg.problem : undefined
  const refused = imported && !imported.ok ? imported.error : undefined
  const adjusted = imported?.ok && imported.changes.length > 0
  return (
    <div
      role="button"
      tabIndex={0}
      title={`Preview ${name ?? folder ?? ''}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={`flex cursor-pointer flex-col rounded-lg border p-3 bg-white dark:bg-neutral-800 hover:border-blue-300 dark:hover:border-blue-700 ${
        outcome?.error ? 'border-red-300 dark:border-red-700' : 'border-neutral-200 dark:border-neutral-700'
      }`}
    >
      {/* The full name on its own row (it wraps, never elides); badges below it. */}
      <div className="break-all text-xs font-medium font-mono text-neutral-700 dark:text-neutral-300">
        {name ? sanitizeDisplayText(name) : <span className="italic text-[var(--adf-ui-text-subtle)]">{sanitizeDisplayText(folder)}</span>}
      </div>
      {(imported || slot.inUse) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {imported && <CompatChip compat={imported.compat} />}
          {adjusted && (
            <span title="Its frontmatter description is adjusted on install; the preview shows how." className="rounded bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 dark:text-blue-300">
              Adjusted on install
            </span>
          )}
          {slot.badge && (
            <span title={slot.title} className="rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] font-medium text-neutral-600 dark:text-neutral-300">
              {slot.badge}
            </span>
          )}
        </div>
      )}

      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400 line-clamp-3" title={sanitizeDisplayText(description)}>
        {description !== null
          ? sanitizeDisplayText(description)
          : state?.status === 'error'
            ? <span className="italic">SKILL.md could not be read: {sanitizeDisplayText(state.error)}</span>
            : <span className="italic">Loading SKILL.md…</span>}
      </p>
      {card.kind === 'package' && path && (
        <div className="mt-1 break-all font-mono text-[10px] text-[var(--adf-ui-text-subtle)]" title={path}>{sanitizeDisplayText(path)}</div>
      )}
      {(problem || refused) && (
        <p className="mt-1.5 text-[10px] text-red-600 dark:text-red-400">Can’t install: {sanitizeDisplayText(problem ?? refused)}</p>
      )}
      {outcome?.error && (
        <p className="mt-1.5 text-[10px] text-red-600 dark:text-red-400">Install failed: {sanitizeDisplayText(outcome.error)}</p>
      )}
      {outcome?.notice && (
        <p className="mt-1.5 text-[10px] text-green-600 dark:text-green-400">{sanitizeDisplayText(outcome.notice)}</p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-2.5">
        <span className="min-w-0 truncate rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:text-neutral-400" title={card.sourceUrl}>
          {sanitizeDisplayText(card.sourceLabel)}
        </span>
        <div className="flex-1" />
        {!problem && !refused && (
          <button
            onClick={(e) => { e.stopPropagation(); onInstall() }}
            disabled={installing}
            title={adjusted ? 'Opens the preview: this package is adjusted on install.' : slot.title}
            className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {installing ? 'Installing…' : slot.action}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Installing into a slot that already has files is an explicit replacement:
 * the files it replaces and the files it keeps are both listed. Only the
 * replaced files were read for their revision before this was shown; a change
 * to any of them before Replace refuses the whole write. Kept files are not
 * written, so they are not checked.
 */
function ReplaceConfirm({ prepared, onCancel, onReplace }: { prepared: PreparedInstall; onCancel: () => void; onReplace: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancelRef.current?.focus() }, [prepared])
  const created = prepared.files.length - prepared.replaces.length
  const list = (paths: string[]) => (
    <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
      {paths.map((path) => <li key={path} className="break-all">{sanitizeDisplayText(path)}</li>)}
    </ul>
  )
  return (
    <div className="m-auto w-full max-w-lg rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 p-4">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {prepared.replaces.length > 0 ? 'Replace existing files in' : 'Install into'} <span className="font-mono">skills/{sanitizeDisplayText(prepared.name)}/</span>{prepared.replaces.length > 0 ? '' : ', which already has files'}?
      </p>
      <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-300">
        That folder already has files. Nothing records which package wrote them, so they may be from another
        package with the same name, another version, or local edits.
        {prepared.replaces.length > 0
          ? ` This replaces ${prepared.replaces.length} file${prepared.replaces.length !== 1 ? 's' : ''}${created > 0 ? ` and writes ${created} new` : ''}. If any file it replaces changes before you confirm, nothing is written.`
          : ` Nothing there is overwritten: this writes ${created} new file${created !== 1 ? 's' : ''} beside them.`}
      </p>
      {prepared.replaces.length > 0 && (
        <>
          <div className="mt-2 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">Replaced</div>
          {list(prepared.replaces)}
        </>
      )}
      {prepared.keeps.length > 0 && (
        <>
          <div className="mt-2 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">Kept as they are (not part of this package)</div>
          {list(prepared.keeps)}
        </>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          ref={cancelRef}
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={onReplace}
          className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 rounded-lg cursor-pointer"
        >
          {prepared.replaces.length > 0 ? 'Replace files' : 'Install beside them'}
        </button>
      </div>
    </div>
  )
}



/**
 * Read a skill before installing it.
 *
 * The card shows a one-line description a publisher wrote about itself, while
 * SKILL.md is what actually lands in the agent's prompt. Everything here is
 * treated as hostile remote text — the frontmatter through the panel's
 * single-line sanitizer, the body through the block sanitizer that keeps line
 * breaks, and the markdown through the same marked + DOMPurify path the loop
 * renders model output with (utils/markdown.ts).
 *
 * What Install will do is stated before it is clicked: the name it installs
 * under, whether the package declares an ADF version, every file it writes,
 * and — when the description has to be adjusted for the ADF index — the
 * adjustment, with the original kept.
 */
function SkillPreview({
  card,
  state,
  occupiedNames,
  installing,
  outcome,
  onBack,
  onInstall,
  onRetry
}: {
  card: CatalogCard
  state: ManifestState | undefined
  occupiedNames: Set<string>
  installing: boolean
  outcome?: { error?: string; notice?: string }
  onBack: () => void
  onInstall: () => void
  onRetry: () => void
}) {
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [card.key])

  const parsed = useMemo(
    () => (state?.status === 'ready' ? splitSkillDocument(state.content) : null),
    [state]
  )
  const highlightVersion = useMarkdownHighlightVersion()
  const bodyHtml = useMemo(
    () => (parsed && parsed.body ? renderMarkdownToSafeHtml(parsed.body) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, highlightVersion]
  )
  const imported = state?.status === 'ready' ? importAs(state.import, card.kind === 'entry' ? card.entry.name : undefined) : null
  const name = cardName(card, imported?.ok ? { name: imported.name, description: imported.description } : null)
  const title = name ?? (card.kind === 'package' ? card.pkg.dir || card.source.repository : '')
  const files: Array<{ path: string; license?: boolean }> = card.kind === 'entry' ? card.entry.files ?? [] : card.pkg.files
  const slot = installSlot(name, occupiedNames)
  const problem = card.kind === 'package' ? card.pkg.problem : undefined
  const blocked = problem ?? (imported && !imported.ok ? imported.error : undefined)
  const linkable = isCatalogUrl(card.manifestUrl)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
        <button
          ref={backRef}
          onClick={onBack}
          className="shrink-0 rounded text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
        >
          ← Catalog
        </button>
        <span className="text-[var(--adf-ui-icon-muted)]">/</span>
        <span className="min-w-0 truncate font-mono text-neutral-600 dark:text-neutral-300">{sanitizeDisplayText(title)}</span>
      </div>

      <div className="mt-3 flex shrink-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-all text-xs font-medium font-mono text-neutral-700 dark:text-neutral-300">{sanitizeDisplayText(title)}</span>
            {imported && <CompatChip compat={imported.compat} showNative />}
            {slot.badge && (
              <span title={slot.title} className="shrink-0 rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] font-medium text-neutral-600 dark:text-neutral-300">
                {slot.badge}
              </span>
            )}
            <span className="min-w-0 truncate rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:text-neutral-400" title={card.sourceUrl}>
              {sanitizeDisplayText(card.sourceLabel)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {sanitizeDisplayText(card.kind === 'entry' ? card.entry.description : imported?.ok ? imported.description : cardPath(card))}
          </p>
          {card.kind === 'package' && (
            <div className="mt-0.5 text-[10px] text-[var(--adf-ui-text-subtle)]">
              {sanitizeDisplayText(cardPath(card))} at commit <span className="font-mono">{card.source.sha.slice(0, 7)}</span>
              {card.source.ref !== card.source.sha && <> ({sanitizeDisplayText(card.source.ref)})</>}
            </div>
          )}
          <div className="mt-1 flex items-baseline gap-1.5 text-[10px]">
            {linkable ? (
              <a href={card.manifestUrl} target="_blank" rel="noopener noreferrer" title={card.manifestUrl} className="min-w-0 truncate font-mono text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300">
                {sanitizeDisplayText(elideMiddle(card.manifestUrl, 68))}
                <span aria-hidden> ↗</span>
              </a>
            ) : (
              <span title={card.manifestUrl} className="min-w-0 truncate font-mono text-[var(--adf-ui-text-subtle)]">
                {sanitizeDisplayText(elideMiddle(card.manifestUrl, 68))}
              </span>
            )}
          </div>
        </div>
        {!blocked && (
          <button
            onClick={onInstall}
            disabled={installing || state?.status !== 'ready'}
            title={slot.title}
            className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {installing ? 'Installing…' : slot.inUse ? slot.action : imported?.ok && imported.changes.length ? 'Install adjusted' : 'Install'}
          </button>
        )}
      </div>

      {blocked && (
        <p className="mt-2 shrink-0 text-[10px] text-red-600 dark:text-red-400">Can’t install: {sanitizeDisplayText(blocked)}</p>
      )}
      {outcome?.error && (
        <p className="mt-2 shrink-0 text-[10px] text-red-600 dark:text-red-400">Install failed: {sanitizeDisplayText(outcome.error)}</p>
      )}
      {outcome?.notice && (
        <p className="mt-2 shrink-0 text-[10px] text-green-600 dark:text-green-400">{sanitizeDisplayText(outcome.notice)} The Skills panel shows whether the index lists it.</p>
      )}

      {imported?.ok && imported.changes.length > 0 && (
        <div className="mt-2 shrink-0 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/10 px-2.5 py-2 text-[10px] text-neutral-600 dark:text-neutral-300">
          <div className="font-medium text-blue-700 dark:text-blue-300">Adjusted on install, so the ADF skill index can read it</div>
          <ul className="mt-1 list-disc pl-4">
            {imported.changes.map((change) => <li key={change}>{sanitizeDisplayText(change)}</li>)}
          </ul>
          <div className="mt-1">Installed description: “{sanitizeDisplayText(imported.description)}”</div>
          <div className="mt-1 text-[var(--adf-ui-text-subtle)]">
            Only the frontmatter <span className="font-mono">description</span> changes. The full original description is added at the top of the body with a comment saying the file was adjusted on install and where it came from; every other line and file is installed as published.
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-2 shrink-0 rounded-lg border border-neutral-200 dark:border-neutral-700 px-2.5 py-2">
          <div className="text-[10px] text-[var(--adf-ui-text-subtle)]">
            Also installs {files.length} file{files.length !== 1 ? 's' : ''} under{' '}
            <span className="font-mono">skills/{sanitizeDisplayText(name ?? '<name>')}/</span>
            {card.kind === 'package' && ` (${Math.ceil(card.pkg.totalBytes / 1024)} KB in all)`}. Nothing is run.
          </div>
          <div className="mt-1 flex max-h-20 flex-wrap gap-x-2 gap-y-0.5 overflow-y-auto">
            {files.map((file) => (
              <span key={file.path} className="max-w-full truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400" title={file.license ? `${file.path} — license or notice file from a parent folder` : file.path}>
                {sanitizeDisplayText(file.path)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
        {!state || state.status === 'loading' ? (
          <SkillPreviewSkeleton />
        ) : state.status === 'error' ? (
          <div className="m-auto py-8 text-center">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Could not read this skill: {sanitizeDisplayText(state.error)}
            </p>
            <button
              onClick={onRetry}
              className="mt-2 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {parsed && parsed.fields.length > 0 && (
              <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 px-2.5 py-2">
                {parsed.fields.map((field) => (
                  <Fragment key={field.key}>
                    <dt className="font-mono text-[10px] text-[var(--adf-ui-text-subtle)]">{sanitizeDisplayText(field.key)}</dt>
                    <dd className="min-w-0 break-words text-[11px] text-neutral-600 dark:text-neutral-300">{sanitizeDisplayText(field.value)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {bodyHtml ? (
              <div
                className="loop-markdown text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-200"
                // Sanitized above by utils/markdown.ts — marked, then DOMPurify
                // with the loop's allowlist. Never raw remote HTML.
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
            ) : (
              <p className="m-auto py-6 text-center text-[11px] italic text-[var(--adf-ui-text-subtle)]">
                This SKILL.md has no body — only frontmatter.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The shape of a SKILL.md, while one is on the wire.
 *
 * A centered "Loading…" line told the truth and looked like a bug: the pane it
 * sat in is a document, and one line of text in a document-sized space reads as
 * a failure. Standing in the frontmatter block and the first paragraphs instead
 * says what is coming, in the same pulsing-bar idiom the dashboard tiles use.
 */
function SkillPreviewSkeleton() {
  return (
    <div className="animate-pulse" role="status">
      <div className="mb-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 px-2.5 py-2">
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-10 rounded bg-neutral-200 dark:bg-neutral-700" />
          <div className="h-2.5 w-28 rounded bg-neutral-100 dark:bg-neutral-700/60" />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <div className="h-2.5 w-14 rounded bg-neutral-200 dark:bg-neutral-700" />
          <div className="h-2.5 flex-1 rounded bg-neutral-100 dark:bg-neutral-700/60" />
        </div>
      </div>
      <div className="h-3.5 w-1/3 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-3 space-y-1.5">
        <div className="h-2.5 w-full rounded bg-neutral-100 dark:bg-neutral-700/60" />
        <div className="h-2.5 w-11/12 rounded bg-neutral-100 dark:bg-neutral-700/60" />
        <div className="h-2.5 w-4/5 rounded bg-neutral-100 dark:bg-neutral-700/60" />
      </div>
      <div className="mt-4 h-3 w-1/4 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-3 space-y-1.5">
        <div className="h-2.5 w-full rounded bg-neutral-100 dark:bg-neutral-700/60" />
        <div className="h-2.5 w-3/4 rounded bg-neutral-100 dark:bg-neutral-700/60" />
      </div>
      <span className="sr-only">Loading SKILL.md…</span>
    </div>
  )
}
