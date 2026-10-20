import { describe, it, expect, beforeEach, vi } from 'vitest'
import { clearDockState, dockStateKey, elementAtPath, elementPath, readDockState, writeDockState } from '../../../src/renderer/stores/dock-panel-state'
import { appendLogs, filterLogs, showingLabel } from '../../../src/renderer/components/logs/logs-model'
import { createDebouncedRefresh, isFileUpdatedEvent, sortByRecent } from '../../../src/renderer/utils/agent-files'
import { ageInSeconds, relativeTime, toEpochMs } from '../../../src/renderer/utils/relative-time'
import { matchesInboxSearch, matchesOutboxSearch } from '../../../src/renderer/components/inbox/inbox-search'
import type { AdfLogEntry } from '../../../src/shared/types/adf-v02.types'
import type { InboxMessage, RendererOutboxMessage } from '../../../src/shared/types/adf.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

/** The dock and bottom panels' pure parts: per-agent view memory, logs, files, inbox search, times. */

const AGENT_1 = '/agents/agent-1.adf'
const AGENT_2 = '/agents/agent-2.adf'

describe('dock panel memory', () => {
  beforeEach(() => clearDockState())

  it('keys by agent, panel and field', () => {
    writeDockState(dockStateKey(AGENT_1, 'files', 'filter'), 'notes')
    expect(readDockState(dockStateKey(AGENT_1, 'files', 'filter'), '')).toBe('notes')
    expect(readDockState(dockStateKey(AGENT_2, 'files', 'filter'), '')).toBe('')
    expect(readDockState(dockStateKey(AGENT_1, 'inbox', 'filter'), 'all')).toBe('all')
  })

  it('finds the scrolled element again by its child-index path', () => {
    type Node = { parentElement: Node | null; children: Node[] }
    const mk = (parent: Node | null): Node => {
      const n: Node = { parentElement: parent, children: [] }
      parent?.children.push(n)
      return n
    }
    const root = mk(null)
    const wrapper = mk(root)
    mk(wrapper) // header
    const list = mk(wrapper)
    const path = elementPath(root as unknown as Element, list as unknown as Element)
    expect(path).toEqual([0, 1])
    expect(elementAtPath(root as unknown as Element, path!)).toBe(list)
    expect(elementAtPath(root as unknown as Element, [0, 5])).toBeNull()
    const stray = mk(null)
    expect(elementPath(root as unknown as Element, stray as unknown as Element)).toBeNull()
  })
})

const log = (id: number, over: Partial<AdfLogEntry> = {}): AdfLogEntry => ({
  id, level: 'info', origin: null, event: null, target: null, message: `m${id}`, data: null, created_at: id, ...over
})

describe('logs', () => {
  it('text filter matches message, origin, event, target and data, case-insensitively', () => {
    const logs = [
      log(1, { message: 'Started loop' }),
      log(2, { origin: 'adapter:telegram' }),
      log(3, { event: 'tool_call' }),
      log(4, { target: 'notes.md' }),
      log(5, { data: '{"error":"Timeout"}' }),
    ]
    const by = (text: string) => filterLogs(logs, { level: 'all', origin: 'all', text }).map((l) => l.id)
    expect(by('started')).toEqual([1])
    expect(by('TELEGRAM')).toEqual([2])
    expect(by('tool_')).toEqual([3])
    expect(by('notes.md')).toEqual([4])
    expect(by('timeout')).toEqual([5])
    expect(by('  ')).toHaveLength(5)
  })

  it('no filter returns the same array (the panel uses identity to know it is not filtering)', () => {
    const logs = [log(1)]
    expect(filterLogs(logs, { level: 'all', origin: 'all', text: '' })).toBe(logs)
  })

  it('level and origin filters combine with text', () => {
    const logs = [log(1, { level: 'error', message: 'boom' }), log(2, { level: 'info', message: 'boom' })]
    expect(filterLogs(logs, { level: 'error', origin: 'all', text: 'boom' }).map((l) => l.id)).toEqual([1])
  })

  it('appends only newer ids and trims the oldest past the cap', () => {
    const { logs, added } = appendLogs([log(1), log(2)], [log(2), log(3), log(4)], 3)
    expect(added).toBe(2)
    expect(logs.map((l) => l.id)).toEqual([2, 3, 4])
    const same = [log(1)]
    expect(appendLogs(same, [log(1)], 10)).toEqual({ logs: same, added: 0 })
  })

  it('footer label never shows fewer total than shown', () => {
    expect(showingLabel(500, 1234)).toBe(`Showing 500 of ${(1234).toLocaleString()}`)
    expect(showingLabel(12, 3)).toBe('Showing 12 of 12')
  })
})

