import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus, BackendSettingsPatch } from '../../shared/types/backend.types'
import type { ConnectionAddRequest, ConnectionResult, ConnectionsView } from '../../shared/types/connection.types'
import type { RemoteDiscoveryUpdate } from '../../shared/types/remote-access-ipc.types'
import type { BackendSettingsStore, BootBackend } from './backend-config'
import { buildConnectionsView, ConnectionError, forgetConnection, saveConnection, savedConnections, savedConnectionTarget } from './connections'
import { KEYCHAIN_FILE_QUESTION } from '../cli/remotes'
import { remoteHandshake } from './daemon-mode/remote/connector'
import { PairingClient } from './remote-access/client'

/**
 * Settings → Connection in Studio main (docs/design/settings-scopes.md §5):
 * the list, Connect, Add connection with a token, Remove. Pairing with a
 * code is REMOTE_PAIR_* (remote-access-ipc.ts). Every answer is for the
 * window that asked (#149: the connection becomes per window); today one
 * connection serves every window.
 *
 * Tokens never reach the renderer, and none is logged.
 */

const TOKEN_PATTERN = /^[\x21-\x7e]+$/
const MAX_TOKEN_LENGTH = 4096

export interface ConnectionsDeps {
  boot: Pick<BootBackend, 'mode' | 'config'>
  backend: BackendSettingsStore
  /** remotesEnv(): where cli-remotes.json and the keychain fallback are. */
  env: NodeJS.ProcessEnv
  daemonStatus: () => BackendDaemonStatus | null
  /** The network search while the Connection page is open (RemoteDiscovery.snapshot). */
  discovery: () => RemoteDiscoveryUpdate | null
  /** A native question; true for the first (OK) button. */
  confirm: (prompt: { message: string; detail: string; ok: string }) => Promise<boolean>
  /** Push the list to the windows (CONNECTION_CHANGED). */
  push: (view: ConnectionsView) => void
  fetch?: typeof fetch
  log?: Pick<Console, 'log' | 'warn'>
}

export interface Connections {
  view(): ConnectionsView
  use(id: unknown): Promise<ConnectionResult>
  add(request: unknown): Promise<ConnectionResult>
  remove(id: unknown): Promise<ConnectionResult>
  /** Something the list shows changed: push it. */
  changed(): void
}

function fail(code: string, error: string): ConnectionResult {
  return { ok: false, code, error }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return url }
}

