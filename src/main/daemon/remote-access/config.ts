/**
 * `<settings dir>/remote-access.json` (docs/design/remote-access.md §3.1):
 * whether other computers may connect, the name they see, the daemon's
 * remote-access id (its fingerprint) and, on macOS and Linux, the networks
 * the owner marked private (§3.3.1). Only the daemon writes it, through the
 * management routes; whoever starts the daemon (Studio, adf, a service)
 * gets the same behaviour without an environment variable.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { protectSecretFile } from '../../utils/secret-file'

export const REMOTE_ACCESS_FILENAME = 'remote-access.json'

export interface PrivateNetwork {
  id: string
  label: string
  addedAt: string
}

export interface RemoteAccessConfig {
  v: 1
  enabled: boolean
  name: string
  /** 128-bit random, base32; minted on first enable, never changed. */
  daemonId: string | null
  privateNetworks: PrivateNetwork[]
  /** Advanced (CLI `--address`): bind exactly these instead of the automatic set. */
  addresses?: string[]
}

export interface LoadedRemoteAccessConfig {
  config: RemoteAccessConfig
  /** Why the file was not used (remote access is then off); null when it was fine or absent. */
  problem: string | null
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Display form of the daemon id: first 40 bits of sha256(daemonId), base32 upper case, `XXXX-XXXX`. */
export function fingerprintOf(daemonId: string): string {
  const fp = base32(createHash('sha256').update(daemonId, 'utf-8').digest().subarray(0, 5)).toUpperCase()
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}`
}

/** Control and bidi characters are refused in names shown to people (spoofing in prompts). */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/

/** A display name (computer name, device label): trimmed, 1..max characters, no control or bidi characters; null when invalid. */
export function cleanDisplayName(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || [...name].length > max || UNSAFE_CHARS.test(name)) return null
  return name
}

export function defaultComputerName(): string {
  return cleanDisplayName(hostname(), 63) ?? 'ADF computer'
}

export function defaultRemoteAccessConfig(name: string = defaultComputerName()): RemoteAccessConfig {
  return { v: 1, enabled: false, name, daemonId: null, privateNetworks: [] }
}

export function remoteAccessConfigPath(settingsDir: string): string {
  return join(settingsDir, REMOTE_ACCESS_FILENAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Read the file; absent = defaults (off). A malformed file or another `v` = off, with the reason. */
export function loadRemoteAccessConfig(settingsDir: string, defaultName?: string): LoadedRemoteAccessConfig {
  const path = remoteAccessConfigPath(settingsDir)
  const defaults = defaultRemoteAccessConfig(defaultName)
  if (!existsSync(path)) return { config: defaults, problem: null }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    return { config: defaults, problem: `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); remote access is off until it is fixed or deleted` }
  }
  if (!isRecord(raw) || raw.v !== 1) {
    return { config: defaults, problem: `${path} has an unsupported version; remote access is off until it is fixed or deleted` }
  }
  const networks = Array.isArray(raw.privateNetworks)
    ? raw.privateNetworks.filter((n): n is PrivateNetwork => isRecord(n) && typeof n.id === 'string' && typeof n.label === 'string' && typeof n.addedAt === 'string')
    : []
  const addresses = Array.isArray(raw.addresses) ? raw.addresses.filter((a): a is string => typeof a === 'string') : undefined
  return {
    config: {
      v: 1,
      enabled: raw.enabled === true,
      name: cleanDisplayName(raw.name, 63) ?? defaults.name,
      daemonId: typeof raw.daemonId === 'string' && /^[a-z2-7]{26}$/.test(raw.daemonId) ? raw.daemonId : null,
      privateNetworks: networks,
      ...(addresses && addresses.length ? { addresses } : {}),
    },
    problem: null,
  }
}

/** Atomic write (temp + rename), restricted to the current user before the rename. */
export function saveRemoteAccessConfig(settingsDir: string, config: RemoteAccessConfig): void {
  const path = remoteAccessConfigPath(settingsDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  protectSecretFile(tmp)
  renameSync(tmp, path)
}

export function newDaemonId(): string {
  return base32(randomBytes(16))
}
