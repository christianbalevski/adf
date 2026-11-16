const SEPARATOR = /[-_:/.@]/

/**
 * Where a name is cut when it does not fit: the head takes the ellipsis, the
 * tail stays whole. The tail is the longest suffix that starts at a separator
 * and is at most `maxTail` characters and at most half the name, so the part
 * that tells two names apart (a version, a quantization: `-5-5`, `-q4_K_M`)
 * stays on screen. A name with no such separator keeps its last few characters.
 */
export function middleSplit(text: string, maxTail = 12): [head: string, tail: string] {
  const cap = Math.min(maxTail, Math.floor(text.length / 2))
  for (let i = text.length - cap; i < text.length - 1; i++) {
    if (i > 0 && SEPARATOR.test(text[i])) return [text.slice(0, i), text.slice(i)]
  }
  const n = Math.min(6, Math.floor(text.length / 3))
  return n > 0 ? [text.slice(0, text.length - n), text.slice(text.length - n)] : [text, '']
}

/** One line of text that, when squeezed, loses its middle rather than its end. The full text is the tooltip. */
export function MiddleTruncate({ text, className = '' }: { text: string; className?: string }) {
  const [head, tail] = middleSplit(text)
  return (
    <span className={`flex min-w-0 whitespace-nowrap ${className}`} title={text}>
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
    </span>
  )
}
