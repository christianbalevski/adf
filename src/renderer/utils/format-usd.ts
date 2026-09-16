/**
 * USD label for a cost figure. Sub-cent values keep four decimals so
 * per-call costs stay readable; anything smaller than the last shown digit
 * prints as a bound instead of a misleading "$0.0000".
 *
 *   0        → "$0.00"
 *   0.00003  → "<$0.0001"
 *   0.0042   → "$0.0042"
 *   0.42     → "$0.42"
 *   12.5     → "$12.50"
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.0001) return '<$0.0001'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}
