import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useEditorTabsStore } from '../../stores/editor-tabs.store'
import { ADF_SKILLS_REGISTRY_URL } from '../../../shared/constants/adf-defaults'
import type { SkillCatalogEntry } from '../../../shared/schemas/skills-catalog.schema'
import type { AgentConfig as AgentConfigType } from '../../../shared/types/adf-v02.types'
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
 */

const SKILLS_REGISTRY_PATH = 'skills-registry.json'
const SKILLS_STATE_PATH = 'skills-state.json'
/** Matches a skill package manifest — kept in sync with the indexer's own pattern. */
const SKILL_MANIFEST = /^skills\/([^/]+)\/SKILL\.md$/

interface FileEntry {
  path: string
  size: number
}

interface RegistryEntry {
  name: string
  description?: string
  path: string
  enabled: boolean
}

/** Tolerant read of the derived catalog. A registry we can't parse is treated as absent. */
function parseRegistry(text: string | null): RegistryEntry[] | null {
  if (!text) return null
  try {
    const doc = JSON.parse(text) as { schema?: unknown; skills?: unknown }
    if (doc?.schema !== 1 || typeof doc.skills !== 'object' || doc.skills === null) return null
    const entries: RegistryEntry[] = []
    for (const value of Object.values(doc.skills as Record<string, unknown>)) {
      const skill = value as Partial<RegistryEntry>
      if (typeof skill?.name !== 'string' || typeof skill?.path !== 'string') continue
      entries.push({
        name: skill.name,
        description: typeof skill.description === 'string' ? skill.description : undefined,
        path: skill.path,
        enabled: skill.enabled !== false
      })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return null
  }
}

/** Read the mute list out of skills-state.json. A corrupt state file mutes nothing. */
function parseDisabled(text: string | null): string[] {
  if (!text) return []
  try {
    const doc = JSON.parse(text) as { schema?: unknown; disabled?: unknown }
    if (doc?.schema !== 1 || !Array.isArray(doc.disabled)) return []
    return doc.disabled.filter((n: unknown): n is string => typeof n === 'string')
  } catch {
    return []
  }
}

/** Rough prompt cost of the injected catalog — bytes are all the panel can see. */
function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4)
}

