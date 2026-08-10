/**
 * Attested umbilical — periodic signed checkpoints over the durable event log.
 *
 * Phase 2 gave every logged row a rolling hash, so the log is a hash chain: any
 * edit or deletion in the middle invalidates every hash after it. That is
 * self-consistency only — an editor who recomputes the chain leaves no trace.
 * A checkpoint fixes that by signing the chain head with the agent's Ed25519
 * identity key at intervals, so the chain cannot be silently rewritten by
 * anyone who does not hold that key.
 *
 * WHAT A SIGNATURE PROVES — exactly this, and no more:
 *
 *   Tamper-evidence + operator non-repudiation. A valid signature proves a
 *   runtime holding the agent's key emitted the events and that nothing
 *   downstream altered them. It does NOT prove the actions occurred: a
 *   malicious runtime signs fabricated events just as happily as real ones.
 *
 * Selective disclosure still works — a verifier can be handed any contiguous
 * row range plus the checkpoints covering it. Omission is *visible* (seq gaps,
 * and a checkpoint whose seq_end has no matching row), not *prevented*.
 *
 * Canonical checkpoint line — the exact bytes that get signed:
 *
 *   `${agent_id}|${seq_start}|${seq_end}|${rolling_hash}|${config_hash}`
 *
 * `rolling_hash` is the chain hash of row `seq_end`, so the signature transitively
 * covers every row from the start of the chain up to that point. Ranges abut
 * exactly: `seq_start` is the previous checkpoint's `seq_end + 1` (or the oldest
 * retained row for the first checkpoint of a table).
 *
 * The checkpoint event is itself logged as a row. It is self-attesting (its own
 * signature is in its payload) and is covered by the NEXT checkpoint, whose
 * range starts at it.
 */

import { createHash } from 'node:crypto'

import { signEd25519, verifyEd25519, didToPublicKey, rawPublicKeyToSpki } from '../crypto/identity-crypto'
import { emitUmbilicalEvent, type EmitUmbilicalInput } from './emit-umbilical'
import type { UmbilicalBus, UmbilicalEvent } from './umbilical-bus'
import type { UmbilicalLogStore, UmbilicalLogWriter } from './umbilical-log-writer'
import type { UmbilicalAttestConfig, UmbilicalConfig } from '../../shared/types/adf-v02.types'

export const DEFAULT_ATTEST_INTERVAL_EVENTS = 1000
export const DEFAULT_ATTEST_INTERVAL_MS = 60_000
/** `source` on every emitted checkpoint. Distinct from `system:lifecycle`. */
export const ATTESTATION_SOURCE = 'system:attestation'
/** Algorithm prefix on `signature`, matching the WS DID auth handshake. */
export const ATTESTATION_SIGNATURE_PREFIX = 'ed25519:'

export interface ResolvedUmbilicalAttestSettings {
  intervalEvents: number
  intervalMs: number
}

/**
 * Config → effective settings, or null when attestation is off (the default).
 *
 * The `attest.enabled` ⇒ `log.enabled` dependency is a hard zod validation
 * error at load time (see adf-schema.ts); this second check keeps a
 * hand-constructed config from producing an attestor with nothing to attest.
 */
