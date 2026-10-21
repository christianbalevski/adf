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
 * Studio and adf both change the list: every change is a read-modify-write
 * under `cli-remotes.json.lock` (updateRemotes), so neither loses the
 * other's change.
 *
 * Resolution for every command (daemon-url.ts): `--url`/`--token` >
 * ADF_DAEMON_URL/ADF_DAEMON_TOKEN > `--remote <name>` / ADF_REMOTE > the
 * default remote > this machine's daemon. `ADF_REMOTE=local` forces this
 * machine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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

/**
 * cli-remotes.json as read, by every reader (Studio and adf, sync and async):
 * the list, every name in it (a malformed entry still counts as a name), and
 * why it could not be read. An absent file is no saved remote; a file that
 * cannot be read or parsed, or is not a remotes file, has `unreadable` set,
 * and then `file` is the empty list, which must not be taken as "nothing
 * saved" nor written back.
 */
export interface RemotesRead {
  file: RemotesFile
  names: Set<string>
  unreadable: string | null
}

/** cli-remotes.json cannot be read: nothing was written over it. */
export class RemotesUnreadableError extends Error {
  constructor(readonly path: string, readonly why: string) {
    super(`${why}. Fix or remove it; nothing was changed.`)
    this.name = 'RemotesUnreadableError'
  }
}

function emptyRemotes(): RemotesFile {
  return { v: 1, default: null, remotes: {} }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The one reading of the file's text (or of why it could not be read). */
function readOf(path: string, text: string | null, readError?: unknown): RemotesRead {
  if (text === null) {
    if ((readError as NodeJS.ErrnoException)?.code === 'ENOENT') return { file: emptyRemotes(), names: new Set(), unreadable: null }
    return { file: emptyRemotes(), names: new Set(), unreadable: `${path} cannot be read (${errorText(readError)})` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(stripBom(text))
  } catch (err) {
    return { file: emptyRemotes(), names: new Set(), unreadable: `${path} is not valid JSON (${errorText(err)})` }
  }
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.remotes)) return { file: emptyRemotes(), names: new Set(), unreadable: `${path} is not a saved-connections file (v 1)` }
  return { file: parseRemotes(text), names: new Set(Object.keys(raw.remotes)), unreadable: null }
}

/** The list, read with blocking IO (adf). */
export function readRemotes(env: NodeJS.ProcessEnv = process.env): RemotesRead {
  const path = remotesPath(env)
  try {
    return readOf(path, readFileSync(path, 'utf-8'))
  } catch (err) {
    return readOf(path, null, err)
  }
}

/** The list without blocking (Studio main). */
export async function readRemotesAsync(env: NodeJS.ProcessEnv = process.env): Promise<RemotesRead> {
  const path = remotesPath(env)
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    return readOf(path, null, err)
  }
  return readOf(path, text)
}

/**
 * The list where an unreadable file may count as empty: a lookup that
 * then finds nothing (a saved token for an origin, the Connections rows).
 * Never for a list that is written back (updateRemotes refuses one).
 */
export function loadRemotes(env: NodeJS.ProcessEnv = process.env): RemotesFile {
  return readRemotes(env).file
}

/** loadRemotes without blocking. */
export async function loadRemotesAsync(env: NodeJS.ProcessEnv = process.env): Promise<RemotesFile> {
  return (await readRemotesAsync(env)).file
}

