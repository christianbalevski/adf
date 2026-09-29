/**
 * Per-install daemon access token.
 *
 * The daemon requires `Authorization: Bearer <token>` on every HTTP route
 * except GET /health. On first start it mints a random token into
 * `<settings dir>/daemon-token` (0600, next to adf-settings.json and
 * runtime-enc-key); local clients (adf CLI, terminal app, daemon control)
 * read the same file, so nothing needs configuring on this machine. A web
 * page cannot read the file, which is what stops cross-site requests.
 * ADF_DAEMON_TOKEN overrides the file on both sides.
 *
 * Unlike runtime-enc-key, the token guards nothing at rest: an unreadable or
 * malformed file is simply replaced (clients re-read it on a 401).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { defaultUserDataPath } from '../utils/user-data-path'

export const DAEMON_TOKEN_FILENAME = 'daemon-token'
const MIN_TOKEN_LENGTH = 32

export function daemonTokenPath(settingsDir: string): string {
  return join(settingsDir, DAEMON_TOKEN_FILENAME)
}

/** The settings directory the daemon uses (same resolution as daemon/index.ts). */
export function daemonSettingsDir(env: NodeJS.ProcessEnv = process.env): string {
  const settingsFile = env.ADF_DAEMON_SETTINGS ?? join(defaultUserDataPath({ quiet: true }), 'adf-settings.json')
  return dirname(settingsFile)
}

function validToken(raw: string): string | null {
  const token = raw.trim()
  return token.length >= MIN_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token) ? token : null
}

/** The token in `<settingsDir>/daemon-token`, or null (absent, unreadable, malformed). */
export function readDaemonToken(settingsDir: string): string | null {
  try {
    return validToken(readFileSync(daemonTokenPath(settingsDir), 'utf-8'))
  } catch {
    return null
  }
}

/** Read the token, minting it (0600) on first use. */
export function ensureDaemonToken(settingsDir: string): { token: string; path: string; created: boolean } {
  const path = daemonTokenPath(settingsDir)
  const existing = readDaemonToken(settingsDir)
  if (existing) {
    try { chmodSync(path, 0o600) } catch { /* windows / read-only fs */ }
    return { token: existing, path, created: false }
  }
  mkdirSync(settingsDir, { recursive: true })
  const token = randomBytes(32).toString('base64url')
  if (!existsSync(path)) {
    try {
      // 'wx': two daemons sharing these settings may start at once; the
      // loser reads the winner's token instead of overwriting it.
      writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' })
      return { token, path, created: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      const raced = readDaemonToken(settingsDir)
      if (raced) return { token: raced, path, created: false }
    }
  }
  // Present but malformed: replace it.
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* windows */ }
  return { token, path, created: true }
}

/** Constant-time comparison (hashing first equalizes lengths). */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf-8').digest()
  const b = createHash('sha256').update(expected, 'utf-8').digest()
  return timingSafeEqual(a, b)
}
