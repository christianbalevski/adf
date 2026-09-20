/**
 * One faint beat in the empty middle of home: the .adf document and the
 * promise that comes with it. A line icon in the subtle text colour, no fill,
 * no box; it should read as part of the background, not a card.
 */
export function HomeExplainer() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-2 text-center text-[var(--adf-ui-text-subtle)]">
      <div className="mb-3 h-14 w-20 opacity-70"><FileGlyph label=".adf" /></div>
      <p className="text-[13px] font-medium text-[var(--adf-ui-text-muted)]">Build an agent you can keep.</p>
    </div>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** A document with a folded corner and the extension written inside. */
function FileGlyph({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 80 56" width="80" height="56" {...stroke} aria-hidden>
      <path d="M26 4h20l12 12v32a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" />
      <path d="M46 4v12h12" />
      <text x="40" y="40" textAnchor="middle" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="10" fill="currentColor" stroke="none">{label}</text>
    </svg>
  )
}
