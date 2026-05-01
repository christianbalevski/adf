/**
 * ALF Messaging Pipeline
 *
 * Messaging-specific middleware built on the generic Pipeline<T, C>.
 * Handles signing, encryption, verification, and decryption of ALF messages.
 *
 * Three-tier middleware architecture:
 * Tier 1 (Runtime): Core crypto — signing, encryption, decryption, verification.
 * Tier 2 (Standard): DID resolution, PoW, thread resolution, rate limiting.
 * Tier 3 (Custom): Agent-installed middleware.
 *
 * Egress order: L3 (custom) → L2 (standard) → L1 (runtime: sign/encrypt)
 * Ingress order: L1 (runtime: verify/decrypt) → L2 (standard) → L3 (custom)
 */

import type { AlfMessage, AlfPayload, SecurityConfig } from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { Pipeline, type MiddlewareFn, type PipelineResult } from './pipeline'
import {
  signEd25519,
  verifyEd25519,
  didToPublicKey,
  rawPublicKeyToSpki
} from '../crypto/identity-crypto'

// ===========================================================================
// Messaging-Specific Context & Types
// ===========================================================================

export interface MessagingPipelineContext {
  direction: 'egress' | 'ingress'
  workspace: AdfWorkspace
  localDid: string
  remoteDid: string
  /** Same-runtime delivery — may skip encryption */
  isLocal: boolean
  security: SecurityConfig
  /** Derived key for accessing password-protected signing keys */
  derivedKey: Buffer | null
  /** Ingress only: request metadata */
  request?: { ip: string }
}

/** Convenience type for the messaging pipeline */
export type MessagingPipeline = Pipeline<AlfMessage, MessagingPipelineContext>

/** Convenience type for messaging middleware functions */
export type MessagingMiddlewareFn = MiddlewareFn<AlfMessage, MessagingPipelineContext>

// Backward-compatible aliases
export type AlfPipelineContext = MessagingPipelineContext
export type AlfMiddlewareFn = MessagingMiddlewareFn
export type AlfPipelineResult = PipelineResult<AlfMessage>

// ===========================================================================
// AlfPipeline — Paired ingress/egress messaging pipeline
// ===========================================================================

/**
 * Paired ingress/egress pipeline for ALF messaging.
 * Wraps two generic Pipeline<AlfMessage> instances.
 */
export class AlfPipeline {
  readonly ingress: MessagingPipeline
  readonly egress: MessagingPipeline

  constructor() {
    this.ingress = new Pipeline<AlfMessage, MessagingPipelineContext>()
    this.egress = new Pipeline<AlfMessage, MessagingPipelineContext>()
  }

  addEgress(fn: MessagingMiddlewareFn): this {
    this.egress.add(fn)
    return this
  }

  addIngress(fn: MessagingMiddlewareFn): this {
    this.ingress.add(fn)
    return this
  }

  async processEgress(message: AlfMessage, ctx: MessagingPipelineContext): Promise<AlfPipelineResult> {
    return this.egress.process(message, ctx)
  }

  async processIngress(message: AlfMessage, ctx: MessagingPipelineContext): Promise<AlfPipelineResult> {
    return this.ingress.process(message, ctx)
  }
}

// ===========================================================================
// Canonical JSON — deterministic serialization for consistent signing
// ===========================================================================

/**
 * Deterministic JSON serialization with sorted keys.
 * Required for consistent signature generation and verification.
 */
export function canonicalJsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((sorted, k) => {
        sorted[k] = value[k]
        return sorted
      }, {})
    }
    return value
  })
}

// ===========================================================================
// Signable Data Extraction
// ===========================================================================

/**
 * Get the data that the message signature covers:
 * everything except `signature` and `transit`.
 */
function getMessageSignableData(message: AlfMessage): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature, transit, ...signable } = message
  return Buffer.from(canonicalJsonStringify(signable))
}

/**
 * Get the data that the payload signature covers:
 * everything except `payload.signature`.
 */
function getPayloadSignableData(payload: AlfPayload): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature, ...signable } = payload
  return Buffer.from(canonicalJsonStringify(signable))
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Stamp a key into message.meta (post-verification, does not affect signature). */
function stampMeta(message: AlfMessage, key: string, value: unknown): AlfMessage {
  return { ...message, meta: { ...message.meta, [key]: value } }
}

// ===========================================================================
// Built-in Middleware Functions
// ===========================================================================

/**
 * EGRESS: Sign the payload with the sender's Ed25519 key.
 * Sets payload.signature. Skips if security level < 1.
 * Rejects if level >= 1 but signing keys are not available.
 */
export const signPayloadMiddleware: MessagingMiddlewareFn = (message, ctx) => {
  if ((ctx.security.level ?? 0) < 1) return { data: message }

  const keys = ctx.workspace.getSigningKeys(ctx.derivedKey)
  if (!keys) {
    return { data: message, rejected: { code: 500, reason: 'Security level requires signing but signing keys are not available. Generate keys in the Identity tab.' } }
  }

  const data = getPayloadSignableData(message.payload)
  const sig = signEd25519(data, keys.privateKey)

  return {
    data: {
      ...message,
      payload: { ...message.payload, signature: `ed25519:${sig}` }
    }
  }
}

