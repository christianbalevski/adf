/**
 * The orbital's speech bubble: a small raised box with a tail pointing at the
 * orbital. Shared by the home page's reroll quips (typed, fading; tail on the
 * left, 11px from the top) and the agent overview's status line (static;
 * above the orbital, tail at the bottom centre). Position it with `className`.
 */

export function SpeechBubble({ className = '', style, tail = 'left', children }: {
  className?: string
  style?: React.CSSProperties
  /** The side facing the orbital. */
  tail?: 'left' | 'bottom'
  children: React.ReactNode
}) {
  return (
    <div
      className={`rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] px-2.5 py-1.5 text-left text-[12px] leading-[1.35] text-[var(--ink-muted)] shadow-[0_6px_18px_-10px_rgba(0,0,0,0.25)] ${className}`}
      style={style}
    >
      {/* Tail: a rotated square whose bordered corner faces the orbital. */}
      <span
        aria-hidden
        className={`absolute h-2 w-2 border-b border-r border-[var(--rule)] bg-[var(--paper-raised)] ${
          tail === 'bottom' ? 'left-1/2 -bottom-[5px] -translate-x-1/2 rotate-45' : '-left-[5px] top-[11px] rotate-[135deg]'
        }`}
      />
      {children}
    </div>
  )
}
