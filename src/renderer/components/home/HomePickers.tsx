import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { resolveTemplate, useTemplates } from '../../hooks/useTemplates'
import type { AgentTemplateSummary } from '../../../shared/types/ipc.types'
import { catalogEntryForProvider } from '../../../shared/constants/provider-catalog'
import { BrandMark } from '../common/BrandMark'
import { Tooltip } from '../common/Tooltip'
import { providerDotClass, providerStatusLabel } from '../providers/provider-status'
import { useHomeProviders } from './HomeProviders'

/* ------------------------------------------------------------------------ */
/* Popover                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * A small menu that opens upward from a chip in the composer footer. Closes
 * on outside press or Escape. Items are plain buttons; the caller decides
 * what they do.
 */
function Popover({ open, onClose, children, align = 'left' }: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      role="menu"
      className={`absolute bottom-full z-20 mb-1.5 min-w-[220px] max-w-[340px] rounded-lg border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-1 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      {children}
    </div>
  )
}

function MenuItem({ onClick, selected, children, muted }: {
  onClick: () => void
  selected?: boolean
  muted?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-[var(--adf-ui-surface-hover)] ${muted ? 'text-[var(--adf-ui-text-muted)]' : 'text-[var(--adf-ui-text)]'} ${selected ? 'bg-[var(--adf-ui-accent-subtle)]' : ''}`}
    >
      {children}
    </button>
  )
}

function MenuRule() {
  return <div className="my-1 border-t border-[var(--adf-ui-separator)]" />
}

const chipClass = 'inline-flex h-6 min-w-0 max-w-[200px] items-center gap-1 rounded-full border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] pl-1 pr-2 text-[11.5px] text-[var(--adf-ui-text)] transition-colors hover:border-[var(--adf-ui-accent)]'

function Caret() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--adf-ui-text-subtle)]" aria-hidden>
      <path d="m18 15-6-6-6 6" />
    </svg>
  )
}

/* ------------------------------------------------------------------------ */
/* Template                                                                  */
/* ------------------------------------------------------------------------ */

/** Shipped templates lead the menu, in the order Studio ships them. */
const SHIPPED_ORDER: Record<string, number> = { standard: 0, sandboxed: 1, 'full-access': 2 }

function templateRank(t: AgentTemplateSummary): number {
  return t.shipped ? SHIPPED_ORDER[t.shipped] ?? 3 : 100
}

/**
 * The template the next new agent is built from, as a chip in the composer
 * footer. New agents get everything in a template except its identity and
 * history. Picking one also pre-fills the provider chip with the template's
 * provider and model when that provider is configured here, so what the chips
 * show is what the agent starts on. Templates are files in the templates
 * folder; "Manage templates…" opens Settings → Agent templates.
 */
