import { Dialog } from './Dialog'
import { useKeyboardStore } from '../../stores/keyboard.store'
import { IS_MAC } from '../../utils/platform'
import { agentWindowsAvailable, isAgentWindow } from '../../utils/window-kind'
import { FLEET_MAP_SECTIONS, SHORTCUT_SECTIONS, rowFor, type ShortcutSection } from '../../../shared/constants/keyboard-shortcuts'

/** Help → Keyboard Shortcuts: every shortcut, from the one table menu.ts binds. */
export function KeyboardShortcutsDialog() {
  const open = useKeyboardStore((s) => s.shortcutsOpen)
  const setOpen = useKeyboardStore((s) => s.setShortcutsOpen)
  const daemonMode = isAgentWindow || agentWindowsAvailable
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" wide>
      {open && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {SHORTCUT_SECTIONS.map((section) => <SectionView key={section.title} section={section} daemonMode={daemonMode} />)}
          </div>
          <div>
            <h3 className="mb-2 text-[12px] font-semibold text-[var(--adf-ui-text)]">Age of Agents</h3>
            <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              {FLEET_MAP_SECTIONS.map((section) => <SectionView key={section.title} section={section} daemonMode={daemonMode} />)}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function SectionView({ section, daemonMode }: { section: ShortcutSection; daemonMode: boolean }) {
  const rows = section.rows.filter((r) => daemonMode || !r.agentWindowsOnly)
  return (
    <section aria-label={section.title}>
      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--adf-ui-text-subtle)]">{section.title}</h4>
      <dl className="space-y-1">
        {rows.map((row) => {
          const { keys, label } = rowFor(row, IS_MAC)
          return (
            <div key={`${row.keys.join(' ')} ${row.label}`} className="flex items-baseline gap-3">
              <dt className="flex shrink-0 min-w-[112px] flex-wrap gap-1">
                {keys.map((k) => (
                  <kbd key={k} className="min-w-[22px] rounded border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-1.5 py-0.5 text-center font-sans text-[11px] text-[var(--adf-ui-text-muted)]">
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className="text-[12px] text-[var(--adf-ui-text)]">{label}</dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}
