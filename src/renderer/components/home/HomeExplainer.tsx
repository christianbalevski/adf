import { useAppStore } from '../../stores/app.store'

/**
 * Three beats in the empty middle of home, drawn faint: what typing below
 * does, what comes out, and that the result is a file the person owns. Line
 * icons in the subtle text colour, no fills, no boxes; it should read as
 * part of the background, not a card.
 */
export function HomeExplainer() {
  const homeName = useAppStore((s) => s.homeName)
  const fileName = `${homeName ?? 'your-agent'}.adf`
  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-8 px-2 text-[var(--adf-ui-text-subtle)] sm:grid-cols-3 sm:gap-6" aria-label="How this works">
      <Beat
        icon={<SendGlyph />}
        title="Send a message"
        line="Say what you want done, in the bar below."
      />
      <Beat
        icon={<FileGlyph label=".adf" />}
        title="Get an agent"
        line={<>It becomes a file, <span className="font-mono text-[11px]">{fileName}</span>, in your agents folder.</>}
      />
      <Beat
        icon={<YoursGlyph />}
        title="It is yours"
        line="Copy it, move it, share it. It runs wherever you put it."
      />
    </div>
  )
}

function Beat({ icon, title, line }: { icon: React.ReactNode; title: string; line: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-3 h-14 w-20 opacity-70">{icon}</div>
      <div className="text-[12.5px] font-medium text-[var(--adf-ui-text-muted)]">{title}</div>
      <p className="mt-1 max-w-[220px] text-[12px] leading-snug">{line}</p>
    </div>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** A speech bubble with the send arrow sitting in its corner. */
function SendGlyph() {
  return (
    <svg viewBox="0 0 80 56" width="80" height="56" {...stroke} aria-hidden>
      <path d="M12 10h44a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H30l-10 9v-9h-8a6 6 0 0 1-6-6V16a6 6 0 0 1 6-6z" />
      <path d="M16 22h22M16 30h14" opacity="0.6" />
      <circle cx="62" cy="40" r="9" />
      <path d="M62 45v-10M58 39l4-4 4 4" />
    </svg>
  )
}

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

/** The same document, twice: one going somewhere, one staying. */
function YoursGlyph() {
  return (
    <svg viewBox="0 0 80 56" width="80" height="56" {...stroke} aria-hidden>
      <path d="M12 8h14l8 8v26a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z" />
      <path d="M26 8v8h8" />
      <path d="M46 14h14l8 8v26a3 3 0 0 1-3 3H46a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3z" opacity="0.55" />
      <path d="M60 14v8h8" opacity="0.55" />
      <path d="M36 30c6-8 12-8 18-4" opacity="0.8" />
      <path d="M50 22l4 4-5 2" opacity="0.8" />
    </svg>
  )
}