export function SkillsPanel() {
  const filePath = useDocumentStore((s) => s.filePath)
  const config = useAgentStore((s) => s.config)
  const setConfig = useAgentStore((s) => s.setConfig)
  const setAgentSubTab = useAppStore((s) => s.setAgentSubTab)

  const [files, setFiles] = useState<FileEntry[]>([])
  const [registry, setRegistry] = useState<RegistryEntry[] | null>(null)
  const [disabled, setDisabled] = useState<string[]>([])
  const [registryBytes, setRegistryBytes] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)

  const skillsEnabled = config?.skills?.enabled ?? false
  // Blank rows are a half-finished edit in the config Section, not a source.
  const catalogs = useMemo(() => {
    const configured = (config?.skills?.catalogs ?? []).map((url) => url.trim()).filter(Boolean)
    return configured.length > 0 ? configured : [ADF_SKILLS_REGISTRY_URL]
  }, [config?.skills?.catalogs])

  const refresh = useCallback(async () => {
    const listed = await window.adfApi?.getInternalFiles()
    const fileList = listed?.files ?? []
    setFiles(fileList)
    setRegistryBytes(fileList.find((f) => f.path === SKILLS_REGISTRY_PATH)?.size ?? 0)
    const [registryFile, stateFile] = await Promise.all([
      window.adfApi?.readInternalFile(SKILLS_REGISTRY_PATH),
      window.adfApi?.readInternalFile(SKILLS_STATE_PATH)
    ])
    setRegistry(parseRegistry(registryFile?.content ?? null))
    setDisabled(parseDisabled(stateFile?.content ?? null))
  }, [])

  useEffect(() => {
    void refresh()
  }, [filePath, skillsEnabled, refresh])

  /** Installed packages as the VFS sees them — the ground truth the indexer reads. */
  const installedNames = useMemo(() => {
    const names = new Set<string>()
    for (const file of files) {
      const match = SKILL_MANIFEST.exec(file.path)
      if (match) names.add(match[1])
    }
    return names
  }, [files])

  /**
   * A package is on disk but absent from the derived catalog. The indexer keeps
   * its rejection reasons in memory only, so the panel reports the fact and the
   * three things that cause it rather than inventing a reason.
   */
  const unindexed = useMemo(() => {
    if (!registry) return []
    const indexed = new Set(registry.map((s) => s.name))
    return [...installedNames].filter((name) => !indexed.has(name)).sort()
  }, [installedNames, registry])

  const disabledCount = registry?.filter((s) => !s.enabled).length ?? 0

  /**
   * Mute or unmute by rewriting skills-state.json. Read-modify-write so a list
   * naming skills this panel can't see (a package removed while muted) survives.
   * The write itself triggers the reindex — hence the settle delay before the
   * refetch rather than any explicit sync call.
   */
  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    setBusy(name)
    const stateFile = await window.adfApi?.readInternalFile(SKILLS_STATE_PATH)
    const current = new Set(parseDisabled(stateFile?.content ?? null))
    if (enabled) current.delete(name)
    else current.add(name)
    const next = { schema: 1, disabled: [...current].sort() }
    await window.adfApi?.writeInternalFile(SKILLS_STATE_PATH, JSON.stringify(next, null, 2) + '\n')
    // The indexer debounces ~250ms; wait past it so the refetch sees the new catalog.
    setTimeout(() => {
      void refresh().finally(() => setBusy(null))
    }, 450)
  }, [refresh])

  /** Install = write the package manifest. The indexer does the rest. */
  const handleInstall = useCallback(async (entry: SkillCatalogEntry) => {
    setBusy(entry.name)
    try {
      const pkg = await window.adfApi?.getSkillPackage(entry.raw_url)
      if (!pkg?.ok) return pkg?.error ?? 'Fetch failed'
      await window.adfApi?.writeInternalFile(`skills/${entry.name}/SKILL.md`, pkg.content)
      await new Promise((resolve) => setTimeout(resolve, 450))
      await refresh()
      return null
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const handleEnableSkills = useCallback(async () => {
    const authoritative = await window.adfApi?.getAgentConfig()
    if (!authoritative) return
    const updated = {
      ...authoritative,
      skills: { ...(authoritative.skills ?? {}), enabled: true }
    } as AgentConfigType
    setConfig(updated)
    await window.adfApi?.setAgentConfig(updated)
    await refresh()
  }, [setConfig, refresh])

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
            <button
              onClick={handleEnableSkills}
              className="mt-4 px-3 py-1.5 text-xs font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg cursor-pointer"
            >
              Enable skills
            </button>
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

  const skills = registry ?? []

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

      {/* Installed list */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {skills.length === 0 && unindexed.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">No skills installed.</p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              Browse the catalog, or write a package into{' '}
              <span className="font-mono">skills/&lt;name&gt;/</span> yourself.
            </p>
          </div>
        )}

        {skills.map((skill) => (
          <div
            key={skill.name}
            className={`border rounded-lg p-3 bg-white dark:bg-neutral-800 ${
              skill.enabled
                ? 'border-neutral-200 dark:border-neutral-700'
                : 'border-neutral-200 dark:border-neutral-700 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300 font-mono truncate">
                  {skill.name}
                </div>
                {skill.enabled ? (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 leading-relaxed">
                    {skill.description ?? <span className="italic">no description</span>}
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-1 italic">
                    muted — description removed from context
                  </p>
                )}
                <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 font-mono truncate" title={skill.path}>
                  {skill.path}
                </div>
              </div>
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer" title={skill.enabled ? 'Mute this skill' : 'Unmute this skill'}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={busy === skill.name}
                  onChange={(e) => handleToggle(skill.name, e.target.checked)}
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
        {unindexed.map((name) => (
          <div
            key={name}
            className="border border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10 rounded-lg p-3"
          >
            <div className="text-xs font-medium text-amber-700 dark:text-amber-400 font-mono truncate">
              {name}
            </div>
            <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-1 leading-relaxed">
              not indexed — check the frontmatter <span className="font-mono">name</span> matches the
              folder, that <span className="font-mono">description</span> is one line under 500
              characters, and that the file is under 256 KB.
            </p>
            <div className="text-[10px] text-amber-500 dark:text-amber-600 mt-1 font-mono truncate">
              skills/{name}/SKILL.md
            </div>
          </div>
        ))}

        {registry === null && installedNames.size > 0 && (
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500 py-2 text-center">
            The catalog hasn&apos;t been generated yet — it appears on the next workspace write.
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-neutral-200 dark:border-neutral-700 px-3 py-2 flex items-center gap-2">
        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
          {skills.length} skill{skills.length !== 1 ? 's' : ''}, {disabledCount} muted
          {registryBytes > 0 && ` · ~${estimateTokens(registryBytes)} tokens`}
        </span>
        <div className="flex-1" />
        {registryBytes > 0 && (
          <button
            onClick={handleOpenRegistry}
            className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer"
          >
            Open skills-registry.json
          </button>
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
  busy: string | null
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
      if (cancelled) return
      merged.sort((a, b) => a.name.localeCompare(b.name))
      setEntries(merged)
      setErrors(failures)
      setLoading(false)
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
                {failure.error} — {failure.url}
              </div>
            </div>
          ))}

          {installError && (
            <div className="border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded-lg p-2.5">
              <div className="text-[11px] text-red-600 dark:text-red-400">Install failed: {installError}</div>
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
                      {entry.name}
                    </div>
                    <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 leading-relaxed">
                      {entry.description}
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
                      disabled={busy !== null}
                      className="shrink-0 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {busy === entry.name ? 'Installing…' : 'Install'}
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
