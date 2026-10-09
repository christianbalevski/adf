/**
 * Identity drafts: Ed25519 keypairs minted before an agent exists, so the
 * create screen can show the agent's real DID (and its orbital) while the
 * user is still naming it. The create call names a draft by id and the new
 * file adopts exactly those keys.
 *
 * The private key stays in this process. Only { draftId, did } crosses IPC.
 * Drafts are held in memory only, expire after a TTL, are capped (oldest
 * evicted first), and are consumed on take. Dropped drafts have their
 * private key bytes zeroed.
 */

import { randomUUID } from 'crypto'
import { extractRawPublicKey, generateEd25519KeyPair, publicKeyToDid } from '../crypto/identity-crypto'

export interface IdentityKeyPair {
  /** PKCS8 DER. */
  privateKey: Buffer
  /** SPKI DER. */
  publicKey: Buffer
}

export interface IdentityDraftKeys extends IdentityKeyPair {
  did: string
}

interface Draft extends IdentityDraftKeys {
  expiresAt: number
}

export const IDENTITY_DRAFT_TTL_MS = 30 * 60 * 1000
export const IDENTITY_DRAFT_CAP = 16

export interface IdentityDraftStoreOptions {
  ttlMs?: number
  cap?: number
  now?: () => number
  /** Off in tests that drive `now` by hand. */
  scheduleSweep?: boolean
}

export class IdentityDraftStore {
  private readonly drafts = new Map<string, Draft>()
  private readonly ttlMs: number
  private readonly cap: number
  private readonly now: () => number
  private readonly scheduleSweep: boolean
  private sweepTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: IdentityDraftStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? IDENTITY_DRAFT_TTL_MS
    this.cap = opts.cap ?? IDENTITY_DRAFT_CAP
    this.now = opts.now ?? Date.now
    this.scheduleSweep = opts.scheduleSweep ?? true
  }

  /** Mint a keypair and hold it. Returns only the id and the public DID. */
  mint(): { draftId: string; did: string } {
    this.sweep()
    while (this.drafts.size >= this.cap) {
      // Map keeps insertion order: the first key is the oldest draft.
      const oldest = this.drafts.keys().next().value as string
      this.drop(oldest)
    }
    const { privateKey, publicKey } = generateEd25519KeyPair()
    const did = publicKeyToDid(extractRawPublicKey(publicKey))
    const draftId = randomUUID()
    this.drafts.set(draftId, { privateKey, publicKey, did, expiresAt: this.now() + this.ttlMs })
    this.armSweep()
    return { draftId, did }
  }

  /**
   * Remove the draft and hand its keys to the caller, once. Null for an
   * unknown or expired id. The caller owns the returned buffers and should
   * zero the private key when done with it.
   */
  take(draftId: string): IdentityDraftKeys | null {
    this.sweep()
    const draft = this.drafts.get(draftId)
    if (!draft) return null
    this.drafts.delete(draftId)
    return { privateKey: draft.privateKey, publicKey: draft.publicKey, did: draft.did }
  }

  /** Forget a draft and zero its private key. False when it was not held. */
  discard(draftId: string): boolean {
    return this.drop(draftId)
  }

  get size(): number {
    return this.drafts.size
  }

  /** Zero and drop every draft (shutdown, tests). */
  clear(): void {
    for (const id of [...this.drafts.keys()]) this.drop(id)
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = null
  }

  /** Drop expired drafts. Runs on every call and on a timer while drafts are held. */
  sweep(): void {
    const now = this.now()
    for (const [id, d] of this.drafts) {
      if (d.expiresAt <= now) this.drop(id)
    }
  }

  private drop(draftId: string): boolean {
    const draft = this.drafts.get(draftId)
    if (!draft) return false
    draft.privateKey.fill(0)
    this.drafts.delete(draftId)
    return true
  }

  /** One timer at a time, so expired keys leave memory even when nobody calls in. */
  private armSweep(): void {
    if (!this.scheduleSweep || this.sweepTimer) return
    const next = Math.min(...[...this.drafts.values()].map((d) => d.expiresAt))
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => {
      this.sweepTimer = null
      this.sweep()
      this.armSweep()
    }, Math.max(0, next - this.now()) + 1000)
    timer.unref?.()
    this.sweepTimer = timer
  }
}

/** The process-wide store used by the IPC layer. */
export const identityDrafts = new IdentityDraftStore()
