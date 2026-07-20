import { useRef } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'compact' | 'default'
}

export function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel, size = 'compact' }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const moveSelection = (fromIndex: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const next = (fromIndex + direction * offset + options.length) % options.length
      if (!options[next].disabled) {
        onChange(options[next].value)
        refs.current[next]?.focus()
        return
      }
    }
  }

  const selectBoundary = (fromEnd: boolean) => {
    const indexes = options.map((_, index) => index)
    if (fromEnd) indexes.reverse()
    const next = indexes.find((index) => !options[index].disabled)
    if (next !== undefined) {
      onChange(options[next].value)
      refs.current[next]?.focus()
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] p-0.5"
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(element) => { refs.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault()
                moveSelection(index, 1)
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault()
                moveSelection(index, -1)
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                selectBoundary(event.key === 'End')
              }
            }}
            className={`min-w-14 rounded-[calc(var(--adf-ui-control-radius)-2px)] px-2.5 text-[12px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] disabled:opacity-45 ${size === 'compact' ? 'h-6' : 'h-7'} ${selected ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)] shadow-[inset_0_0_0_1px_var(--adf-ui-focus)]' : 'text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]'}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
