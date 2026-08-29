import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useEditorTabsStore } from '../../stores/editor-tabs.store'
import type { SkillCatalogEntry } from '../../../shared/schemas/skills-catalog.schema'
import type { AgentExecutionEvent } from '../../../shared/types/ipc.types'
import {
  SKILLS_REGISTRY_PATH,
  SKILLS_STATE_PATH,
  SKILL_MANIFEST,
  MAX_SKILLS,
  MAX_REGISTRY_BYTES,
  MAX_SKILL_FILE_BYTES,
  catalogSourceLabel,
  estimateTokens,
  filterCatalogEntries,
  mergeCatalogResults,
  normalizeCatalogSources,
  parseSkillsRegistry,
  sanitizeDisplayText,
  type CatalogSourceResult,
  type MergedCatalogEntry,
  type ParsedRegistry,
  type RegistryEntry
} from '../../utils/skills-panel'
import { renderMarkdownToSafeHtml } from '../../utils/markdown'
import { splitSkillDocument } from '../../utils/skill-preview'
import { agentChanged, setSkillMuted, syncOpenTab } from '../../utils/skills-state'
import { Dialog } from '../common/Dialog'

/**
 * Skills — the human half of file-backed skills (design doc §4).
 *
 * Everything here is a file operation, never a config edit:
 *
 *   install / remove  →  write or delete skills/<name>/SKILL.md
 *   mute / unmute     →  edit the `disabled` list in skills-state.json
 *
 * Both paths run through the workspace write choke point, which reindexes and
 * regenerates skills-registry.json on its own — this panel never writes the
 * registry, never edits config, and never touches tools, approvals, or
 * `authorized`. Indexing is unconditional, so there is nothing here to turn on.
 *
 * Two hazards shape the code below.
 *
 * 1. DOC_WRITE_INTERNAL_FILE carries no agent identity: it lands in whichever
 *    workspace main has open when it arrives. A ten-second catalog fetch can
 *    easily outlive the agent it started under, so every write captures the
 *    panel's agent (the open document's filePath) beforehand and is abandoned
 *    if the agent changed or a switch is in flight (see beginAgentSwitch).
 * 2. skills-state.json is read-modify-write, so two toggles racing lose one
 *    edit. Both hazards are handled in utils/skills-state.ts, whose write queue
 *    is shared with the composer's `/skills disable|enable` commands; the
 *    checkbox here is optimistic with rollback so the UI never stalls on IPC.
 */

interface FileEntry {
  path: string
  size: number
}

/**
 * What one Install click did.
 *
 * `error` non-null means the package did not land: the manifest was never
 * written, so the indexer never saw it. `warnings` is the partial case — the
 * skill installed and works, but a resource it ships did not arrive, which is
 * worth saying out loud and is not a failure of the install.
 */
interface InstallOutcome {
  error: string | null
  warnings: string[]
}

const NO_BUSY: ReadonlySet<string> = new Set()