export function TemplatePickerChip() {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const homeTemplateId = useAppStore((s) => s.homeTemplateId)
  const setHomeTemplateId = useAppStore((s) => s.setHomeTemplateId)
  const setHomeModelId = useAppStore((s) => s.setHomeModelId)
  const { templates, defaultId, loaded } = useTemplates()
  const { providers, setHomeProviderId } = useHomeProviders()
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  const pick = useCallback((t: AgentTemplateSummary) => {
    setHomeTemplateId(t.id === defaultId ? null : t.id)
    // The template's provider only carries over when this Studio has it;
    // otherwise the chip falls back to the app default with no model.
    if (t.modelProvider && providers.some((p) => p.id === t.modelProvider)) {
      setHomeProviderId(t.modelProvider)
      setHomeModelId(t.modelId ?? null)
    } else {
      setHomeProviderId(null)
      setHomeModelId(null)
    }
    closeMenu()
  }, [closeMenu, defaultId, providers, setHomeModelId, setHomeProviderId, setHomeTemplateId])

  if (!loaded) {
    return <span className="inline-block h-6 w-32 animate-pulse rounded-full bg-[var(--adf-ui-surface-raised)]" aria-busy="true" />
  }

  const current = resolveTemplate(templates, defaultId, homeTemplateId)
  if (!current) return null

  const ordered = [...templates].sort((a, b) => templateRank(a) - templateRank(b) || a.name.localeCompare(b.name))

  return (
    <div className="relative">
      <Tooltip tip={current.description ?? `New agents start from ${current.name}, with a new identity and no history.`}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Start from: ${current.name}`}
          className={chipClass}
        >
          <TemplateIcon />
          <span className="shrink-0 text-[var(--adf-ui-text-muted)]">Start from</span>
          <span className="min-w-0 truncate">{current.name}</span>
          <Caret />
        </button>
      </Tooltip>
      <Popover open={menuOpen} onClose={closeMenu}>
        {ordered.map((t) => (
          <MenuItem key={t.id} selected={t.id === current.id} onClick={() => pick(t)}>
            <TemplateIcon />
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {t.reviewed === false && <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]">Not reviewed</span>}
            {t.id === defaultId && <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]">default</span>}
          </MenuItem>
        ))}
        <MenuRule />
        <MenuItem muted onClick={() => { closeMenu(); openSettingsAt('template') }}>
          <TemplateIcon />
          Manage templates…
        </MenuItem>
      </Popover>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Provider                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The provider and model the next new agent starts on, as a chip in the
 * composer footer. The menu groups the configured providers with their
 * status and lists each one's models underneath, then "Add provider…" (the
 * Settings picker, in place) and a gear that opens Settings → Providers.
 * Model lists are fetched the first time the menu opens; until one arrives
 * the group offers the provider's default model alone. The list and the
 * modal belong to HomeProvidersProvider, shared with the connect card. With
 * nothing configured the chip reads "Connect a provider" and opens the
 * picker straight away.
 */
export function ProviderPickerChip() {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  const homeModelId = useAppStore((s) => s.homeModelId)
  const setHomeModelId = useAppStore((s) => s.setHomeModelId)
  const { providers, loaded, status, selectedId, selected, setHomeProviderId, models, fetchModels, openPicker } = useHomeProviders()
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  // One fetch per provider per session: opening the menu asks for whatever is
  // still missing, and a provider that failed keeps its error rather than
  // retrying on every open.
  const asked = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!menuOpen) return
    for (const p of providers) {
      if (models[p.id] || asked.current.has(p.id)) continue
      asked.current.add(p.id)
      void fetchModels(p.id)
    }
  }, [menuOpen, providers, models, fetchModels])

  const pickModel = useCallback((p: { id: string; defaultModel?: string }, model: string | null) => {
    setHomeProviderId(p.id)
    setHomeModelId(model && model !== p.defaultModel ? model : null)
    closeMenu()
  }, [closeMenu, setHomeModelId, setHomeProviderId])

  if (!loaded) {
    return <span className="inline-block h-7 w-28 animate-pulse rounded-full bg-[var(--adf-ui-surface-raised)]" aria-busy="true" />
  }

  if (!selected) {
    return (
      <>
        <button
          type="button"
          onClick={openPicker}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--adf-ui-accent)] bg-[var(--adf-ui-accent-subtle)] px-2 text-[11.5px] font-medium text-[var(--adf-ui-accent)] transition-colors hover:bg-[var(--adf-ui-accent)] hover:text-white dark:hover:text-neutral-950"
        >
          <PlusIcon />
          Connect a provider
        </button>
      </>
    )
  }

  const entry = catalogEntryForProvider(selected)
  const label = selected.name || entry?.label || selected.type
  const st = status[selected.id]
  const model = homeModelId ?? selected.defaultModel ?? null

  return (
    <div className="relative">
      <Tooltip tip={`${providerStatusLabel(st)}${model ? ` · ${model}` : ''}`}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={model ? `Provider: ${label}, model: ${model}` : `Provider: ${label}`}
          className={chipClass}
        >
          <BrandMark iconKey={entry?.iconKey} label={label} size={16} />
          <span className="min-w-0 truncate">{label}</span>
          {model && (
            <>
              <span className="shrink-0 text-[var(--adf-ui-text-subtle)]" aria-hidden>·</span>
              <span className="min-w-0 truncate text-[var(--adf-ui-text-muted)]">{model}</span>
            </>
          )}
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${providerDotClass(st)}`} aria-hidden />
          <Caret />
        </button>
      </Tooltip>
      <Popover open={menuOpen} onClose={closeMenu}>
        {providers.map((p) => {
          const e = catalogEntryForProvider(p)
          const name = p.name || e?.label || p.type
          const state = models[p.id]
          const current = p.id === selectedId ? homeModelId ?? p.defaultModel ?? null : null
          // A model the provider no longer lists (a template's pick, say) is
          // still shown, so the chip's model always has a row to match.
          const fetched = state?.models ?? []
          const list = current && fetched.length > 0 && !fetched.includes(current) ? [current, ...fetched] : fetched
          return (
            <div key={p.id}>
              <div className="flex items-center gap-2 px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-[var(--adf-ui-text-muted)]">
                <BrandMark iconKey={e?.iconKey} label={name} size={16} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${providerDotClass(status[p.id])}`} aria-hidden />
              </div>
              {list.length > 0 ? (
                list.map((mo) => (
                  <MenuItem key={mo} selected={current === mo} onClick={() => pickModel(p, mo)}>
                    <span className="min-w-0 flex-1 truncate pl-6">{mo}</span>
                    {mo === p.defaultModel && <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]">default</span>}
                  </MenuItem>
                ))
              ) : (
                <Tooltip
                  className="block"
                  tip={state?.error
                    ? `Could not list models: ${state.error}`
                    : state?.loading
                      ? 'Loading the model list.'
                      : p.defaultModel
                        ? `Uses ${p.defaultModel}, the provider's default model.`
                        : "Uses the provider's default model."}
                >
                  <MenuItem selected={p.id === selectedId && !homeModelId} onClick={() => pickModel(p, null)}>
                    <span className="min-w-0 flex-1 truncate pl-6">Default model</span>
                    {state?.loading && <span className="shrink-0 text-[11px] text-[var(--adf-ui-text-subtle)]">loading…</span>}
                  </MenuItem>
                </Tooltip>
              )}
            </div>
          )
        })}
        <MenuRule />
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <MenuItem muted onClick={() => { closeMenu(); openPicker() }}>
              <PlusIcon />
              Add provider…
            </MenuItem>
          </div>
          <Tooltip tip="Provider settings">
            <button
              type="button"
              onClick={() => { closeMenu(); openSettingsAt('providers') }}
              aria-label="Provider settings"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--adf-ui-text-subtle)] transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]"
            >
              <GearIcon />
            </button>
          </Tooltip>
        </div>
      </Popover>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Folder                                                                    */
