import { useCallback, useRef, useState } from 'react'
import { ContextMenu, type ContextMenuItem } from '../../common/ContextMenu'

export function SkillActionsMenu({ name, items, busy }: { name: string; items: ContextMenuItem[]; busy: boolean }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setPosition(null), [])

  return (
    <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button
        ref={anchor}
        type="button"
        aria-label={`Actions for ${name}`}
        title="Skill actions"
        aria-haspopup="menu"
        aria-expanded={position !== null}
        disabled={busy}
        onClick={() => {
          if (position) { close(); return }
          const rect = anchor.current?.getBoundingClientRect()
          if (rect) setPosition({ x: rect.right, y: rect.bottom + 4 })
        }}
        className="flex h-7 w-7 items-center justify-center rounded text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)] disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      <ContextMenu
        position={position}
        items={items.map((item) => ({ ...item, disabled: busy || item.disabled }))}
        onClose={close}
        placement={{ x: 'end' }}
        label={`Actions for ${name}`}
        anchor={anchor}
      />
    </div>
  )
}
