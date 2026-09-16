// Renderer-side token estimate. The real tokenizer lives in the main process
// (token-counter.service.ts) and can't be imported here, so this is the same
// chars/4 heuristic that service falls back to — good enough for a UI hint.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Compact label for display: 812 → "812", 4200 → "4.2k", 137200 → "137k",
 * 1_400_000 → "1.4M", 2_500_000_000 → "2.5B". The one shared token formatter
 * for the renderer — never more than three digits before the unit.
 * Fractional inputs (per-minute rates) round; non-finite prints "0".
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  // Pick the unit from the ROUNDED value, not the raw one — branching on the raw
  // value printed 9_999 as "10.0k" (one decimal too many) and 999_999 as "1000k"
  // (never reaching the M branch).
  const k = tokens / 1000
  if (Math.round(k) < 1000) return k < 9.95 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`
  const m = tokens / 1_000_000
  if (Math.round(m) < 1000) return m < 9.95 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`
  return `${(tokens / 1_000_000_000).toFixed(1)}B`
}
