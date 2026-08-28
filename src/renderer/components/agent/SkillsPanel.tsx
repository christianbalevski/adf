import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useEditorTabsStore, isAgentSwitching } from '../../stores/editor-tabs.store'
import { ADF_SKILLS_REGISTRY_URL } from '../../../shared/constants/adf-defaults'
import type { SkillCatalogEntry } from '../../../shared/schemas/skills-catalog.schema'
import type { AgentConfig as AgentConfigType } from '../../../shared/types/adf-v02.types'
import type { AgentExecutionEvent } from '../../../shared/types/ipc.types'
import {
  SKILLS_REGISTRY_PATH,
  SKILLS_STATE_PATH,
  SKILL_MANIFEST,
  MAX_SKILLS,
  MAX_REGISTRY_BYTES,
  MAX_SKILL_FILE_BYTES,
  estimateTokens,
  mergeDisabledList,
  parseSkillsRegistry,
  sanitizeDisplayText,
  type ParsedRegistry,
  type RegistryEntry
} from '../../utils/skills-panel'
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
 * registry and never touches tools, approvals, or `authorized`. The one config
 * edit it offers is the subsystem master switch, and only from the empty state.
 *
 * Two hazards shape the code below.
 *
 * 1. DOC_WRITE_INTERNAL_FILE carries no agent identity: it lands in whichever
 *    workspace main has open when it arrives. A ten-second catalog fetch can
 *    easily outlive the agent it started under, so every write captures the
 *    panel's agent (the open document's filePath) beforehand and is abandoned
 *    if the agent changed or a switch is in flight (see beginAgentSwitch).
 * 2. skills-state.json is read-modify-write, so two toggles racing lose one
 *    edit. All state writes are serialized through one promise chain, and the
 *    checkbox is optimistic with rollback so the UI never stalls on the IPC.
 */

interface FileEntry {
  path: string
  size: number
}

const NO_BUSY: ReadonlySet<string> = new Set()

/**
 * Guard for the async gap around a write. Returns the reason to abandon, or
 * null when the panel still owns the workspace it started in.
 */
function agentChanged(owner: string | null): string | null {
  if (isAgentSwitching()) return 'The open agent is switching — nothing was written.'
  if (useDocumentStore.getState().filePath !== owner) {
    return 'The open agent changed — nothing was written.'
  }
  return null
}

/**
 * Keep an open editor tab on a skills file honest.
 *
 * The tab store's external-write path is the reload mechanism; it is normally
 * driven by the runtime's `file_updated` event, which deliberately skips writes
 * Studio itself made (assemble-agent.ts) — so a tab showing skills-state.json
 * would sit on pre-toggle text until it was closed and reopened. Dirty tabs are
 * left alone: unsaved human edits outrank a refresh.
 */
function syncOpenTab(path: string, content: string | null | undefined): void {
  if (content == null) return
  const store = useEditorTabsStore.getState()
  const tab = store.tabs.find((t) => t.path === path)
  if (!tab || tab.kind !== 'file' || tab.isDirty || tab.content === content) return
  store.updateTabFromExternal(path, content)
}

