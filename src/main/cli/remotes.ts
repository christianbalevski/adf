/**
 * Saved remote daemons of the adf CLI and terminal app (docs/design/
 * remote-access.md §9.2, §9.3): `adf pair` saves one, `adf remotes`
 * lists, chooses and forgets them.
 *
 * - `<data dir>/cli-remotes.json`: `{v: 1, default, remotes: {<name>: {url,
 *   fingerprint, deviceId, label, pairedAt}}}`. No secret.
 * - The device token: the OS keychain (service `ADF`, account
 *   `remote-token:<fingerprint>`), or, without a usable keychain,
 *   `<data dir>/cli-remote-tokens.json` readable by the current user only.
 *
 * Resolution for every command (daemon-url.ts): `--url`/`--token` >
 * ADF_DAEMON_URL/ADF_DAEMON_TOKEN > `--remote <name>` / ADF_REMOTE > the
 * default remote > this machine's daemon. `ADF_REMOTE=local` forces this
 * machine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonSettingsDir } from '../daemon/daemon-token'
import { openDaemonSecrets } from '../backend/daemon-secrets'
import { writeSecretFileAtomic } from '../utils/secret-write'

export const REMOTES_FILENAME = 'cli-remotes.json'
export const REMOTE_TOKENS_FILENAME = 'cli-remote-tokens.json'
export const REMOTE_ENV = 'ADF_REMOTE'

export interface SavedRemote {
  url: string
  fingerprint: string
  deviceId: string
  /** This computer's label on the host. */
  label: string
  pairedAt: string
  /** The host's computer name when paired. */
  hostName?: string
}

export interface RemotesFile {
  v: 1
  default: string | null
  remotes: Record<string, SavedRemote>
}

function remotesPath(env: NodeJS.ProcessEnv): string {
  return join(daemonSettingsDir(env), REMOTES_FILENAME)
}

function tokensPath(env: NodeJS.ProcessEnv): string {
  return join(daemonSettingsDir(env), REMOTE_TOKENS_FILENAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function loadRemotes(env: NodeJS.ProcessEnv = process.env): RemotesFile {
  const empty: RemotesFile = { v: 1, default: null, remotes: {} }
  const path = remotesPath(env)
  if (!existsSync(path)) return empty
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.remotes)) return empty
    const remotes: Record<string, SavedRemote> = {}
    for (const [name, r] of Object.entries(raw.remotes)) {
      if (isRecord(r) && typeof r.url === 'string' && typeof r.fingerprint === 'string' && typeof r.deviceId === 'string') {
        remotes[name] = {
          url: r.url, fingerprint: r.fingerprint, deviceId: r.deviceId,
          label: typeof r.label === 'string' ? r.label : '', pairedAt: typeof r.pairedAt === 'string' ? r.pairedAt : '',
          ...(typeof r.hostName === 'string' ? { hostName: r.hostName } : {}),
        }
      }
    }
    const def = typeof raw.default === 'string' && remotes[raw.default] ? raw.default : null
    return { v: 1, default: def, remotes }
  } catch {
    return empty
  }
}

/** Both files: readable by the current user only from the first byte (the remotes list names hosts and device ids); throws SecretFileError otherwise. */
function writeJson(path: string, value: unknown): void {
  writeSecretFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function saveRemotes(file: RemotesFile, env: NodeJS.ProcessEnv = process.env): void {
  writeJson(remotesPath(env), file)
}

// --- tokens ---------------------------------------------------------------------

const account = (fingerprint: string) => `remote-token:${fingerprint}`

export interface TokenStoreChoice {
  where: 'keychain' | 'file'
  /** Why the keychain was not used (file); null with the keychain. */
  why: string | null
  path: string | null
}

function readTokenFile(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(tokensPath(env), 'utf-8')) as unknown
    return isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
  } catch {
    return {}
  }
}

