/**
 * The one on/off control in Settings: a switch with its state in words
 * beside it. `label` is the accessible name (the row's label); the row shows
 * the visible one.
 */
export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  /** Hide the On/Off word (a row that states the value elsewhere). */
  hideState?: boolean
}

export function Switch({ checked, onChange, label, disabled = false, hideState = false }: SwitchProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-[var(--adf-ui-accent)]' : 'bg-[var(--adf-ui-border)]'}`}
      >
        <span
          aria-hidden="true"
          className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform duration-150 ${checked ? 'translate-x-[16px]' : 'translate-x-[2px]'}`}
        />
      </button>
      {!hideState && <span className="text-[12px] text-[var(--adf-ui-text-muted)]">{checked ? 'On' : 'Off'}</span>}
    </span>
  )
}