export function resolveUmbilicalAttestSettings(
  config: UmbilicalConfig | undefined,
): ResolvedUmbilicalAttestSettings | null {
  const attest: UmbilicalAttestConfig | undefined = config?.attest
  if (!attest?.enabled) return null
  if (!config?.log?.enabled) return null
  return {
    intervalEvents: positiveOr(attest.interval_events, DEFAULT_ATTEST_INTERVAL_EVENTS),
    intervalMs: positiveOr(attest.interval_ms, DEFAULT_ATTEST_INTERVAL_MS),
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback
}

/** The agent's signing identity. Both fields null ⇒ checkpoints go out unsigned. */
export interface AttestationIdentity {
  /** `did:key:z...` for the agent's Ed25519 public key. */
  did: string | null
  /** PKCS8 DER private key, as `AdfWorkspace.getSigningKeys()` returns it. */
  privateKey: Buffer | null
}

/** Resolved per checkpoint, so a key that becomes available mid-run is picked up. */
export type AttestationIdentityResolver = () => AttestationIdentity | null

/** `umbilical.checkpoint` payload. */
export interface UmbilicalCheckpointPayload {
  /** First seq covered. Previous checkpoint's `seq_end + 1`, or the oldest retained row. */
  seq_start: number
  /** Last seq covered — the row whose `rolling_hash` is signed. */
  seq_end: number
  rolling_hash: string
  config_hash: string
  /** `ed25519:<base64>` over the canonical line. Absent when `unsigned`. */
  signature?: string
  /** Signer DID. Absent when `unsigned`. */
  did?: string
  /** True when no private key was available; the chain still holds, the proof does not. */
  unsigned?: boolean
}

export interface UmbilicalAttestorOptions {
  agentId: string
  /** Source of chain head + event counts. Attestation is meaningless without it. */
  writer: UmbilicalLogWriter
  settings: ResolvedUmbilicalAttestSettings
  /** Read and hashed per checkpoint, so mid-run config edits are reflected — see `hashAgentConfig`. */
  getConfig: () => unknown
  identity: AttestationIdentityResolver
  /** Optional `adf_logs` sink for the one-time unsigned notice. */
  store?: UmbilicalLogStore
  /** Injectable for tests; defaults to the real umbilical emitter. */
  emit?: (input: EmitUmbilicalInput) => void
}

/**
 * Periodic checkpoint emitter. Attach AFTER the log writer so the writer has
 * already recorded the event that triggers a count-based checkpoint.
 */
export class UmbilicalAttestor {
  private readonly agentId: string
  private readonly writer: UmbilicalLogWriter
  private readonly settings: ResolvedUmbilicalAttestSettings
  private readonly identity: AttestationIdentityResolver
  private readonly store: UmbilicalLogStore | undefined
  private readonly emit: (input: EmitUmbilicalInput) => void
  private readonly getConfig: () => unknown

  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSeqEnd: number | null = null
  private rowsAtLastCheckpoint = 0
  /** Re-entrancy guard: the checkpoint we emit flows back through our own subscriber. */
  private emitting = false
  private unsignedReported = false
  private checkpointsEmitted = 0

  constructor(options: UmbilicalAttestorOptions) {
    this.agentId = options.agentId
    this.writer = options.writer
    this.settings = options.settings
    this.identity = options.identity
    this.store = options.store
    this.emit = options.emit ?? emitUmbilicalEvent
    this.getConfig = options.getConfig
  }

  /** sha256 of the canonically serialized config as it would be embedded in a checkpoint right now. */
  get configHash(): string {
    return hashAgentConfig(this.getConfig())
  }

  get checkpointCount(): number {
    return this.checkpointsEmitted
  }

  attach(bus: UmbilicalBus): void {
    if (this.unsubscribe) return
    this.rowsAtLastCheckpoint = this.writer.rowsWritten
    this.unsubscribe = bus.subscribe(() => { this.onEvent() })
    this.timer = setInterval(() => { this.checkpoint('timer') }, this.settings.intervalMs)
    // Never hold the process open for a checkpoint.
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref()
    }
  }

  /**
   * Final checkpoint, then stop. Called from the lifecycle stop path AFTER
   * `agent.unloaded` has been emitted (and therefore logged) and BEFORE the
   * writer detaches, so the unload is inside the last signed range.
   */
  stop(): void {
    this.clearTimer()
    this.checkpoint('final')
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Public for tests and for a future `sys_attest` tool. Returns null when skipped. */
  checkpointNow(): UmbilicalCheckpointPayload | null {
    return this.checkpoint('manual')
  }

  private onEvent(): void {
    if (this.emitting) return
    if (this.newRowCount() < this.settings.intervalEvents) return
    this.checkpoint('events')
  }

  private newRowCount(): number {
    return Math.max(0, this.writer.rowsWritten - this.rowsAtLastCheckpoint)
  }

  /**
   * Emit one checkpoint, or nothing when there is nothing new to cover — a
   * timer tick on an idle agent must not produce a checkpoint per minute
   * forever.
   */
  private checkpoint(_reason: 'events' | 'timer' | 'final' | 'manual'): UmbilicalCheckpointPayload | null {
    if (this.emitting) return null
    if (this.newRowCount() === 0) return null

    const head = this.writer.chainHead
    if (head.seq === null || !head.rollingHash) return null
    if (this.lastSeqEnd !== null && head.seq <= this.lastSeqEnd) return null

    // Ranges abut exactly: the row after the previous checkpoint's last row —
    // which, from the second checkpoint on, is the previous checkpoint's own row.
    const seqStart = this.lastSeqEnd !== null
      ? this.lastSeqEnd + 1
      : (this.writer.oldestRetainedSeq() ?? head.seq)

    const payload: UmbilicalCheckpointPayload = {
      seq_start: seqStart,
      seq_end: head.seq,
      rolling_hash: head.rollingHash,
      config_hash: hashAgentConfig(this.getConfig()),
    }

    const line = checkpointCanonicalLine({ agent_id: this.agentId, ...payload })
    const identity = this.identity()
    if (identity?.privateKey && identity.did) {
      try {
        payload.signature = `${ATTESTATION_SIGNATURE_PREFIX}${signEd25519(Buffer.from(line, 'utf8'), identity.privateKey)}`
        payload.did = identity.did
      } catch (error) {
        this.reportUnsigned(`signing failed: ${error instanceof Error ? error.message : String(error)}`)
        payload.unsigned = true
      }
    } else {
      this.reportUnsigned('no Ed25519 private key available for this agent')
      payload.unsigned = true
    }

    this.emitting = true
    try {
      this.emit({
        event_type: 'umbilical.checkpoint',
        agentId: this.agentId,
        source: ATTESTATION_SOURCE,
        payload: { ...payload },
      })
    } finally {
      this.emitting = false
    }

    this.lastSeqEnd = head.seq
    // AFTER the emit, so the checkpoint's own row counts toward the next window
    // (and a zero-new-event timer tick right after this one is skipped).
    this.rowsAtLastCheckpoint = this.writer.rowsWritten
    this.checkpointsEmitted++
    return payload
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Informational, once per attestor: unsigned checkpoints are a degraded mode, not a failure. */
  private reportUnsigned(reason: string): void {
    if (this.unsignedReported) return
    this.unsignedReported = true
    const message = `emitting UNSIGNED checkpoints for ${this.agentId} — ${reason}. The hash chain still detects tampering; the signature would have proved who emitted it.`
    console.info(`[UmbilicalAttest] ${message}`)
    try {
      this.store?.insertLog?.('info', 'runtime', 'umbilical_checkpoint_unsigned', null, message.slice(0, 200))
    } catch { /* non-fatal */ }
  }
}

/**
 * Build an attestor if the agent opted in, otherwise null. The only
 * construction path used in production (`createUmbilicalLifecycleResource`).
 */
export function createUmbilicalAttestor(options: {
  agentId: string
  writer: UmbilicalLogWriter | null
  getConfig: () => unknown
  umbilical: UmbilicalConfig | undefined
  identity: AttestationIdentityResolver
  store?: UmbilicalLogStore
}): UmbilicalAttestor | null {
  if (!options.writer) return null
  const settings = resolveUmbilicalAttestSettings(options.umbilical)
  if (!settings) return null
  return new UmbilicalAttestor({
    agentId: options.agentId,
    writer: options.writer,
    settings,
    getConfig: options.getConfig,
    identity: options.identity,
    store: options.store,
  })
}

// =============================================================================
// Canonicalization
// =============================================================================

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * JSON with object keys sorted at every depth, so two structurally identical
 * configs hash identically regardless of key insertion order. Arrays keep their
 * order (it is meaningful). `undefined` members are dropped, matching
 * JSON.stringify.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * `config_hash` — a fingerprint of the agent configuration in force when the
 * checkpoint was signed, so a verifier can tell that two ranges were produced
 * under the same (or a different) configuration. It is a HASH, not a
 * disclosure: nothing about the config is recoverable from it.
 */
export function hashAgentConfig(config: unknown): string {
  return sha256Hex(stableStringify(config ?? null))
}

/** The exact bytes signed by a checkpoint. */
export function checkpointCanonicalLine(checkpoint: {
  agent_id: string
  seq_start: number
  seq_end: number
  rolling_hash: string
  config_hash: string
}): string {
  return [
    checkpoint.agent_id,
    checkpoint.seq_start,
    checkpoint.seq_end,
    checkpoint.rolling_hash,
    checkpoint.config_hash,
  ].join('|')
}

/** The row-level line Phase 2's writer hashes. Kept here so verification never imports writer internals. */
export function rowCanonicalLine(row: UmbilicalLogRowLike): string {
  return `${row.seq}|${row.event_type}|${row.timestamp}|${row.source}|${row.payload_json}`
}

// =============================================================================
// Verification — the reference implementation a remote verifier runs
// =============================================================================

/** A row as stored in `local_umbilical_log` (extra columns are ignored). */
export interface UmbilicalLogRowLike {
  seq: number
  event_type: string
  timestamp: number
  source: string
  payload_json: string
  rolling_hash: string
}

/** A checkpoint payload plus the `agent_id` from its event envelope. */
export interface UmbilicalCheckpointRecord extends UmbilicalCheckpointPayload {
  agent_id: string
}

/** DID → SPKI DER public key. Defaults to `didKeyPublicKeyResolver`. */
export type PublicKeyResolver = (did: string) => Buffer | null

/** did:key is self-describing, so the default resolver needs no directory. */
export const didKeyPublicKeyResolver: PublicKeyResolver = (did) => {
  const raw = didToPublicKey(did)
  return raw ? rawPublicKeyToSpki(raw) : null
}

export interface UmbilicalCheckpointVerification {
  /** `[seq_start, seq_end]` as claimed by the checkpoint. */
  seq_range: [number, number]
  /** Signature verifies against the resolved public key. Always false when unsigned. */
  signature_ok: boolean
  /** The recomputed chain hash at `seq_end` equals the signed `rolling_hash`. */
  hash_ok: boolean
  /** Present when the checkpoint carried no signature. */
  unsigned?: boolean
  did?: string
  /** Why `signature_ok` / `hash_ok` is false, when it is not obvious. */
  reason?: string
}

export interface UmbilicalVerificationReport {
  /** Every supplied row's stored hash matches the recomputation. */
  chain_ok: boolean
  /** First row whose stored hash disagrees with the recomputation. */
  first_divergence_seq?: number
  checkpoints: UmbilicalCheckpointVerification[]
  rows_checked: number
  /**
   * The row the recomputation was anchored on. `null` when the supplied rows
   * start at the genesis of the chain (verified, not assumed); otherwise the
   * first row is taken on trust as the anchor — the standard consequence of
   * ring pruning or selective disclosure.
   */
  anchored_from_seq: number | null
}

export interface VerifyUmbilicalLogOptions {
  /**
   * `rolling_hash` of the row immediately before `rows[0]` (`''` for genesis).
   * Supply it to verify `rows[0]` too instead of anchoring on it.
   */
  seedHash?: string
}

/**
 * Recompute the chain over `rows` and check every checkpoint against it.
 *
 * What each failure mode looks like:
 *   - an EDITED row → `chain_ok: false`, `first_divergence_seq` = that row;
 *   - a DELETED row → divergence at the row that FOLLOWED it (its chain input
 *     is gone). Deleting the tail instead leaves the chain self-consistent but
 *     strands the covering checkpoint: `hash_ok: false`;
 *   - a FORGED or altered signature → `signature_ok: false` with `chain_ok`
 *     still true. The chain and the signature fail independently, on purpose.
 */
export function verifyUmbilicalLog(
  rows: readonly UmbilicalLogRowLike[],
  checkpoints: readonly UmbilicalCheckpointRecord[],
  publicKeyResolver: PublicKeyResolver = didKeyPublicKeyResolver,
  options: VerifyUmbilicalLogOptions = {},
): UmbilicalVerificationReport {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq)

  // Where to start: an explicit seed, a detected genesis, or the first row as
  // a trusted anchor (what a verifier holding a pruned or partial range gets).
  let prev: string
  let startIndex: number
  let anchoredFrom: number | null = null
  if (options.seedHash !== undefined) {
    prev = options.seedHash
    startIndex = 0
  } else if (sorted.length > 0 && sha256Hex(`\n${rowCanonicalLine(sorted[0])}`) === sorted[0].rolling_hash) {
    prev = ''
    startIndex = 0
  } else {
    prev = sorted.length > 0 ? sorted[0].rolling_hash : ''
    startIndex = sorted.length > 0 ? 1 : 0
    anchoredFrom = sorted.length > 0 ? sorted[0].seq : null
  }

  const recomputed = new Map<number, string>()
  if (startIndex === 1) recomputed.set(sorted[0].seq, sorted[0].rolling_hash)

  let chainOk = true
  let firstDivergenceSeq: number | undefined
  for (let i = startIndex; i < sorted.length; i++) {
    const row = sorted[i]
    // Chained from the RECOMPUTED value, not the stored one: one edit poisons
    // everything after it, which is exactly the property being claimed.
    const hash = sha256Hex(`${prev}\n${rowCanonicalLine(row)}`)
    recomputed.set(row.seq, hash)
    if (hash !== row.rolling_hash) {
      chainOk = false
      if (firstDivergenceSeq === undefined) firstDivergenceSeq = row.seq
    }
    prev = hash
  }

  const checkpointResults = checkpoints.map(checkpoint => verifyCheckpoint(checkpoint, recomputed, publicKeyResolver))

  const report: UmbilicalVerificationReport = {
    chain_ok: chainOk,
    checkpoints: checkpointResults,
    rows_checked: Math.max(0, sorted.length - startIndex),
    anchored_from_seq: anchoredFrom,
  }
  if (firstDivergenceSeq !== undefined) report.first_divergence_seq = firstDivergenceSeq
  return report
}

function verifyCheckpoint(
  checkpoint: UmbilicalCheckpointRecord,
  recomputed: ReadonlyMap<number, string>,
  publicKeyResolver: PublicKeyResolver,
): UmbilicalCheckpointVerification {
  const result: UmbilicalCheckpointVerification = {
    seq_range: [checkpoint.seq_start, checkpoint.seq_end],
    signature_ok: false,
    hash_ok: false,
  }

  const recomputedEnd = recomputed.get(checkpoint.seq_end)
  if (recomputedEnd === undefined) {
    result.reason = `no row for seq_end ${checkpoint.seq_end} in the supplied range`
  } else if (recomputedEnd !== checkpoint.rolling_hash) {
    result.reason = 'recomputed chain hash does not match the signed rolling_hash'
  } else {
    result.hash_ok = true
  }

  if (!checkpoint.signature || checkpoint.unsigned) {
    result.unsigned = true
    result.reason ??= 'checkpoint carries no signature'
    return result
  }
  if (!checkpoint.did) {
    result.reason ??= 'checkpoint carries a signature but no did'
    return result
  }
  result.did = checkpoint.did

  if (!checkpoint.signature.startsWith(ATTESTATION_SIGNATURE_PREFIX)) {
    result.reason ??= 'unsupported signature algorithm'
    return result
  }
  const publicKey = publicKeyResolver(checkpoint.did)
  if (!publicKey) {
    result.reason ??= `no public key for ${checkpoint.did}`
    return result
  }

  const line = checkpointCanonicalLine(checkpoint)
  const signatureBase64 = checkpoint.signature.slice(ATTESTATION_SIGNATURE_PREFIX.length)
  result.signature_ok = verifyEd25519(Buffer.from(line, 'utf8'), signatureBase64, publicKey)
  if (!result.signature_ok) result.reason ??= 'signature does not verify against the signer DID'
  return result
}

/** Narrow an umbilical event to a checkpoint record, or null. Convenience for verifiers tailing `/events`. */
export function checkpointFromEvent(event: UmbilicalEvent): UmbilicalCheckpointRecord | null {
  if (event.event_type !== 'umbilical.checkpoint') return null
  const payload = event.payload as Partial<UmbilicalCheckpointPayload>
  if (typeof payload?.seq_start !== 'number' || typeof payload?.seq_end !== 'number') return null
  if (typeof payload.rolling_hash !== 'string' || typeof payload.config_hash !== 'string') return null
  return {
    agent_id: event.agent_id ?? '',
    seq_start: payload.seq_start,
    seq_end: payload.seq_end,
    rolling_hash: payload.rolling_hash,
    config_hash: payload.config_hash,
    signature: typeof payload.signature === 'string' ? payload.signature : undefined,
    did: typeof payload.did === 'string' ? payload.did : undefined,
    unsigned: payload.unsigned === true ? true : undefined,
  }
}