/** Save a device token: the keychain, else the user-only file (and say which). */
export function storeRemoteToken(fingerprint: string, token: string, env: NodeJS.ProcessEnv = process.env): TokenStoreChoice {
  const secrets = openDaemonSecrets(env)
  if (secrets.backend) {
    try {
      secrets.backend.set(account(fingerprint), token)
      return { where: 'keychain', why: null, path: null }
    } catch (err) {
      return storeInFile(fingerprint, token, env, `the OS keychain refused it (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return storeInFile(fingerprint, token, env, secrets.unavailable ?? 'no OS keychain')
}

function storeInFile(fingerprint: string, token: string, env: NodeJS.ProcessEnv, why: string): TokenStoreChoice {
  const path = tokensPath(env)
  writeJson(path, { ...readTokenFile(env), [account(fingerprint)]: token })
  return { where: 'file', why, path }
}

export function readRemoteToken(fingerprint: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const secrets = openDaemonSecrets(env)
  if (secrets.backend) {
    try {
      const value = secrets.backend.get(account(fingerprint))
      if (value) return value
    } catch { /* fall through to the file */ }
  }
  return readTokenFile(env)[account(fingerprint)] ?? null
}

export function deleteRemoteToken(fingerprint: string, env: NodeJS.ProcessEnv = process.env): void {
  const secrets = openDaemonSecrets(env)
  try { secrets.backend?.delete(account(fingerprint)) } catch { /* gone */ }
  const tokens = readTokenFile(env)
  if (account(fingerprint) in tokens) {
    delete tokens[account(fingerprint)]
    writeJson(tokensPath(env), tokens)
  }
}

// --- resolution -----------------------------------------------------------------

/** The remote `--remote` / ADF_REMOTE or the default names; null for this machine. Throws for an unknown name. */
export function selectedRemote(env: NodeJS.ProcessEnv = process.env): { name: string; remote: SavedRemote } | null {
  const chosen = env[REMOTE_ENV]?.trim()
  if (chosen === 'local') return null
  if (!chosen && !existsSync(remotesPath(env))) return null
  const file = loadRemotes(env)
  if (chosen) {
    const remote = file.remotes[chosen]
    if (!remote) throw new Error(`No saved remote named "${chosen}". List them with: adf remotes`)
    return { name: chosen, remote }
  }
  return file.default ? { name: file.default, remote: file.remotes[file.default] } : null
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin } catch { return false }
}

/** The saved device token for `url` (a saved remote's origin), or undefined. Never sent to another origin. */
export function savedRemoteToken(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!existsSync(remotesPath(env))) return undefined
  const file = loadRemotes(env)
  for (const remote of Object.values(file.remotes)) {
    if (sameOrigin(remote.url, url)) return readRemoteToken(remote.fingerprint, env) ?? undefined
  }
  return undefined
}

/** The saved remote whose origin `url` is, or null. */
export function savedRemoteFor(url: string, env: NodeJS.ProcessEnv = process.env): { name: string; remote: SavedRemote } | null {
  if (!existsSync(remotesPath(env))) return null
  for (const [name, remote] of Object.entries(loadRemotes(env).remotes)) {
    if (sameOrigin(remote.url, url)) return { name, remote }
  }
  return null
}

/**
 * Before a saved device token goes to `url` (security review item 7): the
 * daemon there MUST answer /remote/hello with the fingerprint pinned when it
 * was paired. Null = go ahead (no saved remote for that origin); otherwise the
 * sentence to show, and the token is not sent. A token given with --token or
 * ADF_DAEMON_TOKEN is the user's own choice and is not checked.
 */
export async function pinnedRemoteRefusal(url: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<string | null> {
  const saved = savedRemoteFor(url, env)
  if (!saved) return null
  const { fetchHello } = await import('./daemon-discovery')
  const hello = await fetchHello(url, fetchImpl)
  const host = `"${saved.name}" (${saved.remote.hostName ?? saved.remote.url})`
  if (!hello) {
    return `${url} did not answer as ${host}: it is down, its remote access is off, or another program answers there. The saved token was not sent.`
  }
  if (hello.fingerprint !== saved.remote.fingerprint) {
    return `The ADF daemon at ${url} is not ${host}: it shows fingerprint ${hello.fingerprint}, and ${saved.remote.fingerprint} was saved when you paired. The saved token was not sent. If that computer was set up again, pair it again: adf remotes forget ${saved.name}, then adf pair ${url}.`
  }
  return null
}

/** A remote name from the host's name: lower case, letters, digits and dashes. */
export function remoteNameFor(hostName: string, taken: Record<string, unknown>): string {
  const base = hostName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'remote'
  let name = base
  for (let i = 2; taken[name]; i++) name = `${base}-${i}`
  return name
}
