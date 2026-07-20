interface SettingsGroupProps {
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
}

export function SettingsGroup({ title, description, children, className = '' }: SettingsGroupProps) {
  return (
    <section className={`overflow-hidden rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] ${className}`}>
      {(title || description) && (
        <div className="px-4 pt-3.5 pb-2.5">
          {title && <h2 className="text-[13px] font-semibold text-[var(--adf-ui-text)]">{title}</h2>}
          {description && <p className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">{description}</p>}
        </div>
      )}
      {children}
    </section>
  )
}

interface SettingsRowProps {
  label: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  separator?: boolean
  stacked?: boolean
  disabled?: boolean
  help?: React.ReactNode
  error?: React.ReactNode
  className?: string
}

export function SettingsRow({ label, description, children, separator = false, stacked = false, disabled = false, help, error, className = '' }: SettingsRowProps) {
  return (
    <div className={`${separator ? 'border-t border-[var(--adf-ui-separator)]' : ''} px-4 py-3 ${disabled ? 'opacity-60' : ''} ${className}`}>
      <div className={stacked ? 'space-y-2' : 'flex flex-col gap-2 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-6'}>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--adf-ui-text)]">{label}</div>
          {description && <div className="mt-0.5 text-[12px] leading-5 text-[var(--adf-ui-text-muted)]">{description}</div>}
        </div>
        {children && <div className={stacked ? '' : 'shrink-0'}>{children}</div>}
      </div>
      {help && <div className="mt-1.5 text-[11px] text-[var(--adf-ui-text-subtle)]">{help}</div>}
      {error && <div className="mt-1.5 text-[11px] text-[var(--adf-ui-danger)]">{error}</div>}
    </div>
  )
}
