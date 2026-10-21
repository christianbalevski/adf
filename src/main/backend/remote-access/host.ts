import type { DaemonClient } from '../../../shared/daemon-client'
import type { PairingClaimView, RemoteAccessEvent, RemoteAccessStatus } from '../../../shared/types/remote-access.types'
import type { RemoteAccessChange, RemoteAccessResult, RemoteAccessView, RemoteDeviceAddResult, RemoteShareResult } from '../../../shared/types/remote-access-ipc.types'
import { listenPlan, listensOnText, NO_NETWORK_YET, PUBLIC_WARNING } from '../../../shared/utils/network-consent-text'
import { RemoteAccessApiError, RemoteAccessManagement } from './client'

/**
 * Remote access in Settings → Connections (Add → Share, Devices)
 * (docs/design/remote-access.md §7, §8). Studio main's side of the host
 * panel, local mode only: every action goes to the daemon's management
 * routes (master token, local proof); Studio keeps no remote-access state
 * of its own.
 *
 * - Turning access on, Add → Share, removing a computer and changing
 *   `tailscale serve` are confirmed first, in a native dialog over the
 *   window (review A1: never on the renderer's word). The dialog that
 *   turns access on names every network it will listen on and warns for a
 *   Public one (review A2).
 * - While a pairing window is open the status is read every second, so the
 *   countdown, the attempts left and a pending claim show without the
 *   daemon's events; a claim raises "Allow <device>?" once.
 * - Notices (device added, removed, pairing closed by wrong codes) go to an
 *   OS notification, main.log and the panel.
 */

export interface ClaimPrompt {
  claim: PairingClaimView
  /** Aborted when the claim is gone (decided elsewhere, expired). */
  signal: AbortSignal
  /** tailscale serve fronts the daemon: a proxied claim came through it. */
  serve?: boolean
}

export interface RemoteAccessHostDeps {
  /** The local daemon's client, or why there is none (embedded or remote mode). */
  daemon: () => { client: () => Promise<DaemonClient> } | { unavailable: string }
  /** The daemon stops when Studio quits (Studio started it, keep-running off). */
  stopsWithStudio: () => boolean
  push: (change: RemoteAccessChange) => void
  /** OS notification; main logs the notice itself. */
  notify: (text: string) => void
  /** A yes/no confirmation over the window. */
  confirm: (prompt: { message: string; detail: string; ok: string }) => Promise<boolean>
  /** "Allow <device>?": true allow, false deny, null when the prompt went away unanswered. */
  askClaim: (prompt: ClaimPrompt) => Promise<boolean | null>
  /** The local runtime as Studio names it, `<name> (Local)`, while there is more than one runtime; else null (review A6). */
  localRuntime?: () => string | null
  platform?: NodeJS.Platform
  pollMs?: number
  log?: Pick<Console, 'log' | 'warn'>
}

/**
 * The `remote_access` push as it arrives (shape: RemoteAccessEvent in
 * remote-access.types.ts), unchecked. Never a token or a code.
 */
export type RemoteAccessEventPayload = { [K in keyof RemoteAccessEvent]?: unknown }

/** The power a device gets; `runtime`: the local runtime's name while there is more than one runtime. */
export function enableDetail(runtime: string | null = null): string {
  return `Devices you pair or add get full control of ${runtime ? `the agents of ${runtime}` : 'this computer\'s agents'}. A device token is as powerful as your seed phrase.`
}
export const ENABLE_DETAIL = enableDetail()
export { NO_NETWORK_YET }
export const WINDOWS_FIREWALL_DETAIL = 'Windows may ask whether ADF Studio may accept connections. Choose Allow on private networks.'

export function deviceAddedNotice(label: string): string {
  return `Device added: ${label}.`
}

export function deviceRemovedNotice(label: string): string {
  return `Device revoked: ${label}.`
}

export const WRONG_CODES_NOTICE = 'Pairing closed after too many wrong codes.'
export const LOCKOUT_NOTICE = 'Pairing: a device was locked out after 5 wrong codes.'

