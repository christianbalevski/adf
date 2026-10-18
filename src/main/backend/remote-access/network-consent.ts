/**
 * "Remote access paused on <network>." (docs/design/remote-access.md §3.3.1,
 * owner decision 2026-10-18 b). Remote access and the mesh's LAN mode
 * listen only on networks the user allowed; when either is on and this
 * computer is on a network that is not allowed, Studio asks once per visit
 * to that network. Leaving the network and coming back asks again.
 *
 * Electron-free: the question and the reads are dependencies.
 */

import type { NetworkView } from '../../../shared/types/remote-access.types'

export interface NetworkConsentDeps {
  /** Remote access or mesh LAN on, and the networks now; null when not readable (remote mode, no daemon). */
  read: () => Promise<{ active: boolean; networks: NetworkView[] } | null>
  /** Show the question; true = Allow on this network. */
  ask: (question: NetworkQuestion) => Promise<boolean>
  allow: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
  log?: Pick<Console, 'log' | 'warn'>
}

export interface NetworkQuestion {
  network: NetworkView
  title: string
  message: string
  /** "Public network. The token is sent unencrypted." on a LAN the OS reports Public or does not report; else null. */
  warning: string | null
  /** False for an unidentified network: it cannot be allowed, the notice only says why nothing listens. */
  canAllow: boolean
  allowLabel: string
  laterLabel: string
}

/** One key per network: its id, or per interface for an unidentified one. */
export function networkKey(network: NetworkView): string {
  return network.id ?? `unidentified:${network.kind}:${network.ifaces.join(',')}`
}

export const PUBLIC_WARNING = 'Public network. The token is sent unencrypted.'

export function networkQuestion(network: NetworkView): NetworkQuestion {
  return {
    network,
    title: 'Remote access paused',
    message: `Remote access paused on ${network.label}.`,
    warning: network.id && network.kind === 'lan' && network.osCategory !== 'private' ? PUBLIC_WARNING : null,
    canAllow: !!network.id,
    allowLabel: 'Allow on this network',
    laterLabel: 'Not now',
  }
}

export class NetworkConsentPrompt {
  /** Networks asked about during the current visit (cleared when the network goes away). */
  private readonly asked = new Set<string>()
  private running = false

  constructor(private readonly deps: NetworkConsentDeps) {}

  /** One check: ask about each network not allowed and not asked during this visit. */
  async check(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const read = await this.deps.read().catch(() => null)
      if (!read) return
      const current = new Set(read.networks.map(networkKey))
      for (const key of [...this.asked]) if (!current.has(key)) this.asked.delete(key)
      if (!read.active) return
      for (const network of read.networks) {
        if (network.allowed || this.asked.has(networkKey(network))) continue
        this.asked.add(networkKey(network))
        const question = networkQuestion(network)
        this.deps.log?.log(`[Remote access] ${question.message}${question.warning ? ` ${question.warning}` : ''}`)
        if (!(await this.deps.ask(question)) || !network.id) {
          this.deps.log?.log(`[Remote access] Not allowed on ${network.label} (Not now)`)
          continue
        }
        const result = await this.deps.allow(network.id)
        if (result.ok) this.deps.log?.log(`[Remote access] Allowed on ${network.label}`)
        else this.deps.log?.warn(`[Remote access] Allow on ${network.label} failed: ${result.error}`)
      }
    } finally {
      this.running = false
    }
  }
}
