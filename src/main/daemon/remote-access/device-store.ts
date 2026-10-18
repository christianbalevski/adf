/**
 * Device tokens (docs/design/remote-access.md §4): one per computer that was
 * paired or given a token by hand, so one can be revoked without breaking
 * the others. `<settings dir>/daemon-devices.json` keeps the SHA-256 of each
 * secret (the secrets have 256 bits of entropy, so no slow KDF), the label,
 * created and last-seen data, and 30-day tombstones of revoked devices so a
 * revoked computer is told so instead of getting a bare 401.
 *
 * A token is `adfd_<id>_<secret>`: the id finds the record without comparing
 * against every hash; the whole string is header-safe like the install
 * token. The plain token exists only in the answer that creates it.
 *
 * An unreadable or malformed file is never replaced: no device token is
 * accepted until it is fixed, because replacing it would revoke every device
 * without the owner knowing.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { protectSecretFile } from '../../utils/secret-file'
import { base32 } from './config'

export const DEVICES_FILENAME = 'daemon-devices.json'
export const DEVICE_TOKEN_PREFIX = 'adfd_'
const TOKEN_RE = /^adfd_([a-z2-7]{10})_([A-Za-z0-9_-]{43})$/
const TOMBSTONE_DAYS = 30
/** lastSeen reaches the file at most this often per device (exact in memory). */
export const LAST_SEEN_FLUSH_MS = 5 * 60_000

export interface DeviceRecord {
  id: string
  label: string
  origin: 'paired' | 'token'
  createdAt: string
  createdBy: 'studio' | 'cli'
  secretSha256: string
  lastSeenAt: string | null
  lastSeenAddress: string | null
}

export interface DeviceTombstone {
  id: string
  label: string
  revokedAt: string
}

interface DevicesFile {
  v: 1
  devices: DeviceRecord[]
  revoked: DeviceTombstone[]
}

export type DeviceTokenCheck =
  | { kind: 'device'; device: DeviceRecord }
  | { kind: 'revoked'; tombstone: DeviceTombstone }
  /** Looks like a device token but matches nothing (or the store is unreadable). */
  | { kind: 'unknown' }

export function isDeviceTokenShape(token: string): boolean {
  return token.startsWith(DEVICE_TOKEN_PREFIX)
}

export function parseDeviceToken(token: string): { id: string; secret: string } | null {
  const match = TOKEN_RE.exec(token)
  return match ? { id: match[1], secret: match[2] } : null
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validDevice(value: unknown): value is DeviceRecord {
  return isRecord(value)
    && typeof value.id === 'string' && /^[a-z2-7]{10}$/.test(value.id)
    && typeof value.label === 'string'
    && (value.origin === 'paired' || value.origin === 'token')
    && typeof value.createdAt === 'string'
    && (value.createdBy === 'studio' || value.createdBy === 'cli')
    && typeof value.secretSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.secretSha256)
}

export class DeviceStore {
  readonly path: string
  private devices = new Map<string, DeviceRecord>()
  private revoked = new Map<string, DeviceTombstone>()
  private problemText: string | null = null
  private lastFlushAt = new Map<string, number>()
  private dirty = false
  private readonly now: () => number

  constructor(settingsDir: string, opts: { now?: () => number } = {}) {
    this.path = join(settingsDir, DEVICES_FILENAME)
    this.now = opts.now ?? Date.now
    this.load()
  }

