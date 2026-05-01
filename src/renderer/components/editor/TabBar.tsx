import type { EditorTab } from '../../stores/editor-tabs.store'

interface Props {
  tabs: EditorTab[]
  activeTabPath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

export function TabBar({ tabs, activeTabPath, onSelect, onClose }: Props) {
  if (tabs.length === 0) return null

  return (
    <div className="flex items-center bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700 overflow-x-auto shrink-0">
      {tabs.map((tab) => {
        const isActive = tab.path === activeTabPath
        const fileName = tab.path.split('/').pop() ?? tab.path

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
            <span className="truncate max-w-[150px]" title={tab.path}>{fileName}</span>
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
