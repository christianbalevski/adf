import { describe, expect, it } from 'vitest'
import { ToolRepetitionMonitor } from '../../../src/main/runtime/tool-repetition-monitor'
import type { ContentBlock } from '../../../src/shared/types/provider.types'

function batch(input: unknown = { path: 'secret.txt' }, content = 'private result', name = 'fs_read', error = false) {
  return [
    [{ type: 'tool_use', id: 'call', name, input }],
    [{ type: 'tool_result', tool_use_id: 'call', content, is_error: error }],
  ] as [ContentBlock[], ContentBlock[]]
}

describe('ToolRepetitionMonitor', () => {
  it('reports three identical batches once, retaining no raw inputs or outputs', () => {
    const monitor = new ToolRepetitionMonitor()
    expect(monitor.observe(...batch())).toBeNull()
    expect(monitor.observe(...batch())).toBeNull()
    expect(monitor.observe(...batch())).toEqual({ period: 1, repetitions: 3, toolNames: ['fs_read'] })
    for (let i = 0; i < 20; i++) expect(monitor.observe(...batch())).toBeNull()
    expect(JSON.stringify(monitor)).not.toContain('secret.txt')
    expect(JSON.stringify(monitor)).not.toContain('private result')
    expect((monitor as unknown as { history: unknown[] }).history).toHaveLength(9)
  })

  it.each([2, 3])('recognizes %i-batch cycles without repeating notices on rotations', period => {
    const monitor = new ToolRepetitionMonitor()
    for (let index = 0; index < period * 3 - 1; index++) {
      expect(monitor.observe(...batch({ direction: index % period }, 'same', `tool_${index % period}`))).toBeNull()
    }
    expect(monitor.observe(...batch({ direction: period - 1 }, 'same', `tool_${period - 1}`)))
      .toEqual({ period, repetitions: 3, toolNames: Array.from({ length: period }, (_, i) => `tool_${i}`) })
    for (let index = 0; index < 10; index++) {
      expect(monitor.observe(...batch({ direction: index % period }, 'same', `tool_${index % period}`))).toBeNull()
    }
  })

  it('canonicalizes nested object keys and ignores only root _reason', () => {
    const monitor = new ToolRepetitionMonitor()
    monitor.observe(...batch({ nested: { a: 1, b: 2 }, _reason: 'first' }))
    monitor.observe(...batch({ _reason: 'second', nested: { b: 2, a: 1 } }))
    expect(monitor.observe(...batch({ nested: { a: 1, b: 2 } }))).not.toBeNull()
    monitor.reset()
    monitor.observe(...batch({ nested: { _reason: 'first' } }))
    monitor.observe(...batch({ nested: { _reason: 'first' } }))
    expect(monitor.observe(...batch({ nested: { _reason: 'different' } }))).toBeNull()
  })

  it.each(['input', 'output', 'name', 'error'] as const)('does not conflate changed %s with repetition', change => {
    const monitor = new ToolRepetitionMonitor()
    monitor.observe(...batch())
    monitor.observe(...batch())
    const changed = batch(
      change === 'input' ? { path: 'different.txt' } : { path: 'secret.txt' },
      change === 'output' ? 'changed result' : 'private result',
      change === 'name' ? 'fs_write' : 'fs_read',
      change === 'error',
    )
    expect(monitor.observe(...changed)).toBeNull()
  })

  it('observes repeated failures without claiming they were successful', () => {
    const monitor = new ToolRepetitionMonitor()
    monitor.observe(...batch({}, 'denied', 'fs_read', true))
    monitor.observe(...batch({}, 'denied', 'fs_read', true))
    expect(monitor.observe(...batch({}, 'denied', 'fs_read', true))).not.toBeNull()
  })

  it('matches results by call id, but preserves tool execution order', () => {
    const monitor = new ToolRepetitionMonitor()
    const uses: ContentBlock[] = [
      { type: 'tool_use', id: 'a', name: 'read', input: {} },
      { type: 'tool_use', id: 'b', name: 'write', input: {} },
    ]
    const results: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'a', content: 'a' },
      { type: 'tool_result', tool_use_id: 'b', content: 'b' },
    ]
    monitor.observe(uses, results)
    monitor.observe(uses, [...results].reverse())
    expect(monitor.observe(uses, results)?.toolNames).toEqual(['read', 'write'])
    expect(monitor.observe([...uses].reverse(), results)).toBeNull()
  })

  it('does not include call ids in the repeated pattern', () => {
    const monitor = new ToolRepetitionMonitor()
    for (let i = 0; i < 3; i++) {
      const [uses, results] = batch()
      uses[0].id = `call-${i}`
      results[0].tool_use_id = `call-${i}`
      expect(monitor.observe(uses, results) !== null).toBe(i === 2)
    }
  })

  it('preserves array input order', () => {
    const monitor = new ToolRepetitionMonitor()
    monitor.observe(...batch({ values: [1, 2] }))
    monitor.observe(...batch({ values: [1, 2] }))
    expect(monitor.observe(...batch({ values: [2, 1] }))).toBeNull()
  })

  it('reset and intervening nonrepeated work require a fresh contiguous streak', () => {
    const monitor = new ToolRepetitionMonitor()
    for (let i = 0; i < 3; i++) monitor.observe(...batch())
    monitor.reset()
    expect(monitor.observe(...batch())).toBeNull()
    expect(monitor.observe(...batch())).toBeNull()
    expect(monitor.observe(...batch())).not.toBeNull()
    expect(monitor.observe(...batch({ newWork: true }))).toBeNull()
    expect(monitor.observe(...batch())).toBeNull()
    expect(monitor.observe(...batch())).toBeNull()
    expect(monitor.observe(...batch())).not.toBeNull()
  })

  it.each(['missing', 'extra', 'wrong-id', 'interrupted', 'media', 'oversized-input', 'oversized-result', 'cyclic', 'non-json', 'sparse'])(
    'clears history for %s rather than comparing a partial observation', kind => {
      const monitor = new ToolRepetitionMonitor()
      monitor.observe(...batch())
      monitor.observe(...batch())
      const [uses, results] = batch()
      if (kind === 'missing') results.length = 0
      if (kind === 'extra') results.push({ type: 'tool_result', tool_use_id: 'extra', content: 'extra' })
      if (kind === 'wrong-id') results[0].tool_use_id = 'other'
      if (kind === 'interrupted') results[0].interrupted = true
      if (kind === 'media') results.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } })
      if (kind === 'oversized-input') uses[0].input = { text: 'x'.repeat(1024 * 1024) }
      if (kind === 'oversized-result') results[0].content = 'x'.repeat(1024 * 1024)
      if (kind === 'cyclic') { const input: Record<string, unknown> = {}; input.self = input; uses[0].input = input }
      if (kind === 'non-json') uses[0].input = { date: new Date() }
      if (kind === 'sparse') uses[0].input = { values: Array(2) }
      expect(monitor.observe(uses, results)).toBeNull()
      expect(monitor.observe(...batch())).toBeNull()
      expect(monitor.observe(...batch())).toBeNull()
      expect(monitor.observe(...batch())).not.toBeNull()
    },
  )
})
