import { useCallback, useRef, useState } from 'react'
import type { EditorTab } from '../../stores/editor-tabs.store'
import { useAppStore } from '../../stores/app.store'
import { Tooltip } from '../common/Tooltip'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { useKeyboardContextMenu } from '../../hooks/useKeyboardContextMenu'

/**
 * The chat's stage tab, when the Loops panel is placed in the center. Pinned
 * first — it is a slot, not a document — so it carries no path and stays out of
 * the editor-tabs store entirely. Closing it does not destroy anything: the
 * chat goes back to the right dock, which is the only other place it can live.
 */
export interface ChatTabProps {
  active: boolean
  /** Some loop logged something while the tab wasn't the one showing. */
  unread: boolean
  onSelect: () => void
  /** Sends the chat back to the side dock — the X, and Ctrl+W on this tab. */
  onClose?: () => void
}

interface Props {
  tabs: EditorTab[]
  activeTabPath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onReload?: (path: string) => void
  chatTab?: ChatTabProps
  /** The tab's right-click menu. `rename` turns the tab's label into a path field. */
  menuItems?: (tab: EditorTab, rename: () => void) => ContextMenuItem[]
  /** Commit a rename from the tab's path field; false keeps the field open. */
  onRename?: (from: string, to: string) => Promise<boolean>
}

/**
 * Tab chrome, VS Code style. The bar is one recessed surface; its bottom
 * hairline is an absolutely positioned sibling under the tabs rather than a
 * border, so the selected tab (opaque, content-coloured, z-above) covers it
 * and opens straight into the content below. The active tab is ink text with
 * a quiet ink-faint mark on its TOP edge, drawn as an inset shadow (a border
 * would shift the tab's height); no blue fill. Focus rings
 * are drawn inset: the file strip scrolls horizontally, and an outset ring
 * gets clipped to a stray vertical bar at the tab's edge.
 */
const TAB_BASE =
  'group relative z-10 flex items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:[outline-offset:-2px]'
const TAB_ACTIVE =
  'bg-surface-1 text-[var(--adf-ui-text)] shadow-[inset_0_2px_0_0_var(--adf-ui-text-subtle)]'
const TAB_IDLE =
  'text-[var(--adf-ui-text-muted)] hover:bg-neutral-500/10 hover:text-[var(--adf-ui-text)]'
const TAB_ICON_BUTTON =
  'w-4 h-4 flex items-center justify-center rounded-sm hover:bg-neutral-500/20'

function CloseGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="1" y1="1" x2="7" y2="7" />
      <line x1="7" y1="1" x2="1" y2="7" />
    </svg>
  )
}