export function createConnections(deps: ConnectionsDeps): Connections {
  const log = deps.log ?? console
  const saved = () => {
    try { return savedConnections(deps.env) } catch { return {} }
  }
  const view = (): ConnectionsView => buildConnectionsView({
    active: { mode: deps.boot.mode, remoteName: deps.boot.mode === 'remote' ? deps.boot.config.remote.name ?? null : null, config: deps.boot.config },
    configured: deps.backend.config(),
    daemon: deps.daemonStatus(),
    saved: saved(),
    discovery: deps.discovery(),
  })
  const changed = () => deps.push(view())
  const configuredId = () => {
    const c = deps.backend.config()
    return c.mode === 'remote' ? (c.remote.name ? `remote:${c.remote.name}` : 'remote') : c.mode
  }

  const use = async (id: unknown): Promise<ConnectionResult> => {
    if (typeof id !== 'string' || !id) return fail('invalid', 'No connection given.')
    if (id.startsWith('found:')) return fail('not_paired', 'Pair first.')
    let patch: BackendSettingsPatch
    if (id === 'local' || id === 'embedded') patch = { mode: id }
    else if (id === 'remote') {
      if (!deps.backend.config().remote.url) return fail('not_found', 'That connection is not saved.')
      patch = { mode: 'remote', remoteName: null }
    } else if (id.startsWith('remote:')) {
      const name = id.slice('remote:'.length)
      // Read the token now, so a keychain that refuses says so before Studio restarts.
      try {
        await savedConnectionTarget(deps.backend.config(), name, deps.env, { log: (line) => log.log(line) })
      } catch (err) {
        return fail(err instanceof ConnectionError ? err.code : 'failed', err instanceof Error ? err.message : String(err))
      }
      patch = { mode: 'remote', remoteName: name }
    } else return fail('not_found', 'That connection is not saved.')
    log.log(`[Connection] Connect: ${id}`)
    const result = await deps.backend.set(patch)
    changed()
    return result.ok ? { ok: true, view: view(), notices: result.notices } : fail(result.code, result.error)
  }

  const add = async (request: unknown): Promise<ConnectionResult> => {
    const r = (request && typeof request === 'object' ? request : {}) as Partial<ConnectionAddRequest>
    const check = checkRemoteDaemonUrl(typeof r.url === 'string' ? r.url : '')
    if (!check.url) return fail('invalid_url', check.reason ?? 'Enter the address.')
    const insecure = check.kind === 'insecure-http'
    if (insecure && r.allowInsecureHttp !== true) return fail('insecure_url_unconfirmed', 'Confirm that you trust this network first: the token is sent unencrypted.')
    const token = typeof r.token === 'string' ? r.token.trim() : ''
    if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return fail('invalid_token', 'The token must be printable characters without spaces.')
    const origin = remoteUrlOrigin(check.url)!

    // Who answers there, before any token is sent (trust on first use, as Pair).
    let hello: { name: string; fingerprint: string } | null = null
    try {
      const answer = await new PairingClient(check.url, deps.fetch).hello({ timeoutMs: 5_000 })
      if (answer?.v === 1 && typeof answer.fingerprint === 'string' && typeof answer.name === 'string') hello = { name: answer.name, fingerprint: answer.fingerprint }
    } catch { /* remote access off there, an older ADF, or a proxy: a connection without a fingerprint */ }
    const all = saved()
    if (hello) {
      const pinned = Object.entries(all).find(([, s]) => remoteUrlOrigin(s.url) === origin && s.fingerprint !== hello!.fingerprint)
      if (pinned) return fail('fingerprint_mismatch', `${hostOf(check.url)} now answers with fingerprint ${hello.fingerprint}, not ${pinned[1].fingerprint} as when ${pinned[0]} was paired. Studio sent nothing. If that computer was set up again, remove ${pinned[0]} first.`)
    }
    try {
      await remoteHandshake(check.url, token, deps.fetch ? { fetch: deps.fetch } : {})
    } catch (err) {
      return fail('unreachable', err instanceof Error ? err.message : String(err))
    }

    if (hello) {
      let name: string
      try {
        name = (await saveConnection(deps.env, { url: check.url, token, fingerprint: hello.fingerprint, hostName: hello.name, deviceId: '', label: '' }, {
          confirmFile: (why) => deps.confirm({ message: KEYCHAIN_FILE_QUESTION, detail: why, ok: 'Save in file' }),
        })).name
      } catch (err) {
        return fail(err instanceof Error && err.name === 'TokenNotStoredError' ? 'not_saved' : 'save_failed', err instanceof Error ? err.message : String(err))
      }
      if (insecure) await deps.backend.set({ trustInsecureOrigin: origin })
      log.log(`[Connection] Added ${name} (${hello.fingerprint}) at ${check.url} with a token`)
      changed()
      return { ok: true, view: view(), notices: [`Saved ${name}.`], id: `remote:${name}` }
    }

    // No fingerprint: the remote URL of studio-backend.json, one connection.
    const slot = deps.backend.config().remote
    if (slot.url && remoteUrlOrigin(slot.url) !== origin) {
      const current = slot.paired?.name ?? hostOf(slot.url)
      const ok = await deps.confirm({ message: 'Replace connection', detail: `Replaces ${current}.`, ok: 'Replace' }).catch(() => false)
      if (!ok) return fail('cancelled', 'Nothing changed.')
    }
    const result = await deps.backend.set({ remoteUrl: check.url, remoteToken: token, allowInsecureHttp: insecure, ...(insecure ? { insecureHttpOrigin: origin } : {}) })
    if (!result.ok) return fail(result.code, result.error)
    log.log(`[Connection] Added ${check.url} with a token, without a fingerprint`)
    changed()
    return { ok: true, view: view(), notices: ['Saved. No fingerprint: Studio cannot check this computer\'s identity.'], id: 'remote' }
  }

  const remove = async (id: unknown): Promise<ConnectionResult> => {
    if (typeof id !== 'string') return fail('invalid', 'No connection given.')
    const current = view().current
    if (id === current.id || id === configuredId()) return fail('in_use', 'In use.')
    if (id === 'remote') {
      const slot = deps.backend.config().remote
      if (!slot.url) return fail('not_found', 'That connection is not saved.')
      const name = slot.paired?.name ?? hostOf(slot.url)
      if (!await deps.confirm({ message: `Remove ${name}`, detail: `Studio forgets its address and token. ${name} still lists this device; revoke it there.`, ok: 'Remove' }).catch(() => false)) return fail('cancelled', 'Nothing changed.')
      const result = await deps.backend.set({ remoteUrl: null })
      if (!result.ok) return fail(result.code, result.error)
      log.log(`[Connection] Removed ${name}`)
      changed()
      return { ok: true, view: view(), notices: [`Removed ${name}.`] }
    }
    if (!id.startsWith('remote:')) return fail('not_found', 'That connection is not saved.')
    const name = id.slice('remote:'.length)
    if (!saved()[name]) return fail('not_found', 'That connection is not saved.')
    if (!await deps.confirm({ message: `Remove ${name}`, detail: `Studio and the adf command forget its address and token. ${name} still lists this device; revoke it there.`, ok: 'Remove' }).catch(() => false)) return fail('cancelled', 'Nothing changed.')
    try {
      await forgetConnection(deps.env, name)
    } catch (err) {
      return fail('save_failed', `Studio could not remove ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    log.log(`[Connection] Removed ${name}`)
    changed()
    return { ok: true, view: view(), notices: [`Removed ${name}.`] }
  }

  return { view, use, add, remove, changed }
}

/** Every window gets the list (Settings and the status bar's runtime indicator). */
export function pushConnections(view: ConnectionsView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try { win.webContents.send(IPC.CONNECTION_CHANGED, view) } catch { /* window going away */ }
  }
}

/** The `local`-class channels of Settings → Connection (channel-map.ts). */
export function registerConnectionHandlers(connections: Connections): void {
  ipcMain.handle(IPC.CONNECTION_LIST, () => connections.view())
  ipcMain.handle(IPC.CONNECTION_USE, (_event, id: unknown) => connections.use(id))
  ipcMain.handle(IPC.CONNECTION_ADD, (_event, request: unknown) => connections.add(request))
  ipcMain.handle(IPC.CONNECTION_REMOVE, (_event, id: unknown) => connections.remove(id))
}
