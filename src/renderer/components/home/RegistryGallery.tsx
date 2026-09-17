import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useAppStore } from '../../stores/app.store'
import type { AgentRegistryAgentView, AgentRegistryGetResult } from '../../../shared/types/ipc.types'

/**
 * Per-agent hue (sRGB channels, space separated so CSS can do
 * `rgb(var(--h) / a)`). Assigned by position so the gallery reads as a set
 * of distinct things rather than six copies of one card; stable across
 * renders because the registry order is stable.
 */
const HUES = [
  '37 99 235',   // blue
  '124 58 237',  // violet
  '5 150 105',   // emerald
  '217 119 6',   // amber
  '225 29 72',   // rose
  '8 145 178',   // cyan
]

/**
 * The registry: the .adf files bundled with this build plus whatever the
 * live index lists beyond them. "Add" copies the file into the
 * agents folder and opens it; the review dialog takes it from there,
 * exactly as for a file someone sent.
 */
/**
 * `grid` (first-run home): every card, three across, `limit` with "Show all".
 * `carousel` (dashboard): the same full cards in one horizontally scrolling
 * row with snap points and chevrons, so the registry keeps its detail while
 * taking one row of the dashboard.
 */
export function RegistryGallery({ mode = 'grid', limit, onCount }: { mode?: 'grid' | 'carousel'; limit?: number; onCount?: (n: number) => void }) {
  const carousel = mode === 'carousel'
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canScroll, setCanScroll] = useState({ left: false, right: false })

  const updateScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    setCanScroll({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    })
  }, [])

  const scrollByPage = useCallback((dir: -1 | 1) => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(200, el.clientWidth - 80), behavior: 'smooth' })
  }, [])

  const { openFile } = useAdfFile()
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const [registry, setRegistry] = useState<AgentRegistryGetResult | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.adfApi?.getAgentRegistry()
      .then((r) => { if (!cancelled) { setRegistry(r); onCount?.(r.agents.length) } })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyToAgents = useCallback(async (agent: AgentRegistryAgentView) => {
    setBusyId(agent.id)
    setActionError(null)
    try {
      const result = await window.adfApi.bringHomeRegistryAgent(agent.id)
      if (!result.success || !result.filePath) {
        setActionError(result.error ?? 'Could not copy the agent')
        return
      }
      setShowMeshGraph(false)
      await openFile(result.filePath)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [openFile, setShowMeshGraph])

  const retryRemote = useCallback(async () => {
    setRetrying(true)
    try {
      const r = await window.adfApi.refreshAgentRegistry()
      setRegistry(r)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetrying(false)
    }
  }, [])

  // Chevrons follow the scroll position and the window width.
  useEffect(() => {
    if (!carousel) return
    const el = scrollerRef.current
    if (!el) return
    updateScroll()
    el.addEventListener('scroll', updateScroll, { passive: true })
    const ro = new ResizeObserver(updateScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScroll)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carousel, registry])

  const gridClass = carousel
    ? 'registry-carousel flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1'
    : 'grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-3'

  if (loadError) {
    return <p className="text-[12px] text-[var(--adf-ui-danger)]">Registry unavailable: {loadError}</p>
  }
  if (!registry) {
    return (
      <div className={gridClass}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${carousel ? 'w-[250px] shrink-0' : ''} h-44 animate-pulse rounded-2xl border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)]`} />
        ))}
      </div>
    )
  }
  if (registry.agents.length === 0) {
    return <p className="text-[12px] text-[var(--adf-ui-text-subtle)]">No agents in the registry yet.</p>
  }

  const hidden = limit && !showAll ? Math.max(0, registry.agents.length - limit) : 0
  const visible = hidden > 0 ? registry.agents.slice(0, limit) : registry.agents

  return (
    <div className="space-y-3">
      <div className="relative">
        <div ref={scrollerRef} className={gridClass}>
          {visible.map((agent, i) => (
            <RegistryCard
              key={agent.id}
              agent={agent}
              index={i}
              hue={HUES[i % HUES.length]}
              carousel={carousel}
              busy={busyId === agent.id}
              disabled={busyId !== null}
              onCopy={() => copyToAgents(agent)}
            />
          ))}
        </div>
        {carousel && canScroll.left && (
          <CarouselChevron side="left" onClick={() => scrollByPage(-1)} />
        )}
        {carousel && canScroll.right && (
          <CarouselChevron side="right" onClick={() => scrollByPage(1)} />
        )}
      </div>
      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll(true)} className="text-[12px] text-[var(--adf-ui-accent)] hover:underline">
          Show all ({registry.agents.length})
        </button>
      )}
      {actionError && <p className="text-[12px] text-[var(--adf-ui-danger)]">{actionError}</p>}
      {registry.remoteError && !carousel && (
        <p className="text-[11px] text-[var(--adf-ui-text-subtle)]">
          Bundled agents only — live registry unavailable ({registry.remoteError}).{' '}
          <button
            type="button"
            onClick={retryRemote}
            disabled={retrying}
            className="text-[var(--adf-ui-accent)] hover:underline disabled:opacity-60"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </p>
      )}
    </div>
  )
}

function capabilityChips(agent: AgentRegistryAgentView): string[] {
  const c = agent.capabilities
  if (!c) return []
  // Most distinctive first: channels and skills differ between agents, the
  // tool count barely does, so it is the one that fades if the row is tight.
  const chips: string[] = []
  for (const ch of c.channels) chips.push(ch)
  if (c.skills > 0) chips.push(`${c.skills} skill${c.skills === 1 ? '' : 's'}`)
  if (c.code) chips.push('code')
  if (c.tools > 0) chips.push(`${c.tools} tools`)
  return chips
}

function CarouselChevron({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Scroll left' : 'Scroll right'}
      className={`absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] text-[var(--adf-ui-text-muted)] shadow-md transition-colors hover:text-[var(--adf-ui-text)] ${side === 'left' ? '-left-3' : '-right-3'}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {side === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
      </svg>
    </button>
  )
}

