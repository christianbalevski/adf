import { forwardRef } from 'react'
import type { ButtonSize } from './Button'

export type IconButtonVariant = 'neutral' | 'selected' | 'danger'

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string
  variant?: IconButtonVariant
  size?: ButtonSize
}

const variants: Record<IconButtonVariant, string> = {
  neutral: 'border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]',
  selected: 'border-[var(--adf-ui-border)] bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-text)]',
  danger: 'border-transparent bg-transparent text-[var(--adf-ui-danger)] hover:bg-[var(--adf-ui-danger-subtle)]',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'neutral', size = 'compact', type = 'button', className = '', ...props },
  ref,
) {
  const dimension = size === 'compact' ? 'size-[var(--adf-ui-control-height-compact)]' : 'size-[var(--adf-ui-control-height)]'
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`inline-flex shrink-0 items-center justify-center rounded-[var(--adf-ui-control-radius)] border transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 ${dimension} ${variants[variant]} ${className}`}
    />
  )
})
