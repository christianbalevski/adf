/**
 * Agent metrics: `metric:<name>` adf_meta values. A value is either a plain
 * string, shown as is, or a JSON object
 * `{"value": number|string, "label"?, "unit"?, "min"?, "max"?, "target"?}`.
 * Anything that does not parse as such an object is a plain string. Pure.
 */

import type { AgentMetric } from '../types/agent-vitals.types'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** One adf_meta row (`name` without the `metric:` prefix) as an AgentMetric. */
export function parseMetric(name: string, raw: unknown): AgentMetric {
  const text = raw == null ? '' : String(raw)
  const plain: AgentMetric = { name, label: name, value: text, raw: text }
  if (!text.trimStart().startsWith('{')) return plain
  let o: unknown
  try { o = JSON.parse(text) } catch { return plain }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return plain
  const r = o as Record<string, unknown>
  if (!isNum(r.value) && typeof r.value !== 'string') return plain
  return {
    name,
    label: isText(r.label) ? r.label : name,
    value: r.value,
    ...(isText(r.unit) ? { unit: r.unit } : {}),
    ...(isNum(r.min) ? { min: r.min } : {}),
    ...(isNum(r.max) ? { max: r.max } : {}),
    ...(isNum(r.target) ? { target: r.target } : {}),
    raw: text
  }
}

/** Position of `v` on min..max (min defaults to 0), clamped to 0..1. null without a usable range. */
function share(m: AgentMetric, v: number): number | null {
  if (m.max === undefined) return null
  const min = m.min ?? 0
  if (!(m.max > min)) return null
  return Math.min(1, Math.max(0, (v - min) / (m.max - min)))
}

/**
 * The bar: value and target as 0..1 of min..max. null unless `max` is set,
 * above `min`, and the value is a number.
 */
export function metricBar(m: AgentMetric): { fill: number; target?: number } | null {
  if (typeof m.value !== 'number') return null
  const fill = share(m, m.value)
  if (fill === null) return null
  const target = m.target === undefined ? null : share(m, m.target)
  return target === null ? { fill } : { fill, target }
}

function num(v: number | string): string {
  return typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v
}

/** "82.4 kg", "64%"; "42 / 50 h" with a target and no max; the raw string for a plain metric. */
export function metricText(m: AgentMetric): string {
  const unit = !m.unit ? '' : m.unit === '%' ? '%' : ` ${m.unit}`
  if (m.max === undefined && m.target !== undefined) return `${num(m.value)} / ${num(m.target)}${unit}`
  return `${num(m.value)}${unit}`
}
