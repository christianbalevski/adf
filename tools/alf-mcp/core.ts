/**
 * ALF MCP core — identity, persistence, and message crypto for the external
 * Claude Code agent. Reuses ADF Studio's own crypto modules so the wire
 * format stays byte-compatible with the runtime.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

import {
  signEd25519,
  verifyEd25519,
  didToPublicKey,
  rawPublicKeyToSpki
} from '../../src/main/crypto/identity-crypto'
import {
  encryptPayloadForDid,
  decryptPayloadWithEd25519,
  isEncryptedPayload
} from '../../src/main/crypto/message-crypto'
import { generateMnemonic, deriveOwnerIdentity } from '../../src/main/crypto/mnemonic-identity'
import { canonicalJsonStringify } from '../../src/main/services/alf-pipeline'
import type { AlfMessage, AlfPayload, AlfAgentCard } from '../../src/shared/types/adf-v02.types'

export const DATA_DIR = process.env.ALF_MCP_DATA_DIR ?? join(homedir(), '.alf-mcp')
export const HANDLE = process.env.ALF_MCP_HANDLE ?? 'claude'
export const DEFAULT_NETWORK = process.env.ALF_MCP_NETWORK ?? 'devnet'

// ===========================================================================
// Identity
// ===========================================================================

export interface Identity {
  did: string
  mnemonic: string
  privateKeyPkcs8: Buffer
  publicKeySpki: Buffer
}

/**
 * Load the persisted identity, or generate one on first run. The mnemonic in
 * identity.json is the recovery artifact — same phrase, same DID, anywhere.
 */
export function loadOrCreateIdentity(): Identity {
  mkdirSync(DATA_DIR, { recursive: true })
  const file = join(DATA_DIR, 'identity.json')
  let mnemonic: string
  if (existsSync(file)) {
    mnemonic = (JSON.parse(readFileSync(file, 'utf-8')) as { mnemonic: string }).mnemonic
  } else {
    mnemonic = generateMnemonic()
    writeFileSync(file, JSON.stringify({ mnemonic, created_at: new Date().toISOString() }, null, 2))
  }
  const { privateKeyPkcs8, publicKeySpki, did } = deriveOwnerIdentity(mnemonic)
  return { did, mnemonic, privateKeyPkcs8, publicKeySpki }
}

// ===========================================================================
// Message construction + crypto (mirrors alf-pipeline egress/ingress order)
// ===========================================================================

/** 22-char globally-unique message id (spec minimum is 20). */
export function newMessageId(): string {
  return `msg_${randomBytes(16).toString('base64url')}`
}

function messageSignable(message: AlfMessage): Buffer {
  const { signature: _s, transit: _t, ...signable } = message
  return Buffer.from(canonicalJsonStringify(signable))
}

function payloadSignable(payload: AlfPayload): Buffer {
  const { signature: _s, ...signable } = payload
  return Buffer.from(canonicalJsonStringify(signable))
}

export interface BuildOpts {
  to: string
  content: string | Record<string, unknown>
  replyTo: string
  cardUrl?: string
  network?: string
  subject?: string
  threadId?: string
  parentId?: string
  contentType?: string
  senderAlias?: string
  recipientAlias?: string
  payloadMeta?: Record<string, unknown>
}

/** Build an unsigned ALF message (same shape as alf-message.ts buildAlfMessage). */
export function buildMessage(opts: BuildOpts, identity: Identity): AlfMessage {
  const now = new Date().toISOString()
  return {
    version: '1.0',
    network: opts.network ?? DEFAULT_NETWORK,
    id: newMessageId(),
    timestamp: now,
    from: identity.did,
    to: opts.to,
    reply_to: opts.replyTo,
    meta: {
      ...(opts.cardUrl && { card: opts.cardUrl })
    },
    payload: {
      ...(opts.payloadMeta && { meta: opts.payloadMeta }),
      ...(opts.senderAlias && { sender_alias: opts.senderAlias }),
      ...(opts.recipientAlias && { recipient_alias: opts.recipientAlias }),
      ...(opts.threadId && { thread_id: opts.threadId }),
      parent_id: opts.parentId ?? null,
      ...(opts.subject && { subject: opts.subject }),
      content: opts.content,
      ...(opts.contentType && { content_type: opts.contentType }),
      sent_at: now
    }
  }
}

/**
 * Egress crypto in the runtime's order: sign payload → encrypt (inner
 * signature travels inside the ciphertext) → sign message (outer signature
 * covers the encrypted form).
 */
export function prepareWire(message: AlfMessage, identity: Identity, encrypt: boolean): AlfMessage {
  let msg: AlfMessage = {
    ...message,
    payload: {
      ...message.payload,
      signature: `ed25519:${signEd25519(payloadSignable(message.payload), identity.privateKeyPkcs8)}`
    }
  }
  if (encrypt) {
    if (!msg.to.startsWith('did:')) throw new Error(`Cannot encrypt: recipient "${msg.to}" is not a DID`)
    const sealed = encryptPayloadForDid(msg.payload, msg.to)
    if (!sealed) throw new Error(`Cannot derive encryption key from recipient DID ${msg.to}`)
    msg = { ...msg, payload: sealed }
  }
  return { ...msg, signature: `ed25519:${signEd25519(messageSignable(msg), identity.privateKeyPkcs8)}` }
}

