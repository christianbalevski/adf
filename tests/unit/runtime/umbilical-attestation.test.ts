/**
 * Phase 5: the attested umbilical — signed checkpoints over the durable log.
 *
 * Fences here:
 *   - checkpoints fire on the event-count interval AND on the timer, whichever
 *     comes first, and NOT at all when a timer tick has nothing new to cover;
 *   - consecutive ranges abut exactly — no gap, no overlap — so the union of
 *     the checkpoints covers every logged row exactly once;
 *   - the signature is a real Ed25519 signature over the documented canonical
 *     line, verifiable with the same helpers the WS DID handshake uses;
 *   - `verifyUmbilicalLog` catches an edited row, a deleted row, and a forged
 *     signature, and reports chain failures independently of signature ones;
 *   - a missing private key degrades to `unsigned: true` rather than failing;
 *   - the lifecycle's final checkpoint lands AFTER `agent.unloaded` and is the
 *     log's last row.
 *
 * The guarantee under test is tamper-EVIDENCE plus operator non-repudiation. A
 * signature proves a runtime holding the agent's key emitted these events and
 * that nothing downstream altered them. It does NOT prove the actions occurred:
 * nothing here (and nothing that could be written here) stops a malicious
 * runtime from signing fabricated events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentConfigSchema } from '../../../src/main/adf/adf-schema'
import {
  extractRawPublicKey,
  generateEd25519KeyPair,
  publicKeyToDid,
  verifyEd25519,
} from '../../../src/main/crypto/identity-crypto'
import { DaemonEventBus } from '../../../src/main/daemon/event-bus'
import { registerDaemonEventBus } from '../../../src/main/runtime/emit-umbilical'
import {
  DEFAULT_ATTEST_INTERVAL_EVENTS,
  DEFAULT_ATTEST_INTERVAL_MS,
  checkpointCanonicalLine,
  checkpointFromEvent,
  createUmbilicalAttestor,
  hashAgentConfig,
  resolveUmbilicalAttestSettings,
  stableStringify,
  verifyUmbilicalLog,
  type UmbilicalAttestor,
  type UmbilicalCheckpointRecord,
  type UmbilicalLogRowLike,
} from '../../../src/main/runtime/umbilical-attestation'
import {
  clearAllUmbilicalBuses,
  ensureWorkspaceUmbilicalBus,
  type UmbilicalEvent,
} from '../../../src/main/runtime/umbilical-bus'
import { createUmbilicalLifecycleResource } from '../../../src/main/runtime/umbilical-lifecycle'
import {
  DEFAULT_UMBILICAL_LOG_TABLE,
  createUmbilicalLogWriter,
  type UmbilicalLogWriter,
} from '../../../src/main/runtime/umbilical-log-writer'
import type { AgentConfig, UmbilicalConfig } from '../../../src/shared/types/adf-v02.types'

const AGENT_ID = 'agent-1'

interface Harness {
  workspace: AdfWorkspace
  writer: UmbilicalLogWriter
  attestor: UmbilicalAttestor
  publish: (event_type: string, payload?: Record<string, unknown>) => UmbilicalEvent
  rows: () => UmbilicalLogRowLike[]
  checkpoints: () => UmbilicalCheckpointRecord[]
}

describe('umbilical attestation', () => {
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    registerDaemonEventBus(new DaemonEventBus(500))
  })

  afterEach(() => {
    clearAllUmbilicalBuses()
    for (const cleanup of cleanups.splice(0)) cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function makeWorkspace(): AdfWorkspace {
    const dir = mkdtempSync(join(tmpdir(), 'adf-umbilical-attest-'))
    const workspace = AdfWorkspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    cleanups.push(() => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    return workspace
  }

  /** A real keypair, resolved exactly as the production resolver does. */
  function makeIdentity(): { did: string; privateKey: Buffer; publicKey: Buffer } {
    const { privateKey, publicKey } = generateEd25519KeyPair()
    return { did: publicKeyToDid(extractRawPublicKey(publicKey)), privateKey, publicKey }
  }

  function makeHarness(options: {
    umbilical: UmbilicalConfig
    identity?: { did: string | null; privateKey: Buffer | null } | null
    config?: Partial<AgentConfig>
    /** Distinct id per harness — the bus registry is keyed on it. */
    agentId?: string
  }): Harness {
    const agentId = options.agentId ?? AGENT_ID
    const workspace = makeWorkspace()
    const bus = ensureWorkspaceUmbilicalBus(agentId, workspace)
    const captured: UmbilicalEvent[] = []
    bus.subscribe(event => { captured.push(event) })

    const writer = createUmbilicalLogWriter({ agentId, store: workspace, config: options.umbilical })
    if (!writer) throw new Error('log writer must exist for attestation tests')
    writer.attach(bus)

    const attestor = createUmbilicalAttestor({
      agentId,
      writer,
      getConfig: () => ({ id: agentId, name: agentId, ...options.config }),
      umbilical: options.umbilical,
      store: workspace,
      identity: () => options.identity ?? { did: null, privateKey: null },
    })
    if (!attestor) throw new Error('attestor must exist when attest.enabled')
    attestor.attach(bus)

    return {
      workspace,
      writer,
      attestor,
      publish: (event_type, payload = {}) => bus.publish({
        event_type,
        timestamp: 1_700_000_000_000,
        source: 'system:test',
        agent_id: agentId,
        payload,
      }),
      rows: () => workspace.querySQL(
        `SELECT * FROM "${DEFAULT_UMBILICAL_LOG_TABLE}" ORDER BY seq ASC`,
      ) as UmbilicalLogRowLike[],
      checkpoints: () => captured
        .map(checkpointFromEvent)
        .filter((c): c is UmbilicalCheckpointRecord => c !== null),
    }
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  it('is off by default and requires the durable log to be on', () => {
    expect(resolveUmbilicalAttestSettings(undefined)).toBeNull()
    expect(resolveUmbilicalAttestSettings({ log: { enabled: true } })).toBeNull()
    expect(resolveUmbilicalAttestSettings({ log: { enabled: true }, attest: { enabled: false } })).toBeNull()
    // Attestation signs the log's chain; without the log there is nothing to sign.
    expect(resolveUmbilicalAttestSettings({ attest: { enabled: true } })).toBeNull()

    expect(resolveUmbilicalAttestSettings({ log: { enabled: true }, attest: { enabled: true } })).toEqual({
      intervalEvents: DEFAULT_ATTEST_INTERVAL_EVENTS,
      intervalMs: DEFAULT_ATTEST_INTERVAL_MS,
    })
    expect(resolveUmbilicalAttestSettings({
      log: { enabled: true },
      attest: { enabled: true, interval_events: 5, interval_ms: 250 },
    })).toEqual({ intervalEvents: 5, intervalMs: 250 })
  })

  it('rejects attest without log at config validation time, with a message that says why', () => {
    const base = {
      adf_version: '0.2',
      id: AGENT_ID,
      name: 'agent-1',
      handle: 'agent-1',
      metadata: { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    }
    // `base` is deliberately partial — this asserts on the umbilical issue
    // specifically, not on whether the whole config is complete.
    const issuesFor = (umbilical: unknown): string[] => {
      const result = AgentConfigSchema.safeParse({ ...base, umbilical })
      return result.success
        ? []
        : result.error.issues
          .filter(i => i.path.join('.') === 'umbilical.attest.enabled')
          .map(i => i.message)
    }

    const [message, ...rest] = issuesFor({ attest: { enabled: true } })
    expect(rest).toEqual([])
    expect(message).toContain('umbilical.attest.enabled requires umbilical.log.enabled')

    expect(issuesFor({ log: { enabled: true }, attest: { enabled: true } })).toEqual([])
    expect(issuesFor({ log: { enabled: false }, attest: { enabled: false } })).toEqual([])
    expect(issuesFor({ log: { enabled: true } })).toEqual([])
  })

  it('serializes config canonically so key order does not change the hash', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}')
    expect(hashAgentConfig({ a: 1, b: 2 })).toBe(hashAgentConfig({ b: 2, a: 1 }))
    expect(hashAgentConfig({ a: 1 })).not.toBe(hashAgentConfig({ a: 2 }))
    expect(hashAgentConfig({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  it('checkpoints on the event-count interval', () => {
    const identity = makeIdentity()
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 3, interval_ms: 10_000_000 } },
      identity,
    })

    h.publish('tool.completed', { name: 'fs_read' })
    h.publish('tool.completed', { name: 'fs_write' })
    expect(h.checkpoints()).toHaveLength(0)

    const third = h.publish('tool.completed', { name: 'db_query' })
    const checkpoints = h.checkpoints()
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].seq_end).toBe(third.seq)

    // The checkpoint itself is logged, and it is the row after the range it covers.
    const rows = h.rows()
    expect(rows.map(r => r.event_type)).toEqual([
      'tool.completed', 'tool.completed', 'tool.completed', 'umbilical.checkpoint',
    ])
    expect(rows[3].seq).toBe(third.seq + 1)
    expect(rows[3].source).toBe('system:attestation')
  })

  it('checkpoints on the timer when the event count has not been reached', () => {
    vi.useFakeTimers()
    const identity = makeIdentity()
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 1_000_000, interval_ms: 1000 } },
      identity,
    })

    const first = h.publish('tool.completed', { name: 'fs_read' })
    vi.advanceTimersByTime(999)
    expect(h.checkpoints()).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(h.checkpoints()).toHaveLength(1)
    expect(h.checkpoints()[0].seq_end).toBe(first.seq)
  })

  it('skips the timer checkpoint when nothing new has been logged', () => {
    vi.useFakeTimers()
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 1_000_000, interval_ms: 1000 } },
      identity: makeIdentity(),
    })

    // No events at all: nothing to attest, so no checkpoint however long we wait.
    vi.advanceTimersByTime(10_000)
    expect(h.checkpoints()).toHaveLength(0)

    h.publish('tool.completed', { name: 'fs_read' })
    vi.advanceTimersByTime(1000)
    expect(h.checkpoints()).toHaveLength(1)

    // Idle again: the only new row was the checkpoint's own, which it already counted.
    vi.advanceTimersByTime(60_000)
    expect(h.checkpoints()).toHaveLength(1)
    expect(h.rows().filter(r => r.event_type === 'umbilical.checkpoint')).toHaveLength(1)
  })

  it('emits consecutive ranges that abut exactly — no gaps, no overlap', () => {
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 2, interval_ms: 10_000_000 } },
      identity: makeIdentity(),
    })

    for (let i = 0; i < 8; i++) h.publish('tool.completed', { i })
    h.attestor.stop()

    const checkpoints = h.checkpoints()
    expect(checkpoints.length).toBeGreaterThanOrEqual(3)
    for (const cp of checkpoints) expect(cp.seq_end).toBeGreaterThanOrEqual(cp.seq_start)
    for (let i = 1; i < checkpoints.length; i++) {
      expect(checkpoints[i].seq_start).toBe(checkpoints[i - 1].seq_end + 1)
    }

    // The union of the ranges covers every logged row exactly once.
    const rows = h.rows()
    expect(checkpoints[0].seq_start).toBe(rows[0].seq)
    expect(checkpoints[checkpoints.length - 1].seq_end).toBe(rows[rows.length - 2].seq)
    // Only the final checkpoint's own row is left uncovered — it is self-attesting.
    expect(rows[rows.length - 1].event_type).toBe('umbilical.checkpoint')
  })

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  it('signs the documented canonical line with the agent key', () => {
    const identity = makeIdentity()
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 2, interval_ms: 10_000_000 } },
      identity,
    })

    h.publish('agent.loaded', { handle: 'agent-1' })
    h.publish('tool.completed', { name: 'fs_read' })

    const [cp] = h.checkpoints()
    expect(cp.unsigned).toBeUndefined()
    expect(cp.did).toBe(identity.did)
    expect(cp.signature?.startsWith('ed25519:')).toBe(true)
    expect(cp.config_hash).toBe(h.attestor.configHash)

    // Byte-for-byte the line the docs promise.
    const line = `${AGENT_ID}|${cp.seq_start}|${cp.seq_end}|${cp.rolling_hash}|${cp.config_hash}`
    expect(checkpointCanonicalLine(cp)).toBe(line)
    expect(verifyEd25519(
      Buffer.from(line, 'utf8'),
      cp.signature!.slice('ed25519:'.length),
      identity.publicKey,
    )).toBe(true)

    // ...and it does not verify for any other line.
    expect(verifyEd25519(
      Buffer.from(`${line}x`, 'utf8'),
      cp.signature!.slice('ed25519:'.length),
      identity.publicKey,
    )).toBe(false)
  })

  it('re-hashes the live config, so a mid-run config change lands in the next checkpoint', () => {
    const mutableConfig = { description: 'v1' } as Partial<AgentConfig>
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 2, interval_ms: 10_000_000 } },
      config: mutableConfig,
    })

    h.publish('agent.loaded', { handle: 'agent-1' })
    h.publish('tool.completed', { name: 'fs_read' })
    mutableConfig.description = 'v2'
    h.publish('tool.completed', { name: 'fs_read' })
    h.publish('tool.completed', { name: 'fs_read' })

    const cps = h.checkpoints()
    expect(cps.length).toBe(2)
    expect(cps[0].config_hash).not.toBe(cps[1].config_hash)
    expect(cps[1].config_hash).toBe(h.attestor.configHash)
  })

  it('degrades to unsigned checkpoints when no private key is available', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 1, interval_ms: 10_000_000 } },
      identity: { did: null, privateKey: null },
    })

    h.publish('tool.completed', { name: 'fs_read' })
    h.publish('tool.completed', { name: 'fs_write' })

    const checkpoints = h.checkpoints()
    expect(checkpoints.length).toBeGreaterThanOrEqual(2)
    for (const cp of checkpoints) {
      expect(cp.unsigned).toBe(true)
      expect(cp.signature).toBeUndefined()
      expect(cp.did).toBeUndefined()
      expect(cp.rolling_hash).toMatch(/^[0-9a-f]{64}$/)
    }
    // One notice per agent, not one per checkpoint.
    expect(info.mock.calls.filter(c => String(c[0]).includes('UNSIGNED'))).toHaveLength(1)

    // The chain still verifies; only the proof of WHO emitted it is missing.
    const report = verifyUmbilicalLog(h.rows(), checkpoints)
    expect(report.chain_ok).toBe(true)
    expect(report.checkpoints.every(c => c.hash_ok)).toBe(true)
    expect(report.checkpoints.every(c => c.signature_ok === false && c.unsigned === true)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  function signedRun(): { rows: UmbilicalLogRowLike[]; checkpoints: UmbilicalCheckpointRecord[] } {
    const h = makeHarness({
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 3, interval_ms: 10_000_000 } },
      identity: makeIdentity(),
    })
    h.publish('agent.loaded', { handle: 'agent-1' })
    for (let i = 0; i < 8; i++) h.publish('tool.completed', { i })
    h.publish('agent.unloaded', {})
    h.attestor.stop()
    return { rows: h.rows(), checkpoints: h.checkpoints() }
  }

  it('verifies an untampered run end to end', () => {
    const { rows, checkpoints } = signedRun()

    const report = verifyUmbilicalLog(rows, checkpoints)
    expect(report.chain_ok).toBe(true)
    expect(report.first_divergence_seq).toBeUndefined()
    // The whole table is present, so the recomputation starts at the genesis row.
    expect(report.anchored_from_seq).toBeNull()
    expect(report.rows_checked).toBe(rows.length)
    expect(report.checkpoints.length).toBe(checkpoints.length)
    expect(report.checkpoints.every(c => c.hash_ok && c.signature_ok)).toBe(true)
  })

  it('detects an edited payload — the chain breaks at that row', () => {
    const { rows, checkpoints } = signedRun()
    const target = rows[4]

    const tampered = rows.map(r => (r.seq === target.seq ? { ...r, payload_json: '{"i":"rm -rf /"}' } : r))
    const report = verifyUmbilicalLog(tampered, checkpoints)

    expect(report.chain_ok).toBe(false)
    expect(report.first_divergence_seq).toBe(target.seq)
    // Every checkpoint whose range ends at or after the edit is stranded.
    const covering = report.checkpoints.filter(c => c.seq_range[1] >= target.seq)
    expect(covering.length).toBeGreaterThan(0)
    expect(covering.every(c => c.hash_ok === false)).toBe(true)
    // The signatures are untouched and still verify — the two failures are independent.
    expect(covering.every(c => c.signature_ok)).toBe(true)
  })

  it('detects a deleted row — the chain breaks at the row that followed it', () => {
    const { rows, checkpoints } = signedRun()
    const removed = rows[3]
    const next = rows[4]

    const report = verifyUmbilicalLog(rows.filter(r => r.seq !== removed.seq), checkpoints)
    expect(report.chain_ok).toBe(false)
    expect(report.first_divergence_seq).toBe(next.seq)
  })

  it('detects a deleted TAIL row — the chain stays consistent but strands its checkpoint', () => {
    const { rows, checkpoints } = signedRun()
    const last = rows[rows.length - 1]
    // The final checkpoint's own row: dropping it leaves the chain self-consistent.
    expect(last.event_type).toBe('umbilical.checkpoint')
    const finalCheckpoint = checkpoints[checkpoints.length - 1]

    const report = verifyUmbilicalLog(rows.slice(0, -2), checkpoints)
    expect(report.chain_ok).toBe(true)
    const stranded = report.checkpoints.find(c => c.seq_range[1] === finalCheckpoint.seq_end)
    expect(stranded?.hash_ok).toBe(false)
    expect(stranded?.reason).toContain('no row for seq_end')
  })

  it('detects a forged checkpoint signature while the chain still verifies', () => {
    const { rows, checkpoints } = signedRun()
    const attacker = makeIdentity()

    // (a) a signature produced by a DIFFERENT key, still presented under the agent's DID.
    const otherKeyRun = makeHarness({
      agentId: 'agent-2',
      umbilical: { log: { enabled: true }, attest: { enabled: true, interval_events: 1, interval_ms: 10_000_000 } },
      identity: attacker,
    })
    otherKeyRun.publish('tool.completed', { name: 'fs_read' })
    const attackerSignature = otherKeyRun.checkpoints()[0].signature!

    const forged = checkpoints.map((c, i) => (i === 0 ? { ...c, signature: attackerSignature } : c))
    const forgedReport = verifyUmbilicalLog(rows, forged)
    expect(forgedReport.chain_ok).toBe(true)
    expect(forgedReport.checkpoints[0].signature_ok).toBe(false)
    expect(forgedReport.checkpoints[0].hash_ok).toBe(true)
    expect(forgedReport.checkpoints[0].reason).toContain('signature does not verify')
    expect(forgedReport.checkpoints.slice(1).every(c => c.signature_ok)).toBe(true)

    // (b) rewriting the covered range without re-signing it.
    const moved = checkpoints.map((c, i) => (i === 0 ? { ...c, seq_end: c.seq_end + 1 } : c))
    const movedReport = verifyUmbilicalLog(rows, moved)
    expect(movedReport.checkpoints[0].signature_ok).toBe(false)
    expect(movedReport.checkpoints[0].hash_ok).toBe(false)

    // (c) swapping in the attacker's own DID — verifies as the ATTACKER's, which
    //     is the point: non-repudiation is per-key, and this key is not the agent's.
    const swapped = checkpoints.map((c, i) => (i === 0 ? { ...c, did: attacker.did } : c))
    expect(verifyUmbilicalLog(rows, swapped).checkpoints[0].signature_ok).toBe(false)
  })

  it('anchors on the first supplied row when the range is partial', () => {
    const { rows, checkpoints } = signedRun()
    const partial = rows.slice(4)

    const report = verifyUmbilicalLog(partial, checkpoints)
    expect(report.anchored_from_seq).toBe(partial[0].seq)
    expect(report.chain_ok).toBe(true)
    expect(report.rows_checked).toBe(partial.length - 1)
    // Checkpoints whose seq_end fell outside the disclosed range are simply unresolved.
    expect(report.checkpoints.some(c => c.reason?.includes('no row for seq_end'))).toBe(true)

    // With the preceding row's hash as an explicit seed, row 0 is verified too.
    const seeded = verifyUmbilicalLog(partial, checkpoints, undefined, { seedHash: rows[3].rolling_hash })
    expect(seeded.chain_ok).toBe(true)
    expect(seeded.rows_checked).toBe(partial.length)
    expect(seeded.anchored_from_seq).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Lifecycle wiring
  // -------------------------------------------------------------------------

  it('emits a final checkpoint at stop, after agent.unloaded and as the log\'s last row', async () => {
    const workspace = makeWorkspace()
    // Real identity provisioning — the same keystore the WS DID handshake reads.
    const { did } = workspace.generateIdentityKeys(null)

    const config = {
      id: AGENT_ID,
      name: 'agent-1',
      handle: 'agent-1',
      umbilical: {
        log: { enabled: true },
        attest: { enabled: true, interval_events: 1_000_000, interval_ms: 10_000_000 },
      },
    } as unknown as AgentConfig

    const lifecycle = createUmbilicalLifecycleResource({
      agentId: AGENT_ID,
      workspace,
      filePath: null,
      config,
    })

    await lifecycle.start?.()
    expect(lifecycle.getAttestor()).not.toBeNull()
    await lifecycle.stop?.()

    const rows = workspace.querySQL(
      `SELECT * FROM "${DEFAULT_UMBILICAL_LOG_TABLE}" ORDER BY seq ASC`,
    ) as UmbilicalLogRowLike[]
    expect(rows.map(r => r.event_type)).toEqual(['agent.loaded', 'agent.unloaded', 'umbilical.checkpoint'])

    const payload = JSON.parse(rows[2].payload_json) as UmbilicalCheckpointRecord
    expect(payload.did).toBe(did)
    // The unload is INSIDE the final signed range, and the checkpoint's own row is not.
    expect(payload.seq_start).toBe(rows[0].seq)
    expect(payload.seq_end).toBe(rows[1].seq)
    expect(payload.rolling_hash).toBe(rows[1].rolling_hash)

    const report = verifyUmbilicalLog(rows, [{ ...payload, agent_id: AGENT_ID }])
    expect(report.chain_ok).toBe(true)
    expect(report.checkpoints[0]).toMatchObject({ hash_ok: true, signature_ok: true })

    // The resource released both the attestor and the writer.
    expect(lifecycle.getAttestor()).toBeNull()
    expect(lifecycle.getLogWriter()).toBeNull()
  })

  it('creates no attestor when the agent did not opt in', async () => {
    const workspace = makeWorkspace()
    const lifecycle = createUmbilicalLifecycleResource({
      agentId: AGENT_ID,
      workspace,
      filePath: null,
      config: { id: AGENT_ID, name: 'agent-1', handle: 'agent_1' } as unknown as AgentConfig,
    })

    await lifecycle.start?.()
    expect(lifecycle.getAttestor()).toBeNull()
    expect(lifecycle.getLogWriter()).toBeNull()
    await lifecycle.stop?.()
  })
})