export function SkillsPanel() {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)
  const setConfig = useAgentStore((s) => s.setConfig)
  const setAgentSubTab = useAppStore((s) => s.setAgentSubTab)

  const [files, setFiles] = useState<FileEntry[]>([])
  const [registry, setRegistry] = useState<ParsedRegistry | null>(null)
  const [registryBytes, setRegistryBytes] = useState(0)
  const [busy, setBusy] = useState<ReadonlySet<string>>(NO_BUSY)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)

  const skillsEnabled = config?.skills?.enabled ?? false
  const skillsLocked = config?.locked_fields?.includes('skills') ?? false

  /**
   * Pending mute/unmute the registry has not caught up with yet. The indexer is
   * debounced, so a refetch right after a toggle still reports the old value —
   * an override outranks the registry until the registry agrees with it, which
   * is what makes the checkbox instant instead of frozen for half a second.
   */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  // Blank rows are a half-finished edit in the config Section, not a source.
  const catalogs = useMemo(() => {
    const configured = (config?.skills?.catalogs ?? []).map((url) => url.trim()).filter(Boolean)
    return configured.length > 0 ? configured : [ADF_SKILLS_REGISTRY_URL]
  }, [config?.skills?.catalogs])

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
  }, [filePath, skillsEnabled, refresh])

  /**
   * Live updates. Every writer that is not Studio itself — the agent's fs_write,
   * skill_install, a lambda, the daemon, and the indexer's own registry write —
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
   * Every skills-state.json write runs here, one at a time. The file is edited
   * read-modify-write, so two overlapping toggles would otherwise each read the
   * pre-toggle document and the second write would erase the first.
   */
  const stateQueue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueueStateWrite = useCallback((task: () => Promise<string | null>): Promise<string | null> => {
    const run = stateQueue.current.then(task, task)
    stateQueue.current = run.then(() => undefined, () => undefined)
    return run
  }, [])

  /**
   * Mute or unmute by merging into skills-state.json — unknown keys and names
   * this panel cannot see (a package removed while muted) survive untouched.
   * The write itself triggers the reindex; the catalog arrives over the
   * `file_updated` push, and the checkbox does not wait for it.
   */
  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    const owner = useDocumentStore.getState().filePath
    setRowError(name, null)
    setOverrides((prev) => ({ ...prev, [name]: enabled }))
    markBusy(name, true)
    try {
      const error = await enqueueStateWrite(async () => {
        const blocked = agentChanged(owner)
        if (blocked) return blocked
        const stateFile = await window.adfApi?.readInternalFile(SKILLS_STATE_PATH)
        const blockedAfterRead = agentChanged(owner)
        if (blockedAfterRead) return blockedAfterRead
        const next = mergeDisabledList(stateFile?.content, name, enabled)
        const written = await window.adfApi?.writeInternalFile(SKILLS_STATE_PATH, next)
        if (!written?.success) return `Could not write ${SKILLS_STATE_PATH}.`
        syncOpenTab(SKILLS_STATE_PATH, next)
        return null
      })
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
  }, [enqueueStateWrite, later, markBusy, refresh, setRowError])

  /**
   * Install = write the package manifest; the indexer does the rest. The fetch
   * is remote and slow, so the agent identity captured up front is re-checked
   * after it before anything touches the VFS.
   */
  const handleInstall = useCallback(async (entry: SkillCatalogEntry): Promise<string | null> => {
    const owner = useDocumentStore.getState().filePath
    markBusy(entry.name, true)
    try {
      const pkg = await window.adfApi?.getSkillPackage(entry.raw_url)
      if (!pkg?.ok) return pkg?.error ?? 'Fetch failed'
      const blocked = agentChanged(owner)
      if (blocked) return blocked
      const path = `skills/${entry.name}/SKILL.md`
      const written = await window.adfApi?.writeInternalFile(path, pkg.content)
      if (!written?.success) return `Could not write ${path}.`
      syncOpenTab(path, pkg.content)
      await refresh()
      later(600, () => void refresh())
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      markBusy(entry.name, false)
    }
  }, [later, markBusy, refresh])

  /**
   * The one config edit this panel makes. Enabling reindexes synchronously in
   * main, but the write and two IPC round trips are not instant — so the
   * catalog is re-fetched on a short ladder rather than assumed to be there.
   */
  const handleEnableSkills = useCallback(async () => {
    if (skillsLocked || enabling) return
    const owner = useDocumentStore.getState().filePath
    const hadPackages = installedNames.size > 0
    setNotice(null)
    setEnabling(true)
    try {
      const authoritative = await window.adfApi?.getAgentConfig()
      if (!authoritative) {
        setNotice('Could not read the agent config — nothing was changed.')
        return
      }
      const blocked = agentChanged(owner)
      if (blocked) {
        setNotice(blocked)
        return
      }
      const updated = {
        ...authoritative,
        skills: { ...(authoritative.skills ?? {}), enabled: true }
      } as AgentConfigType
      const result = await window.adfApi?.setAgentConfig(updated)
      if (!result?.success) {
        // Refused (no workspace, or main switched agents underneath us) —
        // re-sync from the backend rather than showing state that never landed.
        const fresh = await window.adfApi?.getAgentConfig()
        if (fresh) setConfig(fresh as AgentConfigType)
        setNotice('Enabling skills was refused — the panel has been re-synced.')
        return
      }
      setConfig(updated)
      for (const delay of [300, 1000, 2500]) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (agentChanged(owner)) return
        if (await refresh()) return
      }
      if (hadPackages) {
        setNotice('Skills are on, but the catalog has not appeared yet. It is written on the next workspace change.')
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setEnabling(false)
    }
  }, [enabling, installedNames.size, refresh, setConfig, skillsLocked])

  const handleOpenRegistry = useCallback(async () => {
    const result = await window.adfApi?.readInternalFile(SKILLS_REGISTRY_PATH)
    if (result?.content != null) {
      useEditorTabsStore.getState().openTab(SKILLS_REGISTRY_PATH, result.binary ? '' : result.content, result.binary)
    }
  }, [])

  if (!filePath || !config) {
    return (
      <div className="p-4 text-sm text-neutral-400 dark:text-neutral-500 text-center mt-8">
        Open a file to view agent skills.
      </div>
    )
  }

  // --- Subsystem off: nothing is indexed and nothing is injected ---
  if (!skillsEnabled) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center max-w-xs">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Skills are off.</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1.5 leading-relaxed">
              With skills on, the runtime indexes every{' '}
              <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> in this agent and keeps
              the catalog in its prompt. Skills are instructions, never authority — enabling grants
              no tools, files, or approvals.
            </p>
            {installedNames.size > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                {installedNames.size} package{installedNames.size !== 1 ? 's' : ''} already installed
                and not being indexed.
              </p>
            )}
            {notice && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-2">{notice}</p>
            )}
            {skillsLocked ? (
              <p className="mt-4 text-xs text-amber-600 dark:text-amber-400">
                The Skills config section is locked. Unlock it there to turn skills on.
              </p>
            ) : (
              <button
                onClick={handleEnableSkills}
                disabled={enabling}
                className="mt-4 px-3 py-1.5 text-xs font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {enabling ? 'Enabling…' : 'Enable skills'}
              </button>
            )}
            <div className="mt-2">
              <button
                onClick={() => setAgentSubTab('config')}
                className="text-[11px] text-blue-500 dark:text-blue-400 hover:underline cursor-pointer"
              >
                Open the Skills config section
              </button>
            </div>
          </div>
        </div>
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
              Browse the catalog, or write a package into{' '}
              <span className="font-mono">skills/&lt;name&gt;/</span> yourself.
            </p>
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
            className={`border rounded-lg p-3 bg-white dark:bg-neutral-800 ${
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
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer" title={skill.enabled ? 'Mute this skill' : 'Unmute this skill'}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={busy.has(skill.name)}
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
              onClick={handleOpenRegistry}
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
        catalogs={catalogs}
        installedNames={installedNames}
        busy={busy}
        onInstall={handleInstall}
      />
    </div>
  )
}

/**
 * Catalog browser. Catalogs are fetched in the main process (the renderer's CSP
 * blocks remote origins) and merged first-wins, so an earlier catalog in the
 * list overrides a later one publishing the same name.
 *
 * Catalog text is remote data: names and descriptions are sanitized before they
 * are painted, so a bidi override in an upstream document cannot make an entry
 * claim to be something it is not.
 */
function CatalogDialog({
  open,
  onClose,
  catalogs,
  installedNames,
  busy,
  onInstall
}: {
  open: boolean
  onClose: () => void
  catalogs: string[]
  installedNames: Set<string>
  busy: ReadonlySet<string>
  onInstall: (entry: SkillCatalogEntry) => Promise<string | null>
}) {
  const [entries, setEntries] = useState<SkillCatalogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<{ url: string; error: string }[]>([])
  const [installError, setInstallError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setInstallError(null)
    void (async () => {
      const merged: SkillCatalogEntry[] = []
      const seen = new Set<string>()
      const failures: { url: string; error: string }[] = []
      try {
        for (const url of catalogs) {
          const result = await window.adfApi?.getSkillsCatalog(url)
          if (!result?.ok) {
            failures.push({ url, error: result?.error ?? 'Unavailable' })
            continue
          }
          for (const entry of result.entries) {
            if (seen.has(entry.name)) continue
            seen.add(entry.name)
            merged.push(entry)
          }
        }
      } catch (err) {
        // A throw here used to leave the dialog on "Loading catalog…" forever.
        failures.push({ url: 'catalog', error: err instanceof Error ? err.message : String(err) })
      } finally {
        if (!cancelled) {
          merged.sort((a, b) => a.name.localeCompare(b.name))
          setEntries(merged)
          setErrors(failures)
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [open, catalogs])

  return (
    <Dialog open={open} onClose={onClose} title="Skill catalog" wide>
      {loading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 py-6 text-center">
          Loading catalog…
        </p>
      ) : (
        <div className="space-y-2">
          {errors.map((failure) => (
            <div
              key={failure.url}
              className="border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-2.5"
            >
              <div className="text-[11px] text-amber-700 dark:text-amber-400">
                {sanitizeDisplayText(failure.error)} — {failure.url}
              </div>
            </div>
          ))}

          {installError && (
            <div className="border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded-lg p-2.5">
              <div className="text-[11px] text-red-600 dark:text-red-400">
                Install failed: {sanitizeDisplayText(installError)}
              </div>
            </div>
          )}

          {entries.length === 0 && errors.length === 0 && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 py-6 text-center">
              This catalog lists no skills.
            </p>
          )}

          {entries.map((entry) => {
            const installed = installedNames.has(entry.name)
            return (
              <div
                key={entry.name}
                className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 bg-white dark:bg-neutral-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300 font-mono">
                      {sanitizeDisplayText(entry.name)}
                    </div>
                    <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 leading-relaxed">
                      {sanitizeDisplayText(entry.description)}
                    </p>
                  </div>
                  {installed ? (
                    <span className="shrink-0 px-2 py-1 text-[10px] rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
                      installed
                    </span>
                  ) : (
                    <button
                      onClick={async () => {
                        setInstallError(null)
                        const error = await onInstall(entry)
                        if (error) setInstallError(error)
                      }}
                      disabled={busy.has(entry.name)}
                      className="shrink-0 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {busy.has(entry.name) ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
          Installing writes skills/&lt;name&gt;/SKILL.md — no tools, files, or approvals are granted.
        </span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
        >
          Close
        </button>
      </div>
    </Dialog>
  )
}
