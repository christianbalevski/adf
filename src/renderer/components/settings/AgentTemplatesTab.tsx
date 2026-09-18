import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConfig as AgentConfigType } from '../../../shared/types/adf-v02.types'
import type {
  AgentTemplateContents,
  AgentTemplateSummary,
  ProviderConfig,
  ShippedTemplateId,
} from '../../../shared/types/ipc.types'
import { useTemplates, useTemplatesStore } from '../../hooks/useTemplates'
import { useAppStore } from '../../stores/app.store'
import { AgentConfig } from '../agent/AgentConfig'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { Dialog } from '../common/Dialog'
import { Button, IconButton, Select, SettingsGroup, SettingsRow, TextInput, Textarea } from '../ui'

/**
 * Settings > Agent templates.
 *
 * A template is an ordinary .adf file in <userData>/templates; this tab lists
 * the folder and edits one template at a time in place. Every edit is a write
 * to that file through main (config, seed files, extra files), debounced so
 * typing does not write per keystroke and flushed when the selection changes
 * or the tab unmounts. The list re-reads itself whenever main reports the
 * folder changed, and the contents are re-read after each write returns.
 */

/** Shown first, in this order, whatever the folder listing says. */
const SHIPPED_ORDER: ShippedTemplateId[] = ['standard', 'sandboxed', 'full-access']

/** The rule instantiate follows, printed for the user verbatim. */
const INSTANTIATE_RULE = 'New agents get everything in a template except its identity and history.'

const SAVE_DEBOUNCE_MS = 400

type SeedKey = 'readme' | 'mind' | 'soul'

const SEED_FILES: { key: SeedKey; path: string; rows: number }[] = [
  { key: 'readme', path: 'README.md', rows: 6 },
  { key: 'mind', path: 'mind.md', rows: 10 },
  { key: 'soul', path: 'soul.md', rows: 8 },
]

/** File stems accept letters, digits, dashes, underscores and spaces. Main validates too. */
const NAME_RULE = /^[A-Za-z0-9 _-]+$/
const NAME_HINT = 'Use letters, digits, dashes, underscores and spaces.'

function sortTemplates(list: AgentTemplateSummary[]): AgentTemplateSummary[] {
  const shipped = SHIPPED_ORDER
    .map((id) => list.find((t) => t.shipped === id))
    .filter((t): t is AgentTemplateSummary => !!t)
  const rest = list
    .filter((t) => !t.shipped)
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...shipped, ...rest]
}

/** A copy's proposed name, trimmed to the characters a file stem accepts. */
function copyName(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9 _-]/g, '').trim()
  return `${stem || 'template'} copy`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Tag({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'warning'; children: React.ReactNode }) {
  const tones = {
    neutral: 'border-[var(--adf-ui-border)] text-[var(--adf-ui-text-muted)]',
    accent: 'border-[var(--adf-ui-accent)]/40 bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)]',
    warning: 'border-[var(--adf-ui-warning)]/40 bg-[var(--adf-ui-warning-subtle)] text-[var(--adf-ui-warning)]',
  } as const
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** Amber caution mark, shown beside a template's warning. */
function WarningTriangle() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
      <path d="M12 4 2.5 20h19L12 4z" />
      <path d="M12 10v4M12 17.2v.01" />
    </svg>
  )
}

function TemplateGlyph({ name, icon }: { name: string; icon?: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] text-[13px]">
      {icon || (name || '?').charAt(0).toUpperCase()}
    </span>
  )
}

interface AgentTemplatesTabProps {
  providers: ProviderConfig[]
  /** settings.defaultProviderId — persisted by SettingsPage's auto-save. */
  defaultProviderId: string | undefined
  onDefaultProviderChange: (id: string | undefined) => void
}

