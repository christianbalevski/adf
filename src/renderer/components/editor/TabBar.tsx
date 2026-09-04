import type { EditorTab } from '../../stores/editor-tabs.store'

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
  onClose: () => void
}

interface Props {
  tabs: EditorTab[]
  activeTabPath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onReload?: (path: string) => void
  chatTab?: ChatTabProps
}

/**
 * Tab chrome, VS Code style. The bar is one recessed surface; its bottom
 * hairline is an absolutely positioned sibling under the tabs rather than a
 * border, so the selected tab (opaque, content-coloured, z-above) covers it
 * and opens straight into the content below. The accent sits on the TOP edge
 * as an inset shadow (a border would shift the tab's height). Focus rings
 * are drawn inset: the file strip scrolls horizontally, and an outset ring
 * gets clipped to a stray vertical bar at the tab's edge.
 */
const TAB_BASE =
  'group relative z-10 flex items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:[outline-offset:-2px]'
const TAB_ACTIVE =
  'bg-surface-1 text-neutral-800 dark:text-neutral-200 shadow-[inset_0_2px_0_0_var(--color-blue-500)]'
const TAB_IDLE =
  'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-500/10 hover:text-neutral-700 dark:hover:text-neutral-200'
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

export function TabBar({ tabs, activeTabPath, onSelect, onClose, onReload, chatTab }: Props) {
  if (tabs.length === 0 && !chatTab) return null

  return (
    <div className="relative flex h-9 items-stretch bg-surface-0 shrink-0">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-hairline" />
      {chatTab && (
        <>
          {/* Pinned outside the scroller: with many files open the file strip
              scrolls under it and Loops stays put. Tinted with the accent so
              it reads as the agent's slot, not another document. */}
          <button
            type="button"
            onClick={chatTab.onSelect}
            title="Loops — the agent's chat"
            className={`${TAB_BASE} shrink-0 ${
              chatTab.active
                ? 'bg-[color-mix(in_srgb,var(--color-blue-500)_10%,var(--adf-surface-1))] text-blue-700 dark:text-blue-300 shadow-[inset_0_2px_0_0_var(--color-blue-500)]'
                : 'text-neutral-500 dark:text-neutral-400 hover:bg-blue-500/10 hover:text-blue-700 dark:hover:text-blue-300'
            }`}
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
            <span
              onClick={(e) => {
                e.stopPropagation()
                chatTab.onClose()
              }}
              title="Close — put the chat back in the side panel"
              className={`ml-1 ${TAB_ICON_BUTTON} ${
                chatTab.active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
              }`}
            >
              <CloseGlyph />
            </span>
          </button>
          <span aria-hidden className="relative z-10 w-px shrink-0 self-stretch bg-hairline" />
        </>
      )}
      <div className="scrollbar-autohide flex flex-1 min-w-0 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.path === activeTabPath
          const isBrowser = tab.kind === 'browser'
          const fileName = isBrowser ? 'Browser' : tab.path.split('/').pop() ?? tab.path
          const hoverTitle = isBrowser && tab.browserMeta
            ? `Agent browser — http://127.0.0.1:${tab.browserMeta.hostPort}`
            : tab.path

          return (
            <button
              key={tab.path}
              onClick={() => onSelect(tab.path)}
              onMouseDown={(e) => {
                // Middle-click closes tab
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.path)
                }
              }}
              className={`${TAB_BASE} border-r border-hairline ${isActive ? TAB_ACTIVE : TAB_IDLE}`}
            >
              <span className="truncate max-w-[150px]" title={hoverTitle}>{fileName}</span>
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
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.isDirty ? 'bg-blue-500' : 'bg-transparent'}`} />
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
            </button>
          )
        })}
      </div>
    </div>
  )
}
