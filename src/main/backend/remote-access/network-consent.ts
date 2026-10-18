/**
 * "Remote access paused on <network>." (docs/design/remote-access.md §3.3.1,
 * owner decision 2026-10-18 b). Remote access and the mesh's LAN mode
 * listen only on networks the user allowed; when either is on and this
 * computer is on a network that is not allowed, Studio shows a non-modal
 * notice in the window (consent review 3), once per network per session:
 * Wi-Fi that drops and comes back never shows it again. The status line in
 * Settings → Networking shows the same state the whole time.
 *
 * Electron-free: reading the networks and showing the notice are
 * dependencies; Allow goes through NETWORK_ALLOW like the status line's.
 */

import type { NetworkView } from '../../../shared/types/remote-access.types'
import type { NetworkNotice } from '../../../shared/types/remote-access-ipc.types'

export interface NetworkConsentDeps {
  /** Remote access or mesh LAN on, and the networks now; null when not readable (remote mode, no daemon). */
  read: () => Promise<{ active: boolean; networks: NetworkView[] } | null>
  /** Show a new notice. */
  show: (notice: NetworkQuestion) => void
  /** Take these notices away: their network is allowed, left, or remote access and mesh LAN are off. */
  withdraw: (keys: string[]) => void
  log?: Pick<Console, 'log' | 'warn'>
}

export type NetworkQuestion = NetworkNotice

export const PUBLIC_WARNING = 'Public network. The token is sent unencrypted.'

/** One key per network: its id, or per interface for an unidentified one. */
export function networkKey(network: NetworkView): string {
  return network.id ?? `unidentified:${network.kind}:${network.ifaces.join(',')}`
}

export function networkQuestion(network: NetworkView): NetworkQuestion {
  return {
    key: networkKey(network),
    networkId: network.id,
    message: `Remote access paused on ${network.label}.`,
    warning: network.id && network.kind === 'lan' && network.osCategory !== 'private' ? PUBLIC_WARNING : null,
    canAllow: !!network.id,
  }
}

export class NetworkConsentPrompt {
  /** Every network a notice was shown for this session: never shown again (flapping Wi-Fi). */
  private readonly shown = new Set<string>()
  /** Notices on screen now. */
  private readonly visible = new Set<string>()
  private running = false

  constructor(private readonly deps: NetworkConsentDeps) {}

  /** One check: a notice for each network not allowed and not shown this session; withdraw the stale ones. */
  async check(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const read = await this.deps.read().catch(() => null)
      if (!read) return
      const waiting = read.active ? read.networks.filter((n) => !n.allowed) : []
      const keys = new Set(waiting.map(networkKey))
      const stale = [...this.visible].filter((key) => !keys.has(key))
      if (stale.length) {
        for (const key of stale) this.visible.delete(key)
        this.deps.withdraw(stale)
      }
      for (const network of waiting) {
        const key = networkKey(network)
        if (this.shown.has(key)) continue
        this.shown.add(key)
        this.visible.add(key)
        const notice = networkQuestion(network)
        this.deps.log?.log(`[Remote access] ${notice.message}${notice.warning ? ` ${notice.warning}` : ''}`)
        this.deps.show(notice)
      }
    } finally {
      this.running = false
    }
  }

  /** Not now, or Allow: the notice goes (and is not shown again this session). */
  dismiss(key: string): void {
    this.visible.delete(key)
  }
}
