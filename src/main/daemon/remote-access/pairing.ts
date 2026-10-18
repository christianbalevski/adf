/**
 * The pairing window (docs/design/remote-access.md §5.3-§5.5).
 *
 * The owner opens it on this machine; it shows a 6-digit code for 120 s.
 * Another computer posts the code and its name; a correct code puts the
 * claim before the owner, who MUST allow it before a device token exists.
 * The code alone never yields a token.
 *
 * Limits: 5 wrong codes in total close the window; per source address one
 * claim per 2 s and 10 per 10 minutes. A closed window answers like one that
 * never opened. The code is never logged, announced or put in an event.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { PairClaimResult, PairingClaimView, PairingWindowView, RemoteUrl } from '../../../shared/types/remote-access.types'
import { BoundedMap, SOURCE_TRACKING_CAP } from './bounded-map'

export const PAIRING_WINDOW_MS = 120_000
export const PAIRING_MAX_WRONG = 5
export const CLAIM_MIN_INTERVAL_MS = 2_000
export const CLAIM_BURST_WINDOW_MS = 10 * 60_000
export const CLAIM_BURST_MAX = 10
/** An approved token waits this long to be collected, then is dropped (the device stays listed, "never connected"). */
export const APPROVED_COLLECT_MS = 120_000

export class PairingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PairingError'
  }
}

/** `wrong_codes`: 5 wrong codes; `cancelled`: the owner closed it or opened a new one. */
export type PairingCloseReason = 'expired' | 'wrong_codes' | 'cancelled' | 'paired' | 'denied' | 'disabled'

interface Claim {
  view: PairingClaimView
  /** Only the claimant has it (the 202 answer): collecting the token needs it, not the claim id the owner's clients see. */
  secret: string
  state: 'pending' | 'approved' | 'denied'
  result?: Extract<PairClaimResult, { state: 'approved' }>
  waiters: Set<() => void>
  dropTimer?: ReturnType<typeof setTimeout>
}

interface PairingWindow {
  code: string
  openedAt: number
  expiresAt: number
  wrong: number
  claimId: string | null
  timer: ReturnType<typeof setTimeout>
}

export interface PairingEvents {
  opened(): void
  closed(reason: PairingCloseReason): void
  claimPending(claim: PairingClaimView): void
}

export interface ApprovedDevice {
  token: string
  device: { id: string; label: string }
  daemon: { name: string; fingerprint: string; urls: RemoteUrl[] }
}

/** Constant-time comparison of two secrets of any length. */
function secretsEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf-8').digest()
  const b = createHash('sha256').update(expected, 'utf-8').digest()
  return timingSafeEqual(a, b)
}

export class PairingManager {
  private window: PairingWindow | null = null
  private readonly claims = new Map<string, Claim>()
  /** Claim times per source (socket address, or tailnet user behind serve); bounded. */
  private readonly perAddress = new BoundedMap<string, number[]>(SOURCE_TRACKING_CAP)
  private readonly now: () => number

  constructor(private readonly events: PairingEvents, opts: { now?: () => number; host?: () => { name: string; fingerprint: string } } = {}) {
    this.now = opts.now ?? Date.now
    this.host = opts.host ?? (() => ({ name: '', fingerprint: '' }))
  }

  private readonly host: () => { name: string; fingerprint: string }

  get isOpen(): boolean {
    return this.window !== null && this.window.expiresAt > this.now()
  }

  view(): PairingWindowView | null {
    const w = this.window
    if (!w || w.expiresAt <= this.now()) return null
    const claim = w.claimId ? this.claims.get(w.claimId) : undefined
    return {
      code: w.code,
      ...this.host(),
      openedAt: new Date(w.openedAt).toISOString(),
      expiresAt: new Date(w.expiresAt).toISOString(),
      attemptsLeft: PAIRING_MAX_WRONG - w.wrong,
      claim: claim && claim.state === 'pending' ? claim.view : null,
    }
  }

  /** Open (or replace) the window with a new code. */
  open(): PairingWindowView {
    if (this.window) this.close('cancelled', { quiet: true })
    const openedAt = this.now()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const timer = setTimeout(() => this.close('expired'), PAIRING_WINDOW_MS)
    timer.unref?.()
    this.window = { code, openedAt, expiresAt: openedAt + PAIRING_WINDOW_MS, wrong: 0, claimId: null, timer }
    this.events.opened()
    return this.view() as PairingWindowView
  }

  /** Close the window; a pending claim is dropped (its poll answers 404). */
  close(reason: PairingCloseReason, opts: { quiet?: boolean } = {}): void {
    const w = this.window
    if (!w) return
    this.window = null
    clearTimeout(w.timer)
    if (w.claimId) {
      const claim = this.claims.get(w.claimId)
      if (claim && claim.state === 'pending') this.dropClaim(w.claimId)
    }
    if (!opts.quiet) this.events.closed(reason)
  }

  /** Rate limit per source address: throws 429 with Retry-After seconds. */
  private rateLimit(address: string): void {
    const now = this.now()
    const times = (this.perAddress.get(address) ?? []).filter(t => now - t < CLAIM_BURST_WINDOW_MS)
    const last = times[times.length - 1]
    if (last !== undefined && now - last < CLAIM_MIN_INTERVAL_MS) {
      throw new PairingError('Too many pairing attempts from this address. Wait a moment and try again.', 429, 'rate_limited', { retryAfter: Math.ceil((CLAIM_MIN_INTERVAL_MS - (now - last)) / 1000) })
    }
    if (times.length >= CLAIM_BURST_MAX) {
      throw new PairingError('Too many pairing attempts from this address. Wait a few minutes and try again.', 429, 'rate_limited', { retryAfter: Math.ceil((CLAIM_BURST_WINDOW_MS - (now - times[0])) / 1000) })
    }
    times.push(now)
    this.perAddress.set(address, times)
  }