export function SkillsPanel() {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)

  const [files, setFiles] = useState<FileEntry[]>([])
  const [registry, setRegistry] = useState<ParsedRegistry | null>(null)
  const [registryBytes, setRegistryBytes] = useState(0)
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
    const owner = useDocumentStore.getState().filePath
    try {
      const listed = await window.adfApi?.getInternalFiles()
      const [registryFile, stateFile] = await Promise.all([
        window.adfApi?.readInternalFile(SKILLS_REGISTRY_PATH),
        window.adfApi?.readInternalFile(SKILLS_STATE_PATH)
      ])
      if (seq !== refreshSeq.current) return false
      if (useDocumentStore.getState().filePath !== owner) return false

      const fileList = listed?.files ?? []
      const parsed = parseSkillsRegistry(registryFile?.content)
      setFiles(fileList)
      setRegistryBytes(fileList.find((f) => f.path === SKILLS_REGISTRY_PATH)?.size ?? 0)
      setRegistry(parsed)
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
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [filePath, refresh])

  /**
   * Live updates. Every writer that is not Studio itself — the agent's fs_write,
   * a lambda, the daemon, and the indexer's own registry write —
   * surfaces as a `file_updated` event (assemble-agent.ts), so the panel follows
   * the same push channel its siblings use instead of guessing at a settle
   * delay. Debounced: one install fires several of these in a row.
   */
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.adfApi?.onAgentEvent?.((event: AgentExecutionEvent) => {
      if (event?.type !== 'file_updated') return
      const path = (event.payload as { path?: string } | undefined)?.path
      if (!path) return
      if (path !== SKILLS_REGISTRY_PATH && path !== SKILLS_STATE_PATH && !SKILL_MANIFEST.test(path)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        void refresh()
      }, 150)
    })
    return () => {
      if (debounce) clearTimeout(debounce)
      unsubscribe?.()
    }
  }, [refresh])

  /** Installed packages as the VFS sees them — the ground truth the indexer reads. */
  const installedNames = useMemo(() => {
    const names = new Set<string>()
    for (const file of files) {
      const match = SKILL_MANIFEST.exec(file.path)
      if (match) names.add(match[1])
    }
    return names
  }, [files])

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

  /**
   * Install = write the package; the indexer does the rest. The fetches are
   * remote and slow, so the agent identity captured up front is re-checked
   * after them before anything touches the VFS.
   *
   * An entry carrying `files` is a whole package — scripts, references,
   * `agents/openai.yaml` — and every one of them is written RESOURCES FIRST,
   * `SKILL.md` LAST (design doc §3.5). The indexer keys on the manifest path, so
   * that ordering is what keeps a half-arrived package from ever being indexed
   * or injected. Entries with no `files` are the schema-1 case and behave
   * exactly as before: one manifest, one write.
   *
   * A resource that will not fetch or write is reported and skipped rather than
   * aborting the install — the skill's instructions are the part that matters,
   * and a missing reference file is a thing a human can see and re-run.
   */
  const handleInstall = useCallback(async (entry: SkillCatalogEntry): Promise<InstallOutcome> => {
    const owner = useDocumentStore.getState().filePath
    markBusy(entry.name, true)
    try {
      const directory = `skills/${entry.name}`
      const manifestPath = `${directory}/SKILL.md`
      const pkg = await window.adfApi?.getSkillPackage(entry.raw_url)
      if (!pkg?.ok) return { error: pkg?.error ?? 'Fetch failed', warnings: [] }

      // Resources ride the same capped, SSRF-guarded package IPC as the
      // manifest. Fetch them all before writing anything, so the write phase is
      // short and the agent-identity check in front of it stays meaningful.
      const warnings: string[] = []
      const resources: Array<{ path: string; content: string }> = []
      for (const file of entry.files ?? []) {
        const fetched = await window.adfApi?.getSkillPackage(file.raw_url)
        if (!fetched?.ok) {
          warnings.push(`${file.path} — ${fetched?.error ?? 'Fetch failed'}`)
          continue
        }
        resources.push({ path: `${directory}/${file.path}`, content: fetched.content })
      }

      const blocked = agentChanged(owner)
      if (blocked) return { error: blocked, warnings: [] }

      for (const resource of resources) {
        const ok = await window.adfApi?.writeInternalFile(resource.path, resource.content)
        if (!ok?.success) {
          warnings.push(`${resource.path} — could not write`)
          continue
        }
        syncOpenTab(resource.path, resource.content)
      }

      // The manifest goes last, and only to the agent this install started
      // under: the resource writes above are more IPC round trips, and a
      // workspace switch during them must not publish a package here.
      const moved = agentChanged(owner)
      if (moved) return { error: moved, warnings }
      const written = await window.adfApi?.writeInternalFile(manifestPath, pkg.content)
      if (!written?.success) return { error: `Could not write ${manifestPath}.`, warnings }
      syncOpenTab(manifestPath, pkg.content)
      await refresh()
      later(600, () => void refresh())
      return { error: null, warnings }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), warnings: [] }
    } finally {
      markBusy(entry.name, false)
    }
  }, [later, markBusy, refresh])

  /** Open any workspace file in the editor — the registry button and every row. */
  const openInEditor = useCallback(async (path: string) => {
    const result = await window.adfApi?.readInternalFile(path)
    if (result?.content != null) {
      useEditorTabsStore.getState().openTab(path, result.binary ? '' : result.content, result.binary)
    }
  }, [])

  if (!filePath || !config) {
    return (
      <div className="p-4 text-sm text-neutral-400 dark:text-neutral-500 text-center mt-8">
        Open a file to view agent skills.
      </div>
    )
  }

  // Exactly one empty state at a time: the catalog is unreadable, or it has not
  // been written yet, or it exists and has nothing in it.
  const catalogUnreadable = registry === null && registryBytes > 0
  const showNotGenerated = registry === null && registryBytes === 0 && installedNames.size > 0
  const showNothingInstalled =
    !catalogUnreadable && !showNotGenerated && skills.length === 0 && problems.length === 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {skills.length} skill{skills.length !== 1 ? 's' : ''} installed
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
        {showNothingInstalled && (
          <div className="text-center py-8">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">No skills installed.</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              Every <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> in this agent is
              indexed and kept in its prompt. Skills are instructions, never authority.
            </p>
            <button
              onClick={() => setCatalogOpen(true)}
              className="mt-3 px-3 py-1.5 text-xs font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg cursor-pointer"
            >
              Browse catalog
            </button>
          </div>
        )}

        {showNotGenerated && (
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500 py-8 text-center">
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
                <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300 font-mono truncate">
                  {sanitizeDisplayText(skill.name)}
                </div>
                {skill.enabled ? (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 leading-relaxed">
                    {skill.description
                      ? sanitizeDisplayText(skill.description)
                      : <span className="italic">no description</span>}
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-1 italic">
                    muted — description removed from context
                  </p>
                )}
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 font-mono truncate" title={skill.path}>
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
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
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
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
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
          <div className="text-[10px] text-neutral-400 dark:text-neutral-500 text-right mt-0.5">
            runtime-generated — edits are overwritten
          </div>
        )}
      </div>

      <CatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        installedNames={installedNames}
        busy={busy}
        onInstall={handleInstall}
      />
    </div>
  )
}

