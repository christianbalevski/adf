import { forwardRef } from 'react'

export const fieldClass = 'h-[var(--adf-ui-control-height)] w-full min-w-0 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface-raised)] px-2.5 text-[13px] text-[var(--adf-ui-text)] placeholder:text-[var(--adf-ui-text-subtle)] outline-none transition-colors duration-150 focus:border-[var(--adf-ui-accent)] focus:ring-2 focus:ring-[var(--adf-ui-focus)] disabled:cursor-not-allowed disabled:bg-[var(--adf-ui-canvas)] disabled:text-[var(--adf-ui-text-subtle)] disabled:opacity-70'
export const textareaClass = `${fieldClass} h-auto py-2`

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className = '', ...props },
  ref,
) {
  return <input {...props} ref={ref} className={`${fieldClass} ${className}`} />
})

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', ...props },
  ref,
) {
  return <select {...props} ref={ref} className={`${fieldClass} ${className}`} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...props },
  ref,
) {
  return <textarea {...props} ref={ref} className={`${textareaClass} ${className}`} />
})