export function AgentTemplatesTab({ providers, defaultProviderId, onDefaultProviderChange }: AgentTemplatesTabProps) {
  const { templates, folder, defaultId, migrated, loaded } = useTemplates()
  const sorted = useMemo(() => sortTemplates(templates), [templates])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contents, setContents] = useState<AgentTemplateContents | null>(null)
  const [contentsError, setContentsError] = useState<string | null>(null)
  const [loadingContents, setLoadingContents] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; template: AgentTemplateSummary } | null>(null)
  const [newName, setNewName] = useState<string | null>(null)
  const [newNameError, setNewNameError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string; was: string } | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [notes, setNotes] = useState<{ description: string; warning: string }>({ description: '', warning: '' })
  const [metaError, setMetaError] = useState<string | null>(null)
  const notesRef = useRef(notes)
  const notesFor = useRef<string | null>(null)

  // settings.childTemplateId ('' = none) — written immediately, not debounced.
  const [childTemplateId, setChildTemplateId] = useState('')
  useEffect(() => {
    let cancelled = false
    void window.adfApi.getSettings().then((settings) => {
      if (!cancelled) setChildTemplateId(settings?.childTemplateId ?? '')
    }).catch(() => { /* leave it on None */ })
    return () => { cancelled = true }
  }, [])
  const pickChildTemplate = (id: string) => {
    setChildTemplateId(id)
    void window.adfApi.setSettings({ childTemplateId: id })
  }

  // --- debounced writes -----------------------------------------------------
  // One pending write per key (config, or one per file path). A local edit is
  // "dirty" until its write lands, and a re-read never overwrites a dirty
  // editor.
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>())
  const dirty = useRef(false)

  const flushPending = useCallback(() => {
    const queued = [...pending.current.values()]
    pending.current.clear()
    for (const entry of queued) {
      clearTimeout(entry.timer)
      entry.run()
    }
  }, [])

  const schedule = useCallback((key: string, run: () => void) => {
    const existing = pending.current.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      pending.current.delete(key)
      run()
    }, SAVE_DEBOUNCE_MS)
    pending.current.set(key, { timer, run })
  }, [])

  useEffect(() => () => { flushPending() }, [flushPending])

  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  const refreshContents = useCallback(async (id: string) => {
    try {
      const res = await window.adfApi.getTemplateContents(id)
      // The selection may have moved while this was in flight; a stale answer
      // must not replace what is on screen.
      if (selectedIdRef.current !== id) return
      if (res?.success && res.contents) {
        setContents(res.contents)
        setContentsError(null)
      } else {
        setContentsError(res?.error || 'This template could not be read.')
      }
    } catch (err) {
      if (selectedIdRef.current === id) {
        setContentsError(err instanceof Error ? err.message : 'This template could not be read.')
      }
    }
  }, [])

  const runWrite = useCallback(async (id: string, op: () => Promise<{ success: boolean; error?: string }>) => {
    try {
      const res = await op()
      if (!res?.success) {
        setWriteError(res?.error || 'The template could not be saved.')
        return
      }
      setWriteError(null)
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : 'The template could not be saved.')
      return
    }
    // Re-read once the queue has drained, so the editor shows what is on disk
    // without clobbering an edit the user is still making.
    if (pending.current.size === 0 && selectedIdRef.current === id) {
      dirty.current = false
      await refreshContents(id)
    }
  }, [refreshContents])

  // --- selection ------------------------------------------------------------
  const select = useCallback((id: string | null) => {
    flushPending()
    dirty.current = false
    setWriteError(null)
    setContentsError(null)
    setSelectedId(id)
    // Kept in step here, not only at the next render: the fetch below resolves
    // against this ref and must not be judged stale by a not-yet-rendered id.
    selectedIdRef.current = id
    setContents(null)
    if (!id) return
    setLoadingContents(true)
    void window.adfApi.getTemplateContents(id)
      .then((res) => {
        if (selectedIdRef.current !== id) return
        if (res?.success && res.contents) setContents(res.contents)
        else setContentsError(res?.error || 'This template could not be read.')
      })
      .catch((err: unknown) => {
        if (selectedIdRef.current === id) {
          setContentsError(err instanceof Error ? err.message : 'This template could not be read.')
        }
      })
      .finally(() => {
        if (selectedIdRef.current === id) setLoadingContents(false)
      })
  }, [flushPending])

  // The selected template left the folder (deleted here or elsewhere).
  useEffect(() => {
    if (!loaded || !selectedId) return
    if (!templates.some((t) => t.id === selectedId)) {
      setSelectedId(null)
      setContents(null)
    }
  }, [templates, loaded, selectedId])

  // Folder changed on disk: re-read the open template unless it has unsaved edits.
  useEffect(() => {
    const off = window.adfApi.onTemplatesChanged(() => {
      const id = selectedIdRef.current
      if (!id || dirty.current || pending.current.size > 0) return
      void refreshContents(id)
    })
    return off
  }, [refreshContents])

  // --- editor writes --------------------------------------------------------
  const setSeedFile = (id: string, key: SeedKey, path: string, content: string) => {
    dirty.current = true
    setContents((prev) => (prev ? { ...prev, files: { ...prev.files, [key]: content } } : prev))
    schedule(`file:${path}`, () => {
      void runWrite(id, () => window.adfApi.setTemplateFile({ id, path, content }))
    })
  }

  // Template notes live in the file's meta, not in its contents, so they are
  // written on their own and their errors are reported on their own row.
  const setMeta = (id: string, patch: Partial<{ description: string; warning: string }>) => {
    const next = { ...notesRef.current, ...patch }
    notesRef.current = next
    setNotes(next)
    schedule('meta', () => {
      void (async () => {
        try {
          const res = await window.adfApi.setTemplateMeta({ id, description: next.description, warning: next.warning })
          setMetaError(res?.success ? null : res?.error || 'The notes could not be saved.')
        } catch (err) {
          setMetaError(err instanceof Error ? err.message : 'The notes could not be saved.')
        }
      })()
    })
  }

  const setConfig = (id: string, next: AgentConfigType) => {
    dirty.current = true
    setContents((prev) => (prev ? { ...prev, config: next } : prev))
    schedule('config', () => {
      void runWrite(id, () => window.adfApi.setTemplateConfig({ id, config: next }))
    })
  }

  const addFiles = async (id: string) => {
    setAdding(true)
    try {
      const res = await window.adfApi.addTemplateFiles(id)
      if (!res.success) {
        if (res.error && res.error !== 'Cancelled') setWriteError(res.error)
      } else {
        setWriteError(null)
        await refreshContents(id)
      }
    } finally {
      setAdding(false)
    }
  }

  const removeFile = async (id: string, path: string) => {
    await runWrite(id, () => window.adfApi.removeTemplateFile({ id, path }))
    await refreshContents(id)
  }

  // --- list actions ---------------------------------------------------------
  const refreshList = useCallback(() => useTemplatesStore.getState().refresh(), [])

  const act = useCallback(async (op: () => Promise<{ success: boolean; error?: string } | void>) => {
    setListError(null)
    setBusy(true)
    try {
      const res = await op()
      if (res && res.success === false) {
        setListError(res.error || 'That did not work.')
        return false
      }
      await refreshList()
      return true
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'That did not work.')
      return false
    } finally {
      setBusy(false)
    }
  }, [refreshList])

  const createTemplate = async (name: string, fromId?: string) => {
    setListError(null)
    setBusy(true)
    try {
      const res = await window.adfApi.createTemplate({ name, fromId })
      if (!res.success) {
        setListError(res.error || 'The template could not be created.')
        return
      }
      setNewName(null)
      setNewNameError(null)
      await refreshList()
      if (res.id) select(res.id)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'The template could not be created.')
    } finally {
      setBusy(false)
    }
  }

  const submitNewName = () => {
    const name = (newName ?? '').trim()
    if (!name) {
      setNewNameError('Give the template a name.')
      return
    }
    if (!NAME_RULE.test(name)) {
      setNewNameError(NAME_HINT)
      return
    }
    void createTemplate(name)
  }

  const reviewTemplate = async (t: AgentTemplateSummary) => {
    setListError(null)
    try {
      const review = await window.adfApi.checkTemplateReview(t.id)
      if (review.needsReview && review.configSummary) {
        useAppStore.getState().openTemplateReview(t.id, review.configSummary, () => { void refreshList() })
      } else {
        await refreshList()
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'This template could not be read.')
    }
  }

  const submitRename = async () => {
    if (!renaming) return
    const name = renaming.name.trim()
    if (!name) {
      setRenameError('Give the template a name.')
      return
    }
    if (!NAME_RULE.test(name)) {
      setRenameError(NAME_HINT)
      return
    }
    if (name === renaming.was) {
      setRenaming(null)
      return
    }
    setRenameError(null)
    // A rename moves the file, so anything queued against the old id has to
    // land first.
    flushPending()
    setBusy(true)
    try {
      const res = await window.adfApi.renameTemplate({ id: renaming.id, name })
      if (!res.success) {
        setRenameError(res.error || 'The template could not be renamed.')
        return
      }
      setRenaming(null)
      await refreshList()
      // The id is the file stem, so a rename moves it: follow the new one.
      if (res.id) select(res.id)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'The template could not be renamed.')
    } finally {
      setBusy(false)
    }
  }

  const menuItems = (t: AgentTemplateSummary): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        label: 'Rename…',
        onSelect: () => { setRenameError(null); setRenaming({ id: t.id, name: t.name, was: t.name }) },
      },
      {
        label: 'Make default',
        disabled: t.id === defaultId,
        onSelect: () => { void act(() => window.adfApi.setDefaultTemplate(t.id)) },
      },
      {
        label: 'Duplicate',
        onSelect: () => { void createTemplate(copyName(t.name), t.id) },
      },
      {
        label: 'Reveal in Finder',
        onSelect: () => { void window.adfApi.revealTemplate(t.id) },
      },
    ]
    if (t.shipped) {
      const shipped = t.shipped
      items.push({
        label: 'Reset to shipped',
        separatorBefore: true,
        onSelect: () => {
          if (!window.confirm(`Reset "${t.name}" to the version Studio ships? Your changes to it are lost.`)) return
          void act(() => window.adfApi.resetShippedTemplate(shipped))
        },
      })
    }
    items.push({
      label: 'Delete',
      danger: true,
      separatorBefore: !t.shipped,
      onSelect: () => {
        if (!window.confirm(`Delete "${t.name}"? The file goes to the trash.`)) return
        void act(() => window.adfApi.deleteTemplate(t.id))
      },
    })
    return items
  }

  const dismissMigration = async () => {
    await window.adfApi.templatesMigrationSeen()
    await refreshList()
  }

  const selected = selectedId ? sorted.find((t) => t.id === selectedId) ?? null : null

  // Notes come from the list summary, not from the contents read. Seeded once
  // per selection, so a list refresh never overwrites what is being typed.
  useEffect(() => {
    const id = selected?.id ?? null
    if (notesFor.current === id) return
    notesFor.current = id
    const next = { description: selected?.templateDescription ?? '', warning: selected?.warning ?? '' }
    notesRef.current = next
    setNotes(next)
    setMetaError(null)
  }, [selected])

  return (
    <>
      {migrated && (
        <div className="flex items-start justify-between gap-3 rounded-[var(--adf-ui-container-radius)] border border-hairline bg-[var(--adf-ui-surface)] px-4 py-3">
          <p className="text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
            Your previous template was saved as {templates.find((t) => t.id === migrated.id)?.name ?? migrated.id}.
          </p>
          <Button onClick={() => void dismissMigration()} variant="ghost" size="compact" className="shrink-0">
            Dismiss
          </Button>
        </div>
      )}

      <SettingsGroup
        title="Templates"
        description="Every agent you create starts from one of these. Pick one to edit it."
      >
        {!loaded ? (
          <p className="px-4 pb-3 text-[12px] text-[var(--adf-ui-text-subtle)]">Loading templates…</p>
        ) : sorted.length === 0 ? (
          <p className="px-4 pb-3 text-[12px] text-[var(--adf-ui-text-subtle)]">No templates in the folder.</p>
        ) : (
          <ul>
            {sorted.map((t) => {
              const isSelected = t.id === selectedId
              return (
                <li
                  key={t.id}
                  className={`flex items-center gap-2 border-t border-[var(--adf-ui-separator)] px-4 py-2.5 ${
                    isSelected ? 'bg-[var(--adf-ui-surface-hover)]' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => select(isSelected ? null : t.id)}
                    aria-expanded={isSelected}
                    title={t.filePath}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--adf-ui-control-radius)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)]"
                  >
                    <TemplateGlyph name={t.name} icon={t.icon} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-[var(--adf-ui-text)]">{t.name}</span>
                        {t.shipped && <Tag>Shipped</Tag>}
                        {t.id === defaultId && <Tag tone="accent">Default</Tag>}
                        {!t.reviewed && <Tag tone="warning">Not reviewed</Tag>}
                      </span>
                      {(t.templateDescription ?? t.description) && (
                        <span className="mt-0.5 block truncate text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">
                          {t.templateDescription ?? t.description}
                        </span>
                      )}
                      {t.warning && (
                        <span className="mt-0.5 flex items-center gap-1 text-[12px] leading-5 text-[var(--adf-ui-warning)]">
                          <WarningTriangle />
                          <span className="min-w-0 truncate">{t.warning}</span>
                        </span>
                      )}
                    </span>
                  </button>
                  {t.hasHistory && (
                    <span
                      className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]"
                      title="This file has run. New agents start with no history either way."
                    >
                      Has run
                    </span>
                  )}
                  {!t.reviewed && (
                    <Button onClick={() => void reviewTemplate(t)} size="compact" className="shrink-0">
                      Review
                    </Button>
                  )}
                  <IconButton
                    aria-label={`Actions for ${t.name}`}
                    title="Actions"
                    disabled={busy}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ x: r.left, y: r.bottom + 2, template: t })
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="12" cy="19" r="1.6" />
                    </svg>
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}

        <div className="border-t border-[var(--adf-ui-separator)] px-4 py-3">
          {newName === null ? (
            <Button onClick={() => { setNewName(''); setNewNameError(null) }} variant="ghost" size="compact" disabled={busy}>
              New template…
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Template name"
                value={newName}
                autoFocus
                spellCheck={false}
                placeholder="Template name"
                onChange={(e) => { setNewName(e.target.value); setNewNameError(null) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submitNewName() }
                  if (e.key === 'Escape') { e.preventDefault(); setNewName(null); setNewNameError(null) }
                }}
                className="h-[var(--adf-ui-control-height-compact)] w-56 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-2.5 text-[12px] text-[var(--adf-ui-text)] outline-none focus:border-[var(--adf-ui-accent)] focus:ring-2 focus:ring-[var(--adf-ui-focus)]"
              />
              <Button onClick={submitNewName} size="compact" variant="primary" disabled={busy}>
                Create
              </Button>
              <Button onClick={() => { setNewName(null); setNewNameError(null) }} size="compact" variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </div>
          )}
          {newNameError && <p className="mt-1.5 text-[11px] text-[var(--adf-ui-danger)]">{newNameError}</p>}
          {listError && <p className="mt-1.5 text-[11px] text-[var(--adf-ui-danger)]" role="alert">{listError}</p>}
          <p className="mt-2 text-[11px] leading-5 text-[var(--adf-ui-text-subtle)]">{INSTANTIATE_RULE}</p>
          {folder && (
            <p className="mt-0.5 break-all text-[11px] leading-5 text-[var(--adf-ui-text-subtle)]">
              Templates folder: {folder}
            </p>
          )}
        </div>
      </SettingsGroup>

      {selected && (
        <>
          <SettingsGroup
            title={`Files in ${selected.name}`}
            description="Starting content for a new agent's files."
          >
            {loadingContents && !contents && (
              <p className="px-4 pb-3 text-[12px] text-[var(--adf-ui-text-subtle)]">Loading…</p>
            )}
            {contentsError && (
              <p className="px-4 pb-3 text-[12px] text-[var(--adf-ui-danger)]" role="alert">{contentsError}</p>
            )}
            {contents && (
              <>
                {SEED_FILES.map((f, i) => (
                  <SettingsRow key={f.key} label={f.path} description="Starting content." stacked separator={i > 0}>
                    <Textarea
                      aria-label={f.path}
                      value={contents.files[f.key] ?? ''}
                      onChange={(e) => setSeedFile(selected.id, f.key, f.path, e.target.value)}
                      rows={f.rows}
                      className="font-mono text-xs resize-y"
                    />
                  </SettingsRow>
                ))}
                <SettingsRow
                  label="Extra files"
                  description="Copied into every new agent."
                  stacked
                  separator
                  error={writeError}
                >
                  {contents.extra.length > 0 && (
                    <ul className="flex flex-col gap-1.5">
                      {contents.extra.map((f) => (
                        <li key={f.path} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--adf-ui-text)]">{f.path}</span>
                          <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-[var(--adf-ui-text-subtle)]">
                            {formatSize(f.size)}
                          </span>
                          <Button
                            onClick={() => void removeFile(selected.id, f.path)}
                            variant="ghost"
                            size="compact"
                            aria-label={`Remove ${f.path}`}
                            title="Remove"
                            className="shrink-0 px-2"
                          >
                            ×
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className={contents.extra.length > 0 ? 'mt-2' : ''}>
                    <Button onClick={() => void addFiles(selected.id)} variant="ghost" size="compact" disabled={adding}>
                      {adding ? 'Adding…' : 'Add files…'}
                    </Button>
                  </div>
                </SettingsRow>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup
            title="Template notes"
            description="Shown wherever this template is offered. Neither line is copied into agents made from it."
          >
            <SettingsRow label="Description" stacked>
              <TextInput
                aria-label="Template description"
                spellCheck={false}
                placeholder="What this template is for. Shown in the list and the composer chip."
                value={notes.description}
                onChange={(e) => setMeta(selected.id, { description: e.target.value })}
              />
            </SettingsRow>
            <SettingsRow label="Warning" stacked separator error={metaError}>
              <TextInput
                aria-label="Template warning"
                spellCheck={false}
                placeholder="A caution shown in amber wherever this template is offered."
                value={notes.warning}
                onChange={(e) => setMeta(selected.id, { warning: e.target.value })}
              />
            </SettingsRow>
          </SettingsGroup>

          {contents && (
            <AgentConfig
              key={selected.id}
              template={{ value: contents.config, onChange: (next) => setConfig(selected.id, next) }}
            />
          )}
        </>
      )}

      <SettingsGroup title="Applies to" description="Agents you create in Studio always start from a template.">
        <SettingsRow
          label="Template for agents created by agents"
          description="Agents made with sys_create_adf start from this template, without its credentials or identity. A parent that names a template .adf of its own uses that instead."
        >
          <Select
            aria-label="Template for agents created by agents"
            className="w-64"
            value={childTemplateId}
            onChange={(e) => pickChildTemplate(e.target.value)}
          >
            <option value="">None (code defaults)</option>
            {sorted.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
            {/* A template that left the folder still shows, so the setting is not read as None. */}
            {childTemplateId && !sorted.some((t) => t.id === childTemplateId) && (
              <option value={childTemplateId}>{childTemplateId} (not in the folder)</option>
            )}
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Default provider" description="Used when the template leaves Provider unset. Its default model fills Model ID.">
        <SettingsRow label="Default provider">
          {providers.length === 0 ? (
            <span className="text-[12px] text-[var(--adf-ui-text-subtle)]">No providers configured.</span>
          ) : (
            <Select
              aria-label="Default provider"
              className="w-64"
              value={defaultProviderId ?? ''}
              onChange={(e) => onDefaultProviderChange(e.target.value || undefined)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.type}</option>
              ))}
            </Select>
          )}
        </SettingsRow>
      </SettingsGroup>

      <ContextMenu
        position={menu ? { x: menu.x, y: menu.y } : null}
        items={menu ? menuItems(menu.template) : []}
        onClose={() => setMenu(null)}
      />

      <Dialog
        open={!!renaming}
        onClose={() => { setRenaming(null); setRenameError(null) }}
        title="Rename template"
        lightDismiss={false}
      >
        <div className="space-y-3">
          <TextInput
            aria-label="Template name"
            autoFocus
            spellCheck={false}
            placeholder="Template name"
            value={renaming?.name ?? ''}
            onChange={(e) => {
              const value = e.target.value
              setRenaming((prev) => (prev ? { ...prev, name: value } : prev))
              setRenameError(null)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitRename() } }}
          />
          <p className="text-[11px] leading-5 text-[var(--adf-ui-text-subtle)]">
            {NAME_HINT} This renames the file and the agent name inside it.
          </p>
          {renameError && <p className="text-[11px] text-[var(--adf-ui-danger)]" role="alert">{renameError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => { setRenaming(null); setRenameError(null) }}
              variant="ghost"
              size="compact"
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void submitRename()} variant="primary" size="compact" disabled={busy}>
              Rename
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
