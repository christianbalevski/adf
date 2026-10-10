/**
 * Sticky header for the agent config panel: it names the section in view and
 * opens a filterable, grouped list of every section to jump to. Sections
 * register themselves through ConfigNavContext, so sections that render
 * conditionally (Channels, MCP, Metadata) show up only when they are there.
 * A jump goes through `pendingConfigSection`, the same request the Overview
 * uses: the section expands, scrolls into view and takes focus.
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '../../stores/app.store'
import { configNavGroupOf, configNavItems } from './config-nav-model'

interface NavEntry {
  el: HTMLElement
  summary?: string
  locked?: boolean
}

interface ConfigNavRegistry {
  register: (title: string, entry: NavEntry) => () => void
}

const ConfigNavContext = createContext<ConfigNavRegistry | null>(null)

/** Registers a section with the nav. A no-op outside the panel (e.g. the template editor). */
export function useConfigNavEntry(title: unknown, ref: RefObject<HTMLElement | null>, summary: unknown, locked: boolean | undefined) {
  const registry = useContext(ConfigNavContext)
  const text = typeof summary === 'string' ? summary : undefined
  useEffect(() => {
    if (!registry || typeof title !== 'string' || !ref.current) return
    return registry.register(title, { el: ref.current, summary: text, locked })
  }, [registry, title, ref, text, locked])
}

/** The space the sticky header covers; sections scroll to just below it. */
export const CONFIG_NAV_OFFSET_CLASS = 'scroll-mt-11'

export function ConfigNavProvider({ scrollRef, children }: { scrollRef: RefObject<HTMLElement | null>; children: React.ReactNode }) {
  // Kept in a ref: summaries change on every edit and the nav only needs
  // them when the menu opens or the panel scrolls.
  const entries = useRef(new Map<string, NavEntry>())
  const [layoutTick, setLayoutTick] = useState(0)
  const registry = useMemo<ConfigNavRegistry>(() => ({
    register: (title, entry) => {
      entries.current.set(title, entry)
      setLayoutTick((n) => n + 1)
      return () => {
        if (entries.current.get(title) === entry) entries.current.delete(title)
        setLayoutTick((n) => n + 1)
      }
    }
  }), [])
  return (
    <ConfigNavContext.Provider value={registry}>
      <ConfigNavBar scrollRef={scrollRef} entries={entries} layoutTick={layoutTick} />
      {children}
    </ConfigNavContext.Provider>
  )
}

function ConfigNavBar({ scrollRef, entries, layoutTick }: {
  scrollRef: RefObject<HTMLElement | null>
  entries: RefObject<Map<string, NavEntry>>
  layoutTick: number
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  // A section just jumped to keeps the bar until the user scrolls: one near
  // the end can't reach the top, so the spy alone would name another.
  const pinned = useRef<string | null>(null)

  // Scroll-spy: the current section is the last one whose top has reached
  // the bottom of the sticky bar; at the very bottom, the last section.
  const measure = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller || pinned.current) return
    const line = scroller.getBoundingClientRect().top + (barRef.current?.offsetHeight ?? 0) + 8
    let best: { title: string; top: number } | null = null
    let first: { title: string; top: number } | null = null
    for (const [title, { el }] of entries.current) {
      const top = el.getBoundingClientRect().top
      if (!first || top < first.top) first = { title, top }
      if (top <= line && (!best || top > best.top)) best = { title, top }
    }
    const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
    if (atBottom) {
      let last: { title: string; top: number } | null = null
      for (const [title, { el }] of entries.current) {
        const top = el.getBoundingClientRect().top
        if (!last || top > last.top) last = { title, top }
      }
      best = last
    }
    setCurrent((best ?? first)?.title ?? null)
  }, [scrollRef, entries])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    const unpin = () => { pinned.current = null }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', unpin, { passive: true })
    scroller.addEventListener('touchmove', unpin, { passive: true })
    scroller.addEventListener('keydown', unpin)
    scroller.addEventListener('pointerdown', unpin)
    // Sections collapsing or expanding move everything below them.
    const ro = new ResizeObserver(onScroll)
    for (const child of Array.from(scroller.children)) ro.observe(child)
    onScroll()
    return () => {
      cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', unpin)
      scroller.removeEventListener('touchmove', unpin)
      scroller.removeEventListener('keydown', unpin)
      scroller.removeEventListener('pointerdown', unpin)
      ro.disconnect()
    }
  }, [scrollRef, measure, layoutTick])

  const items = useMemo(
    () => (open ? configNavItems([...entries.current.keys()], query) : []),
    // layoutTick: sections appearing or leaving while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, query, layoutTick]
  )
  useEffect(() => { setActive(0) }, [query])

  const close = useCallback(() => { setOpen(false); setQuery('') }, [])
  const jump = useCallback((title: string) => {
    close()
    pinned.current = title
    setCurrent(title)
    useAppStore.getState().setPendingConfigSection(title)
  }, [close])

  // "/" anywhere in the panel, outside a text field, opens the menu.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return
      e.preventDefault()
      setOpen(true)
    }
    scroller.addEventListener('keydown', onKey)
    return () => scroller.removeEventListener('keydown', onKey)
  }, [scrollRef])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it) jump(it.title) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  const group = current ? configNavGroupOf(current) : null

  return (
    <div ref={barRef} className="sticky top-0 z-20 border-b border-hairline bg-surface-0">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] hover:bg-[var(--adf-ui-accent-subtle)]"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {group && <span className="text-neutral-400 dark:text-neutral-500">{group}</span>}
        {group && <span className="text-neutral-300 dark:text-neutral-600">›</span>}
        <span className="truncate font-medium text-[var(--adf-ui-text)]">{current ?? 'Sections'}</span>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <kbd className="ml-auto rounded border border-hairline px-1 font-sans text-[10px] leading-4 text-neutral-400 dark:text-neutral-500">/</kbd>
      </button>
      {open && (
        <div className="absolute inset-x-2 top-full mt-1 rounded-lg border border-hairline bg-surface-0 shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Jump to a section…"
            className="w-full border-b border-hairline bg-transparent px-3 py-2 text-xs outline-none placeholder:text-neutral-400"
          />
          <div ref={listRef} role="listbox" className="max-h-[60vh] overflow-y-auto py-1">
            {items.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-neutral-400 dark:text-neutral-500">No section matches.</p>
            )}
            {items.map((it, i) => {
              const entry = entries.current.get(it.title)
              const showGroup = i === 0 || items[i - 1].group !== it.group
              return (
                <div key={it.title}>
                  {showGroup && (
                    <div className={`px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500 ${i === 0 ? 'pt-1' : 'pt-2'}`}>
                      {it.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => jump(it.title)}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${i === active ? 'bg-[var(--adf-ui-accent-subtle)]' : ''}`}
                  >
                    <span className={`shrink-0 ${it.title === current ? 'font-medium text-[var(--adf-ui-text)]' : 'text-neutral-600 dark:text-neutral-300'}`}>{it.title}</span>
                    {entry?.locked && (
                      <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        className="shrink-0 text-amber-500 dark:text-amber-400" aria-label="Locked">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    )}
                    {entry?.summary && (
                      <span className="ml-auto min-w-0 truncate text-[10px] text-neutral-400 dark:text-neutral-500">{entry.summary}</span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