describe('files', () => {
  it('Recent sorts newest change first, then by path', () => {
    const files = [
      { path: 'a.md', updated_at: '2026-10-01T10:00:00.000Z' },
      { path: 'c.md', updated_at: '2026-10-20T10:00:00.000Z' },
      { path: 'b.md', updated_at: '2026-10-20T10:00:00.000Z' },
      { path: 'x.md', updated_at: 'garbage' },
    ]
    expect(sortByRecent(files).map((f) => f.path)).toEqual(['b.md', 'c.md', 'a.md', 'x.md'])
  })

  it('file_updated with a path counts as a change signal', () => {
    const ev = (type: string, payload: unknown) => ({ type, payload, timestamp: 1 }) as AgentExecutionEvent
    expect(isFileUpdatedEvent(ev('file_updated', { path: 'notes.md' }))).toBe(true)
    expect(isFileUpdatedEvent(ev('file_updated', {}))).toBe(false)
    expect(isFileUpdatedEvent(ev('document_updated', { path: 'README.md' }))).toBe(false)
    expect(isFileUpdatedEvent(undefined)).toBe(false)
  })

  it('a burst of signals costs one refetch', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const d = createDebouncedRefresh(refresh, 300)
      d.trigger(); d.trigger()
      vi.advanceTimersByTime(250)
      d.trigger() // the files scope, 250 ms after file_updated
      vi.advanceTimersByTime(299)
      expect(refresh).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(refresh).toHaveBeenCalledTimes(1)
      d.trigger(); d.cancel()
      vi.advanceTimersByTime(1000)
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('relative times', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0)
  it('reads short and then falls back to the date', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(relativeTime(now - 30 * 86_400_000, now)).not.toMatch(/ago/)
    expect(relativeTime(NaN, now)).toBe('')
  })

  it('freshness ages count seconds first', () => {
    expect(ageInSeconds(now - 12_000, now)).toBe('12s ago')
    expect(ageInSeconds(now - 120_000, now)).toBe('2m ago')
    expect(ageInSeconds(now + 5000, now)).toBe('0s ago')
  })

  it('parses ISO and SQLite UTC datetimes alike', () => {
    expect(toEpochMs('2026-10-20T12:00:00.000Z')).toBe(now)
    expect(toEpochMs('2026-10-20 12:00:00')).toBe(now)
    expect(toEpochMs(now)).toBe(now)
    expect(toEpochMs(null)).toBeNaN()
  })
})

describe('inbox search', () => {
  const msg = (over: Partial<InboxMessage>): InboxMessage => ({
    id: '6f1c2c3e-0d7a-4b8e-9f21-3c4d5e6f7a81', from: 'did:key:agent-1', content: 'hello there', received_at: 1, status: 'unread', ...over
  })
  const sent = (over: Partial<RendererOutboxMessage>): RendererOutboxMessage => ({
    id: '0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f', from: 'did:key:agent-1', to: 'did:key:agent-2', content: 'report', status: 'sent', created_at: 1, ...over
  })

  it('matches sender address and alias, subject and body', () => {
    expect(matchesInboxSearch(msg({}), 'AGENT-1')).toBe(true)
    expect(matchesInboxSearch(msg({ sender_alias: 'agent-7' }), 'agent-7')).toBe(true)
    expect(matchesInboxSearch(msg({ subject: 'Weekly sync' }), 'weekly')).toBe(true)
    expect(matchesInboxSearch(msg({}), 'there')).toBe(true)
    expect(matchesInboxSearch(msg({}), 'absent')).toBe(false)
    expect(matchesInboxSearch(msg({}), '')).toBe(true)
  })

  it('Sent matches recipient, subject and body', () => {
    expect(matchesOutboxSearch(sent({}), 'agent-2')).toBe(true)
    expect(matchesOutboxSearch(sent({ recipient_alias: 'agent-9' }), 'agent-9')).toBe(true)
    expect(matchesOutboxSearch(sent({}), 'REPORT')).toBe(true)
    expect(matchesOutboxSearch(sent({}), 'nothing')).toBe(false)
  })
})