/**
 * Catalog browser — a marketplace over every configured source at once.
 *
 * The source list is an APP preference (Settings → Skills), not agent config:
 * the dialog reads `skillCatalogSources` each time it opens and fetches every
 * source concurrently in the main process, since the renderer's CSP blocks
 * remote origins. The list is the whole truth — the first-party registry is in
 * it as an ordinary entry when the human kept it, and absent when they did not,
 * so an empty list is a legitimate state the dialog says out loud. Results merge
 * first-wins by name in LIST ORDER, so precedence is what Settings shows, and
 * one source failing costs its own row and nothing else.
 *
 * Catalog text is remote data. Names, descriptions, publishers and error
 * strings are all sanitized before they are painted, so a bidi override in an
 * upstream document cannot make an entry claim to be something it is not — the
 * second layer behind the main-side schema, which rejects those characters
 * per-entry rather than failing a whole document.
 *
 * The dialog has two views, not two dialogs: clicking a card swaps the grid for
 * that skill's preview and Escape (or the breadcrumb) swaps it back, the same
 * in-place step the MCP add-server modal and the agent review dialog use. A
 * second stacked modal over a `<dialog>` would take the Escape key with it.
 */
function CatalogDialog({
  open,
  onClose,
  installedNames,
  busy,
  onInstall
}: {
  open: boolean
  onClose: () => void
  installedNames: Set<string>
  busy: ReadonlySet<string>
  onInstall: (entry: SkillCatalogEntry) => Promise<InstallOutcome>
}) {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)

  /** The resolved source list from app settings. `null` until it has been read. */
  const [sources, setSources] = useState<string[] | null>(null)
  const [results, setResults] = useState<CatalogSourceResult[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  /** Install failures, per entry, so one bad row never blanks the grid. */
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  /** Resources an otherwise-successful install could not bring along. */
  const [installWarnings, setInstallWarnings] = useState<Record<string, string[]>>({})

  /** The entry being previewed, or null for the grid. */
  const [preview, setPreview] = useState<MergedCatalogEntry | null>(null)

  /**
   * Fetched SKILL.md bodies, keyed by raw_url and kept for the life of one
   * dialog-open. Flipping between cards is then free, and reopening the browser
   * is the refresh — the same rule the source list already follows, so a preview
   * can never be older than the catalog it was opened from.
   */
  const [previews, setPreviews] = useState<Map<string, PreviewState>>(() => new Map())

  /**
   * Which dialog-open a preview fetch belongs to. A slow fetch that resolves
   * after the dialog closed and reopened must not repopulate the cache that its
   * own open cleared.
   */
  const sessionRef = useRef(0)

  /**
   * Re-read the preference on every open. Sources are edited in Settings — a
   * different part of the app, with no change event to subscribe to — so
   * opening the browser is the refresh, and there is no Load button to press.
   */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQuery('')
    setInstallErrors({})
    setInstallWarnings({})
    setPreview(null)
    setPreviews(new Map())
    sessionRef.current++
    // Held from the moment the dialog opens: without it the gap before the
    // preference read resolves paints "These sources list no skills."
    setLoading(true)
    void (async () => {
      const stored = (await window.adfApi?.getSettings?.()) as unknown as
        { skillCatalogSources?: unknown } | undefined
      if (!cancelled) setSources(normalizeCatalogSources(stored?.skillCatalogSources))
    })()
    return () => { cancelled = true }
  }, [open])

  /**
   * Fetch every source concurrently. A rejected promise — which used to strand
   * the dialog on "Loading catalog…" forever — is caught per source and becomes
   * that source's own failure row, so the rest of the marketplace still paints.
   */
  useEffect(() => {
    if (!open || sources === null) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      const settled = await Promise.all(
        sources.map(async (url): Promise<CatalogSourceResult> => {
          try {
            const result = await window.adfApi?.getSkillsCatalog(url)
            if (!result?.ok) {
              return { url, ok: false, entries: [], error: result?.error ?? 'Unavailable' }
            }
            return {
              url,
              ok: true,
              entries: result.entries,
              publisher: result.publisher,
              dropped: result.dropped
            }
          } catch (err) {
            return { url, ok: false, entries: [], error: err instanceof Error ? err.message : String(err) }
          }
        })
      )
      if (cancelled) return
      setResults(settled)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [open, sources])

  const merged = useMemo(() => mergeCatalogResults(results), [results])
  const visible = useMemo(() => filterCatalogEntries(merged, query), [merged, query])
  const failures = useMemo(() => results.filter((result) => !result.ok), [results])

  /**
   * The one install path, shared by the card button and the preview's. Both
   * report into the same per-entry maps, so opening a preview after a failed
   * card install shows the failure that already happened.
   */
  const install = useCallback(async (entry: MergedCatalogEntry) => {
    const clear = <T,>(prev: Record<string, T>): Record<string, T> => {
      if (!(entry.name in prev)) return prev
      const next = { ...prev }
      delete next[entry.name]
      return next
    }
    setInstallErrors(clear)
    setInstallWarnings(clear)
    const outcome = await onInstall(entry)
    if (outcome.error) setInstallErrors((prev) => ({ ...prev, [entry.name]: outcome.error as string }))
    if (outcome.warnings.length) {
      setInstallWarnings((prev) => ({ ...prev, [entry.name]: outcome.warnings }))
    }
  }, [onInstall])

  /**
   * Fetch one entry's SKILL.md for preview through the SAME package IPC install
   * uses — https-only, SSRF-guarded, capped at 256KB in the main process. A
   * preview is a fetch and nothing else: it writes no file and touches no agent,
   * which is the entire point of reading a skill before installing it.
   */
  const loadPreview = useCallback(async (entry: MergedCatalogEntry) => {
    const url = entry.raw_url
    const session = sessionRef.current
    setPreviews((prev) => new Map(prev).set(url, { status: 'loading' }))
    let next: PreviewState
    try {
      const pkg = await window.adfApi?.getSkillPackage(url)
      next = pkg?.ok
        ? { status: 'ready', content: pkg.content }
        : { status: 'error', error: pkg?.error ?? 'Fetch failed' }
    } catch (err) {
      next = { status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
    if (session !== sessionRef.current) return
    setPreviews((prev) => new Map(prev).set(url, next))
  }, [])

  const openPreview = (entry: MergedCatalogEntry): void => {
    setPreview(entry)
    // A cached failure stays put; the preview's own Retry is what refetches it.
    if (!previews.has(entry.raw_url)) void loadPreview(entry)
  }

  const manageSources = () => {
    onClose()
    openSettingsAt('skills')
  }

  /**
   * How many sources the count line names. Taken from the preference rather
   * than from `results`, so the line reads "· 3 sources" while they are still
   * in flight instead of "· 0 sources".
   */
  const sourceCount = sources?.length ?? 0

  /** Nothing configured at all — a state a human can legitimately choose. */
  const noSources = sources !== null && sources.length === 0

  return (
    <Dialog open={open} onClose={onClose} title="Skill catalog" wide>
      {/*
        Escape unwinds one step at a time: it leaves a preview first, then
        clears a live query, and only closes the dialog when neither is showing.
        Preventing the default on the keydown is what stops <dialog>'s own close
        — the cancel event never fires. It reaches this handler because the
        preview focuses its own back button on entry, so focus never leaves the
        subtree when the grid unmounts underneath it.
      */}
      <div
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          if (preview) {
            e.preventDefault()
            e.stopPropagation()
            setPreview(null)
            return
          }
          if (query) {
            e.preventDefault()
            e.stopPropagation()
            setQuery('')
          }
        }}
      >
        {preview ? (
          <SkillPreview
            entry={preview}
            state={previews.get(preview.raw_url)}
            installed={installedNames.has(preview.name)}
            installing={busy.has(preview.name)}
            installError={installErrors[preview.name]}
            installWarnings={installWarnings[preview.name]}
            onBack={() => setPreview(null)}
            onInstall={() => void install(preview)}
            onRetry={() => void loadPreview(preview)}
          />
        ) : (
          <>
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              aria-label="Search skills"
              placeholder="Search skills…"
              className="w-full px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
            />

            <div className="mt-2 flex items-center gap-2">
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {query ? `${visible.length} of ${merged.length}` : merged.length} skill
                {(query ? visible.length : merged.length) !== 1 ? 's' : ''} · {sourceCount} source
                {sourceCount !== 1 ? 's' : ''}
              </span>
              <div className="flex-1" />
              <button
                onClick={manageSources}
                className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
              >
                Manage sources in Settings
              </button>
            </div>

            {/* Per-source load status, one chip each: how many it contributed, or why it failed. */}
            {results.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {results.map((result) => (
                  <span
                    key={result.url}
                    title={
                      result.ok
                        ? `${result.url}${result.dropped ? ` — ${result.dropped} entr${result.dropped === 1 ? 'y' : 'ies'} dropped as invalid` : ''}`
                        : result.url
                    }
                    className={`max-w-full truncate rounded px-1.5 py-0.5 text-[10px] ${
                      result.ok
                        ? 'bg-neutral-100 dark:bg-neutral-700/60 text-neutral-500 dark:text-neutral-400'
                        : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {catalogSourceLabel(result.url, result.publisher)}
                    {' · '}
                    {result.ok ? `${result.entries.length} loaded` : sanitizeDisplayText(result.error)}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-3">
              {/*
                Checked before `loading`: with no sources there is nothing to wait
                for, and the honest answer is that the list is empty by choice —
                not that every catalog happened to come back with nothing.
              */}
              {noSources ? (
                <div className="py-6 text-center">
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
              ) : loading ? (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 py-6 text-center">
                  Loading catalogs…
                </p>
              ) : merged.length === 0 ? (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 py-6 text-center">
                  {failures.length === results.length && results.length > 0
                    ? 'No source could be reached.'
                    : 'These sources list no skills.'}
                </p>
              ) : visible.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    No skill matches “{sanitizeDisplayText(query)}”.
                  </p>
                  <button
                    onClick={() => setQuery('')}
                    className="mt-2 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <div className="max-h-[55vh] overflow-y-auto pr-1">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {visible.map((entry) => {
                      const installed = installedNames.has(entry.name)
                      const installing = busy.has(entry.name)
                      const error = installErrors[entry.name]
                      const warnings = installWarnings[entry.name]
                      return (
                        // The card opens the preview; the Install button must not.
                        <div
                          key={entry.name}
                          role="button"
                          tabIndex={0}
                          title={`Preview ${entry.name}`}
                          onClick={() => openPreview(entry)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openPreview(entry)
                            }
                          }}
                          className={`flex cursor-pointer flex-col rounded-lg border p-3 bg-white dark:bg-neutral-800 hover:border-blue-300 dark:hover:border-blue-700 ${
                            error
                              ? 'border-red-300 dark:border-red-700'
                              : 'border-neutral-200 dark:border-neutral-700'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span
                              className="min-w-0 truncate text-xs font-medium font-mono text-neutral-700 dark:text-neutral-300"
                              title={sanitizeDisplayText(entry.name)}
                            >
                              {sanitizeDisplayText(entry.name)}
                            </span>
                            {installed && (
                              <span className="shrink-0 rounded bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 text-[9px] font-medium text-green-600 dark:text-green-400">
                                Installed
                              </span>
                            )}
                          </div>

                          <p
                            className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400 line-clamp-3"
                            title={sanitizeDisplayText(entry.description)}
                          >
                            {sanitizeDisplayText(entry.description)}
                          </p>

                          {error && (
                            <p className="mt-1.5 text-[10px] text-red-600 dark:text-red-400">
                              Install failed: {sanitizeDisplayText(error)}
                            </p>
                          )}

                          {warnings && warnings.length > 0 && (
                            <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-500">
                              Installed without {warnings.length} file{warnings.length !== 1 ? 's' : ''}:{' '}
                              {sanitizeDisplayText(warnings.join('; '))}
                            </p>
                          )}

                          <div className="mt-auto flex items-center gap-2 pt-2.5">
                            <span
                              className="min-w-0 truncate rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:text-neutral-400"
                              title={entry.sourceUrl}
                            >
                              {sanitizeDisplayText(entry.sourceLabel)}
                            </span>
                            <div className="flex-1" />
                            <button
                              onClick={(e) => { e.stopPropagation(); void install(entry) }}
                              disabled={installing}
                              title={installed ? `Overwrite skills/${entry.name}/` : undefined}
                              className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                            >
                              {installing ? 'Installing…' : installed ? 'Reinstall' : 'Install'}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex items-center gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
            Installing writes files under skills/&lt;name&gt;/ — no tools, files, or approvals are granted.
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}

/** One entry's SKILL.md as the preview has it: in flight, fetched, or refused. */
type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; error: string }

/**
 * Read a skill before installing it.
 *
 * This is the whole argument for the view: the card shows a one-line
 * description a publisher wrote about itself, while SKILL.md is what actually
 * lands in the agent's prompt. Everything here is therefore treated as hostile
 * remote text — the frontmatter through the panel's single-line sanitizer, the
 * body through the block sanitizer that keeps line breaks, and the markdown
 * through the same marked + DOMPurify path the loop renders model output with
 * (utils/markdown.ts). No other renderer, and no unsanitized HTML.
 *
 * Resources the package ships are listed, never fetched: the point of the list
 * is to say what Install will write, and reading six more remote files to
 * answer that would cost more than it tells anyone.
 */
function SkillPreview({
  entry,
  state,
  installed,
  installing,
  installError,
  installWarnings,
  onBack,
  onInstall,
  onRetry
}: {
  entry: MergedCatalogEntry
  state: PreviewState | undefined
  installed: boolean
  installing: boolean
  installError?: string
  installWarnings?: string[]
  onBack: () => void
  onInstall: () => void
  onRetry: () => void
}) {
  // Focus lands on the breadcrumb, which keeps the keyboard inside the dialog's
  // handler subtree after the grid unmounts — that is what makes Escape step
  // back to the catalog instead of closing the dialog outright.
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [entry.raw_url])

  const parsed = useMemo(
    () => (state?.status === 'ready' ? splitSkillDocument(state.content) : null),
    [state]
  )
  const bodyHtml = useMemo(
    () => (parsed && parsed.body ? renderMarkdownToSafeHtml(parsed.body) : ''),
    [parsed]
  )
  const files = entry.files ?? []

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <button
          ref={backRef}
          onClick={onBack}
          className="shrink-0 rounded text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 cursor-pointer"
        >
          ← Catalog
        </button>
        <span className="text-neutral-300 dark:text-neutral-600">/</span>
        <span className="min-w-0 truncate font-mono text-neutral-600 dark:text-neutral-300">
          {sanitizeDisplayText(entry.name)}
        </span>
      </div>

      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium font-mono text-neutral-700 dark:text-neutral-300">
              {sanitizeDisplayText(entry.name)}
            </span>
            {installed && (
              <span className="shrink-0 rounded bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 text-[9px] font-medium text-green-600 dark:text-green-400">
                Installed
              </span>
            )}
            <span
              className="min-w-0 truncate rounded bg-neutral-100 dark:bg-neutral-700/60 px-1.5 py-0.5 text-[9px] text-neutral-500 dark:text-neutral-400"
              title={entry.sourceUrl}
            >
              {sanitizeDisplayText(entry.sourceLabel)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {sanitizeDisplayText(entry.description)}
          </p>
        </div>
        <button
          onClick={onInstall}
          disabled={installing}
          title={installed ? `Overwrite skills/${entry.name}/` : `Write skills/${entry.name}/`}
          className="shrink-0 px-2.5 py-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {installing ? 'Installing…' : installed ? 'Reinstall' : 'Install'}
        </button>
      </div>

      {installError && (
        <p className="mt-2 text-[10px] text-red-600 dark:text-red-400">
          Install failed: {sanitizeDisplayText(installError)}
        </p>
      )}

      {installWarnings && installWarnings.length > 0 && (
        <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-500">
          Installed without {installWarnings.length} file
          {installWarnings.length !== 1 ? 's' : ''}: {sanitizeDisplayText(installWarnings.join('; '))}
        </p>
      )}

      {/* What Install writes beside SKILL.md, straight from the catalog entry. */}
      {files.length > 0 && (
        <div className="mt-2 rounded-lg border border-neutral-200 dark:border-neutral-700 px-2.5 py-2">
          <div className="text-[10px] text-neutral-400 dark:text-neutral-500">
            Also installs {files.length} file{files.length !== 1 ? 's' : ''} under{' '}
            <span className="font-mono">skills/{entry.name}/</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            {files.map((file) => (
              <span
                key={file.path}
                className="max-w-full truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400"
                title={file.path}
              >
                {sanitizeDisplayText(file.path)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 max-h-[50vh] overflow-y-auto pr-1">
        {!state || state.status === 'loading' ? (
          <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
            Loading SKILL.md…
          </p>
        ) : state.status === 'error' ? (
          <div className="py-8 text-center">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Could not read this skill: {sanitizeDisplayText(state.error)}
            </p>
            <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">
              A package over {Math.round(MAX_SKILL_FILE_BYTES / 1024)} KB, or one that is not text,
              is refused before it is fetched — the same bound the indexer enforces.
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
                    <dt className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                      {sanitizeDisplayText(field.key)}
                    </dt>
                    <dd className="min-w-0 break-words text-[11px] text-neutral-600 dark:text-neutral-300">
                      {sanitizeDisplayText(field.value)}
                    </dd>
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
              <p className="py-6 text-center text-[11px] italic text-neutral-400 dark:text-neutral-500">
                This SKILL.md has no body — only frontmatter.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
