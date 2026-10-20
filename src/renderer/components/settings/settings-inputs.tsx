/**
 * Settings fields that commit on Enter or when they lose focus, never per
 * keystroke, and say inline why a value is refused (docs/guides/settings.md,
 * "Saving"). The checks are pure so tests can run them without a DOM.
 */
import { useEffect, useState } from 'react'
import { TextInput } from '../ui'

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** A whole number in [min, max]; anything else is refused, never clamped or zeroed. */
export function checkWholeNumber(raw: string, min: number, max: number): Checked<number> {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return { ok: false, error: `Enter a whole number from ${min} to ${max}.` }
  const value = Number(text)
  if (value < min || value > max) return { ok: false, error: `Enter a whole number from ${min} to ${max}.` }
  return { ok: true, value }
}

/** A manual mesh peer: `host:port`, or a bare host (the mesh port is used). */
export function checkPeerAddress(raw: string): Checked<string> {
  const text = raw.trim()
  if (!text) return { ok: false, error: 'Enter an address.' }
  if (/^[a-z]+:\/\//i.test(text) || /[\s/?#@]/.test(text)) return { ok: false, error: 'Use host:port, without http:// or a path.' }
  // [IPv6]:port, [IPv6], host:port, host
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(text)
  const plain = /^([^:[\]]+)(?::(\d+))?$/.exec(text)
  const match = bracketed ?? plain
  if (!match) return { ok: false, error: 'Use host:port, for example 100.101.102.103:7295.' }
  const host = match[1]
  const port = match[2]
  if (!bracketed && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) {
    return { ok: false, error: 'The host has characters a host name cannot have.' }
  }
  if (port !== undefined) {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: 'The port must be from 1 to 65535.' }
  }
  return { ok: true, value: text }
}

/**
 * A text field holding a draft: Enter or leaving the field commits it, Escape
 * puts the saved value back. A refused value stays in the field with the
 * reason under it, and nothing is written.
 */
export function CommitInput({ value, onCommit, check, className = '', ...props }: {
  value: string
  onCommit: (value: string) => void
  /** Null when the value is fine; otherwise the reason it is refused. */
  check?: (value: string) => string | null
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'>) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setDraft(value); setError(null) }, [value])

  const commit = () => {
    if (draft === value) { setError(null); return }
    const problem = check?.(draft) ?? null
    setError(problem)
    if (!problem) onCommit(draft)
  }

  return (
    <span className="inline-flex min-w-0 flex-col gap-1">
      <TextInput
        {...props}
        value={draft}
        aria-invalid={!!error}
        onChange={(e) => { setDraft(e.target.value); setError(null) }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setDraft(value); setError(null) }
        }}
        className={className}
      />
      {error && <span role="alert" className="text-[11px] text-[var(--adf-ui-danger)]">{error}</span>}
    </span>
  )
}
