import { forwardRef } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'compact' | 'default'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

const baseClass = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--adf-ui-control-radius)] border text-[12px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--adf-ui-surface)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-[var(--adf-ui-accent)] text-white hover:bg-[var(--adf-ui-accent-hover)] dark:text-neutral-950',
  secondary: 'border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] text-[var(--adf-ui-text)] hover:bg-[var(--adf-ui-surface-hover)]',
  ghost: 'border-transparent bg-transparent text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)]',
  danger: 'border-transparent bg-[var(--adf-ui-danger-subtle)] text-[var(--adf-ui-danger)] hover:border-[var(--adf-ui-danger)]/30',
}

const sizeClasses: Record<ButtonSize, string> = {
  compact: 'h-[var(--adf-ui-control-height-compact)] px-2.5',
  default: 'h-[var(--adf-ui-control-height)] px-3',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'default', loading = false, disabled, type = 'button', className = '', children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${baseClass} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    >
      {children}
    </button>
  )
})
