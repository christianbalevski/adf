/** Subsequence match score; 0 = no match. Contiguous and word-start hits score higher. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase().trim()
  if (!q) return 1
  const t = text.toLowerCase()
  if (t === q) return 200
  const at = t.indexOf(q)
  if (at >= 0) {
    const wordStart = at === 0 || /[\s._/:>›-]/.test(t[at - 1] ?? ' ')
    return 100 + (wordStart ? 40 : 0) - Math.min(at, 60)
  }
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    if (found === prev + 1) score += 3
    else if (/[\s._/:>›-]/.test(t[found - 1] ?? ' ')) score += 2
    else score += 1
    prev = found
    ti = found + 1
  }
  return score
}

/** Best score across the entry's fields; secondary fields count half. */
export function scoreEntry(query: string, title: string, extra: string): number {
  if (!query.trim()) return 1
  // Multi-word queries: every word must match somewhere.
  const words = query.trim().split(/\s+/)
  if (words.length > 1) {
    let total = 0
    for (const word of words) {
      const s = Math.max(fuzzyScore(word, title), fuzzyScore(word, extra) * 0.5)
      if (s <= 0) return 0
      total += s
    }
    return total / words.length + (fuzzyScore(query, title) > 100 ? 50 : 0)
  }
  return Math.max(fuzzyScore(query, title), fuzzyScore(query, extra) * 0.5)
}