function errorText(err: unknown): string {
  if (err instanceof RemoteAccessApiError) {
    // An older daemon has no /remote-access route: 404 with code not_found, or no code at all.
    if (err.status === 404 && (err.code === 'not_found' || err.code === 'http_404')) return 'This ADF daemon has no remote access. Update ADF, then restart the daemon.'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export class RemoteAccessHost {
  private readonly log: Pick<Console, 'log' | 'warn'>
  private last: RemoteAccessStatus | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private polling = false
  private readonly prompts = new Map<string, AbortController>()
  private readonly recentNotices = new Map<string, number>()
  private disposed = false
  private lockouts = 0
  private sharing = false

  constructor(private readonly deps: RemoteAccessHostDeps) {
    this.log = deps.log ?? console
  }

  /** The last status read (the quit prompt's fallback). */
  get lastStatus(): RemoteAccessStatus | null {
    return this.last
  }

  private management(): RemoteAccessManagement | string {
    const daemon = this.deps.daemon()
    return 'unavailable' in daemon ? daemon.unavailable : new RemoteAccessManagement(new LazyClient(daemon.client))
  }

  private view(status: RemoteAccessStatus | null, error: string | null): RemoteAccessView {
    const daemon = this.deps.daemon()
    const unavailable = 'unavailable' in daemon ? daemon.unavailable : null
    return { available: unavailable === null, unavailableReason: unavailable, status, error, stopsWithStudio: unavailable === null && this.deps.stopsWithStudio() }
  }

  private adopt(status: RemoteAccessStatus): RemoteAccessView {
    this.last = status
    this.watchPairing(status)
    return this.view(status, null)
  }

  private publish(view: RemoteAccessView, notice: string | null = null): void {
    if (!this.disposed) this.deps.push({ view, notice })
  }

  async get(opts: { refresh?: boolean } = {}): Promise<RemoteAccessView> {
    const mgmt = this.management()
    if (typeof mgmt === 'string') return this.view(null, null)
    try {
      return this.adopt(await mgmt.status({ refresh: opts.refresh === true }))
    } catch (err) {
      return this.view(this.last, errorText(err))
    }
  }

  private async run(action: string, fn: (mgmt: RemoteAccessManagement) => Promise<RemoteAccessStatus>): Promise<RemoteAccessResult> {
    const mgmt = this.management()
    if (typeof mgmt === 'string') return { ok: false, code: 'unavailable', error: mgmt }
    try {
      const view = this.adopt(await fn(mgmt))
      this.publish(view)
      return { ok: true, view }
    } catch (err) {
      const error = errorText(err)
      this.log.warn(`[Remote access] ${action} failed: ${error}`)
      return { ok: false, code: err instanceof RemoteAccessApiError && err.code === 'cancelled' ? 'cancelled' : 'daemon', error }
    }
  }

  /**
   * The switch (turning it on is confirmed once, in main, naming the
   * networks it listens on) and the computer's name. Nothing the renderer
   * sends skips the dialog (review A1); Add → Share is share().
   */
  async set(request: { enabled?: unknown; name?: unknown }): Promise<RemoteAccessResult> {
    const enabled = typeof request?.enabled === 'boolean' ? request.enabled : undefined
    const name = typeof request?.name === 'string' && request.name.trim() ? request.name.trim() : undefined
    if (enabled === undefined && name === undefined) return { ok: false, code: 'daemon', error: 'Nothing to change.' }
    if (typeof this.management() === 'string') return { ok: false, code: 'unavailable', error: this.management() as string }
    if (enabled === undefined) {
      return this.run('Renaming', async (m) => {
        const s = await m.set({ ...(name ? { name } : {}) })
        this.log.log(`[Remote access] Name: ${s.name} (Settings): ${s.message}`)
        return s
      })
    }
    if (enabled) {
      // Read now: the dialog names what it listens on at this moment.
      const status = await (this.management() as RemoteAccessManagement).status().catch(() => this.last)
      if (status) this.last = status
    }
    if (enabled && !this.last?.enabled) {
      const ok = await this.deps.confirm({
        message: 'Turn on remote access',
        detail: this.consentDetail(this.last ? listenPlan(this.last, { allow: false }) : null),
        ok: 'Turn on',
      })
      if (!ok) {
        this.log.log('[Remote access] Turning on cancelled in the confirmation')
        return { ok: false, code: 'cancelled', error: 'Nothing changed.' }
      }
    }
    const result = await this.run(enabled ? 'Turning on' : 'Turning off', (m) => m.set({ enabled, ...(name ? { name } : {}) }))
    if (result.ok) {
      const s = result.view.status
      this.log.log(`[Remote access] ${enabled ? 'On' : 'Off'} (Settings → Connections): ${s?.state ?? '?'}${s?.message ? `: ${s.message}` : ''}`)
    }
    return result
  }

  /** The dialog body: the power, every network it will listen on, the Public warning, the Windows firewall prompt. */
  private consentDetail(plan: ReturnType<typeof listenPlan> | null): string {
    return [
      enableDetail(this.deps.localRuntime?.() ?? null),
      plan ? listensOnText(plan.labels) : null,
      plan?.exposed ? PUBLIC_WARNING : null,
      (this.deps.platform ?? process.platform) === 'win32' ? WINDOWS_FIREWALL_DETAIL : null,
    ].filter((line): line is string => !!line).join('\n\n')
  }

  /**
   * Add → Share (review A1): one native dialog, owned here, naming every
   * network remote access will listen on (those already allowed too, review
   * A2) with the Public warning; Allow turns remote access on and allows
   * exactly the networks it named, read here, never from the renderer.
   * Nothing to ask (on, every current network allowed): nothing changes.
   */
  async share(): Promise<RemoteShareResult> {
    const mgmt = this.management()
    if (typeof mgmt === 'string') return { ok: false, code: 'unavailable', error: mgmt }
    if (this.sharing) return { ok: false, code: 'cancelled', error: 'Share is already asking.' }
    this.sharing = true
    let turnedOn = false
    try {
      const status = await mgmt.status()
      this.adopt(status)
      const plan = listenPlan(status, { allow: true })
      const enable = !status.enabled
      if (!enable && plan.allow.length === 0) return { ok: true, view: this.view(status, null), turnedOn: false }
      const ok = await this.deps.confirm({ message: 'Share', detail: this.consentDetail(plan), ok: 'Allow' })
      if (!ok) {
        this.log.log('[Remote access] Share cancelled in the confirmation')
        return { ok: false, code: 'cancelled', error: 'Nothing changed.' }
      }
      if (enable) {
        await mgmt.set({ enabled: true })
        turnedOn = true
        this.log.log('[Remote access] On (Settings → Connections → Add → Share)')
      }
      for (const n of plan.allow) {
        await mgmt.allowNetwork(n.id!)
        this.log.log(`[Remote access] Allowed on ${n.label} (Add → Share)`)
      }
      const view = this.adopt(await mgmt.status())
      this.publish(view)
      return { ok: true, view, turnedOn }
    } catch (err) {
      const error = errorText(err)
      this.log.warn(`[Remote access] Share failed: ${error}`)
      if (turnedOn) void this.get().then((view) => this.publish(view))
      return { ok: false, code: 'daemon', error, turnedOn }
    } finally {
      this.sharing = false
    }
  }

  /** Allow on this network / Remove (owner decision 2026-10-18 b): the daemon's consent routes. */
  async network(action: 'allow' | 'forget', id: unknown): Promise<RemoteAccessResult> {
    if (typeof id !== 'string' || !id) return { ok: false, code: 'daemon', error: 'No network given.' }
    return this.run(action === 'allow' ? 'Allow on this network' : 'Remove network', async (m) => {
      const s = action === 'allow' ? await m.allowNetwork(id) : await m.forgetNetwork(id)
      const label = s.networks.find((n) => n.id === id)?.label ?? s.allowedNetworks.find((n) => n.id === id)?.label ?? id
      this.log.log(`[Remote access] ${action === 'allow' ? 'Allowed on' : 'Removed'} ${label} (Settings): ${s.message}`)
      return s
    })
  }

  /** "Add a computer": a device token, returned once. */
  async addDevice(label: unknown): Promise<RemoteDeviceAddResult> {
    const mgmt = this.management()
    if (typeof mgmt === 'string') return { ok: false, code: 'unavailable', error: mgmt }
    const text = typeof label === 'string' && label.trim() ? label.trim() : `Computer added ${new Date().toISOString().slice(0, 10)}`
    try {
      const { device, token } = await mgmt.addDevice(text)
      this.log.log(`[Remote access] Token created for "${device.label}" (${device.id}); shown once in Settings → Connections`)
      this.notice(`added:${device.id}`, deviceAddedNotice(device.label))
      const view = await this.get()
      this.publish(view)
      return { ok: true, view, device, token }
    } catch (err) {
      const error = errorText(err)
      this.log.warn(`[Remote access] Creating a token failed: ${error}`)
      return { ok: false, code: 'daemon', error }
    }
  }

  async removeDevice(id: unknown): Promise<RemoteAccessResult> {
    if (typeof id !== 'string' || !id) return { ok: false, code: 'daemon', error: 'Unknown device.' }
    const device = this.last?.devices.find((d) => d.id === id)
    const label = device?.label ?? id
    const ok = await this.deps.confirm({ message: 'Revoke device', detail: `"${label}" is disconnected now and its token stops working.`, ok: 'Revoke' })
    if (!ok) return { ok: false, code: 'cancelled', error: 'Nothing changed.' }
    return this.run(`Removing ${label}`, async (m) => {
      const removed = await m.removeDevice(id)
      this.log.log(`[Remote access] Removed "${removed.device.label}" (${id}): closed ${removed.closedSessions} sessions, ${removed.closedConnections} connections`)
      this.notice(`revoked:${id}`, deviceRemovedNotice(removed.device.label))
      return m.status()
    })
  }

  async openPairing(): Promise<RemoteAccessResult> {
    return this.run('Opening pairing', async (m) => {
      await m.openPairing()
      this.log.log('[Remote access] Pairing window opened (Settings → Connections)')
      return m.status()
    })
  }

  async closePairing(): Promise<RemoteAccessResult> {
    return this.run('Closing pairing', async (m) => {
      await m.closePairing()
      this.log.log('[Remote access] Pairing window closed (Settings → Connections)')
      return m.status()
    })
  }

  /** "Enable Tailscale https" / "Disable Tailscale https": the exact command is confirmed first (§5.7). */
  async tailscaleServe(enabled: unknown): Promise<RemoteAccessResult & { output?: string }> {
    if (typeof enabled !== 'boolean') return { ok: false, code: 'daemon', error: 'enabled must be true or false.' }
    const command = this.last?.tailscale.serveCommand ?? null
    const ok = await this.deps.confirm(enabled
      ? { message: 'Enable Tailscale https', detail: `The daemon runs:\n${command ?? 'tailscale serve'}\n\nDevices on your tailnet then reach this computer over https.`, ok: 'Enable' }
      : { message: 'Disable Tailscale https', detail: 'The daemon removes the tailscale serve entry for its port only.', ok: 'Disable' })
    if (!ok) return { ok: false, code: 'cancelled', error: 'Nothing changed.' }
    let output: string | undefined
    const result = await this.run(`tailscale serve ${enabled ? 'on' : 'off'}`, async (m) => {
      try {
        output = (await m.tailscaleServe(enabled)).output
      } catch (err) {
        if (err instanceof RemoteAccessApiError && err.code === 'tailscale_failed') {
          throw new RemoteAccessApiError(`${err.message}${err.extra.command ? ` Run it by hand: ${err.extra.command}` : ''}`, err.status, err.code)
        }
        throw err
      }
      this.log.log(`[Remote access] tailscale serve ${enabled ? 'on' : 'off'}: ${output ?? ''}`.trim())
      return m.status({ refresh: true })
    })
    return result.ok ? { ...result, ...(output !== undefined ? { output } : {}) } : result
  }

  /**
   * A `remote_access` event from the daemon's client stream. Every event
   * re-reads the status and pushes it: `claim_pending` carries nothing (the
   * claim is read from the local-only GET /remote-access) and then raises
   * "Allow device" (watchPairing); `networks_changed` and `addresses_changed`
   * refresh the addresses and the status line, device_* the list.
   */
  onDaemonEvent(event: RemoteAccessEventPayload): void {
    const type = typeof event?.type === 'string' ? event.type : ''
    const label = typeof event?.label === 'string' ? event.label : null
    const deviceId = typeof event?.deviceId === 'string' ? event.deviceId : null
    if (type === 'device_added' && label) this.notice(`added:${deviceId ?? label}`, deviceAddedNotice(label))
    else if (type === 'device_revoked' && label) this.notice(`revoked:${deviceId ?? label}`, deviceRemovedNotice(label))
    else if (type === 'pairing_closed' && event.reason === 'wrong_codes') this.notice('wrong_codes', WRONG_CODES_NOTICE)
    // The window stays open; the key counts lockouts so each one is a notice.
    else if (type === 'pairing_lockout') this.notice(`lockout:${this.lockouts++}`, LOCKOUT_NOTICE)
    void this.get().then((view) => this.publish(view))
  }

  /**
   * Computers connected now, for the quit prompt: a fresh read within
   * `timeoutMs`, else the last status. Null when unknown.
   */
  async connectedCount(timeoutMs = 1_500): Promise<number | null> {
    const mgmt = this.management()
    if (typeof mgmt === 'string') return null
    try {
      this.last = await mgmt.status({ timeoutMs })
    } catch (err) {
      // An older daemon has no remote access: nobody can be connected.
      if (err instanceof RemoteAccessApiError && err.status === 404 && (err.code === 'not_found' || err.code === 'http_404')) return 0
      this.log.warn(`[Remote access] Could not read the connected devices at quit: ${errorText(err)}`)
      return null
    }
    return this.last.enabled ? this.last.devices.filter((d) => d.connected).length : 0
  }

  dispose(): void {
    this.disposed = true
    this.stopPoll()
    for (const prompt of this.prompts.values()) prompt.abort()
    this.prompts.clear()
  }

  private notice(key: string, text: string): void {
    const now = Date.now()
    for (const [k, at] of this.recentNotices) if (now - at > 30_000) this.recentNotices.delete(k)
    if (this.recentNotices.has(key)) return
    this.recentNotices.set(key, now)
    this.log.log(`[Remote access] Notice: ${text}`)
    this.deps.notify(text)
    this.publish(this.view(this.last, null), text)
  }

  // --- Pairing window: poll, claim prompt -------------------------------------

  private watchPairing(status: RemoteAccessStatus): void {
    const claimId = status.pairing?.claim?.claimId ?? null
    // A prompt whose claim is gone (decided in the terminal, expired) closes.
    for (const [id, abort] of this.prompts) {
      if (id !== claimId) { abort.abort(); this.prompts.delete(id) }
    }
    if (status.pairing?.claim && !this.prompts.has(status.pairing.claim.claimId)) void this.prompt(status.pairing.claim)
    if (status.pairing && !this.poll && !this.disposed) {
      this.poll = setInterval(() => void this.tick(), this.deps.pollMs ?? 1_000)
      this.poll.unref?.()
    } else if (!status.pairing) {
      this.stopPoll()
    }
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const wasOpen = this.last?.pairing ?? null
      const view = await this.get()
      // Closed by wrong codes without the daemon's event: the last read had no tries left.
      if (wasOpen && !view.status?.pairing && wasOpen.attemptsLeft <= 1 && !wasOpen.claim && Date.parse(wasOpen.expiresAt) > Date.now()) {
        this.notice('wrong_codes', WRONG_CODES_NOTICE)
      }
      this.publish(view)
    } finally {
      this.polling = false
    }
  }

  private async prompt(claim: PairingClaimView): Promise<void> {
    const abort = new AbortController()
    this.prompts.set(claim.claimId, abort)
    this.log.log(`[Remote access] ${claim.deviceName} (${claim.address}, ${claim.via}) entered the right code; asking whether to allow it`)
    let allow: boolean | null
    try {
      allow = await this.deps.askClaim({ claim, signal: abort.signal, serve: this.last?.tailscale.serve === 'on' })
    } catch {
      allow = null
    }
    if (abort.signal.aborted || allow === null) {
      this.log.log(`[Remote access] The question about ${claim.deviceName} closed without an answer here`)
      return
    }
    const mgmt = this.management()
    if (typeof mgmt === 'string') return
    try {
      const decided = await mgmt.decideClaim(claim.claimId, allow)
      if (decided.state === 'approved') {
        this.log.log(`[Remote access] Allowed ${claim.deviceName} (${claim.address}) as "${decided.device.label}" (${decided.device.id})`)
        this.notice(`added:${decided.device.id}`, deviceAddedNotice(decided.device.label))
      } else {
        this.log.log(`[Remote access] Denied ${claim.deviceName} (${claim.address})`)
      }
    } catch (err) {
      const decidedElsewhere = err instanceof RemoteAccessApiError && (err.code === 'claim_decided' || err.code === 'claim_not_found' || err.code === 'pairing_closed')
      this.log.warn(`[Remote access] ${allow ? 'Allowing' : 'Denying'} ${claim.deviceName}: ${decidedElsewhere ? 'already decided or expired' : errorText(err)}`)
      if (!decidedElsewhere) this.deps.notify(`Studio could not ${allow ? 'allow' : 'deny'} ${claim.deviceName}: ${errorText(err)}`)
    } finally {
      this.prompts.delete(claim.claimId)
      void this.get().then((view) => this.publish(view))
    }
  }
}

/** The daemon client once connected: `request` resolves the client first. */
class LazyClient implements Pick<DaemonClient, 'request'> {
  constructor(private readonly client: () => Promise<DaemonClient>) {}
  async request<T>(...args: Parameters<DaemonClient['request']>): Promise<T> {
    return (await this.client()).request<T>(...args)
  }
}
