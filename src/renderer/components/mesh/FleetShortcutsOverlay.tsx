import { memo } from 'react'
import { IS_MAC } from '../../utils/platform'
import { FLEET_MAP_SECTIONS, rowFor } from '../../../shared/constants/keyboard-shortcuts'

function Key({ k }: { k: string }) {
  return (
    <kbd className="px-1.5 py-0.5 min-w-[22px] text-center rounded border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-800 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
      {k}
    </kbd>
  )
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1 shrink-0 min-w-[104px]">
        {keys.map((k) => <Key key={k} k={k} />)}
      </span>
      <span className="text-[12px] text-neutral-600 dark:text-neutral-300">{label}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--adf-ui-text-subtle)]">{title}</div>
      {children}
    </div>
  )
}

/**
 * Command card — every map hotkey on a blurred full-screen sheet. ? toggles,
 * Esc or a click anywhere dismisses. The keys come from the shared table
 * (keyboard-shortcuts.ts) that Help → Keyboard Shortcuts lists too.
 */
export const FleetShortcutsOverlay = memo(function FleetShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-white/40 dark:bg-black/40 backdrop-blur-md"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="grid grid-cols-2 gap-x-10 gap-y-5 px-8 py-6 rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="col-span-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Keyboard commands</span>
          <span className="text-[10px] text-[var(--adf-ui-text-subtle)]">? toggles · Esc closes</span>
        </div>
        {FLEET_MAP_SECTIONS.map((section) => (
          <Section key={section.title} title={section.title}>
            {section.rows.map((row) => {
              const { keys, label } = rowFor(row, IS_MAC)
              return <Row key={`${row.keys.join(' ')} ${row.label}`} keys={keys} label={label} />
            })}
          </Section>
        ))}
      </div>
    </div>
  )
})