/** Verify the outer message signature. null = unsigned or non-DID sender. */
export function verifyMessageSignature(message: AlfMessage): boolean | null {
  if (!message.signature || !message.from.startsWith('did:')) return null
  const [alg, ...rest] = message.signature.split(':')
  if (alg !== 'ed25519') return false
  const rawPubKey = didToPublicKey(message.from)
  if (!rawPubKey) return false
  return verifyEd25519(messageSignable(message), rest.join(':'), rawPublicKeyToSpki(rawPubKey))
}

/** Verify the inner payload signature (over plaintext). null = unsigned. */
export function verifyPayloadSignature(message: AlfMessage): boolean | null {
  if (!message.payload.signature || !message.from.startsWith('did:')) return null
  const [alg, ...rest] = message.payload.signature.split(':')
  if (alg !== 'ed25519') return false
  const rawPubKey = didToPublicKey(message.from)
  if (!rawPubKey) return false
  return verifyEd25519(payloadSignable(message.payload), rest.join(':'), rawPublicKeyToSpki(rawPubKey))
}

/** Decrypt an incoming encrypted payload with our key. */
export function decryptIfNeeded(
  message: AlfMessage,
  identity: Identity
): { message: AlfMessage; encrypted: boolean; error?: string } {
  if (!isEncryptedPayload(message.payload)) return { message, encrypted: false }
  const plain = decryptPayloadWithEd25519(message.payload, identity.privateKeyPkcs8)
  if (!plain) {
    return { message, encrypted: true, error: 'Failed to decrypt payload — the message was not encrypted to this agent' }
  }
  return { message: { ...message, payload: plain }, encrypted: true }
}

// ===========================================================================
// Agent card (canonicalization mirrors mesh-server.ts canonicalizeCardForSignature)
// ===========================================================================

function canonicalizeCardForSignature(card: AlfAgentCard): string {
  const signable: Record<string, unknown> = {}
  if (card.did !== undefined) signable.did = card.did
  if (card.public_key !== undefined) signable.public_key = card.public_key
  if (card.signed_at !== undefined) signable.signed_at = card.signed_at
  signable.handle = card.handle
  signable.description = card.description
  if (card.icon !== undefined) signable.icon = card.icon
  if (card.resolution) {
    const { endpoint: _e, ...resolutionRest } = card.resolution as unknown as { endpoint?: string; [k: string]: unknown }
    signable.resolution = resolutionRest
  }
  if (card.mesh_routes !== undefined) signable.mesh_routes = card.mesh_routes
  signable.public = card.public
  signable.shared = card.shared
  if (card.attestations !== undefined) signable.attestations = card.attestations
  if (card.policies !== undefined) signable.policies = card.policies
  return canonicalJsonStringify(signable)
}

export function buildCard(identity: Identity, host: string, port: number): AlfAgentCard {
  const base = `http://${host}:${port}/${HANDLE}/mesh`
  const card: AlfAgentCard = {
    handle: HANDLE,
    description: 'Claude Code — external ALF agent (MCP)',
    icon: '🤖',
    resolution: { method: 'self', endpoint: `${base}/card` },
    endpoints: { inbox: `${base}/inbox`, card: `${base}/card`, health: `${base}/health` },
    public: true,
    shared: [],
    attestations: [],
    policies: [{ type: 'signing', standard: 'ed25519', send: 'required', receive: 'optional' }],
    did: identity.did,
    public_key: identity.did.slice('did:key:'.length),
    signed_at: new Date().toISOString()
  }
  card.signature = `ed25519:${signEd25519(Buffer.from(canonicalizeCardForSignature(card)), identity.privateKeyPkcs8)}`
  return card
}

// ===========================================================================
// Persistence — inbox / outbox / contacts as JSON files under DATA_DIR
// ===========================================================================

export interface InboxRecord {
  id: string
  received_at: string
  read: boolean
  encrypted: boolean
  /** true = valid signature, false = invalid/absent-but-checked, null = unsigned */
  verified: { message: boolean | null; payload: boolean | null }
  return_path?: string
  message: AlfMessage
}

export interface OutboxRecord {
  id: string
  created_at: string
  address: string
  status: 'delivered' | 'failed'
  status_code?: number
  error?: string
  encrypted: boolean
  /** Plaintext copy (pre-encryption) for local reference. */
  message: AlfMessage
}

export interface Contact {
  did: string
  handle?: string
  alias?: string
  inbox_url?: string
  last_seen: string
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as T) : fallback
  } catch {
    return fallback
  }
}

export class Store {
  private inboxFile = join(DATA_DIR, 'inbox.json')
  private outboxFile = join(DATA_DIR, 'outbox.json')
  private contactsFile = join(DATA_DIR, 'contacts.json')

  inbox: InboxRecord[] = loadJson(this.inboxFile, [])
  outbox: OutboxRecord[] = loadJson(this.outboxFile, [])
  contacts: Record<string, Contact> = loadJson(this.contactsFile, {})

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true })
  }

  addInbox(record: InboxRecord): void {
    this.inbox.push(record)
    writeFileSync(this.inboxFile, JSON.stringify(this.inbox, null, 2))
  }

  saveInbox(): void {
    writeFileSync(this.inboxFile, JSON.stringify(this.inbox, null, 2))
  }

  addOutbox(record: OutboxRecord): void {
    this.outbox.push(record)
    writeFileSync(this.outboxFile, JSON.stringify(this.outbox, null, 2))
  }

  upsertContact(partial: Omit<Contact, 'last_seen'>): void {
    const existing = this.contacts[partial.did]
    this.contacts[partial.did] = {
      ...existing,
      ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)),
      did: partial.did,
      last_seen: new Date().toISOString()
    }
    writeFileSync(this.contactsFile, JSON.stringify(this.contacts, null, 2))
  }
}
