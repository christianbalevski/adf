/**
 * Two small affordances that keep the config panels from turning into a manual:
 *
 *   <InfoHint tip="…" />   — an ⓘ next to a label; the prose that used to sit
 *                            under the control lives in its tooltip
 *   <DocsLink href={DOCS.model} /> — a "Docs ↗" link in a section header,
 *                            opening the matching guide on GitHub
 *
 * Short hints that read as part of the control ("0 = model default", "seconds")
 * stay inline — they are labels, not explanations.
 */

import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'

/** Open in the OS browser. Electron's renderer has no `shell.openExternal`; the
 *  main process intercepts `window.open` and routes it (see main/index.ts). */
function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function DocsLink({
  href,
  label = 'Docs',
  className = '',
  stopPropagation = true
}: {
  href: string
  label?: string
  className?: string
  /** Section headers toggle collapse on click — don't let the link do that too. */
  stopPropagation?: boolean
}) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (stopPropagation) e.stopPropagation()
        openExternal(href)
      }}
      title={href}
      className={`shrink-0 inline-flex items-center gap-0.5 text-[10px] font-normal normal-case tracking-normal text-neutral-400 hover:text-blue-500 dark:text-neutral-500 dark:hover:text-blue-400 transition-colors ${className}`}
    >
      {label}
      <span aria-hidden>↗</span>
    </a>
  )
}

/**
 * ⓘ glyph carrying a tooltip. Sits after a field label.
 *
 * Most of these live inside a `<label>` wrapping a checkbox, or inside a
 * section header that collapses on click — so swallow the click. Reading the
 * hint must never flip the setting the hint is describing.
 */
export function InfoHint({
  tip,
  className = '',
  children
}: {
  tip: string
  className?: string
  children?: ReactNode
}) {
  return (
    <Tooltip tip={tip} className={`inline-flex items-center align-middle ${className}`}>
      <span
        className="inline-flex items-center"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {children}
        <svg
          width={11}
          height={11}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="More information"
          role="img"
          className="ml-1 shrink-0 cursor-help text-neutral-300 hover:text-neutral-500 dark:text-neutral-600 dark:hover:text-neutral-400 transition-colors"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </span>
    </Tooltip>
  )
}
