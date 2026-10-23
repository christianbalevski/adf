import { describe, expect, it } from 'vitest'
import { formatOwnerCommandRow, parseOwnerCommandRow } from '../../../src/shared/utils/owner-command-row'
import { classifyInjectedText, isNoticeCategory, parseLoopToDisplay } from '../../../src/shared/utils/loop-parser'
const header = { v: 1 as const, id: 'cmd_one', command: '/echo hi', lambda: 'lib/a.ts:run', authorized: false, status: 'ok' as const, duration_ms: 4 }
describe('owner command rows', () => {
  it('round trips multiline bodies and classifies standalone context', () => {
    const text = formatOwnerCommandRow(header, 'hello\nworld')
    expect(parseOwnerCommandRow(text)).toEqual({ header, body: 'hello\nworld' })
    expect(classifyInjectedText(text)).toEqual({ content: 'hello\nworld', metadata: { category: 'owner_command', ownerCommand: header } })
    expect(isNoticeCategory('owner_command')).toBe(true)
    const entries = parseLoopToDisplay([{ seq: 1, role: 'user', content_json: [{ type: 'text', text }], created_at: 0 }] as any)
    expect(entries[0]).toMatchObject({ type: 'context', metadata: { category: 'owner_command' } })
  })
  it.each(['[Owner command] {bad', '[Owner command] {"v":2,"id":"x","status":"ok"}', '[Owner command] {"v":1,"id":"x","status":"running"}'])('ignores malformed records', text => expect(parseOwnerCommandRow(text)).toBeNull())
})

it.each([
  { command: {} }, { command: null }, { lambda: [] }, { authorized: 'yes' },
  { duration_ms: -1 }, { duration_ms: null }, { duration_ms: '4' },
])('leaves malformed owner headers as ordinary text: %j', patch => {
  const text = '[Owner command] ' + JSON.stringify({ ...header, ...patch }) + '\nresult'
  expect(parseOwnerCommandRow(text)).toBeNull()
  expect(classifyInjectedText(text)).toBeNull()
  const entries = parseLoopToDisplay([{ seq: 1, role: 'user', content_json: [{ type: 'text', text }], created_at: 0 }] as any)
  expect(entries[0].content).toBe(text)
  expect(entries[0].metadata?.category).not.toBe('owner_command')
})
