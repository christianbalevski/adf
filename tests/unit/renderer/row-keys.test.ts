import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { alignRowKeys, createRowKeyStore, rowsEqual } from '../../../src/renderer/hooks/useRowKeys'

/**
 * Row identity for the editable lists in AgentConfig.
 *
 * LIVE BUG: every one of those lists was keyed by array index. Removing the
 * middle row handed its DOM node — with the caret, the uncontrolled
 * `defaultValue` textarea and the row's own `useState` — to the row that
 * followed it, so deleting binding #1 left binding #2 showing #1's JSON and
 * the focused input jumping a row. Keying on a field is not an option either:
 * every field is rewritten per keystroke, which would remount the row and
 * steal focus on each character.
 *
 * The alignment below is the whole contract: keys survive edits, survive a
 * config echoed back from main after the debounced save, and reset only when
 * another agent owns the list.
 */

const ROOT = join(__dirname, '..', '..', '..')

/** Two middleware refs, as the Security section holds them. */
const mw = (lambda: string) => ({ lambda })

describe('alignRowKeys', () => {
  it('keeps every key when the length is unchanged (in-place edit)', () => {
    const prev = [mw('a.ts:one'), mw('b.ts:two'), mw('c.ts:three')]
    const next = [mw('a.ts:one'), mw('b.ts:twoX'), mw('c.ts:three')]
    const keys = alignRowKeys(['k0', 'k1', 'k2'], prev, next, () => 'minted')
    expect(keys).toEqual(['k0', 'k1', 'k2'])
  })

  it('keeps the survivors and drops exactly one key on a removal', () => {
    const prev = [mw('a'), mw('b'), mw('c')]
    const next = [mw('a'), mw('c')]
    const keys = alignRowKeys(['k0', 'k1', 'k2'], prev, next, () => 'minted')
    expect(keys).toEqual(['k0', 'k2'])
  })

  it('mints one key on append and keeps it on prepend', () => {
    const prev = [mw('a'), mw('b')]
    expect(alignRowKeys(['k0', 'k1'], prev, [...prev, mw('c')], () => 'new')).toEqual(['k0', 'k1', 'new'])
    expect(alignRowKeys(['k0', 'k1'], prev, [mw('z'), ...prev], () => 'new')).toEqual(['new', 'k0', 'k1'])
  })

  it('keeps the common prefix and suffix when an outside write changes the length', () => {
    const prev = [mw('a'), mw('b'), mw('c'), mw('d')]
    const next = [mw('a'), mw('x'), mw('y'), mw('c'), mw('d')]
    let n = 0
    const keys = alignRowKeys(['k0', 'k1', 'k2', 'k3'], prev, next, () => `new${n++}`)
    expect(keys).toEqual(['k0', 'new0', 'new1', 'k2', 'k3'])
  })

  it('mints for a list that was empty', () => {
    let n = 0
    expect(alignRowKeys([], [], [mw('a'), mw('b')], () => `new${n++}`)).toEqual(['new0', 'new1'])
  })
})

