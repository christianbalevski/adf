import { BrowserWindow } from 'electron'
// Studio-scope channels refuse a runtime tag (docs/design/multi-runtime.md §4.2).
import { ipcMain } from './studio-ipc'
import { IPC } from '../../shared/constants/ipc-channels'
import { checkRemoteDaemonUrl, remoteUrlOrigin } from '../../shared/utils/remote-backend-url'
import type { BackendDaemonStatus } from '../../shared/types/backend.types'
import type { ConnectionAddRequest, ConnectionResult, ConnectionsView, RuntimeView } from '../../shared/types/connection.types'
import type { RemoteDiscoveryUpdate } from '../../shared/types/remote-access-ipc.types'
import type { BackendSettingsStore, BootBackend } from './backend-config'
import { buildConnectionsView, forgetConnection, SavedConnectionsCache, saveConnection } from './connections'
import { KEYCHAIN_FILE_COPY } from '../cli/remotes'
import { remoteHandshake } from './daemon-mode/remote/connector'
import { PairingClient } from './remote-access/client'

/**
 * Settings → Connections in Studio main (docs/design/settings-scopes.md §5,
 * docs/design/multi-runtime.md §6.5): the list, Add with a token, Remove,
 * and the choice of This computer or Inside Studio (legacy), saved for the
 * next launch. Pairing with a code is REMOTE_PAIR_* (remote-access-ipc.ts).
 * Saving a connection connects it; Remove disconnects and forgets it. There
 * is no switch and no restart.
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
  /** The saved connections, cached (review item 9); default: a cache of `env` refreshed on each action. */
  saved?: SavedConnectionsCache
  daemonStatus: () => BackendDaemonStatus | null
  /** The network search while the Connection page is open (RemoteDiscovery.snapshot). */
  discovery: () => RemoteDiscoveryUpdate | null
  /** A native question; true for the first (OK) button. */
  confirm: (prompt: { title?: string; message: string; detail: string; ok: string }) => Promise<boolean>
  /** Push the list to the windows (CONNECTION_CHANGED). */
  push: (view: ConnectionsView) => void
  /** The runtime set in order (multi-runtime.md §3.1); the view lists it only while it has more than one runtime. */
  runtimes?: () => RuntimeView[]
  /** How many agent windows show an agent of the runtime `id` (Remove says it closes them, §6.5). */
  agentWindowsOn?: (id: string) => number
  /** The remote slot of studio-backend.json was added, replaced or removed: the runtime set follows it now. */
  slotChanged?: () => void
  /**
   * The runtime `id` was removed, or the remote slot replaced by another
   * address: its Open Recent and Mesh view keys go (`runtimeRecentFiles`,
   * `runtimeFleet`, multi-runtime.md §7.4), so a computer saved later under
   * that id starts without them.
   */
  forgetRuntimeKeys?: (id: string) => void
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
  const cache = deps.saved ?? new SavedConnectionsCache(deps.env)
  // The list and every push read the cache; an action reads the file again first (async), and after it writes.
  const saved = () => cache.get()
  const fresh = () => cache.refresh().catch(() => cache.get())
  /** This computer's launch: saved connections are runtimes of the set (multi-runtime.md §3.1); Inside Studio has none (§7.2). */
  const runtimeSet = deps.boot.mode === 'local'
  const view = (): ConnectionsView => {
    const runtimes = deps.runtimes?.() ?? []
    const built = buildConnectionsView({
      active: { mode: deps.boot.mode },
      configured: deps.backend.config(),
      daemon: deps.daemonStatus(),
      saved: saved(),
      discovery: deps.discovery(),
      ...(runtimeSet ? { runtimeStates: Object.fromEntries(runtimes.map((r) => [r.id, r.state])) } : {}),
    })
    // One runtime: the view is the one sent before (multi-runtime.md §4.6).
    return runtimes.length > 1 ? { ...built, runtimes } : built
  }
  /** "Closes 2 agent windows." when Remove closes any (§6.5). */
  const closesWindows = (id: string): string => {
    const n = deps.agentWindowsOn?.(id) ?? 0
    return n > 0 ? `\nCloses ${n} agent window${n === 1 ? '' : 's'}.` : ''
  }
  const changed = () => deps.push(view())

  /** §4.5: `local` or `embedded` is saved as the mode of the next launch; Studio does not restart (§7.2). */
  const use = async (id: unknown): Promise<ConnectionResult> => {
    if (typeof id !== 'string' || !id) return fail('invalid', 'No connection given.')
    if (id !== 'local' && id !== 'embedded') {
      if (id.startsWith('found:')) return fail('not_paired', 'Add it first.')
      return fail('not_found', id === 'remote' || id.startsWith('remote:') ? 'Already connected.' : 'That connection is not saved.')
    }
    log.log(`[Connection] ${id === 'local' ? 'This computer' : 'Inside Studio (legacy)'} chosen for the next launch`)
    const result = await deps.backend.set({ mode: id })
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
    await fresh()

    // Who answers there, before any token is sent (trust on first use, as Pair).
    let hello: { name: string; fingerprint: string } | null = null
    try {
      const answer = await new PairingClient(check.url, deps.fetch).hello({ timeoutMs: 5_000 })
      if (answer?.v === 1 && typeof answer.fingerprint === 'string' && typeof answer.name === 'string') hello = { name: answer.name, fingerprint: answer.fingerprint }
    } catch { /* remote access off there, an older ADF, or a proxy: a connection without a fingerprint */ }
    const all = saved()
    // An address a saved computer was paired at: no token until it shows that fingerprint (trust on first use).
    const pinnedHere = Object.entries(all).find(([, s]) => remoteUrlOrigin(s.url) === origin)
      ?? (deps.backend.config().remote.paired && remoteUrlOrigin(deps.backend.config().remote.url) === origin
        ? [deps.backend.config().remote.paired!.name, { fingerprint: deps.backend.config().remote.paired!.fingerprint }] as const
        : undefined)
    if (!hello && pinnedHere) return fail('fingerprint_mismatch', `${check.url} is where ${pinnedHere[0]} was paired, but it shows no fingerprint now; Studio sent nothing.`)
    if (hello) {
      const pinned = Object.entries(all).find(([, s]) => remoteUrlOrigin(s.url) === origin && s.fingerprint !== hello!.fingerprint)
      if (pinned) return fail('fingerprint_mismatch', `${hostOf(check.url)} now answers with fingerprint ${hello.fingerprint}, not ${pinned[1].fingerprint} as when ${pinned[0]} was paired; Studio sent nothing, and if it was set up again, remove ${pinned[0]} and pair again.`)
      // The computer is saved under another address: never move it without asking, as Pair does.
      const moved = Object.entries(all).find(([, s]) => s.fingerprint === hello!.fingerprint && remoteUrlOrigin(s.url) !== origin)
      if (moved) {
        const ok = await deps.confirm({ message: 'Use new address', detail: `${moved[0]} is now at ${check.url}.`, ok: 'Use new address' }).catch(() => false)
        if (!ok) return fail('kept', `Kept the saved address of ${moved[0]}.`)
      }
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
          confirmFile: (why) => deps.confirm({ title: KEYCHAIN_FILE_COPY.title, message: KEYCHAIN_FILE_COPY.message, detail: why, ok: KEYCHAIN_FILE_COPY.ok }),
        })).name
      } catch (err) {
        return fail(err instanceof Error && err.name === 'TokenNotStoredError' ? 'not_saved' : 'save_failed', err instanceof Error ? err.message : String(err))
      }
      if (insecure) await deps.backend.set({ trustInsecureOrigin: origin })
      await fresh()
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
    const replaced = !!slot.url && remoteUrlOrigin(slot.url) !== origin
    const result = await deps.backend.set({ remoteUrl: check.url, remoteToken: token, allowInsecureHttp: insecure, ...(insecure ? { insecureHttpOrigin: origin } : {}) })
    if (!result.ok) return fail(result.code, result.error)
    log.log(`[Connection] Added ${check.url} with a token, without a fingerprint`)
    // Another computer in the slot: the previous one's keys are not its.
    if (replaced) deps.forgetRuntimeKeys?.('remote')
    // Saving connects (§12 item 2).
    deps.slotChanged?.()
    changed()
    return { ok: true, view: view(), notices: ['Saved without a fingerprint; identity not checked.'], id: 'remote' }
  }

  /** §6.5: Remove disconnects and forgets a saved connection (§3.3); its agent windows close. */
  const remove = async (id: unknown): Promise<ConnectionResult> => {
    if (typeof id !== 'string') return fail('invalid', 'No connection given.')
    await fresh()
    if (id === 'local') return fail('in_use', 'In use.')
    if (id === 'remote') {
      const slot = deps.backend.config().remote
      if (!slot.url) return fail('not_found', 'That connection is not saved.')
      const name = slot.paired?.name ?? hostOf(slot.url)
      if (!await deps.confirm({ message: `Remove ${name}`, detail: `Removes the address and token from Studio.${closesWindows('remote')}\nStill listed on ${name}; revoke it there.`, ok: 'Remove' }).catch(() => false)) return fail('cancelled', 'Nothing changed.')
      const result = await deps.backend.set({ remoteUrl: null })
      if (!result.ok) return fail(result.code, result.error)
      log.log(`[Connection] Removed ${name}`)
      deps.forgetRuntimeKeys?.('remote')
      // Removing disconnects (§12 item 2).
      deps.slotChanged?.()
      changed()
      return { ok: true, view: view(), notices: [`Removed ${name}.`] }
    }
    if (!id.startsWith('remote:')) return fail('not_found', 'That connection is not saved.')
    const name = id.slice('remote:'.length)
    if (!saved()[name]) return fail('not_found', 'That connection is not saved.')
    if (!await deps.confirm({ message: `Remove ${name}`, detail: `Removes the address and token from Studio and adf.${closesWindows(id)}\nStill listed on ${name}; revoke it there.`, ok: 'Remove' }).catch(() => false)) return fail('cancelled', 'Nothing changed.')
    const fingerprint = saved()[name].fingerprint
    try {
      await forgetConnection(deps.env, name)
      await fresh()
    } catch (err) {
      return fail('save_failed', `Studio could not remove ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The remote slot paired with the same computer is this connection too (runtimeSlot hid it): it goes with it,
    // token included, or it would join the set again and connect with that token.
    const slot = deps.backend.config().remote
    if (slot.url && slot.paired?.fingerprint === fingerprint && !Object.values(saved()).some((r) => r.fingerprint === fingerprint)) {
      const result = await deps.backend.set({ remoteUrl: null })
      if (!result.ok) return fail(result.code, result.error)
      log.log(`[Connection] Removed the remote URL ${slot.url} of studio-backend.json too: it was paired with ${name}`)
      deps.forgetRuntimeKeys?.('remote')
      deps.slotChanged?.()
    }
    log.log(`[Connection] Removed ${name}`)
    deps.forgetRuntimeKeys?.(id)
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

/** The `local`-class channels of Settings → Connections (channel-map.ts). */
export function registerConnectionHandlers(connections: Connections): void {
  ipcMain.handle(IPC.CONNECTION_LIST, () => connections.view())
  ipcMain.handle(IPC.CONNECTION_USE, (_event, id: unknown) => connections.use(id))
  ipcMain.handle(IPC.CONNECTION_ADD, (_event, request: unknown) => connections.add(request))
  ipcMain.handle(IPC.CONNECTION_REMOVE, (_event, id: unknown) => connections.remove(id))
}