/* ------------------------------------------------------------------------ */

function folderName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * Where the next new agent's file goes: the agents folder by default, any
 * tracked folder from the menu, or one chosen with the native dialog. The
 * choice lasts for the session; the default itself is set in Settings.
 */
export function FolderPickerChip() {
  const homeFolder = useAppStore((s) => s.homeFolder)
  const setHomeFolder = useAppStore((s) => s.setHomeFolder)
  const directories = useTrackedDirsStore((s) => s.directories)
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  useEffect(() => {
    let cancelled = false
    window.adfApi.getDefaultAgentsFolder().then((r) => { if (!cancelled) setDefaultFolder(r.path) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const current = homeFolder ?? defaultFolder
  const options = Array.from(new Set([defaultFolder, ...directories].filter((d): d is string => !!d)))

  const chooseOther = async () => {
    closeMenu()
    try {
      const r = await window.adfApi.pickDirectory()
      if (r.path) setHomeFolder(r.path)
    } catch { /* dialog dismissed */ }
  }

  return (
    <div className="relative">
      <Tooltip tip={current ?? 'Agents folder'}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Folder: ${current ? folderName(current) : 'agents folder'}`}
          className={chipClass}
        >
          <FolderIcon />
          <span className="truncate">{current ? folderName(current) : 'Agents folder'}</span>
          <Caret />
        </button>
      </Tooltip>
      <Popover open={menuOpen} onClose={closeMenu}>
        {options.map((dir) => (
          <MenuItem key={dir} selected={dir === current} onClick={() => { setHomeFolder(dir === defaultFolder ? null : dir); closeMenu() }}>
            <FolderIcon />
            <span className="min-w-0 flex-1 truncate">{folderName(dir)}</span>
            {dir === defaultFolder && <span className="text-[11px] text-[var(--adf-ui-text-subtle)]">default</span>}
          </MenuItem>
        ))}
        {homeFolder && !options.includes(homeFolder) && (
          <MenuItem selected onClick={closeMenu}>
            <FolderIcon />
            <span className="min-w-0 flex-1 truncate">{folderName(homeFolder)}</span>
          </MenuItem>
        )}
        <MenuRule />
        <MenuItem muted onClick={() => { void chooseOther() }}>
          <FolderIcon />
          Choose folder…
        </MenuItem>
      </Popover>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Icons                                                                     */
/* ------------------------------------------------------------------------ */

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function TemplateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--adf-ui-text-muted)]" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--adf-ui-text-muted)]" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}