describe('rowsEqual', () => {
  it('compares nested config values structurally', () => {
    expect(rowsEqual({ filter: { event_types: ['tool.failed'] } }, { filter: { event_types: ['tool.failed'] } })).toBe(true)
    expect(rowsEqual({ filter: { event_types: ['tool.failed'] } }, { filter: { event_types: ['tool.done'] } })).toBe(false)
    expect(rowsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(rowsEqual(undefined, undefined)).toBe(true)
  })
})

describe('row key store', () => {
  it('holds keys steady while a row is edited per keystroke', () => {
    const store = createRowKeyStore()
    const first = store.sync([{ id: 'ws-a', url: '' }], 'agent-1.adf').keys.slice()
    let keys = first
    for (const url of ['w', 'ws', 'wss', 'wss:']) {
      keys = store.sync([{ id: 'ws-a', url }], 'agent-1.adf').keys
    }
    expect(keys).toEqual(first)
  })

  it('drops only the removed row key when the site reports the removal', () => {
    const store = createRowKeyStore()
    const items = [mw('a'), mw('a'), mw('b')]
    const before = store.sync(items, 'agent-1.adf').keys.slice()
    // Two identical rows: only the explicit removeAt can say which one went.
    store.sync(items, 'agent-1.adf').removeAt(0)
    const after = store.sync([mw('a'), mw('b')], 'agent-1.adf').keys
    expect(after).toEqual([before[1], before[2]])
  })

  it('mints exactly one key for an append and keeps the rest', () => {
    const store = createRowKeyStore()
    const items = [mw('a'), mw('b')]
    const before = store.sync(items, 'agent-1.adf').keys.slice()
    store.sync(items, 'agent-1.adf').append()
    const after = store.sync([...items, mw('c')], 'agent-1.adf').keys
    expect(after.slice(0, 2)).toEqual(before)
    expect(after).toHaveLength(3)
    expect(new Set(after).size).toBe(3)
  })

  it('carries a key along when a row moves', () => {
    const store = createRowKeyStore()
    const items = [mw('a'), mw('b'), mw('c')]
    const before = store.sync(items, 'agent-1.adf').keys.slice()
    store.sync(items, 'agent-1.adf').move(2, 0)
    const after = store.sync([mw('c'), mw('a'), mw('b')], 'agent-1.adf').keys
    expect(after).toEqual([before[2], before[0], before[1]])
  })

  it('keeps keys when main echoes the same config back (new array, same content)', () => {
    const store = createRowKeyStore()
    const before = store.sync([mw('a'), mw('b')], 'agent-1.adf').keys.slice()
    // The debounced save round-trip: fresh objects, identical content.
    const echoed = store.sync([mw('a'), mw('b')], 'agent-1.adf').keys
    expect(echoed).toEqual(before)
  })

  it('keeps the common rows when an outside write changes the length', () => {
    const store = createRowKeyStore()
    const before = store.sync([mw('a'), mw('b'), mw('c')], 'agent-1.adf').keys.slice()
    // sys_update_config dropped the middle rule without going through the UI.
    const after = store.sync([mw('a'), mw('c')], 'agent-1.adf').keys
    expect(after).toEqual([before[0], before[2]])
  })

  it('resets every key when another agent owns the list', () => {
    const store = createRowKeyStore()
    const before = store.sync([mw('a'), mw('b')], 'agent-1.adf').keys.slice()
    const after = store.sync([mw('a'), mw('b')], 'agent-2.adf').keys
    expect(after).toHaveLength(2)
    // Fresh names, so React cannot match a row of the previous agent.
    expect(after.filter((k) => before.includes(k))).toEqual([])
  })

  it('never writes anything into the items it is handed', () => {
    // The same objects go to setAgentConfig, SQLite and the .adf file: a key
    // stashed on a row would leak into the persisted config shape.
    const rows = [Object.freeze({ id: 'ws-a', url: 'wss://x' }), Object.freeze({ id: 'ws-b', url: '' })]
    const store = createRowKeyStore()
    const api = store.sync(rows, 'agent-1.adf')
    api.append()
    api.removeAt(0)
    store.sync(rows, 'agent-1.adf')
    expect(rows.map((r) => Object.keys(r))).toEqual([['id', 'url'], ['id', 'url']])
    expect(rows[0]).toEqual({ id: 'ws-a', url: 'wss://x' })
  })
})

describe('AgentConfig list rendering', () => {
  const source = readFileSync(join(ROOT, 'src', 'renderer', 'components', 'agent', 'AgentConfig.tsx'), 'utf8')

  it('keys no editable row by its array index', () => {
    expect(source).not.toMatch(/key=\{(i|j|k|ti|idx|index)\}/)
  })

  it('never stores a row key inside a config object', () => {
    // The mutation sites spread the item; a key field would ride along into
    // the object passed to save() and on to setAgentConfig.
    expect(source).not.toMatch(/_key:|__id:|_rowKey/)
  })
})
