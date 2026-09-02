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

export function TabBar({ tabs, activeTabPath, onSelect, onClose, onReload, chatTab }: Props) {
  if (tabs.length === 0 && !chatTab) return null

  return (
    <div className="flex items-center bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700 overflow-x-auto shrink-0">
      {chatTab && (
        <button
          type="button"
          onClick={chatTab.onSelect}
          title="Loops — the agent's chat"
          className={`group relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap border-r border-neutral-200 dark:border-neutral-700 ${
            chatTab.active
              ? 'bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 border-b-2 border-b-blue-500'
              : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/80 hover:text-neutral-700 dark:hover:text-neutral-300'
          }`}
        >
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
            className={`ml-1 w-4 h-4 flex items-center justify-center rounded-sm hover:bg-neutral-200 dark:hover:bg-neutral-600 ${
              chatTab.active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
            }`}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="1" y1="1" x2="7" y2="7" />
              <line x1="7" y1="1" x2="1" y2="7" />
            </svg>
          </span>
        </button>
      )}
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
            className={`group relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap border-r border-neutral-200 dark:border-neutral-700 ${
              isActive
                ? 'bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 border-b-2 border-b-blue-500'
                : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/80 hover:text-neutral-700 dark:hover:text-neutral-300'
            }`}
          >
            <span className="truncate max-w-[150px]" title={hoverTitle}>{fileName}</span>
            {isBrowser && onReload && (
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  onReload(tab.path)
                }}
                title="Reload viewer"
                className={`w-4 h-4 flex items-center justify-center rounded-sm hover:bg-neutral-200 dark:hover:bg-neutral-600 ${
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
              className={`ml-1 w-4 h-4 flex items-center justify-center rounded-sm hover:bg-neutral-200 dark:hover:bg-neutral-600 ${
                isActive ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
              }`}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="1" y1="1" x2="7" y2="7" />
                <line x1="7" y1="1" x2="1" y2="7" />
              </svg>
            </span>
          </button>
        )
      })}
    </div>
  )
}
