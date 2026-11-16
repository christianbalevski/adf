import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '../../../stores/app.store'
import {
  CATALOG_PAGE_SIZE,
  browserResults,
  configuredBrowserSources,
  settleBrowserSource,
  toCatalogSourceResult,
  buildCatalogCards,
  catalogSourceLabel,
  filterCatalogCards,
  normalizeCatalogSources,
  sanitizeDisplayText,
  type BrowserSource,
  type CatalogCard,
  type CatalogSourceResult,
  type LoadedManifestName
} from '../../../../shared/utils/skills-panel'
import { Dialog } from '../../common/Dialog'
import { openApi } from '../../../utils/runtime-api'
import { captureAgentView } from '../../../utils/agent-view'
import { installFromCard, manifestName, toManifestState, type InstallOutcome, type InstallRequest, type ManifestState, type PreparedInstall } from '../../../utils/skill-install'
import { CatalogCardView } from './CatalogCardView'
import { ReplaceConfirm } from './ReplaceConfirm'
import { SkillPreview } from './SkillPreview'

/**
 * Catalog browser over the sources configured in Settings → Skills.
 *
 * The source list is an APP preference (Settings → Skills), not agent config:
 * the dialog reads `skillCatalogSources` each time it opens and fetches every
 * source concurrently in the main process, since the renderer's CSP blocks
 * remote origins. Catalog entries merge first-wins by name in LIST ORDER.
 *
 * A GitHub source lists packages straight from the repository tree, pinned to one
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
export function CatalogDialog({
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
   * The configured sources in precedence order, managed only in Settings.
   * `null` until the configured list has been read.
   */
  const [sources, setSources] = useState<BrowserSource[] | null>(null)
  const [query, setQuery] = useState('')
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
  /** Manifest loads waiting or running, so a URL is fetched once. */
  const queueRef = useRef<{ waiting: string[]; running: number; known: Set<string> }>({ waiting: [], running: 0, known: new Set() })

  /** Fetch one configured source into its row for this dialog session. */
  const fetchSource = useCallback(async (url: string) => {
    const session = sessionRef.current
    let result: CatalogSourceResult
    try {
      result = toCatalogSourceResult(url, await openApi()?.getSkillsCatalog(url))
    } catch (err) {
      result = { url, ok: false, entries: [], error: err instanceof Error ? err.message : String(err) }
    }
    if (session === sessionRef.current) setSources((prev) => (prev ? settleBrowserSource(prev, url, result) : prev))
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
    setPageSize(CATALOG_PAGE_SIZE)
    sessionRef.current++
    const session = sessionRef.current
    queueRef.current = { waiting: [], running: 0, known: new Set() }
    void (async () => {
      const stored = (await openApi()?.getSettings?.()) as unknown as
        { skillCatalogSources?: unknown } | undefined
      if (session !== sessionRef.current) return
      const rows = configuredBrowserSources(normalizeCatalogSources(stored?.skillCatalogSources))
      setSources(rows)
      for (const row of rows) void fetchSource(row.url)
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
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPageSize(CATALOG_PAGE_SIZE) }}
                spellCheck={false}
                aria-label="Search skills"
                placeholder="Search skills…"
                className="w-full px-2 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
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
                  {sources.map(({ url, result }) => (
                    <span
                      key={url}
                      title={
                        result?.ok
                          ? `${url}${result.dropped ? ` — ${result.dropped} entr${result.dropped === 1 ? 'y' : 'ies'} dropped as invalid` : ''}`
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