/** The file's text as a RemotesFile; anything malformed is left out. */
export function parseRemotes(text: string): RemotesFile {
  const empty = emptyRemotes()
  try {
    const raw = JSON.parse(stripBom(text)) as unknown
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

/** A lock older than this is left over from a process that died holding it, and is taken over. */
export const REMOTES_LOCK_STALE_MS = 10_000
const REMOTES_LOCK_WAIT_MS = 5_000

export class RemotesLockedError extends Error {
  constructor(readonly path: string) {
    super(`${path} is locked by another program; try again.`)
    this.name = 'RemotesLockedError'
  }
}

/** The path of cli-remotes.json (Studio watches it). */
export function remotesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return remotesPath(env)
}

/**
 * Change the saved remotes, Studio and adf alike: under
 * `cli-remotes.json.lock` (created exclusively; one older than
 * REMOTES_LOCK_STALE_MS is a crashed holder's and is taken over), read the
 * file, let `mutate` change it, and write it back when it changed. Neither
 * program loses the other's change. `mutate` may throw: nothing is written.
 *
 * Takeover is atomic: only the waiter that creates `cli-remotes.json.lock.claim`
 * removes a stale lock, and it checks the staleness again under the claim, on
 * the file it renamed to a tombstone of its own; so two waiters that both saw
 * the stale lock never delete a new holder's lock. The lock holds the
 * holder's pid and a nonce, and a holder removes it only while it is still
 * its own. A file that cannot be read or parsed is never written over
 * (RemotesUnreadableError).
 */
export async function updateRemotes<T>(env: NodeJS.ProcessEnv, mutate: (file: RemotesFile) => T | Promise<T>, opts: {
  staleMs?: number
  waitMs?: number
  /** Tests: the platform whose busy-file errors are retried, and the lock's open. */
  platform?: NodeJS.Platform
  openLock?: typeof open
  /** Tests: a waiter saw a stale lock, before it tries the takeover. */
  onStaleSeen?: () => Promise<void>
} = {}): Promise<T> {
  const path = remotesPath(env)
  const lock = `${path}.lock`
  const staleMs = opts.staleMs ?? REMOTES_LOCK_STALE_MS
  const deadline = Date.now() + (opts.waitMs ?? REMOTES_LOCK_WAIT_MS)
  const openLock = opts.openLock ?? open
  // Windows refuses to create a file another process is still deleting (EPERM): busy, as EEXIST is.
  const busy = (err: unknown): boolean => {
    const code = (err as NodeJS.ErrnoException)?.code
    return code === 'EEXIST' || ((opts.platform ?? process.platform) === 'win32' && code === 'EPERM')
  }
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`
  const ageOf = (file: string): Promise<number | null> => stat(file).then((s) => Date.now() - s.mtimeMs, () => null)
  // Only the claim's creator removes a stale lock; the claim is held for a few ms.
  const takeOver = async (): Promise<void> => {
    const claim = `${lock}.claim`
    try {
      await (await openLock(claim, 'wx')).close()
    } catch (err) {
      if (!busy(err)) throw err
      const age = await ageOf(claim)
      if (age !== null && age > staleMs) await unlink(claim).catch(() => {})
      return
    }
    try {
      const age = await ageOf(lock)
      if (age === null || age <= staleMs) return
      const tomb = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`
      try {
        await rename(lock, tomb)
      } catch {
        return
      }
      const tombAge = await ageOf(tomb)
      // Not stale after all (it changed between the two looks): put it back unless a lock exists again.
      if (tombAge !== null && tombAge <= staleMs) await link(tomb, lock).catch(() => {})
      await unlink(tomb).catch(() => {})
    } finally {
      await unlink(claim).catch(() => {})
    }
  }
  await import('node:fs/promises').then((fs) => fs.mkdir(daemonSettingsDir(env), { recursive: true }))
  for (;;) {
    try {
      const handle = await openLock(lock, 'wx')
      await handle.writeFile(`${mine}\n`)
      await handle.close()
      break
    } catch (err) {
      if (!busy(err)) throw err
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        if (Date.now() > deadline) throw new RemotesLockedError(path)
        await new Promise((r) => setTimeout(r, 25))
        continue
      }
      const age = await ageOf(lock)
      if (age !== null && age > staleMs) {
        await opts.onStaleSeen?.()
        await takeOver()
        continue
      }
      if (Date.now() > deadline) throw new RemotesLockedError(path)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    // Never written over while it cannot be read: the user's list would be lost.
    const read = await readRemotesAsync(env)
    if (read.unreadable) throw new RemotesUnreadableError(path, read.unreadable)
    const file = read.file
    const before = JSON.stringify(file)
    const result = await mutate(file)
    if (JSON.stringify(file) !== before) {
      // Windows: the rename over the file fails while a reader has it open (EPERM, EBUSY): retried until the deadline.
      for (;;) {
        try {
          writeJson(path, file)
          break
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if ((opts.platform ?? process.platform) !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || Date.now() > deadline) throw err
          await new Promise((r) => setTimeout(r, 25))
        }
      }
    }
    return result
  } finally {
    // Only while the lock is still this holder's (pid and nonce).
    const held = await readFile(lock, 'utf8').catch(() => null)
    if (held?.trim() === mine) await unlink(lock).catch(() => {})
  }
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

/** Before a token goes to the user-only file: Studio's dialog and adf's lines (plain heading, one sentence, a short verb). */
export const KEYCHAIN_FILE_COPY = {
  title: 'Keychain unavailable',
  message: 'The token can be saved in a file only you can read.',
  ok: 'Save to file',
  cancel: 'Cancel',
  prompt: 'Save to file? [y/N] ',
} as const

/** The keychain did not take the token and the user did not choose the file: nothing was saved. */
export class TokenNotStoredError extends Error {
  constructor(readonly why: string) {
    super(`The token was not saved (${why}).`)
    this.name = 'TokenNotStoredError'
  }
}

/**
 * Save a device token in the OS keychain. When the keychain refuses it or
 * there is none, the token goes to the user-only file only after
 * `confirmFile` says yes (Studio's dialog, adf's prompt; `why` is the
 * reason); otherwise nothing is saved (TokenNotStoredError). Never a silent
 * fallback.
 */
export async function storeRemoteToken(fingerprint: string, token: string, env: NodeJS.ProcessEnv, confirmFile?: (why: string) => Promise<boolean>): Promise<TokenStoreChoice> {
  const secrets = openDaemonSecrets(env)
  let why = secrets.unavailable ?? 'no OS keychain'
  if (secrets.backend) {
    try {
      secrets.backend.set(account(fingerprint), token)
      return { where: 'keychain', why: null, path: null }
    } catch (err) {
      why = `the OS keychain refused it: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!confirmFile || !await confirmFile(why).catch(() => false)) throw new TokenNotStoredError(why)
  return storeInFile(fingerprint, token, env, why)
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

/** The remote `--remote` / ADF_REMOTE or the default names; null for this machine. Throws for an unknown name, or a list that cannot be read. */
export function selectedRemote(env: NodeJS.ProcessEnv = process.env): { name: string; remote: SavedRemote } | null {
  const chosen = env[REMOTE_ENV]?.trim()
  if (chosen === 'local') return null
  if (!chosen && !existsSync(remotesPath(env))) return null
  // An unreadable list is not "no default": this computer is not used in its place.
  const read = readRemotes(env)
  if (read.unreadable) throw new RemotesUnreadableError(remotesPath(env), read.unreadable)
  const file = read.file
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
