import { Tooltip } from '../common/Tooltip'
import { useEffect, useRef } from 'react'
import type { SlashCommand } from '../../utils/slash-commands'
import { LockIcon, PERMISSION_ON_CLASS, ShieldIcon } from './config-panel-parts'

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
  authorize = false,
  activeIndex,
  listId,
  onSelect,
  onHighlight
}: {
  authorize?: boolean
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
      className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-64 overflow-y-auto rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] py-1 shadow-float"
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
            index === activeIndex ? 'bg-[var(--adf-ui-surface-hover)]' : ''
          }`}
        >
          <span
            className={`shrink-0 font-mono text-xs ${
              command.muted
                ? 'text-[var(--adf-ui-text-subtle)]'
                : 'text-[var(--adf-ui-text)]'
            }`}
          >
            {command.label}
            {command.locked && <Tooltip tip="Locked by the owner: the agent cannot change or remove it." className="ml-1 inline-flex align-middle"><span aria-label="Locked by the owner" role="img" className={PERMISSION_ON_CLASS.locked}><LockIcon size={12} /></span></Tooltip>}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-[11px] ${
              command.muted
                ? 'italic text-[var(--adf-ui-text-subtle)]'
                : 'text-[var(--adf-ui-text-muted)]'
            }`}
          >
            {command.kind === 'agent' && command.muted ? 'Start the agent to run this.' : command.description}
          </span>
          {command.kind === 'agent' && authorize && index === activeIndex && <Tooltip tip="Runs once as authorized code: restricted tools and methods are allowed." className="inline-flex shrink-0"><span aria-label="Authorized run" role="img" className="text-[var(--adf-ui-warning)]"><ShieldIcon size={12} filled /></span></Tooltip>}
          {command.kind === 'skill' && command.muted && (
            <span className="shrink-0 text-[10px] text-[var(--adf-ui-text-subtle)]">(muted)</span>
          )}
        </button>
      ))}
    </div>
  )
}