  /**
   * A claim. Correct code: the claim waits for the owner (202). Throws
   * PairingError for every refusal; `wrongCode` is true for a wrong code
   * (the route delays that answer).
   */
  claim(input: {
    code: string; deviceName: string; clientKind: 'studio' | 'cli'
    /** Rate-limit key: the socket address, or `tailscale:<login>` behind serve. Default: `address`. */
    source?: string
    address: string; via: 'lan' | 'tailnet' | 'proxy'; tailnetLogin: string | null
  }): { claimId: string; expiresAt: string; collectSecret: string; claim: PairingClaimView } {
    this.rateLimit(input.source ?? input.address)
    const w = this.window
    if (!w || w.expiresAt <= this.now()) throw new PairingError('No pairing window is open on this computer. Open one on the host (Pair a computer, or adf daemon pair) and try again.', 404, 'pairing_closed')
    if (w.claimId) throw new PairingError('Another computer is waiting for the host to allow it. Try again when the host has answered.', 409, 'pairing_busy')
    const a = Buffer.from(input.code.padEnd(6, ' ').slice(0, 6), 'utf-8')
    const b = Buffer.from(w.code, 'utf-8')
    if (input.code.length !== 6 || !timingSafeEqual(a, b)) {
      w.wrong += 1
      const attemptsLeft = PAIRING_MAX_WRONG - w.wrong
      if (attemptsLeft <= 0) this.close('wrong_codes')
      throw new PairingError(attemptsLeft > 0 ? 'That code is not the one the host shows.' : 'That code is not the one the host shows. Pairing closed after 5 wrong codes; open a new window on the host.', 403, 'wrong_code', { attemptsLeft: Math.max(0, attemptsLeft) })
    }
    const claimId = randomBytes(16).toString('base64url')
    const view: PairingClaimView = {
      claimId,
      deviceName: input.deviceName,
      clientKind: input.clientKind,
      address: input.address,
      via: input.via,
      tailnetLogin: input.tailnetLogin,
      at: new Date(this.now()).toISOString(),
    }
    const collectSecret = randomBytes(32).toString('base64url')
    this.claims.set(claimId, { view, secret: collectSecret, state: 'pending', waiters: new Set() })
    w.claimId = claimId
    this.events.claimPending(view)
    return { claimId, expiresAt: new Date(w.expiresAt).toISOString(), collectSecret, claim: view }
  }

  /** The owner's answer. `approve` mints the device; its token is kept until the claimant collects it. */
  decide(claimId: string, allow: boolean, approve: (claim: PairingClaimView) => ApprovedDevice): { state: 'approved'; deviceId: string } | { state: 'denied' } {
    const claim = this.claims.get(claimId)
    const w = this.window
    if (!claim || !w || w.claimId !== claimId) {
      if (claim && claim.state !== 'pending') throw new PairingError('This pairing request was already answered.', 409, 'claim_decided')
      throw new PairingError('No such pairing request (it expired or the window closed).', 404, 'claim_not_found')
    }
    if (claim.state !== 'pending') throw new PairingError('This pairing request was already answered.', 409, 'claim_decided')
    if (!allow) {
      claim.state = 'denied'
      this.wake(claim)
      this.scheduleDrop(claimId)
      this.close('denied')
      return { state: 'denied' }
    }
    const approved = approve(claim.view)
    claim.state = 'approved'
    claim.result = { state: 'approved', ...approved }
    this.wake(claim)
    this.scheduleDrop(claimId)
    this.close('paired')
    return { state: 'approved', deviceId: approved.device.id }
  }

  /**
   * The claimant's poll: waits up to `waitMs` while pending. An approved
   * result is delivered once, then the claim is deleted. Null = unknown
   * claim, or a collect secret that is not this claim's (constant time): the
   * claim id alone, which the owner's clients see, collects nothing.
   */
  async poll(claimId: string, collectSecret: string, waitMs: number): Promise<PairClaimResult | null> {
    let claim = this.claims.get(claimId)
    if (!claim || !secretsEqual(collectSecret, claim.secret)) return null
    if (claim.state === 'pending' && waitMs > 0) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); claim?.waiters.delete(done); resolve() }
        const timer = setTimeout(done, waitMs)
        timer.unref?.()
        claim?.waiters.add(done)
      })
      claim = this.claims.get(claimId)
      if (!claim) return null
    }
    if (claim.state === 'pending') return { state: 'pending' }
    if (claim.state === 'denied') return { state: 'denied' }
    const result = claim.result as PairClaimResult
    this.dropClaim(claimId)
    return result
  }

  /** Pending claims of a closing window, and decided ones after APPROVED_COLLECT_MS. */
  private dropClaim(claimId: string): void {
    const claim = this.claims.get(claimId)
    if (!claim) return
    this.claims.delete(claimId)
    if (claim.dropTimer) clearTimeout(claim.dropTimer)
    this.wake(claim)
  }

  private scheduleDrop(claimId: string): void {
    const claim = this.claims.get(claimId)
    if (!claim) return
    claim.dropTimer = setTimeout(() => this.dropClaim(claimId), APPROVED_COLLECT_MS)
    claim.dropTimer.unref?.()
  }

  private wake(claim: Claim): void {
    for (const waiter of [...claim.waiters]) waiter()
  }

  /** Daemon stop / remote access off. */
  dispose(): void {
    this.close('disabled', { quiet: true })
    for (const id of [...this.claims.keys()]) this.dropClaim(id)
    this.perAddress.clear()
  }
}
