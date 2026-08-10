/**
 * Phase 2: the opt-in durable umbilical log.
 *
 * Fences here:
 *   - opt-in — no config, no table (this is the default for every agent);
 *   - the table is agent-space `local_*`, written by the runtime at publish time;
 *   - exclusions (built-in + configured) never reach the table;
 *   - oversize payloads are stubbed, not stored;
 *   - the ring stays bounded;
 *   - the rolling-hash chain recomputes independently over the stored rows and
 *     survives a restart (a fresh writer over the existing table continues it).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import {
  clearAllUmbilicalBuses,
  destroyUmbilicalBus,
  ensureWorkspaceUmbilicalBus,
  type UmbilicalBus,
  type UmbilicalEvent,
} from '../../../src/main/runtime/umbilical-bus'
import {
  DEFAULT_UMBILICAL_LOG_TABLE,
  UMBILICAL_LOG_PREVIEW_CHARS,
  createUmbilicalLogWriter,
  resolveUmbilicalLogSettings,
  type UmbilicalLogWriter,
} from '../../../src/main/runtime/umbilical-log-writer'
import type { UmbilicalConfig } from '../../../src/shared/types/adf-v02.types'

const AGENT_ID = 'agent-1'

interface LogRow {
  seq: number
  event_type: string
  timestamp: number
  source: string
  payload_json: string
  truncated: number
  rolling_hash: string
}

describe('umbilical log writer', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    clearAllUmbilicalBuses()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function makeWorkspace(): AdfWorkspace {
    const dir = mkdtempSync(join(tmpdir(), 'adf-umbilical-log-'))
    const workspace = AdfWorkspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    cleanups.push(() => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    return workspace
  }

  function attachWriter(workspace: AdfWorkspace, umbilical: UmbilicalConfig | undefined): {
    bus: UmbilicalBus
    writer: UmbilicalLogWriter | null
    publish: (event_type: string, payload?: Record<string, unknown>) => UmbilicalEvent
  } {
    // Same construction production uses: seq continues across restarts because
    // it is reserved in workspace meta, not in the bus object.
    const bus = ensureWorkspaceUmbilicalBus(AGENT_ID, workspace)
    const writer = createUmbilicalLogWriter({ agentId: AGENT_ID, store: workspace, config: umbilical })
    writer?.attach(bus)
    return {
      bus,
      writer,
      publish: (event_type, payload = {}) => bus.publish({
        event_type,
        timestamp: 1_700_000_000_000,
        source: 'system:test',
        agent_id: AGENT_ID,
        payload,
      }),
    }
  }

  function readRows(workspace: AdfWorkspace, table = DEFAULT_UMBILICAL_LOG_TABLE): LogRow[] {
    return workspace.querySQL(`SELECT * FROM "${table}" ORDER BY seq ASC`) as LogRow[]
  }

  function tableExists(workspace: AdfWorkspace, table = DEFAULT_UMBILICAL_LOG_TABLE): boolean {
    return workspace.listLocalTables().some(t => t.name === table)
  }

  /** Independent re-derivation of the chain — never reuses writer internals. */
  function recomputeChain(rows: LogRow[], seed = ''): string[] {
    let prev = seed
    return rows.map(row => {
      const line = `${row.seq}|${row.event_type}|${row.timestamp}|${row.source}|${row.payload_json}`
      prev = createHash('sha256').update(`${prev}\n${line}`, 'utf8').digest('hex')
      return prev
    })
  }

  it('is off by default — no config means no table', () => {
    const workspace = makeWorkspace()
    const { writer, publish } = attachWriter(workspace, undefined)

    publish('tool.completed', { name: 'fs_read' })

    expect(writer).toBeNull()
    expect(tableExists(workspace)).toBe(false)
    expect(resolveUmbilicalLogSettings(undefined)).toBeNull()
    expect(resolveUmbilicalLogSettings({ stream_deltas: true })).toBeNull()
    expect(resolveUmbilicalLogSettings({ log: { enabled: false } })).toBeNull()
  })

  it('rejects a table name outside the agent-space local_ namespace', () => {
    expect(resolveUmbilicalLogSettings({ log: { enabled: true, table: 'adf_logs' } })).toBeNull()
    expect(resolveUmbilicalLogSettings({ log: { enabled: true, table: 'events' } })).toBeNull()
    expect(resolveUmbilicalLogSettings({ log: { enabled: true, table: 'local_events' } })).toEqual(
      expect.objectContaining({ table: 'local_events', maxEvents: 2000 }),
    )
  })

  it('writes through on publish into the configured local_ table', () => {
    const workspace = makeWorkspace()
    const { publish } = attachWriter(workspace, { log: { enabled: true, table: 'local_events' } })

    const first = publish('agent.loaded', { handle: 'agent-1' })
    const second = publish('tool.completed', { name: 'fs_read', ok: true })

    const rows = readRows(workspace, 'local_events')
    expect(rows.map(r => [r.seq, r.event_type])).toEqual([
      [first.seq, 'agent.loaded'],
      [second.seq, 'tool.completed'],
    ])
    expect(JSON.parse(rows[1].payload_json)).toEqual({ name: 'fs_read', ok: true })
    expect(rows[1].truncated).toBe(0)
    expect(rows[1].source).toBe('system:test')
    // The default table is not touched when another one is configured.
    expect(tableExists(workspace)).toBe(false)
  })

  it('excludes turn.delta and binding.flow_summary always, plus configured types', () => {
    const workspace = makeWorkspace()
    const { publish } = attachWriter(workspace, {
      log: { enabled: true, exclude_types: ['mcp.log'] },
    })

    publish('turn.delta', { text: 'hel' })
    publish('binding.flow_summary', { bytes: 12 })
    publish('mcp.log', { name: 'server' })
    publish('turn.completed', { tokens: 42 })

    expect(readRows(workspace).map(r => r.event_type)).toEqual(['turn.completed'])
  })

  it('truncates oversize payloads into a preview stub and flags the row', () => {
    const workspace = makeWorkspace()
    const { publish } = attachWriter(workspace, { log: { enabled: true } })

    const big = 'x'.repeat(20_000)
    publish('tool.completed', { name: 'fs_read', content: big })
    publish('tool.completed', { name: 'small' })

    const [truncatedRow, plainRow] = readRows(workspace)
    expect(truncatedRow.truncated).toBe(1)
    const stub = JSON.parse(truncatedRow.payload_json) as { _truncated: boolean; preview: string }
    expect(stub._truncated).toBe(true)
    expect(stub.preview.length).toBe(UMBILICAL_LOG_PREVIEW_CHARS)
    expect(stub.preview.startsWith('{"name":"fs_read"')).toBe(true)
    expect(plainRow.truncated).toBe(0)
  })

  it('prunes to max_events once the ring overflows', () => {
    const workspace = makeWorkspace()
    // 100 inserts between prunes, so 250 events settle to <= 250 with the tail kept.
    const { publish, writer } = attachWriter(workspace, { log: { enabled: true, max_events: 150 } })

    const seqs: number[] = []
    for (let i = 0; i < 400; i++) seqs.push(publish('tool.completed', { i }).seq)
    writer?.detach()

    const rows = readRows(workspace)
    expect(rows.length).toBeLessThanOrEqual(150)
    expect(rows.length).toBeGreaterThan(0)
    // Oldest go first: the newest event is always still there.
    expect(rows[rows.length - 1].seq).toBe(seqs[seqs.length - 1])
    expect(rows[0].seq).toBeGreaterThan(seqs[0])
  })

  it('chains rolling hashes so an independent recomputation matches', () => {
    const workspace = makeWorkspace()
    const { publish } = attachWriter(workspace, { log: { enabled: true } })

    publish('agent.loaded', { handle: 'agent-1' })
    publish('tool.completed', { name: 'fs_read' })
    publish('tool.completed', { name: 'x'.repeat(20_000) })
    publish('agent.unloaded', {})

    const rows = readRows(workspace)
    expect(rows).toHaveLength(4)
    expect(recomputeChain(rows)).toEqual(rows.map(r => r.rolling_hash))
    // A tampered payload breaks verification from that row onward.
    const tampered = rows.map((r, i) => (i === 1 ? { ...r, payload_json: '{"name":"rm -rf"}' } : r))
    expect(recomputeChain(tampered)[1]).not.toBe(rows[1].rolling_hash)
  })

  it('seeds from the last row on restart so the chain continues across writers', () => {
    const workspace = makeWorkspace()
    const first = attachWriter(workspace, { log: { enabled: true } })
    first.publish('agent.loaded', { handle: 'agent-1' })
    first.publish('tool.completed', { name: 'fs_read' })
    first.writer?.detach()

    const beforeRestart = readRows(workspace)

    // New bus, new writer, same table — as after an agent stop/start.
    destroyUmbilicalBus(AGENT_ID)
    const second = attachWriter(workspace, { log: { enabled: true } })
    second.publish('agent.loaded', { handle: 'agent-1' })
    second.writer?.detach()

    const rows = readRows(workspace)
    expect(rows).toHaveLength(3)
    // One unbroken chain across the restart boundary.
    expect(recomputeChain(rows)).toEqual(rows.map(r => r.rolling_hash))
    expect(rows.slice(0, 2).map(r => r.rolling_hash)).toEqual(beforeRestart.map(r => r.rolling_hash))
  })

  it('never breaks emission when the write fails', () => {
    const workspace = makeWorkspace()
    const { publish, writer } = attachWriter(workspace, { log: { enabled: true } })
    publish('agent.loaded', {})

    // Simulate a hostile DB: every subsequent statement throws.
    const original = workspace.executeSQL.bind(workspace)
    workspace.executeSQL = () => { throw new Error('disk I/O error') }

    expect(() => publish('tool.completed', { name: 'fs_read' })).not.toThrow()
    expect(() => publish('tool.completed', { name: 'fs_write' })).not.toThrow()
    expect(writer?.failures).toBe(2)

    workspace.executeSQL = original
    expect(readRows(workspace)).toHaveLength(1)
  })

  it('stops writing after detach', () => {
    const workspace = makeWorkspace()
    const { publish, writer } = attachWriter(workspace, { log: { enabled: true } })
    publish('agent.loaded', {})
    writer?.detach()
    publish('tool.completed', { name: 'fs_read' })

    expect(readRows(workspace).map(r => r.event_type)).toEqual(['agent.loaded'])
  })
})