/**
 * EGRESS: Sign the full message (minus signature and transit fields).
 * Sets top-level signature. Skips if security level < 1.
 * Rejects if level >= 1 but signing keys are not available.
 */
export const signMessageMiddleware: MessagingMiddlewareFn = (message, ctx) => {
  if ((ctx.security.level ?? 0) < 1) return { data: message }

  const keys = ctx.workspace.getSigningKeys(ctx.derivedKey)
  if (!keys) {
    return { data: message, rejected: { code: 500, reason: 'Security level requires signing but signing keys are not available. Generate keys in the Identity tab.' } }
  }

  const sigData = getMessageSignableData(message)
  const sig = signEd25519(sigData, keys.privateKey)

  return {
    data: { ...message, signature: `ed25519:${sig}` }
  }
}


/**
 * INGRESS: Verify the top-level message signature.
 * Extracts public key from the sender's DID.
 * Rejects if require_signature is set and no signature present.
 * Rejects if signature is present but invalid.
 */
export const verifyMessageSignatureMiddleware: MessagingMiddlewareFn = (message, ctx) => {
  // Wire format: `from` may be a DID, an adapter-prefixed label, or a bare handle.
  // Signature verification is only meaningful when `from` is a DID.
  const senderIsDid = typeof message.from === 'string' && message.from.startsWith('did:')
  if (!message.signature || !senderIsDid) {
    if (ctx.security.require_signature && !ctx.security.allow_unsigned) {
      return { data: message, rejected: { code: 403, reason: 'Message signature required but missing' } }
    }
    // Stamp as not verified (no signature or unsigned-by-design sender)
    return { data: stampMeta(message, 'message_verified', false) }
  }

  // Parse "ed25519:<base64>"
  const parts = message.signature.split(':')
  if (parts.length < 2 || parts[0] !== 'ed25519') {
    return { data: message, rejected: { code: 400, reason: `Unsupported signature algorithm: ${parts[0]}` } }
  }
  const sigBase64 = parts.slice(1).join(':')

  // Extract public key from sender DID
  const rawPubKey = didToPublicKey(message.from)
  if (!rawPubKey) {
    return { data: message, rejected: { code: 400, reason: `Cannot extract public key from DID: ${message.from}` } }
  }
  const spkiKey = rawPublicKeyToSpki(rawPubKey)

  const sigData = getMessageSignableData(message)
  const valid = verifyEd25519(sigData, sigBase64, spkiKey)
  if (!valid) {
    return { data: message, rejected: { code: 403, reason: 'Invalid message signature' } }
  }

  // Stamp as verified — written after signature check so it doesn't affect the signature
  return { data: stampMeta(message, 'message_verified', true) }
}


/**
 * INGRESS: Verify the payload signature.
 * Non-fatal if missing (payload signature is optional per spec).
 * Rejects only if require_payload_signature is set and missing, or if present but invalid.
 */
export const verifyPayloadSignatureMiddleware: MessagingMiddlewareFn = (message, ctx) => {
  // Payload signature verification is only meaningful for DID senders (same rationale as above).
  const senderIsDid = typeof message.from === 'string' && message.from.startsWith('did:')
  if (!message.payload.signature || !senderIsDid) {
    if (ctx.security.require_payload_signature) {
      return { data: message, rejected: { code: 403, reason: 'Payload signature required but missing' } }
    }
    return { data: stampMeta(message, 'payload_verified', false) }
  }

  const parts = message.payload.signature.split(':')
  if (parts.length < 2 || parts[0] !== 'ed25519') {
    return { data: message, rejected: { code: 400, reason: `Unsupported payload signature algorithm: ${parts[0]}` } }
  }
  const sigBase64 = parts.slice(1).join(':')

  // Payload signature is always from the original author (message.from)
  const rawPubKey = didToPublicKey(message.from)
  if (!rawPubKey) {
    return { data: message, rejected: { code: 400, reason: `Cannot extract public key from DID: ${message.from}` } }
  }
  const spkiKey = rawPublicKeyToSpki(rawPubKey)

  const sigData = getPayloadSignableData(message.payload)
  const valid = verifyEd25519(sigData, sigBase64, spkiKey)
  if (!valid) {
    return { data: message, rejected: { code: 403, reason: 'Invalid payload signature' } }
  }

  return { data: stampMeta(message, 'payload_verified', true) }
}

// ===========================================================================
// Default Pipeline Factory
// ===========================================================================

/**
 * Create the default ALF messaging pipeline with runtime signing/verification middleware.
 *
 * Egress: signPayload → signMessage
 * Ingress: verifyMessageSig → verifyPayloadSig
 *
 * Future slots:
 * Egress: signPayload → encryptPayload → addPoW → signMessage
 * Ingress: verifyPoW → verifyMessageSig → decryptPayload → verifyPayloadSig → unwrapWrapper
 */
export function createDefaultPipeline(): AlfPipeline {
  const pipeline = new AlfPipeline()

  // Egress: sign payload first (survives forwarding), then sign message
  pipeline.addEgress(signPayloadMiddleware)
  pipeline.addEgress(signMessageMiddleware)

  // Ingress: verify message signature first (outer), then payload (inner)
  pipeline.addIngress(verifyMessageSignatureMiddleware)
  pipeline.addIngress(verifyPayloadSignatureMiddleware)

  return pipeline
}
