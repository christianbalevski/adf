/** Actual Ink measurements, rather than source-text wrapping estimates. */
export interface BlockMeasurement {
  signature: string
  height: number
}

export interface MarkdownViewport {
  width: number
  height: number
  clipBottom: number
}

/**
 * Prove which blocks cannot intersect a bottom-relative viewport. Unknown
 * heights contribute zero to the lower bound for rows below a block, and
 * stop exact bottom clipping. Unknown blocks themselves always render.
 */
export function measuredBlockWindow(signatures: string[], measurements: Map<number, BlockMeasurement>, viewport: MarkdownViewport): boolean[] {
  const hidden = Array<boolean>(signatures.length).fill(false)
  let below = 0
  let exact = true
  const bottom = Math.max(0, viewport.clipBottom)
  const top = bottom + Math.max(1, viewport.height)
  for (let i = signatures.length - 1; i >= 0; i--) {
    const m = measurements.get(i)
    if (!m || m.signature !== signatures[i]) { exact = false; continue }
    hidden[i] = below >= top || (exact && below + m.height <= bottom)
    below += m.height
  }
  return hidden
}