function RegistryCard({ agent, index, hue, carousel, busy, disabled, onCopy }: {
  agent: AgentRegistryAgentView
  index: number
  hue: string
  carousel: boolean
  busy: boolean
  disabled: boolean
  onCopy: () => void
}) {
  const style = { '--h': hue, '--i': index } as React.CSSProperties
  const addLabel = busy ? 'Adding…' : 'Add'
  const chips = capabilityChips(agent)

  return (
    <div style={style} className={`registry-card group relative flex flex-col rounded-2xl p-4 ${carousel ? 'w-[250px] shrink-0 snap-start' : ''}`}>
      <div className="registry-glow pointer-events-none absolute inset-0 rounded-2xl" aria-hidden />
      <div className="relative flex items-start gap-3">
        <span className="registry-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-[26px] leading-none" aria-hidden>
          {agent.icon ?? '📄'}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-[15px] font-semibold tracking-tight text-[var(--adf-ui-text)]">{agent.name}</div>
          {agent.tags.length > 0 && (
            <div className="mt-0.5 truncate text-[11px] text-[var(--adf-ui-text-subtle)]">{agent.tags.join(' · ')}</div>
          )}
        </div>
      </div>
      <p className="registry-blurb relative mt-3 text-[12.5px] leading-relaxed text-[var(--adf-ui-text-muted)]">{agent.blurb}</p>
      {chips.length > 0 && (
        <div className="registry-chips relative mt-3 flex flex-nowrap gap-1 overflow-hidden">
          {chips.map((chip) => (
            <span key={chip} className="registry-chip shrink-0 whitespace-nowrap rounded-md px-[5px] py-0.5 text-[10px] font-medium">{chip}</span>
          ))}
        </div>
      )}
      <div className="relative mt-auto flex items-center justify-between gap-2 pt-4">
        <span className="truncate font-mono text-[10.5px] text-[var(--adf-ui-text-subtle)]">
          {agent.file}{agent.source === 'remote' ? ' · download' : ''}
        </span>
        {agent.supported ? (
          <button type="button" onClick={onCopy} disabled={disabled} className="registry-add h-7 shrink-0 rounded-full px-3.5 text-[12px] font-medium">
            {addLabel}
          </button>
        ) : (
          <span className="text-[11px] text-[var(--adf-ui-text-subtle)]">Needs ADF Studio {agent.min_app_version}</span>
        )}
      </div>
    </div>
  )
}
