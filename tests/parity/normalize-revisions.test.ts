import { describe, expect, it } from 'vitest'
import { normalizeRecording, type NormalizationContext } from './harness/normalize'
import { diffRendered, renderRecording } from './harness/format'
import type { ComparableRecording } from './harness/recording'

/**
 * Rule R18 (W3-F): revision numbers become `<rev#n>` by first appearance and
 * `writer` is compared as is, so two correct runs (other clock, same
 * revisions in the same places) match, and a save over the wrong revision or
 * a change attributed to someone else shows as a difference.
 */

const T0 = Date.parse('2026-10-14T10:00:00.000Z')
const ctx: NormalizationContext = { rootSpellings: [], ports: [], named: [], fixtureIds: [], window: { from: T0, to: T0 + 60_000 } }

/** Read note.md (revision `read`), the agent writes it (`agent`, by `writer`), Studio saves over `base`. */
function run(read: number, agent: number, base: number, writer: unknown): ComparableRecording {
  const steps = [
    { kind: 'invoke', channel: 'adf:doc:read-internal-file', args: [{ path: 'note.md' }], result: { content: 'a', revision: read }, pushes: { before: 0, after: 0 } },
    { kind: 'invoke', channel: 'adf:doc:write-internal-file', args: [{ path: 'note.md', content: 'b', baseRevision: base }], result: { success: false, conflict: { resource: 'note.md', revision: agent, writer } }, pushes: { before: 1, after: 1 } },
  ]
  const pushes = { 'adf:agent:event': [{ type: 'file_updated', payload: { path: 'note.md', content: 'agent', revision: agent, writer } }] }
  return { scenario: 's', steps: steps as ComparableRecording['steps'], pushes, timelines: {}, local: [], llm: [], state: { adf: {}, userDataJson: {}, leases: {}, tree: [] } }
}
const text = (r: ComparableRecording) => renderRecording(normalizeRecording(r, ctx))

describe('R18 revisions', () => {
  it('two runs with other clock-seeded numbers in the same places match', () => {
    const a = run(1792000000000001, 1792000000000002, 1792000000000001, { kind: 'agent' })
    const b = run(1795000000000101, 1795000000000555, 1795000000000101, { kind: 'agent' })
    expect(diffRendered(text(a), text(b))).toBe('')
    expect(text(a)).toContain('baseRevision: "<rev#1>"')
    expect(text(a)).toContain('revision: "<rev#2>"')
  })

  it('a save over another revision than the one read shows', () => {
    const right = run(11, 12, 11, { kind: 'agent' })
    const wrong = run(11, 12, 12, { kind: 'agent' })
    expect(diffRendered(text(right), text(wrong))).not.toBe('')
  })

  it('a change attributed to another writer shows', () => {
    const agent = run(11, 12, 11, { kind: 'agent' })
    const client = run(11, 12, 11, { kind: 'client', client: 'studio' })
    const diff = diffRendered(text(agent), text(client))
    expect(diff).toContain('kind: "agent"')
    expect(diff).toContain('kind: "client"')
  })
})

/** A batch write's answer (DOC_WRITE_INTERNAL_FILES), and a refusal sentence quoting revisions. */
function batch(first: number, second: number, refusal: string, extra: Record<string, unknown> = {}): ComparableRecording {
  const steps = [
    { kind: 'invoke', channel: 'adf:doc:write-internal-files', args: [{}], result: { success: true, revisions: { 'skills/a/SKILL.md': first, 'skills/a/ref.md': second } }, pushes: { before: 0, after: 0 } },
    { kind: 'invoke', channel: 'adf:doc:write-internal-files', args: [{}], result: { success: false, error: refusal, ...extra }, pushes: { before: 0, after: 0 } },
  ]
  return { scenario: 's', steps: steps as ComparableRecording['steps'], pushes: {}, timelines: {}, local: [], llm: [], state: { adf: {}, userDataJson: {}, leases: {}, tree: [] } }
}

describe('R18 revisions, map and sentence forms (skill install batches)', () => {
  const stale = (base: number, now: number) => `"skills/a/ref.md" changed since revision ${base} (now ${now}). Reload it, or save again with baseRevision ${now} to overwrite.`

  it('the same identities in the same places match across clocks', () => {
    const a = batch(1792000000000001, 1792000000000002, stale(1792000000000002, 1792000000000003))
    const b = batch(1795000000000101, 1795000000000555, stale(1795000000000555, 1795000000000999))
    expect(diffRendered(text(a), text(b))).toBe('')
    expect(text(a)).toContain('skills/a/SKILL.md: "<rev#1>"')
    expect(text(a)).toContain('changed since revision <rev#2> (now <rev#3>). Reload it, or save again with baseRevision <rev#3> to overwrite.')
  })

  it('a refusal naming another revision than the one written shows', () => {
    const right = batch(11_000_000_000_000_001, 11_000_000_000_000_002, stale(11_000_000_000_000_002, 11_000_000_000_000_003))
    const wrong = batch(11_000_000_000_000_001, 11_000_000_000_000_002, stale(11_000_000_000_000_001, 11_000_000_000_000_003))
    expect(diffRendered(text(right), text(wrong))).not.toBe('')
  })

  it('two files with one revision, against two with two, shows', () => {
    const same = batch(1792000000000001, 1792000000000001, 'x')
    const distinct = batch(1792000000000001, 1792000000000002, 'x')
    expect(diffRendered(text(same), text(distinct))).not.toBe('')
  })

  it('unrelated prose numbers and similarly named keys are not taken for revisions', () => {
    const t = T0 + 1000
    const prose = text(batch(1, 2, `now ${t * 1000} and at ${t}`, { revisionsCount: 1792000000000009, previsions: { x: 1792000000000009 } }))
    expect(prose).not.toContain('<rev#3>')
    expect(prose).toContain('revisionsCount: 1792000000000009')
    expect(prose).toContain('x: 1792000000000009')
    expect(prose).toContain('error: "now <t> and at <t>"')
  })
})