/** The tab's label as a path field: Enter renames, Escape or leaving it cancels. */
function RenameField({ path, onCommit, onCancel }: { path: string; onCommit: (to: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState(path)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const commit = async () => {
    const to = value.trim()
    if (!to || to === path) return onCancel()
    setBusy(true)
    const done = await onCommit(to)
    setBusy(false)
    if (done) onCancel()
    else input.current?.focus()
  }
  return (
    <input
      ref={input}
      autoFocus
      value={value}
      readOnly={busy}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      aria-label={`New path for ${path}`}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => {
        // Select the name without its extension, as a file manager does.
        const name = path.lastIndexOf('/') + 1
        const dot = path.lastIndexOf('.')
        e.currentTarget.setSelectionRange(name, dot > name ? dot : path.length)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') void commit()
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => { if (!busy) onCancel() }}
      className="w-[220px] bg-surface-1 border border-[var(--adf-ui-border)] rounded-sm px-1 py-0.5 text-xs text-[var(--adf-ui-text)] outline-none"
    />
  )
}

export function TabBar({ tabs, activeTabPath, onSelect, onClose, onReload, chatTab, menuItems, onRename }: Props) {
  const computerMatchTab = useAppStore((s) => s.computerMatchTab)
  const setComputerMatchTab = useAppStore((s) => s.setComputerMatchTab)
  const [menu, setMenu] = useState<{ tab: EditorTab; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // One handler pair for the strip: the tab is the one under the pointer, or
  // (Shift+F10 / the Menu key, which carry no target) the focused one.
  const tabMenu = useKeyboardContextMenu(useCallback((e: React.MouseEvent) => {
    const byKey = !(e.target instanceof Element)
    const el = (byKey ? document.activeElement : e.target as Element)?.closest<HTMLElement>('[data-tab-path]')
    const tab = tabs.find((t) => t.path === el?.dataset.tabPath)
    if (!el || !tab || !menuItems) return
    e.preventDefault()
    e.stopPropagation()
    // The hook places a key-opened menu under the strip's start; it belongs under the tab.
    const r = el.getBoundingClientRect()
    setMenu({ tab, x: byKey ? r.left + 12 : e.clientX, y: byKey ? r.bottom : e.clientY })
  }, [tabs, menuItems]))
  if (tabs.length === 0 && !chatTab) return null

  return (
    <div className="relative flex h-9 items-stretch bg-surface-0 shrink-0">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-hairline" />
      {chatTab && (
        <>
          {/* Pinned outside the scroller: with many files open the file strip
              scrolls under it and Loops stays put. */}
          <button
            type="button"
            onClick={chatTab.onSelect}
            title="Agent loops"
            className={`${TAB_BASE} shrink-0 ${chatTab.active ? TAB_ACTIVE : TAB_IDLE}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Loops</span>
            {/* Aggregate across every loop — per-loop detail stays on the strip.
                Occupies the same slot the file tabs give their dirty dot, so the
                pinned tab lines up with the rest of the bar. */}
            <span
              aria-hidden
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                chatTab.unread && !chatTab.active ? 'bg-blue-500' : 'bg-transparent'
              }`}
            />
            {/* The same X the file tabs carry, in the same slot: on a tab bar,
                "close" is the one gesture the user should not have to relearn.
                Here it means "put the chat back in the side dock". */}
            {chatTab.onClose && <span
              onClick={(e) => {
                e.stopPropagation()
                chatTab.onClose?.()
              }}
              title="Close tab and show loops in the side panel"
              className={`ml-1 ${TAB_ICON_BUTTON} ${
                chatTab.active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
              }`}
            >
              <CloseGlyph />
            </span>}
          </button>
          <span aria-hidden className="relative z-10 w-px shrink-0 self-stretch bg-hairline" />
        </>
      )}
      {/* A scrollbar gutter would shorten only the file tabs, misaligning
          them with Loops. Keep horizontal scrolling without reserving height. */}
      <div
        className="scrollbar-none flex flex-1 min-w-0 items-stretch overflow-x-auto overflow-y-hidden"
        onContextMenu={tabMenu.onContextMenu}
        onKeyDown={tabMenu.onKeyDown}
      >
        {tabs.map((tab) => {
          const isActive = tab.path === activeTabPath
          const isBrowser = tab.kind === 'browser'
          const fileName = isBrowser ? 'Computer' : tab.path.split('/').pop() ?? tab.path
          // Not the port: the viewer follows the container, the tab's meta may not.
          const hoverTitle = isBrowser ? 'Agent computer' : tab.path

          // A tab being renamed holds a text field, which a <button> cannot.
          const Tab = renaming === tab.path ? 'div' : 'button'
          return (
            <Tab
              key={tab.path}
              data-tab-path={tab.path}
              onClick={() => onSelect(tab.path)}
              onMouseDown={(e) => {
                // Middle-click closes tab
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.path)
                }
              }}
              className={`${TAB_BASE} shrink-0 border-r border-hairline ${isActive ? TAB_ACTIVE : TAB_IDLE}`}
            >
              {renaming === tab.path && onRename ? (
                <RenameField path={tab.path} onCommit={(to) => onRename(tab.path, to)} onCancel={() => setRenaming(null)} />
              ) : (
                <span className="truncate max-w-[150px]" title={hoverTitle}>{fileName}</span>
              )}
              {isBrowser && (
                <Tooltip tip={computerMatchTab
                  ? "Match tab size is on: the agent's screen resizes to fill this tab. Click to keep the agent's size and scale it to fit."
                  : "Match tab size: resize the agent's screen to fill this tab. Off, the screen keeps the size the agent set, scaled to fit."}>
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      setComputerMatchTab(!computerMatchTab)
                    }}
                    aria-pressed={computerMatchTab}
                    className={`${TAB_ICON_BUTTON} ${
                      computerMatchTab
                        ? 'opacity-100 text-[var(--adf-ui-accent)]'
                        : isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
                    }`}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  </span>
                </Tooltip>
              )}
              {isBrowser && onReload && (
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    onReload(tab.path)
                  }}
                  title="Reload viewer"
                  className={`${TAB_ICON_BUTTON} ${
                    isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
                  }`}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <polyline points="21 3 21 9 15 9" />
                  </svg>
                </span>
              )}
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.isDirty ? 'bg-[var(--adf-ui-text-muted)]' : 'bg-transparent'}`} />
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.path)
                }}
                className={`ml-1 ${TAB_ICON_BUTTON} ${
                  isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
                }`}
              >
                <CloseGlyph />
              </span>
            </Tab>
          )
        })}
      </div>
      <ContextMenu
        position={menu ? { x: menu.x, y: menu.y } : null}
        items={menu && menuItems ? menuItems(menu.tab, () => setRenaming(menu.tab.path)) : []}
        onClose={closeMenu}
        label={menu ? `${menu.tab.path} actions` : undefined}
      />
    </div>
  )
}