  /** Why no device token is accepted (unreadable file); null when fine. */
  get problem(): string | null {
    return this.problemText
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.devices)) throw new Error('unsupported version or shape')
      for (const device of raw.devices) {
        if (!validDevice(device)) throw new Error('a device record is malformed')
        this.devices.set(device.id, {
          ...device,
          lastSeenAt: typeof device.lastSeenAt === 'string' ? device.lastSeenAt : null,
          lastSeenAddress: typeof device.lastSeenAddress === 'string' ? device.lastSeenAddress : null,
        })
      }
      const cutoff = this.now() - TOMBSTONE_DAYS * 86_400_000
      for (const t of Array.isArray(raw.revoked) ? raw.revoked : []) {
        if (isRecord(t) && typeof t.id === 'string' && typeof t.label === 'string' && typeof t.revokedAt === 'string' && Date.parse(t.revokedAt) >= cutoff) {
          this.revoked.set(t.id, { id: t.id, label: t.label, revokedAt: t.revokedAt })
        }
      }
    } catch (err) {
      this.devices.clear()
      this.revoked.clear()
      this.problemText = `${this.path} cannot be read (${err instanceof Error ? err.message : String(err)}); no device token is accepted until it is fixed or deleted`
    }
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): DeviceRecord | undefined {
    return this.devices.get(id)
  }

  /** Mint a device: the record is written before the token is returned. Throws when the store is unreadable. */
  create(input: { label: string; origin: 'paired' | 'token'; createdBy: 'studio' | 'cli' }): { device: DeviceRecord; token: string } {
    if (this.problemText) throw new Error(this.problemText)
    let id = ''
    do { id = base32(randomBytes(7)).slice(0, 10) } while (this.devices.has(id) || this.revoked.has(id))
    const secret = randomBytes(32).toString('base64url')
    const device: DeviceRecord = {
      id,
      label: input.label,
      origin: input.origin,
      createdAt: new Date(this.now()).toISOString(),
      createdBy: input.createdBy,
      secretSha256: sha256Hex(secret),
      lastSeenAt: null,
      lastSeenAddress: null,
    }
    this.devices.set(id, device)
    try {
      this.write()
    } catch (err) {
      this.devices.delete(id)
      throw err
    }
    return { device, token: `${DEVICE_TOKEN_PREFIX}${id}_${secret}` }
  }

  /** Remove a device and keep its tombstone; the file is written first. Null for an unknown id. */
  revoke(id: string): DeviceRecord | null {
    const device = this.devices.get(id)
    if (!device) return null
    const tombstone: DeviceTombstone = { id, label: device.label, revokedAt: new Date(this.now()).toISOString() }
    this.devices.delete(id)
    this.revoked.set(id, tombstone)
    try {
      this.write()
    } catch (err) {
      this.devices.set(id, device)
      this.revoked.delete(id)
      throw err
    }
    this.lastFlushAt.delete(id)
    return device
  }

  /** Constant-time check of a presented `adfd_` token. */
  check(token: string): DeviceTokenCheck {
    if (this.problemText) return { kind: 'unknown' }
    const parsed = parseDeviceToken(token)
    if (!parsed) return { kind: 'unknown' }
    const device = this.devices.get(parsed.id)
    if (device) {
      const a = Buffer.from(sha256Hex(parsed.secret), 'hex')
      const b = Buffer.from(device.secretSha256, 'hex')
      return a.length === b.length && timingSafeEqual(a, b) ? { kind: 'device', device } : { kind: 'unknown' }
    }
    const tombstone = this.revoked.get(parsed.id)
    return tombstone ? { kind: 'revoked', tombstone } : { kind: 'unknown' }
  }

  /** A request from the device: exact in memory, written at most every LAST_SEEN_FLUSH_MS (flushDue). */
  touch(id: string, address: string | null): void {
    const device = this.devices.get(id)
    if (!device) return
    device.lastSeenAt = new Date(this.now()).toISOString()
    device.lastSeenAddress = address
    this.dirty = true
  }

  /** Write lastSeen changes when a device's last write is older than LAST_SEEN_FLUSH_MS (or `force`, at shutdown). */
  flushLastSeen(force = false): void {
    if (!this.dirty || this.problemText) return
    const now = this.now()
    const due = force || [...this.devices.values()].some(d => d.lastSeenAt && now - (this.lastFlushAt.get(d.id) ?? 0) >= LAST_SEEN_FLUSH_MS)
    if (!due) return
    try {
      this.write()
      for (const id of this.devices.keys()) this.lastFlushAt.set(id, now)
      this.dirty = false
    } catch (err) {
      console.error(`[remote-access] Could not write ${this.path}:`, err instanceof Error ? err.message : err)
    }
  }

  private write(): void {
    const file: DevicesFile = { v: 1, devices: this.list(), revoked: [...this.revoked.values()] }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    protectSecretFile(tmp)
    renameSync(tmp, this.path)
  }
}
