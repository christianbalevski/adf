/**
 * The orbital's speech bubble: a small raised box with a tail on its left
 * side pointing at the orbital. Shared by the home page's reroll quips
 * (typed, fading) and the agent overview's status line (static).
 * Position it with `className`; the tail sits 11px from the top.
 */

export function SpeechBubble({ className = '', style, children }: {
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  return (
    <div
      className={`rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] px-2.5 py-1.5 text-left text-[12px] leading-[1.35] text-[var(--ink-muted)] shadow-[0_6px_18px_-10px_rgba(0,0,0,0.25)] ${className}`}
      style={style}
    >
      {/* Tail: a rotated square on the side facing the orbital. */}
      <span aria-hidden className="absolute -left-[5px] top-[11px] h-2 w-2 rotate-[135deg] border-b border-r border-[var(--rule)] bg-[var(--paper-raised)]" />
      {children}
    </div>
  )
}
