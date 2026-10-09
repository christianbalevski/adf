import { describe, expect, it } from 'vitest'
import { metricBar, metricText, parseMetric } from '../../../src/shared/utils/agent-metrics'

describe('parseMetric', () => {
  it('a plain string is shown as is', () => {
    expect(parseMetric('tickets_closed', '42')).toEqual({ name: 'tickets_closed', label: 'tickets_closed', value: '42', raw: '42' })
    expect(parseMetric('n', null)).toEqual({ name: 'n', label: 'n', value: '', raw: '' })
    expect(metricText(parseMetric('n', 'all green'))).toBe('all green')
  })

  it('reads every field of a full object', () => {
    const raw = '{"value": 64, "label": "Disk used", "unit": "%", "min": 0, "max": 100, "target": 80}'
    const m = parseMetric('disk', raw)
    expect(m).toEqual({ name: 'disk', label: 'Disk used', value: 64, unit: '%', min: 0, max: 100, target: 80, raw })
    expect(metricText(m)).toBe('64%')
    expect(metricBar(m)).toEqual({ fill: 0.64, target: 0.8 })
  })

  it('without max, a target reads "value / target unit"', () => {
    const m = parseMetric('focus', '{"value": 42, "unit": "h", "target": 50}')
    expect(metricText(m)).toBe('42 / 50 h')
    expect(metricBar(m)).toBeNull()
  })

  it('anything that is not a metric object falls back to the raw string', () => {
    for (const raw of ['{"value": 1', '[1, 2]', '{"label": "x"}', '{"value": null}', '{"value": {"a": 1}}', '7']) {
      expect(parseMetric('m', raw)).toEqual({ name: 'm', label: 'm', value: raw, raw })
    }
  })

  it('ignores fields of the wrong type', () => {
    expect(parseMetric('m', '{"value": 3, "label": 5, "unit": "", "max": "10"}')).toEqual({ name: 'm', label: 'm', value: 3, raw: '{"value": 3, "label": 5, "unit": "", "max": "10"}' })
  })

  it('a non-numeric value with max gets no bar', () => {
    const m = parseMetric('mood', '{"value": "high", "max": 10}')
    expect(m.value).toBe('high')
    expect(metricBar(m)).toBeNull()
    expect(metricText(m)).toBe('high')
  })

  it('clamps the bar and the target to the range', () => {
    expect(metricBar(parseMetric('m', '{"value": 150, "max": 100, "target": -5}'))).toEqual({ fill: 1, target: 0 })
    expect(metricBar(parseMetric('m', '{"value": 5, "min": 10, "max": 20}'))).toEqual({ fill: 0 })
    expect(metricBar(parseMetric('m', '{"value": 15, "min": 10, "max": 20}'))).toEqual({ fill: 0.5 })
    // An empty range has no bar.
    expect(metricBar(parseMetric('m', '{"value": 5, "min": 10, "max": 10}'))).toBeNull()
  })
})
