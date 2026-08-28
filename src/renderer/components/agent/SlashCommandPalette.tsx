import { useEffect, useRef } from 'react'
import type { SlashCommand } from '../../utils/slash-commands'

/**
 * The `/` command palette over the composer (design doc §5).
 *
 * Presentation only: the composer owns the open/closed state, the highlight,
 * and every keystroke, because the keys the palette needs (Arrow, Enter, Tab,
 * Escape) have to be intercepted on the textarea before it acts on them. This
 * component draws the list and reports clicks.
 *
 * Rows carry no authority. A skill row is data read out of the agent's own
 * catalog, sanitized upstream in `buildSlashCommands`, and selecting one only
 * puts text in the composer.
 */
export function SlashCommandPalette({
  commands,
  activeIndex,
  listId,
  onSelect,
  onHighlight
}: {
  commands: readonly SlashCommand[]
  activeIndex: number
  listId: string
  onSelect: (command: SlashCommand) => void
  onHighlight: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view as the arrows walk past the fold.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) return null

  return (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Commands"
      className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-64 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
    >
      {commands.map((command, index) => (
        <button
          key={command.key}
          type="button"
          role="option"
          id={`${listId}-${index}`}
          data-index={index}
          aria-selected={index === activeIndex}
          // mousedown, not click: the textarea must not lose focus first.
          onMouseDown={(e) => { e.preventDefault(); onSelect(command) }}
          onMouseEnter={() => onHighlight(index)}
          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
            index === activeIndex ? 'bg-neutral-100 dark:bg-neutral-700' : ''
          }`}
        >
          <span
            className={`shrink-0 font-mono text-xs ${
              command.muted
                ? 'text-neutral-400 dark:text-neutral-500'
                : 'text-neutral-700 dark:text-neutral-200'
            }`}
          >
            {command.label}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-[11px] ${
              command.muted
                ? 'italic text-neutral-400 dark:text-neutral-500'
                : 'text-neutral-500 dark:text-neutral-400'
            }`}
          >
            {command.description}
          </span>
          {command.muted && (
            <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">(muted)</span>
          )}
        </button>
      ))}
    </div>
  )
}
